const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const configPaths = [
  path.join(process.cwd(), 'configs', 'config.yaml'),
  path.join(process.cwd(), 'config.yaml'),
  path.join(__dirname, '..', '..', 'configs', 'config.yaml'),
].filter(Boolean);

function loadConfig() {
  let raw = null;
  // Embedded/local test runtimes may set their isolated config after importing
  // a media utility. Resolve the explicit binding when reading, not at import.
  for (const p of [process.env.YINZI_WORKFLOW_CONFIG, ...configPaths].filter(Boolean)) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, 'utf8');
      break;
    }
  }
  if (!raw) {
    throw new Error('Config file not found: configs/config.yaml');
  }
  const parsed = yaml.load(raw);
  if (!parsed?.app?.name) {
    throw new Error('Invalid config: missing app section');
  }
  return parsed;
}

module.exports = { loadConfig };
