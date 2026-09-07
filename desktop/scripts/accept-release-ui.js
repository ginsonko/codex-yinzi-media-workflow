'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const sharp = require('sharp');

const cdpUrl = process.argv[2] || 'http://127.0.0.1:9224';
const origin = new URL(process.argv[3] || 'http://127.0.0.1:5679').origin;
const outputDir = path.resolve(process.argv[4] || path.join(__dirname, '..', 'release-acceptance', 'ui-evidence'));

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  cdp_url: cdpUrl,
  origin,
  pages: [],
  console_errors: [],
  page_errors: [],
  request_failures: [],
  expected_media_aborts: [],
  http_errors: [],
  external_requests: [],
  interactions: {},
  director_canvas: null,
};

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

async function pageMetrics(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const oversized = [...document.querySelectorAll('body *')]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.position === 'fixed' && style.display === 'none') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > viewportWidth + 1 || rect.left < -1);
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: String(element.className || '').slice(0, 120),
        text: String(element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
        rect: (() => {
          const value = element.getBoundingClientRect();
          return { left: value.left, right: value.right, width: value.width };
        })(),
      }));
    const visibleText = String(body?.innerText || '').trim();
    return {
      title: document.title,
      viewport: { width: viewportWidth, height: window.innerHeight },
      document: {
        client_width: root.clientWidth,
        scroll_width: Math.max(root.scrollWidth, body?.scrollWidth || 0),
        scroll_height: Math.max(root.scrollHeight, body?.scrollHeight || 0),
      },
      horizontal_overflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > root.clientWidth + 1,
      oversized,
      visible_text_length: visibleText.length,
      body_excerpt: visibleText.slice(0, 240),
    };
  });
}

