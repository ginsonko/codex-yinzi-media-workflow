'use strict';
const {validateUrl} = require('./mediaDownload');
const {readPublicPage} = require('./publicResearchHttp');
const fail = (code, message) => Object.assign(new Error(message), {code});

// Read the public server-rendered metadata only. No cookies, private APIs or
// JavaScript evaluation. Kept separate so a markup change affects one adapter.
function parsePage(html, requestedUrl, observedAt = new Date().toISOString()) {
  const marker = /(?:window\.)?__INITIAL_STATE__\s*=\s*/g.exec(html);
  if (!marker) throw fail('PLATFORM_METADATA_UNAVAILABLE', 'B站页面没有公开视频元数据，可能需要登录或遇到访问限制');
  const start = html.indexOf('{', marker.index + marker[0].length);
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = start; i >= 0 && i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw fail('PLATFORM_METADATA_INVALID', 'B站页面元数据不完整');
  let data;
  try { data = JSON.parse(html.slice(start, end)).videoData; }
  catch { throw fail('PLATFORM_METADATA_INVALID', 'B站页面元数据不是可读取的JSON'); }
  if (!data?.bvid || !/^BV[a-zA-Z0-9]+$/.test(data.bvid) || !data.title) throw fail('PLATFORM_METADATA_UNAVAILABLE', 'B站页面未返回有效视频信息');
  const requestedId = new URL(requestedUrl).pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)?.[1];
  if (requestedId && data.bvid !== requestedId) throw fail('PLATFORM_ID_MISMATCH', 'B站返回的视频编号与请求不符');
  const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  const url = 'https://www.bilibili.com/video/' + data.bvid + '/';
  const published = Number(data.pubdate);
  return {
    id: 'bilibili-' + data.bvid, url, platform: 'bilibili', title: String(data.title),
    author: data.owner?.name || null,
    published_at: Number.isFinite(published) && published > 0 && published < 8640000000000 ? new Date(published * 1000).toISOString() : null,
    observed_at: observedAt, region: null, duration_seconds: count(data.duration),
    evidence: {kind:'platform_page', url, note:'B站公开页面 __INITIAL_STATE__.videoData；只读取元数据，未观看视频'},
    metrics: {views:count(data.stat?.view), likes:count(data.stat?.like), comments:count(data.stat?.reply), shares:count(data.stat?.share), saves:count(data.stat?.favorite)},
    analysis_basis:'metadata_only', selected:false
  };
}

function readPage(url, {timeout = 15000, maxBytes = 4 * 1024 * 1024} = {}) {
  validateUrl(url);
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['www.bilibili.com','bilibili.com'].includes(u.hostname) || !/^\/video\/(?:BV[a-zA-Z0-9]+|av\d+)\/?$/.test(u.pathname)) {
    throw fail('UNSUPPORTED_BILIBILI_URL', '公开页面适配器只接受B站标准视频详情链接');
  }
  return readPublicPage(url,{hosts:['www.bilibili.com','bilibili.com'],timeout,maxBytes});
}
async function collect(url, options = {}) { return parsePage(await readPage(url, options), url); }
module.exports = {parsePage, readPage, collect};
