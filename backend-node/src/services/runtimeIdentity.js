const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Runtime identity is deliberately read-only and bounded.  It lets the UI and
// Codex prove they are looking at the same local process without exposing a
// working directory, database path, or credentials.
let cached = null;

function sha256Files(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.basename(file));
    try {
      // Identity must describe the source contents, not filesystem metadata.
      // mtime changes during a checkout/copy and would otherwise create a
      // false split-brain result for byte-identical runtimes.
      hash.update(fs.readFileSync(file));
    } catch (_) {
      hash.update(':missing:');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function fileFingerprint(file) {
  if (!file || file === ':memory:') return 'unknown';
  try {
    // A database fingerprint is an instance identity, not a content version.
    // Hashing the normalized path keeps it stable across normal SQLite writes
    // while still separating independent database files without exposing the
    // path itself in the response.
    const normalized = path.resolve(file).replace(/[\\/]+/g, '/').toLowerCase();
    return crypto.createHash('sha256').update(`database-path:${normalized}`).digest('hex').slice(0, 16);
  } catch (_) { return 'unknown'; }
}

function buildRuntimeIdentity(config, options = {}) {
  if (cached) return { ...cached };
  const root = path.resolve(__dirname, '..', '..');
  const packageFile = path.join(root, 'package.json');
  const sourceFiles = [
    path.join(root, 'src', 'app.js'),
    path.join(root, 'src', 'routes', 'index.js'),
    path.join(root, 'src', 'routes', 'orchestration.js'),
    path.join(root, 'src', 'services', 'orchestrationService.js'),
    path.join(root, 'src', 'services', 'runtimeIdentity.js'),
    packageFile,
  ];
  let packageVersion = config?.app?.version || 'unknown';
  try { packageVersion = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version || packageVersion; } catch (_) {}
  const databasePath = config?.database?.path
    ? (path.isAbsolute(config.database.path) ? config.database.path : path.resolve(process.cwd(), config.database.path))
    : '';
  const identity = {
    schema: 'yinzi.workflow-runtime-identity/v1',
    runtime_id: `yinzi-${crypto.createHash('sha256').update(`${process.pid}:${process.cwd()}`).digest('hex').slice(0, 12)}`,
    app_version: packageVersion,
    source_revision: sha256Files(sourceFiles),
    source_digest: process.env.YINZI_WORKFLOW_SOURCE_DIGEST || null,
    launch_token: process.env.YINZI_WORKFLOW_LAUNCH_TOKEN || null,
    database: {
      label: databasePath ? path.basename(databasePath) : 'unknown',
      fingerprint: fileFingerprint(databasePath),
    },
    orchestration_router: true,
    canonical: options.canonical === true || process.env.YINZI_WORKFLOW_CANONICAL === '1',
    capabilities: ['orchestration', 'production-bridge', 'asset-import', 'audit-export'],
    generated_at: new Date().toISOString(),
  };
  cached = Object.freeze(identity);
  return { ...identity };
}

function clearRuntimeIdentityCache() { cached = null; }

module.exports = {
  buildRuntimeIdentity,
  clearRuntimeIdentityCache,
  // Exported for contract tests only; callers should use buildRuntimeIdentity.
  computeSourceRevision: sha256Files,
  computeDatabaseFingerprint: fileFingerprint,
};
