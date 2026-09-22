'use strict';
const fs = require('node:fs');
const path = require('node:path');
const profiles = require('./videoPlatformProfiles.json');
const { known, metrics } = require('./productReferenceReportModel');
const text = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const escapeHtml = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function publicLink(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !url.hostname.includes('.') || /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(url.hostname)) return null;
    // Keep only the public video locator. Never export access/signature tokens.
    const video = /(^|\.)youtube\.com$/.test(url.hostname) ? url.searchParams.get('v') : null;
    url.search = ''; url.hash = '';
    if (video) url.searchParams.set('v', video);
    return url.href;
  } catch { return null; }
}
function snapshot(result, brief = {}) {
  const excluded = new Map((result.excluded || []).map(row => [row.id, row.exclusion_reason || '']));
  return {
    schema_version: 1, product: text(result.query.product || '商品视频'),
    generated_at: result.generated_at || new Date().toISOString(),
    query: { product: text(result.query.product), platforms: result.query.platforms || [], region: result.query.region || null, since: result.query.since || null, until: result.query.until || null },
    platform_labels: Object.fromEntries(profiles.map(profile => [profile.id, profile.name])),
    items: result.items.map(row => {
      const reason = excluded.get(row.id) || '';
      return {
        id: text(row.id), title: text(row.title || '未命名视频'), author: text(row.author),
        author_followers: known(row.author_followers) ? row.author_followers : null,
        description: text(row.description), discovery_queries: row.discovery_queries || [],
        comment_samples: (row.comment_samples || []).map(c=>({text:text(c.text).slice(0,500),likes:known(c.likes)?c.likes:null,observed_at:c.observed_at || null})),
        platform: text(row.platform || 'unknown'), region: text(row.region), content_kind: text(row.content_kind),
        url: publicLink(row.url), published_at: row.published_at || null, observed_at: row.observed_at || null,
        duration_seconds: known(row.duration_seconds) ? row.duration_seconds : null,
        evidence: { kind: row.evidence?.kind || 'unknown', url: publicLink(row.evidence?.url), note: text(row.evidence?.note) },
        metrics: Object.fromEntries(Object.keys(metrics).map(key => [key, known(row.metrics[key]) ? row.metrics[key] : null])),
        analysis_basis: text(row.analysis_basis), analysis: row.analysis || null,
        exclusion_reason: reason, scope_match: !reason.split(', ').some(value => /^(platform_|region_|published_at_|before_|after_)/.test(value)),
        observations: (row.duplicate_observations || []).map(observation => ({ observed_at: observation.observed_at, evidence_kind: observation.evidence?.kind, metrics: Object.fromEntries(Object.keys(metrics).map(key => [key, observation.metrics?.[key] ?? null])) })),
      };
    }),
    product_facts: brief.product_facts || [], experiments: brief.experiments || [],
  };
}
function renderReport(result, brief) {
  const data = snapshot(result, brief);
  const assets = path.join(__dirname, 'productResearchReport');
  const html = fs.readFileSync(path.join(assets, 'report.html'), 'utf8');
  const replacements = {
    TITLE: escapeHtml(data.product),
    DATA: JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'),
    CSS: fs.readFileSync(path.join(assets, 'report.css'), 'utf8'),
    MODEL: fs.readFileSync(path.join(__dirname, 'productReferenceReportModel.js'), 'utf8'),
    CLIENT: fs.readFileSync(path.join(assets, 'report.js'), 'utf8'),
  };
  return html.replace(/__REPORT_(TITLE|DATA|CSS|MODEL|CLIENT)__/g, (_, key) => replacements[key]);
}
module.exports = { snapshot, renderReport, publicLink };
