/**
 * Test suite for multi-host MCP & Skills adapter
 * Covers:
 * 1. Codex TOML config parsing and serialization
 * 2. CODEX_HOME and --config-path overrides
 * 3. JSONC incremental path edit preserving single-line and block comments
 * 4. JSON URL preservation (https://)
 * 5. Continue array/map container support
 * 6. Cursor descriptor pointing to ~/.cursor/mcp.json without guessing AppData
 * 7. Separate Cline and Roo Code descriptors without path confusion or fallback pollution
 * 8. Zed context_servers structure and explicit export guidance
 * 9. Custom descriptor support for unknown hosts
 * 10. Idempotent install: identical config skips write, differing config preserved without overwrite
 * 11. Atomic writes and timestamped backup/rollback
 * 12. Paths with spaces
 * 13. Corrupted file safety
 * 14. Dynamic project root locator without hardcoded personal user paths
 * 15. Isolated skills installation integration reusing install-skills.mjs rules on isolated copy
 * 16. Verification status taxonomy: config-observed, adapter-tested, not-tested
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  parseConfigFile,
  serializeConfig,
  mergeMcpConfig,
  atomicWrite,
  rollback,
  installMcpServer,
  exportMcpConfig,
  resolveHostDescriptor,
  detectHostConfigStatus,
  locateProjectRoot,
  installSkillsIntegration,
  HOST_DESCRIPTORS
} from './host-config.mjs'

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'host-adapter-test-'))
}

test('Codex descriptor uses config.toml and does not assume a local configuration exists', () => {
  const descriptor = HOST_DESCRIPTORS['codex-cli']
  assert.equal(descriptor.formats[0], 'toml', 'Codex must use TOML')
  assert.equal(descriptor.mcpConfigKey, 'mcp_servers', 'Codex uses mcp_servers table')
  assert.equal(descriptor.verified, 'adapter-tested', 'Codex config is observed on host')

  const defaultPath = descriptor.getConfigPath()
  assert.ok(defaultPath.endsWith('config.toml'), `Expected config.toml, got ${defaultPath}`)
  assert.ok(!defaultPath.endsWith('config.json'), 'Must not use config.json')
})

test('Codex descriptor respects CODEX_HOME environment variable', () => {
  const descriptor = HOST_DESCRIPTORS['codex-cli']
  const original = process.env.CODEX_HOME
  try {
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'custom-codex-home')
    const p = descriptor.getConfigPath()
    assert.ok(p.startsWith(process.env.CODEX_HOME), `Should respect CODEX_HOME, got ${p}`)
    assert.ok(p.endsWith('config.toml'))
  } finally {
    if (original === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = original
  }
})

test('explicit configPath override wins over default path for all hosts', () => {
  for (const [id, descriptor] of Object.entries(HOST_DESCRIPTORS)) {
    const custom = path.join(os.tmpdir(), 'override', 'custom_config.file')
    assert.equal(descriptor.getConfigPath(custom), path.resolve(custom), `${id} should honour override`)
  }
})

test('TOML is parsed structurally and serialized cleanly', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'config.toml')
    await fs.writeFile(p, `model = "gpt-6-astra"

[mcp_servers.ap-vibe]
command = 'python.exe'
args = ['C:\\\\tools\\\\ap_vibe_mcp.py']

[mcp_servers.cua_repl]
command = 'ChatGPT.exe'
enabled = false
`)
    const { parsed } = await parseConfigFile(p, 'toml')
    assert.equal(parsed.model, 'gpt-6-astra')
    assert.ok(parsed.mcp_servers, 'mcp_servers table parsed')
    assert.equal(parsed.mcp_servers['ap-vibe'].command, 'python.exe')
    assert.equal(parsed.mcp_servers.cua_repl.enabled, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('strict JSON rejects comments instead of stripping them', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'strict.json')
    await fs.writeFile(p, '{\n  // comment\n  "mcpServers": {}\n}')
    await assert.rejects(() => parseConfigFile(p, 'json'), /Invalid JSON/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('JSON parser preserves https:// inside strings', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'urls.json')
    await fs.writeFile(p, JSON.stringify({
      mcpServers: {
        web: { env: { API_URL: 'https://api.example.com/v1' } }
      }
    }))
    const { parsed } = await parseConfigFile(p, 'json')
    assert.equal(parsed.mcpServers.web.env.API_URL, 'https://api.example.com/v1')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('JSONC trailing commas are legal and comments are parsed', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'trailing.jsonc')
    await fs.writeFile(p, `{
  // A comment here
  "mcpServers": {
    "a": {"command": "node"},
  },
}`)
    const { parsed } = await parseConfigFile(p, 'jsonc')
    assert.equal(parsed.mcpServers.a.command, 'node')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('JSONC install preserves user comments and https:// URLs via incremental path edit', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'settings.json')
    const original = `{
  // Keep this user comment
  "editor.fontSize": 14,
  /* block comment */
  "mcpServers": {
    "existing": {
      "url": "https://existing.example.com/sse"
    },
  },
}`
    await fs.writeFile(p, original)

    const jsoncHost = {
      name: 'Test JSONC Host',
      formats: ['jsonc'],
      getConfigPath: () => p,
      mcpConfigKey: 'mcpServers',
      containerType: 'map',
      mcpMergeStrategy: 'preserve-existing'
    }

    await installMcpServer({
      customDescriptor: jsoncHost,
      serverName: 'yinzi_video_workflow',
      serverConfig: { command: 'node', args: ['server.mjs'] },
      configPath: p
    })

    const after = await fs.readFile(p, 'utf8')
    assert.ok(after.includes('// Keep this user comment'), 'single-line comment preserved')
    assert.ok(after.includes('/* block comment */'), 'block comment preserved')
    assert.ok(after.includes('https://existing.example.com/sse'), 'URL preserved')
    assert.ok(after.includes('yinzi_video_workflow'), 'new server added')

    const reparsed = await parseConfigFile(p, 'jsonc')
    assert.equal(reparsed.parsed['editor.fontSize'], 14, 'unrelated user setting preserved')
    assert.equal(reparsed.parsed.mcpServers.yinzi_video_workflow.command, 'node')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('TOML install preserves top-level comments and existing tables', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'config.toml')
    const original = `# Codex CLI Global Configuration
