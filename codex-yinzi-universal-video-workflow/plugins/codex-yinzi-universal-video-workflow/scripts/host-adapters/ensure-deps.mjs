import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))

export function findNpmCli(env = process.env) {
  const dirs = [path.dirname(process.execPath), ...(env.PATH || '').split(path.delimiter)].filter(Boolean)
  const candidates = [env.npm_execpath, ...dirs.flatMap(dir => [
    path.join(dir, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(dir, '../lib/node_modules/npm/bin/npm-cli.js'),
    path.resolve(dir, '../share/nodejs/npm/bin/npm-cli.js'),
  ])].filter(Boolean)
  for (const file of candidates) if (fs.existsSync(file) && /npm-cli\.js$/i.test(file)) return file
  throw Object.assign(new Error('npm CLI not found beside Node or on PATH. Install Node with npm, then retry the same host command.'), { code: 'HOST_NPM_MISSING' })
}

export function ensureDependencies({ quiet = false, directory = here } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
  const required = Object.entries(lock.packages).filter(([name]) => name.startsWith('node_modules/'))
  const ready = () => required.every(([name, entry]) => {
    try {
      const installed = JSON.parse(fs.readFileSync(path.join(directory, name, 'package.json'), 'utf8'))
      return installed.version === entry.version && fs.existsSync(path.join(directory, name, installed.main || 'index.js'))
    } catch { return false }
  })
  if (ready()) return { ok: true, installed: false }
  if (!quiet) process.stderr.write('Preparing MCP host adapter dependencies…\n')
  const result = spawnSync(process.execPath, [findNpmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0 || !ready()) throw Object.assign(new Error(
    'Host dependencies were not installed; configuration has not been written. Retry the same command. '
      + (result.error?.message || result.stderr || 'Installed versions differ from the lockfile.').slice(-1500)
  ), { code: 'HOST_DEPENDENCY_INSTALL_FAILED' })
  return { ok: true, installed: true }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(ensureDependencies())) }
  catch (error) { console.error(error.code + ': ' + error.message); process.exitCode = 1 }
}