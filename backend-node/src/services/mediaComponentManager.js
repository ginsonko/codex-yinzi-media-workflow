const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');

const execFileAsync = promisify(execFile);
const COMPONENT_ROOT = path.resolve(process.env.YINZI_WORKFLOW_COMPONENT_DIR || path.join(process.cwd(), 'data', 'media-components'));
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const ALLOWED_HOSTS = new Set((process.env.YINZI_COMPONENT_HOSTS || 'github.com,raw.githubusercontent.com,objects.githubusercontent.com').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));

function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z][a-z0-9.-]{1,99}$/.test(id)) throw new Error('组件编号无效');
  return id;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject); stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function machineProfile() {
  const total = os.totalmem();
  return {
    platform: process.platform,
    arch: process.arch,
    cpu_count: os.cpus().length,
    memory_gib: Math.round(total / 1024 ** 3 * 10) / 10,
    gpu: process.env.YINZI_GPU || 'unknown',
    acceleration: process.env.YINZI_ACCELERATION || 'cpu',
  };
}

function validateManifest(input = {}) {
  const id = safeId(input.component_id);
  const version = String(input.version || '').trim();
  const url = String(input.url || '').trim();
  const sha = String(input.sha256 || '').trim().toLowerCase();
  if (!version || !/^https:\/\//i.test(url) || !/^[a-f0-9]{64}$/.test(sha)) throw new Error('组件清单必须包含版本、HTTPS 地址和 SHA-256');
  if (!ALLOWED_HOSTS.has(new URL(url).hostname.toLowerCase())) throw new Error('组件来源不在受信清单');
  const size = Number(input.size_bytes);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD_BYTES) throw new Error('组件大小超出允许范围');
  const healthcheck = input.healthcheck && typeof input.healthcheck === 'object' ? input.healthcheck : null;
  if (!healthcheck || !String(healthcheck.executable || '').trim()) throw new Error('组件必须配置本地健康检查');
  return { component_id: id, version, url, sha256: sha, size_bytes: size, archive: String(input.archive || 'zip'), healthcheck: { executable: String(healthcheck.executable), args: Array.isArray(healthcheck.args) ? healthcheck.args.map(String) : [], expected: String(healthcheck.expected || '') }, description: String(input.description || '').slice(0, 1000) };
}

function componentPath(id) { return path.join(COMPONENT_ROOT, safeId(id)); }
function statePath(id) { return path.join(componentPath(id), 'component.json'); }
function readState(id) { try { return JSON.parse(fs.readFileSync(statePath(id), 'utf8')); } catch (_) { return null; } }

async function download(url, target, expectedSize) {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`组件下载失败 HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > MAX_DOWNLOAD_BYTES) throw new Error('组件下载大小超限');
  let bytes = 0;
  const limited = Readable.fromWeb(response.body).on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_DOWNLOAD_BYTES || (expectedSize && bytes > expectedSize)) limited.destroy(new Error('组件下载大小与清单不符')); });
  await pipeline(limited, fs.createWriteStream(target));
  if (expectedSize && bytes !== expectedSize) throw new Error('组件下载大小与清单不符');
}

async function ensureComponent(manifestInput, onProgress = () => {}) {
  const manifest = validateManifest(manifestInput);
  const dir = componentPath(manifest.component_id);
  const current = readState(manifest.component_id);
  if (current?.status === 'ready' && current.sha256 === manifest.sha256) return { ...current, reused: true, machine: machineProfile() };
  fs.mkdirSync(COMPONENT_ROOT, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(COMPONENT_ROOT, '.install-'));
  const archive = path.join(tempDir, 'component.archive');
  try {
    onProgress({ stage: 'download', progress: 0, component_id: manifest.component_id });
    await download(manifest.url, archive, manifest.size_bytes);
    onProgress({ stage: 'verify', progress: 60, component_id: manifest.component_id });
    const actual = await sha256(archive);
    if (actual !== manifest.sha256) throw new Error('组件 SHA-256 校验失败');
    onProgress({ stage: 'install', progress: 75, component_id: manifest.component_id });
    const next = path.join(tempDir, 'payload'); fs.mkdirSync(next);
    if (manifest.archive !== 'zip') throw new Error('暂只允许 ZIP 组件包');
    const zip = new AdmZip(archive);
    let unpackedBytes = 0;
    for (const entry of zip.getEntries()) {
      unpackedBytes += entry.header.size;
      if (unpackedBytes > MAX_DOWNLOAD_BYTES * 3) throw new Error('组件解压大小超限');
      const name = String(entry.entryName || '').replaceAll('\\', '/');
      if (!name || name.startsWith('/') || name.includes('../') || /^[a-zA-Z]:/.test(name)) throw new Error('组件包包含不安全路径');
      const target = path.resolve(next, name);
      if (path.dirname(target) !== next && !target.startsWith(next + path.sep)) throw new Error('组件包路径越界');
      if (entry.isDirectory) fs.mkdirSync(target, { recursive: true });
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, entry.getData()); }
    }
    fs.writeFileSync(path.join(next, 'component.manifest.json'), JSON.stringify(manifest, null, 2));
    onProgress({ stage: 'healthcheck', progress: 90, component_id: manifest.component_id });
    const executable = path.resolve(next, manifest.healthcheck.executable);
    if (!executable.startsWith(next + path.sep) || !fs.existsSync(executable)) throw new Error('组件健康检查文件不存在或越界');
    const probe = await execFileAsync(executable, manifest.healthcheck.args, { cwd: next, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (manifest.healthcheck.expected && !String(probe.stdout).includes(manifest.healthcheck.expected)) throw new Error('组件健康检查未返回预期结果');
    const previous = dir + '.previous';
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, previous);
    fs.renameSync(next, dir);
    const state = { ...manifest, status: 'ready', installed_at: new Date().toISOString(), machine: machineProfile(), healthcheck_result: 'passed', artifact: path.join(dir, 'component.manifest.json') };
    fs.writeFileSync(statePath(manifest.component_id), JSON.stringify(state, null, 2));
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true, force: true });
    onProgress({ stage: 'complete', progress: 100, component_id: manifest.component_id });
    return state;
  } catch (error) {
    if (fs.existsSync(dir + '.previous') && !fs.existsSync(dir)) fs.renameSync(dir + '.previous', dir);
    throw error;
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

module.exports = { validateManifest, machineProfile, ensureComponent, readState, sha256 };