# Keep this important comment!
model = "gpt-6-astra"

[mcp_servers.existing]
command = "python.exe"
args = ["tools/existing.py"]
`
    await fs.writeFile(p, original)

    await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi_workflow',
      serverConfig: { command: 'node', args: ['server.mjs'] },
      configPath: p
    })

    const after = await fs.readFile(p, 'utf8')
    assert.ok(after.includes('# Codex CLI Global Configuration'), 'header comment preserved')
    assert.ok(after.includes('# Keep this important comment!'), 'comment preserved')
    assert.ok(after.includes('model = "gpt-6-astra"'), 'top-level setting preserved')
    assert.ok(after.includes('[mcp_servers.existing]'), 'existing table preserved')
    assert.ok(after.includes('[mcp_servers.yinzi_workflow]'), 'new table added')

    const reparsed = await parseConfigFile(p, 'toml')
    assert.equal(reparsed.parsed.model, 'gpt-6-astra')
    assert.equal(reparsed.parsed.mcp_servers.existing.command, 'python.exe')
    assert.equal(reparsed.parsed.mcp_servers.yinzi_workflow.command, 'node')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('Cursor descriptor points to ~/.cursor/mcp.json and does not write to settings.json', () => {
  const descriptor = HOST_DESCRIPTORS['cursor']
  const p = descriptor.getConfigPath()
  assert.ok(p.includes('.cursor') && p.endsWith('mcp.json'), `Expected .cursor/mcp.json, got ${p}`)
  assert.equal(descriptor.fallbackConfigPath, undefined, 'Cursor must not define deceptive fallback path')
})

test('Cline descriptor points to saoudrizwan.claude-dev storage without fallback', () => {
  const descriptor = HOST_DESCRIPTORS['cline']
  const p = descriptor.getConfigPath()
  assert.ok(p.includes('saoudrizwan.claude-dev') && p.endsWith('cline_mcp_settings.json'), `Expected saoudrizwan cline path, got ${p}`)
  assert.equal(descriptor.fallbackConfigPath, undefined, 'Cline must not fallback to global VS Code settings.json')
  assert.equal(descriptor.verified, 'adapter-tested')
})

test('Roo Code descriptor is separate and points to rooveterinaryinc.roo-cline storage', () => {
  const descriptor = HOST_DESCRIPTORS['roo-code']
  assert.ok(descriptor, 'Roo Code descriptor exists')
  const p = descriptor.getConfigPath()
  assert.ok(p.includes('rooveterinaryinc.roo-cline') && p.endsWith('mcp_settings.json'), `Expected roo-cline path, got ${p}`)
  assert.equal(descriptor.fallbackConfigPath, undefined, 'Roo Code must not fallback to global VS Code settings.json')
  assert.equal(descriptor.verified, 'adapter-tested', 'Roo Code storage is observed on this machine')
})

test('Custom legacy array descriptor preserves sibling settings', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'continue.json')
    const original = {
      models: [],
      experimental: {
        otherFlag: true,
        modelContextProtocolServers: [
          {
            name: 'existing_server',
            transport: { type: 'stdio', command: 'python' }
          }
        ]
      }
    }
    await fs.writeFile(p, JSON.stringify(original, null, 2))

    await installMcpServer({
      customDescriptor: {name:'Legacy array',formats:['json'],mcpConfigKey:'experimental.modelContextProtocolServers'},
      serverName: 'yinzi_workflow',
      serverConfig: { command: 'node', args: ['server.mjs'] },
      configPath: p
    })

    const { parsed } = await parseConfigFile(p, 'json')
    assert.ok(Array.isArray(parsed.experimental.modelContextProtocolServers), 'must remain an array')
    assert.equal(parsed.experimental.modelContextProtocolServers.length, 2)
    assert.equal(parsed.experimental.modelContextProtocolServers[0].name, 'existing_server')
    assert.equal(parsed.experimental.modelContextProtocolServers[1].name, 'yinzi_workflow')
    assert.equal(parsed.experimental.otherFlag, true, 'sibling flag preserved')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('Zed descriptor uses context_servers key and export provides notice', async () => {
  const descriptor = HOST_DESCRIPTORS['zed']
  assert.equal(descriptor.mcpConfigKey, 'context_servers')
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'zed-settings.json')
    await fs.writeFile(p, JSON.stringify({ theme: 'One Dark' }, null, 2))

    await installMcpServer({
      hostId: 'zed',
      serverName: 'yinzi_video',
      serverConfig: { command: 'node', args: ['server.mjs'] },
      configPath: p
    })

    const { parsed } = await parseConfigFile(p, 'json')
    assert.equal(parsed.theme, 'One Dark')
    assert.ok(parsed.context_servers.yinzi_video)
    assert.equal(parsed.context_servers.yinzi_video.command, 'node')

    const exp = exportMcpConfig({
      hostId: 'zed',
      serverName: 'yinzi_video',
      serverConfig: { command: 'node', args: ['server.mjs'] }
    })
    assert.ok(exp.mergeInstructions.includes('context_servers'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('Custom descriptor works for unknown hosts without hardcoded guessing', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'unknown-agent.json')
    await fs.writeFile(p, JSON.stringify({ customRoot: {} }, null, 2))

    const customHost = {
      name: 'My Custom Agent',
      formats: ['json'],
      getConfigPath: () => p,
      mcpConfigKey: 'customRoot.plugins.mcp',
      containerType: 'map',
      mcpMergeStrategy: 'preserve-existing'
    }

    const result = await installMcpServer({
      customDescriptor: customHost,
      serverName: 'custom_service',
      serverConfig: { command: 'deno', args: ['run', 'main.ts'] },
      configPath: p
    })

    assert.equal(result.ok, true)
    assert.equal(result.hostName, 'My Custom Agent')

    const { parsed } = await parseConfigFile(p, 'json')
    assert.equal(parsed.customRoot.plugins.mcp.custom_service.command, 'deno')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('fresh install writes file and reports isNewFile', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'fresh.toml')
    const result = await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi',
      serverConfig: { command: 'node' },
      configPath: p
    })
    assert.equal(result.ok, true)
    assert.equal(result.isNewFile, true)
    assert.equal(result.changed, true)

    const exists = await fs.access(p).then(() => true).catch(() => false)
    assert.equal(exists, true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('second identical install does not write the file (idempotent)', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'idempotent.toml')
    await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi',
      serverConfig: { command: 'node', args: ['a.js'] },
      configPath: p
    })

    const statBefore = await fs.stat(p)
    await new Promise(r => setTimeout(r, 20))

    const result2 = await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi',
      serverConfig: { command: 'node', args: ['a.js'] },
      configPath: p
    })

    assert.equal(result2.ok, true)
    assert.equal(result2.unchanged, true, 'must be marked unchanged')
    assert.equal(result2.changed, false, 'must not report changed')

    const statAfter = await fs.stat(p)
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'disk file was untouched')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('same-name differing config is preserved, not overwritten, and conflict flagged', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'conflict.toml')
    await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi',
      serverConfig: { command: 'python', args: ['old.py'] },
      configPath: p
    })

    const statA = await fs.stat(p)
    await new Promise(r => setTimeout(r, 20))

    const result = await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi',
      serverConfig: { command: 'node', args: ['new.js'] },
      configPath: p
    })

    assert.equal(result.ok, true)
    assert.equal(result.conflict, true, 'conflict must be flagged')
    assert.equal(result.conflictWithDiff, true, 'conflict with diff flagged')
    assert.equal(result.changed, false, 'no change on conflict')
    assert.equal(result.unchanged, true)

    const statB = await fs.stat(p)
    assert.equal(statA.mtimeMs, statB.mtimeMs, 'file untouched on conflict')

    const { parsed } = await parseConfigFile(p, 'toml')
    assert.equal(parsed.mcp_servers.yinzi.command, 'python', 'user config preserved')
    assert.deepEqual(parsed.mcp_servers.yinzi.args, ['old.py'], 'user args preserved')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('truly corrupted input is rejected and left untouched', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'broken.json')
    const broken = '{"mcpServers": {invalid'
    await fs.writeFile(p, broken)

    await assert.rejects(
      () => installMcpServer({
        hostId: 'claude-desktop',
        serverName: 'x',
        serverConfig: { command: 'node' },
        configPath: p
      }),
      /Invalid JSON/
    )

    assert.equal(await fs.readFile(p, 'utf8'), broken, 'corrupted file not overwritten')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('atomic write creates backup and rollback restores original', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'rollback.toml')
    const original = '[mcp_servers.orig]\ncommand = "node"\n'
    await fs.writeFile(p, original)

    const { backupPath } = await atomicWrite(p, '[mcp_servers.mod]\ncommand = "python"\n', true)
    assert.ok(backupPath, 'backup path returned')
    assert.equal(await fs.readFile(backupPath, 'utf8'), original, 'backup holds original')

    await rollback(p, backupPath)
    assert.equal(await fs.readFile(p, 'utf8'), original, 'file rolled back')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('paths containing spaces work end to end', async () => {
  const dir = await makeTempDir()
  try {
    const spaced = path.join(dir, 'dir with spaces', 'my config.toml')
    const result = await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi',
      serverConfig: { command: 'node', args: ['C:\\Program Files\\app\\server.mjs'] },
      configPath: spaced
    })
    assert.equal(result.ok, true)
    assert.ok(result.configPath.includes('dir with spaces'))

    const { parsed } = await parseConfigFile(spaced, 'toml')
    assert.equal(parsed.mcp_servers.yinzi.args[0], 'C:\\Program Files\\app\\server.mjs')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dry run makes no changes', async () => {
  const dir = await makeTempDir()
  try {
    const p = path.join(dir, 'dryrun.toml')
    const result = await installMcpServer({
      hostId: 'codex-cli',
      serverName: 'yinzi',
      serverConfig: { command: 'node' },
      configPath: p,
      dryRun: true
    })
    assert.equal(result.dryRun, true)
    assert.equal(result.isNewFile, true)

    let exists = true
    try { await fs.access(p) } catch { exists = false }
    assert.equal(exists, false, 'dry run must not create file')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('export produces snippet in the host native format', () => {
  const tomlExport = exportMcpConfig({
    hostId: 'codex-cli',
    serverName: 'yinzi',
    serverConfig: { command: 'node', args: ['server.mjs'] }
  })
  assert.equal(tomlExport.format, 'toml')
  assert.ok(tomlExport.configSnippet.includes('[mcp_servers.yinzi]'),
    `expected TOML table header, got: ${tomlExport.configSnippet}`)

  const jsonExport = exportMcpConfig({
    hostId: 'claude-desktop',
    serverName: 'yinzi',
    serverConfig: { command: 'node' }
  })
  const parsed = JSON.parse(jsonExport.configSnippet)
  assert.equal(parsed.mcpServers.yinzi.command, 'node')
})

test('verified status taxonomy distinguishes config-observed from adapter-tested and not-tested', () => {
  assert.equal(HOST_DESCRIPTORS['codex-cli'].verified, 'adapter-tested')
  assert.equal(HOST_DESCRIPTORS['roo-code'].verified, 'adapter-tested')
  assert.equal(HOST_DESCRIPTORS['cline'].verified, 'adapter-tested')
  assert.equal(HOST_DESCRIPTORS['cursor'].verified, 'adapter-tested')
  assert.equal(HOST_DESCRIPTORS['continue'].verified, 'adapter-tested')
  assert.equal(HOST_DESCRIPTORS['zed'].verified, 'adapter-tested')
  assert.equal(HOST_DESCRIPTORS['claude-desktop'].verified, 'not-tested')
})

test('locateProjectRoot finds real repository root dynamically without personal path', async () => {
  const root = locateProjectRoot()
  assert.ok(root, 'Project root must be found dynamically')
  const expectedRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
  assert.equal(await fs.realpath(root), await fs.realpath(expectedRoot))
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'backend-node', 'package.json'), 'utf8'))
  assert.ok(manifest.name, 'Located root must contain the backend package')
})

test('isolated skills installation integration succeeds on temporary mock repo copy', async () => {
  const dir = await makeTempDir()
  const mockRepo = path.join(dir, 'mock-repo')
  const pluginDir = path.join(mockRepo, 'codex-yinzi-universal-video-workflow', 'plugins', 'codex-yinzi-universal-video-workflow')
  await fs.mkdir(path.join(pluginDir, 'scripts'), { recursive: true })
  await fs.mkdir(path.join(pluginDir, 'skills', 'mock-skill-a'), { recursive: true })
  await fs.writeFile(path.join(pluginDir, 'skills', 'mock-skill-a', 'SKILL.md'), '# Mock Skill A\n')

  const realProjectRoot = locateProjectRoot()
  assert.ok(realProjectRoot, 'real project root must exist for copying scripts')
  const realScriptsDir = path.join(realProjectRoot, 'codex-yinzi-universal-video-workflow', 'plugins', 'codex-yinzi-universal-video-workflow', 'scripts')

  for (const f of await fs.readdir(realScriptsDir, { withFileTypes: true })) {
    if (f.isFile()) await fs.copyFile(path.join(realScriptsDir, f.name), path.join(pluginDir, 'scripts', f.name))
  }

  const customSkills = path.join(dir, 'isolated-skills')
  const customCodex = path.join(dir, 'isolated-codex')
  const customRuntime = path.join(dir, 'isolated-runtime')

  try {
    const receipt = await installSkillsIntegration({
      projectRoot: mockRepo,
      skillsRoots: [customSkills],
      codexHome: customCodex,
      runtimeDir: customRuntime
    })

    assert.equal(receipt.ok, true, 'Skills install receipt ok')
    assert.ok(receipt.links?.length >= 1, 'At least 1 skill linked')

    const installedSkills = await fs.readdir(customSkills)
    assert.ok(installedSkills.includes('mock-skill-a'), 'mock-skill-a skill linked')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