async function auditPage(page, name, pathname, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${origin}${pathname}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500);
  const metrics = await pageMetrics(page);
  const screenshot = path.join(outputDir, `${safeName(name)}-${viewport.width}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  report.pages.push({ name, pathname, screenshot, ...metrics });
  return metrics;
}

async function waitForVideo(page, selector) {
  const videoLocator = page.locator(selector).first();
  await videoLocator.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction((value) => {
    const video = document.querySelector(value);
    return video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0;
  }, selector, { timeout: 30000 });
  return videoLocator.evaluate((video) => ({
    ready_state: video.readyState,
    duration: video.duration,
    video_width: video.videoWidth,
    video_height: video.videoHeight,
    paused: video.paused,
  }));
}

async function canvasEvidence(page) {
  const canvas = page.locator('canvas:visible').first();
  await canvas.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);
  const box = await canvas.boundingBox();
  if (!box || box.width < 100 || box.height < 100) throw new Error('3D canvas has no stable visible bounds');
  const clip = {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.max(1, Math.min(box.width, (await page.viewportSize()).width - Math.max(0, box.x))),
    height: Math.max(1, Math.min(box.height, (await page.viewportSize()).height - Math.max(0, box.y))),
  };
  const screenshot = path.join(outputDir, 'director-canvas.png');
  await page.screenshot({ path: screenshot, clip });
  const { channels } = await sharp(screenshot).stats();
  const standardDeviation = channels.slice(0, 3).map((channel) => channel.stdev);
  const nonblank = standardDeviation.some((value) => value > 4);
  const before = await page.locator('canvas').evaluate((element) => ({ width: element.width, height: element.height }));
  const playButton = page.getByRole('button', { name: /播放|预览/ }).first();
  if (await playButton.count()) {
    await playButton.click().catch(() => {});
    await page.waitForTimeout(900);
  }
  const afterScreenshot = path.join(outputDir, 'director-canvas-after-play.png');
  await page.screenshot({ path: afterScreenshot, clip });
  const changed = !fs.readFileSync(screenshot).equals(fs.readFileSync(afterScreenshot));
  return { screenshot, after_screenshot: afterScreenshot, css_box: box, bitmap: before, channel_stdev: standardDeviation, nonblank, changed_after_play: changed };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Electron CDP context not found');
    const pages = context.pages();
    const page = pages.find((candidate) => candidate.url().startsWith(origin)) || pages[0];
    if (!page) throw new Error('Electron renderer page not found');

    page.on('console', (message) => {
      if (message.type() === 'error') report.console_errors.push({ url: page.url(), text: message.text() });
    });
    page.on('pageerror', (error) => report.page_errors.push({ url: page.url(), message: error.message }));
    page.on('requestfailed', (request) => {
      const failure = { url: request.url(), error: request.failure()?.errorText || 'unknown' };
      let isExpectedDemoAbort = false;
      try {
        const url = new URL(request.url());
        isExpectedDemoAbort = url.origin === origin
          && url.pathname.startsWith('/demo/')
          && /\.(mp4|webm)$/i.test(url.pathname)
          && failure.error === 'net::ERR_ABORTED';
      } catch (_) {}
      if (isExpectedDemoAbort) report.expected_media_aborts.push(failure);
      else report.request_failures.push(failure);
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) report.http_errors.push({ url: response.url(), status });
      try {
        if (new URL(response.url()).origin !== origin) report.external_requests.push(response.url());
      } catch (_) {}
    });

    const desktop = { width: 1360, height: 880 };
    const mobile = { width: 390, height: 844 };
    await auditPage(page, 'home', '/', desktop);

    await page.goto(`${origin}/guided-demo`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.setViewportSize(desktop);
    await page.getByRole('button', { name: '打回看看' }).click();
    await page.getByPlaceholder(/例如/).fill('验收模拟：请保持角色与场景一致性。');
    await page.getByRole('button', { name: /提交评价并模拟重做/ }).click();
    await page.getByText('当前修订：R2').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /确认并继续/ }).click();
    await page.getByRole('heading', { name: '确认角色与场景' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /确认并继续/ }).click();
    await page.getByRole('heading', { name: '审批分镜与可选 3D 预演' }).waitFor({ state: 'visible' });
    await page.getByText('携带 3D 预演', { exact: true }).click();
    const directorVideo = await waitForVideo(page, '.director-demo video');
    await page.getByRole('button', { name: /确认并继续/ }).click();
    await page.getByRole('heading', { name: '逐镜头审核视频片段' }).waitFor({ state: 'visible' });
    const shotVideos = await page.locator('.shot-review-list video').count();
    const firstShot = await waitForVideo(page, '.shot-review-list video');
    await page.getByRole('button', { name: /确认并继续/ }).click();
    await page.getByRole('heading', { name: '检查成片并交付' }).waitFor({ state: 'visible' });
    const finalVideo = await waitForVideo(page, '.final-layout video');
    const finalScreenshot = path.join(outputDir, 'guided-demo-final-1360.png');
    await page.screenshot({ path: finalScreenshot, fullPage: true });
    report.interactions.guided_demo = { revision: 2, director_video: directorVideo, shot_video_count: shotVideos, first_shot: firstShot, final_video: finalVideo, screenshot: finalScreenshot };

    await auditPage(page, 'ai-config', '/ai-config', desktop);
    await auditPage(page, 'advanced-settings', '/advanced-settings', desktop);
    await auditPage(page, 'help', '/help', desktop);

    await page.setViewportSize(desktop);
    await page.goto(`${origin}/director?tutorial=1`, { waitUntil: 'networkidle', timeout: 30000 });
    report.director_canvas = await canvasEvidence(page);
    const directorScreenshot = path.join(outputDir, 'director-1360.png');
    await page.screenshot({ path: directorScreenshot, fullPage: true });
    report.pages.push({ name: 'director', pathname: '/director?tutorial=1', screenshot: directorScreenshot, ...(await pageMetrics(page)) });

    for (const [name, pathname] of [['home', '/'], ['guided-demo', '/guided-demo'], ['ai-config', '/ai-config'], ['help', '/help']]) {
      await auditPage(page, `${name}-mobile`, pathname, mobile);
    }

    report.external_requests = [...new Set(report.external_requests)];
    report.expected_media_aborts = report.expected_media_aborts.filter((item, index, values) => (
      values.findIndex((candidate) => candidate.url === item.url && candidate.error === item.error) === index
    ));
    report.pass = report.console_errors.length === 0
      && report.page_errors.length === 0
      && report.request_failures.length === 0
      && report.http_errors.length === 0
      && report.external_requests.length === 0
      && report.pages.every((item) => !item.horizontal_overflow && item.visible_text_length > 20)
      && report.director_canvas?.nonblank === true
      && report.interactions.guided_demo?.final_video?.ready_state >= 1;
    const reportPath = path.join(outputDir, 'report.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ report: reportPath, pass: report.pass, pages: report.pages.length, errors: report.console_errors.length + report.page_errors.length + report.request_failures.length + report.http_errors.length, external_requests: report.external_requests.length, director: report.director_canvas }, null, 2));
    if (!report.pass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
