'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', 'catalogs', 'media-tool-options.json');
const SUMMARY_DESCRIPTION_LIMIT = 160;
const SEARCH_TEXT_LIMIT = 4000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_OFFSET = 1_000_000;
const MAX_QUERY_LENGTH = 500;

const CATEGORY_LABELS = Object.freeze({
  mad: 'MAD / 节拍剪辑',
  mv: 'MV / 影像风格',
  highlight: '高光精选',
  guichu: '鬼畜',
  comp: '合成',
  frame: '关键帧 / 补帧',
  transition: '转场',
  camera: '镜头 / 跟踪',
  mask: '蒙版 / 抠像',
  sky_beauty: '天空 / 美颜',
  audio: '音频',
  privacy: '隐私处理（研究）',
  fx_decorative: '装饰特效（非隐私）',
});

const PLANNING_DISCLAIMER = '这是规划参考目录，不是已验证可执行工具清单。条目不可直接执行或安装。';
const RECIPE_NOTE = '仅关联当前运行时已存在的基础操作，不代表完整配方已实现。';
const AUTO_INSTALL_NOTE = '自动安装未接入当前组件管理器；auto_install_supported 固定为 false。';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function asText(value, max = 4000) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let cleaned = '';
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    cleaned += ch;
  }
  return cleaned.trim().slice(0, max);
}

