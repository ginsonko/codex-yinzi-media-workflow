import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseConfigFile, rollback } from './host-config.mjs'

const entry = fileURLToPath(new URL('../install-host.mjs', import.meta.url))
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yinzi grok acceptance '))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}
function invoke(dir, args = []) {
  const result = spawnSync(process.execPath, [entry, '--host', 'grok', '--runtime-dir', path.join(dir, 'runtime'), ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, GROK_HOME: path.join(dir, 'agent home') }
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

test('Grok installs MCP and discoverable skills in GROK_HOME while preserving settings and repeat installs', async t => {
  const dir = await workspace(t), grokRoot = path.join(dir, 'agent home'), config = path.join(grokRoot, 'config.toml')
  await fs.mkdir(grokRoot, { recursive: true })
  const original = '# keep user notes\nmodel = "user-choice"\n[mcp_servers.other]\ncommand = "existing"\n'
  await fs.writeFile(config, original)
  const dry = invoke(dir, ['--dry-run'])
  assert.equal(dry.skills_root, path.join(grokRoot, 'skills'))
  assert.equal(await fs.readFile(config, 'utf8'), original)
  await assert.rejects(fs.access(path.join(grokRoot, 'skills')))
  const first = invoke(dir), installed = await fs.readFile(config, 'utf8')
  const { parsed } = await parseConfigFile(config, 'toml')
  assert.equal(parsed.model, 'user-choice')
  assert.equal(parsed.mcp_servers.other.command, 'existing')
  assert.equal(parsed.mcp_servers.yinzi_video_workflow.command, process.execPath)
  await fs.access(parsed.mcp_servers.yinzi_video_workflow.args[0])
  assert.match(installed, /# keep user notes/)
  await fs.access(path.join(grokRoot, 'skills/codex-yinzi-universal-video/SKILL.md'))
  const second = invoke(dir)
  assert.equal(second.unchanged, true)
  assert.equal(await fs.readFile(config, 'utf8'), installed)
  assert.ok(first.backupPath)
  await rollback(config, first.backupPath)
  assert.equal(await fs.readFile(config, 'utf8'), original)
})

test('Grok explicit config root and skills override take precedence over default GROK_HOME', async t => {
  const dir = await workspace(t), configRoot = path.join(dir, 'desktop agent'), config = path.join(configRoot, 'custom.toml')
  const dry = invoke(dir, ['--config-path', config, '--dry-run'])
  assert.equal(dry.skills_root, path.join(configRoot, 'skills'))
  await assert.rejects(fs.access(config))
  const skills = path.join(dir, 'shared skills')
  const result = invoke(dir, ['--config-path', config, '--skills-root', skills])
  assert.equal(result.skills_root, skills)
  await fs.access(path.join(skills, 'codex-yinzi-universal-video/SKILL.md'))
  await fs.access(config)
  await assert.rejects(fs.access(path.join(dir, 'agent home/config.toml')))
  await assert.rejects(fs.access(path.join(configRoot, 'skills')))
})