function clipGraphemes(value, max) {
  const chars = [...asText(value, max * 4)];
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

function boundedNumber(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const item of values) {
    const text = asText(item, 200);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function sanitizeHttpUrl(value) {
  const raw = asText(value, 2000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function hardwareSummary(requirements) {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
    return '设备需求未给出；研究初估，不能当执行门控。';
  }
  const cpu = asText(requirements.cpu, 80) || '未知 CPU';
  const gpu = asText(requirements.gpu, 80) || '未知 GPU';
  const ram = requirements.ram_gib == null ? '未知内存' : `${requirements.ram_gib} GiB 内存`;
  const disk = requirements.disk_mib == null ? '未知磁盘' : `${requirements.disk_mib} MiB 磁盘`;
  return `${cpu} · GPU ${gpu} · ${ram} · ${disk}（研究初估，须按真实素材校准）`;
}

function loadCatalogDocument(input) {
  if (input && typeof input === 'object' && !Array.isArray(input) && (input.options || input.catalog)) {
    return input.options ? input : { options: input.catalog, metadata: input.metadata || {} };
  }
  const catalogPath = typeof input === 'string' && input.trim()
    ? path.resolve(input)
    : DEFAULT_CATALOG_PATH;
  let raw;
  try {
    raw = fs.readFileSync(catalogPath, 'utf8');
  } catch (error) {
    throw fail('CATALOG_UNREADABLE', `无法读取规划选项目录：${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw fail('CATALOG_INVALID', '规划选项目录不是有效 JSON');
  }
}

function resolveOperation(getOperation, knownIds, id) {
  if (knownIds && knownIds.has(id)) {
    const lookedUp = typeof getOperation === 'function' ? getOperation(id) : null;
    if (lookedUp && typeof lookedUp === 'object') return { id, title: lookedUp.title || id, exists: true };
    return { id, title: id, exists: true };
  }
  if (typeof getOperation === 'function') {
    const found = getOperation(id);
    if (found) {
      return { id, title: found.title || id, exists: true };
    }
  }
  return null;
}

function buildSearchText(option) {
  return [
    option.id,
    option.title,
    option.description,
    option.category,
    CATEGORY_LABELS[option.category] || '',
    option.primary_engine,
    option.fallback_route,
    ...(option.dependency_order || []),
    ...(option.existing_module_ids || []),
  ].map((part) => asText(part, 800)).join(' ').toLowerCase().slice(0, SEARCH_TEXT_LIMIT);
}

function normalizeOption(raw, index, getOperation, knownIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = asText(raw.id, 200);
  if (!id) return null;
  const sourceModuleIds = uniqueStrings(raw.existing_module_ids);
  const linked = [];
  const unmatched = [];
  for (const moduleId of sourceModuleIds) {
    const operation = resolveOperation(getOperation, knownIds, moduleId);
    if (operation) linked.push(operation);
    else unmatched.push(moduleId);
  }
  const category = asText(raw.category, 80) || 'uncategorized';
  const title = asText(raw.title, 240) || id;
  const description = asText(raw.description, 2000);
  const option = {
    id,
    source_index: index,
    category,
    category_label: CATEGORY_LABELS[category] || category,
    title,
    description,
    primary_engine: asText(raw.primary_engine, 400),
    fallback_route: asText(raw.fallback_route, 800),
    hardware_requirements: raw.hardware_requirements && typeof raw.hardware_requirements === 'object'
      ? {
        cpu: asText(raw.hardware_requirements.cpu, 80) || null,
        gpu: asText(raw.hardware_requirements.gpu, 80) || null,
        ram_gib: raw.hardware_requirements.ram_gib != null && raw.hardware_requirements.ram_gib !== '' && Number.isFinite(Number(raw.hardware_requirements.ram_gib))
          ? Number(raw.hardware_requirements.ram_gib)
          : null,
        disk_mib: raw.hardware_requirements.disk_mib != null && raw.hardware_requirements.disk_mib !== '' && Number.isFinite(Number(raw.hardware_requirements.disk_mib))
          ? Number(raw.hardware_requirements.disk_mib)
          : null,
      }
      : null,
    license: asText(raw.license, 200),
    status: asText(raw.status, 80) || 'research_candidate',
    install_method: asText(raw.install_method, 400),
    dependency_order: uniqueStrings(raw.dependency_order),
    inputs: raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {},
    outputs: raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {},
    sample_verification: asText(raw.sample_verification, 2000),
    gotchas_and_pitfalls: asText(raw.gotchas_and_pitfalls, 4000),
    engine_availability: asText(raw.engine_availability, 200),
    operation_validation: asText(raw.operation_validation, 80) || 'planned_unverified',
    engine_source_url: sanitizeHttpUrl(raw.engine_source_url),
    engine_docs_url: sanitizeHttpUrl(raw.engine_docs_url),
    baseline_relation: asText(raw.baseline_relation, 120) || 'distinctness_not_yet_verified',
    candidate_platforms: uniqueStrings(raw.candidate_platforms),
    existing_module_ids: linked.map((item) => item.id),
    unmatched_source_module_ids: unmatched,
    linked_operations: linked.map((item) => ({
      module_id: item.id,
      title: item.title,
      exists: true,
      recipe_implemented: false,
      note: RECIPE_NOTE,
    })),
    auto_install_supported: false,
    source_verification: asText(raw.source_verification, 200) || 'cited_research_sources_not_install_receipts',
    evidence_boundary: asText(raw.evidence_boundary, 800)
      || '候选路线，尚非可执行操作；引擎安装不等于配方效果通过。设备需求和验收阈值为初始估计，须按真实素材校准。',
    executable: false,
    recipe_implemented: false,
    planning_only: true,
    availability: 'advisory',
  };
  option.search_text = buildSearchText(option);
  return option;
}

function toSummary(option) {
  return {
    id: option.id,
    category: option.category,
    category_label: option.category_label,
    title: option.title,
    summary: clipGraphemes(option.description, SUMMARY_DESCRIPTION_LIMIT),
    status: option.status,
    availability: 'advisory',
    planning_only: true,
    executable: false,
    recipe_implemented: false,
    auto_install_supported: false,
    primary_engine: clipGraphemes(option.primary_engine, 120),
    fallback_route: clipGraphemes(option.fallback_route, 160),
    existing_module_ids: option.existing_module_ids.slice(),
    linked_operation_count: option.existing_module_ids.length,
    hardware_summary: hardwareSummary(option.hardware_requirements),
    candidate_platforms: option.candidate_platforms.slice(),
    baseline_relation: option.baseline_relation,
  };
}

function toDetail(option) {
  return {
    id: option.id,
    category: option.category,
    category_label: option.category_label,
    title: option.title,
    description: option.description,
    primary_engine: option.primary_engine,
    fallback_route: option.fallback_route,
    hardware_requirements: option.hardware_requirements,
    hardware_summary: hardwareSummary(option.hardware_requirements),
    license: option.license,
    status: option.status,
    install_method: option.install_method,
    dependency_order: option.dependency_order.slice(),
    inputs: option.inputs,
    outputs: option.outputs,
    sample_verification: option.sample_verification,
    gotchas_and_pitfalls: option.gotchas_and_pitfalls,
    engine_availability: option.engine_availability,
    operation_validation: option.operation_validation,
    engine_source_url: option.engine_source_url,
    engine_docs_url: option.engine_docs_url,
    baseline_relation: option.baseline_relation,
    candidate_platforms: option.candidate_platforms.slice(),
    existing_module_ids: option.existing_module_ids.slice(),
    unmatched_source_module_ids: option.unmatched_source_module_ids.slice(),
    linked_operations: option.linked_operations.map((item) => ({ ...item })),
    auto_install_supported: false,
    auto_install_note: AUTO_INSTALL_NOTE,
    source_verification: option.source_verification,
    evidence_boundary: option.evidence_boundary,
    executable: false,
    recipe_implemented: false,
    planning_only: true,
    availability: 'advisory',
    planning_disclaimer: PLANNING_DISCLAIMER,
    recipe_note: option.existing_module_ids.length ? RECIPE_NOTE : '当前没有已确认存在的基础操作可链接。',
  };
}

function matchesQuery(option, query) {
  const terms = asText(query, MAX_QUERY_LENGTH).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return true;
  return terms.every((term) => option.search_text.includes(term));
}

function createMediaToolOptions(settings = {}) {
  const document = loadCatalogDocument(settings.catalog || settings.catalogPath || DEFAULT_CATALOG_PATH);
  const rows = Array.isArray(document.options) ? document.options : [];
  const getOperation = settings.getOperation || null;
  const knownIds = settings.knownOperationIds
    ? new Set([...settings.knownOperationIds].map((id) => asText(id, 200)).filter(Boolean))
    : null;

  const seen = new Set();
  const options = [];
  let duplicateCount = 0;
  rows.forEach((raw, index) => {
    const option = normalizeOption(raw, index, getOperation, knownIds);
    if (!option) return;
    if (seen.has(option.id)) {
      duplicateCount += 1;
      return;
    }
    seen.add(option.id);
    options.push(option);
  });

  const categoryCounts = new Map();
  for (const option of options) {
    categoryCounts.set(option.category, (categoryCounts.get(option.category) || 0) + 1);
  }
  const linkedOptionCount = options.filter((option) => option.existing_module_ids.length).length;

  function catalogInfo() {
    return {
      version: document.version || 1,
      reviewed_at: document.reviewed_at || null,
      source_run: document.source_run || null,
      options_count: options.length,
      categories_count: categoryCounts.size,
      options_reusing_existing_operations: linkedOptionCount,
      new_distinct_executable_operations: 0,
      verified_executable_count: 0,
      duplicate_ids_dropped: duplicateCount,
      purpose: asText(document.metadata?.purpose, 400)
        || '供任务规划检索选择；不把候选、参数配方或不同名称累计成已实测工具。',
      disclaimer: PLANNING_DISCLAIMER,
      auto_install_note: AUTO_INSTALL_NOTE,
    };
  }

  function categories() {
    return [...categoryCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ key, label: CATEGORY_LABELS[key] || key, count }));
  }

  function list(query = {}) {
    const category = asText(query.category, 80);
    const filtered = options.filter((option) => {
      if (category && option.category !== category) return false;
      return matchesQuery(option, query.q);
    });
    const limit = boundedNumber(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = boundedNumber(query.offset, 0, 0, MAX_OFFSET);
    return {
      items: filtered.slice(offset, offset + limit).map(toSummary),
      total: filtered.length,
      limit,
      offset,
      categories: categories(),
      catalog: catalogInfo(),
    };
  }

  function get(id) {
    const key = asText(id, 200);
    if (!key) return null;
    const option = options.find((item) => item.id === key);
    return option ? toDetail(option) : null;
  }

  function requireGet(id) {
    const item = get(id);
    if (!item) throw fail('OPTION_NOT_FOUND', '规划选项不存在');
    return item;
  }

  return {
    list,
    get,
    requireGet,
    categories,
    catalog: catalogInfo,
    size: () => options.length,
  };
}

module.exports = {
  CATEGORY_LABELS,
  DEFAULT_CATALOG_PATH,
  PLANNING_DISCLAIMER,
  RECIPE_NOTE,
  createMediaToolOptions,
  sanitizeHttpUrl,
};
