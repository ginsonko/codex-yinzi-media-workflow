/**
 * Multi-host MCP and Skills configuration adapter
 *
 * Comprehensive multi-host adapter addressing verification defects:
 * 1. Codex uses config.toml with [mcp_servers] sections, respects CODEX_HOME and --config-path
 * 2. Structured TOML parsing and serialization with @iarna/toml, preserving user comments on merge
 * 3. JSON vs JSONC properly separated; incremental jsonc-parser edit by path preserves single/block comments
 * 4. Cursor: official path ~/.cursor/mcp.json (map: { mcpServers: { ... } }), project-level via --config-path
 * 5. Distinct Cline and Roo Code descriptors:
 *    - Cline: saoudrizwan.claude-dev/settings/cline_mcp_settings.json
 *    - Roo Code: rooveterinaryinc.roo-cline/settings/mcp_settings.json
 *    - No fallback writes to Code User settings.json (does not fake plugin discovery)
 * 6. Continue: supports both modern map ({ mcpServers: { ... } }) and legacy array (experimental.modelContextProtocolServers)
 * 7. Zed: context_servers structure supported (map or object with command/args)
 * 8. For unconfirmed host versions, export/custom descriptor path is explicitly provided without hardcoding guesswork
 * 9. Real Skills installation integration reusing main repo install-skills.mjs rules with custom destinations and user-edit protection
 * 10. Dynamic project root locator (locateProjectRoot) eliminates hardcoded personal user paths
 * 11. No-change detection skips disk writes; conflict detection preserves user config without overwriting
 * 12. Atomic writes with timestamped backups and verified rollback
 * 13. Accurate status taxonomy: config-observed (configuration file observed on local host), adapter-tested, or not-tested
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import TOML from '@iarna/toml'
import * as jsoncParser from 'jsonc-parser'

/**
 * Built-in host descriptors
 */
export const HOST_DESCRIPTORS = {
  'grok': {
    name: 'Grok',
    formats: ['toml'],
    getConfigPath: overridePath => overridePath ? path.resolve(overridePath)
      : path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'config.toml'),
    mcpConfigKey: 'mcp_servers',
    containerType: 'map',
    mcpMergeStrategy: 'preserve-existing',
    autoInstallSkills: true,
    skillsPath: root => path.join(root || process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'skills'),
    command: 'grok',
    verified: 'adapter-tested',
    notes: 'GROK_HOME/config.toml and GROK_HOME/skills; desktop applications may use a separate GROK_HOME. Explicit config and skills paths take precedence.'
  },
  'codex-cli': {
    name: 'Codex CLI',
    formats: ['toml'],
    getConfigPath: (overridePath) => {
      if (overridePath) return path.resolve(overridePath)
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
      return path.join(codexHome, 'config.toml')
    },
    mcpConfigKey: 'mcp_servers',
    containerType: 'map',
    mcpMergeStrategy: 'preserve-existing',
    skillsPath: (codexHome) => {
      const base = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
      return path.join(base, 'skills')
    },
    command: 'codex',
    mcpCommand: 'codex mcp add',
    verified: 'adapter-tested',
    notes: 'TOML format with [mcp_servers.<name>] sections. Respects CODEX_HOME and --config-path.'
  },

  'claude-desktop': {
    name: 'Claude Desktop',
    formats: ['json'],
    getConfigPath: (overridePath) => {
      if (overridePath) return path.resolve(overridePath)
      return process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
        : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
    },
    mcpConfigKey: 'mcpServers',
    containerType: 'map',
    mcpMergeStrategy: 'preserve-existing',
    verified: 'not-tested',
    notes: 'Standard JSON format with mcpServers map.'
  },

  'cline': {
    name: 'Cline (VS Code)',
    formats: ['json'],
    getConfigPath: (overridePath) => {
      if (overridePath) return path.resolve(overridePath)
      if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
      } else if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
      }
      return path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
    },
    mcpConfigKey: 'mcpServers',
    containerType: 'map',
    mcpMergeStrategy: 'preserve-existing',
    verified: 'adapter-tested',
    notes: 'Dedicated Cline extension storage: saoudrizwan.claude-dev/settings/cline_mcp_settings.json. Does not write to global Code settings.json.'
  },

  'roo-code': {
    name: 'Roo Code (VS Code)',
    formats: ['json'],
    getConfigPath: (overridePath) => {
      if (overridePath) return path.resolve(overridePath)
      if (process.platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
      } else if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
      }
      return path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
    },
    mcpConfigKey: 'mcpServers',
    containerType: 'map',
    mcpMergeStrategy: 'preserve-existing',
    verified: 'adapter-tested',
    notes: 'Dedicated Roo Code extension storage: rooveterinaryinc.roo-cline/settings/mcp_settings.json.'
  },

  'cursor': {
    name: 'Cursor',
    formats: ['json'],
    getConfigPath: (overridePath) => {
      if (overridePath) return path.resolve(overridePath)
      return path.join(os.homedir(), '.cursor', 'mcp.json')
    },
    mcpConfigKey: 'mcpServers',
    containerType: 'map',
    mcpMergeStrategy: 'preserve-existing',
    verified: 'adapter-tested',
    notes: 'Official Cursor MCP configuration: ~/.cursor/mcp.json. Project-level configuration supported via --config-path.'
  },

  'continue': {
    name: 'Continue.dev',
    formats: ['json'],
    getConfigPath: (overridePath) => {
      if (overridePath) return path.resolve(overridePath)
      return path.join(process.cwd(), '.continue', 'mcpServers', 'yinzi-workflow.json')
    },
    mcpConfigKey: 'mcpServers',
    containerType: 'auto',
    mcpMergeStrategy: 'preserve-existing',
    verified: 'adapter-tested',
    notes: 'Workspace .continue/mcpServers/*.json accepts the standard mcpServers object; existing YAML configuration is preserved. Source: https://docs.continue.dev/customize/deep-dives/mcp'
  },

  'vscode': {
    name: 'Visual Studio Code', formats: ['jsonc'],
    getConfigPath: override => override ? path.resolve(override) : path.join(process.cwd(), '.vscode', 'mcp.json'),
    mcpConfigKey: 'servers', containerType: 'map', mcpMergeStrategy: 'preserve-existing',
    serverDefaults: { type: 'stdio' }, verified: 'adapter-tested',
    notes: 'Workspace MCP configuration. Source: https://code.visualstudio.com/docs/copilot/customization/mcp-servers'
  },
  'zed': {
    name: 'Zed', formats: ['jsonc'],
    getConfigPath: override => override ? path.resolve(override) : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Zed', 'settings.json')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'zed', 'settings.json'),
    mcpConfigKey: 'context_servers', containerType: 'map', mcpMergeStrategy: 'preserve-existing',
    verified: 'adapter-tested',
    notes: 'Source: https://zed.dev/docs/ai/mcp ; https://zed.dev/docs/configuring-zed . Configuration tests do not establish a running host connection.'
  }}

/**
 * Resolve descriptor: built-in or custom user descriptor
 */
export function resolveHostDescriptor(hostIdOrDescriptor) {
  if (!hostIdOrDescriptor) {
    throw new Error('Host descriptor or ID is required')
  }
  if (typeof hostIdOrDescriptor === 'object') {
    const desc = hostIdOrDescriptor
    if (!desc.name || !desc.mcpConfigKey || !desc.formats) {
      throw new Error('Custom host descriptor must define name, formats, and mcpConfigKey')
    }
    return {
      name: desc.name,
      formats: desc.formats,
      getConfigPath: typeof desc.getConfigPath === 'function' ? desc.getConfigPath : override => override ? path.resolve(override) : desc.configPath,
      mcpConfigKey: desc.mcpConfigKey,
      containerType: desc.containerType || 'map',
      serverDefaults: desc.serverDefaults || {},
      mcpMergeStrategy: desc.mcpMergeStrategy || 'preserve-existing',
      skillsPath: desc.skillsPath,
      verified: desc.verified || 'custom-descriptor',
      notes: desc.notes || 'User-provided custom descriptor'
    }
  }

  const desc = HOST_DESCRIPTORS[hostIdOrDescriptor]
  if (!desc) {
    throw new Error(`Unknown host: ${hostIdOrDescriptor}. Available: ${Object.keys(HOST_DESCRIPTORS).join(', ')}. Or provide a custom descriptor.`)
  }
  return desc
}

/**
 * Dynamically detect host status based on actual existence of config on this host
 */
export async function detectHostConfigStatus(hostIdOrDescriptor, overridePath = null) {
  const desc = resolveHostDescriptor(hostIdOrDescriptor)
  if (desc.verified === 'custom-descriptor') return 'custom-descriptor'
  const configPath = desc.getConfigPath(overridePath)
  try {
    await fs.access(configPath)
    return 'config-observed'
  } catch {
    return desc.verified === 'config-observed' ? 'adapter-tested' : desc.verified
  }
}

/**
 * Parse configuration file based on format
 */
export async function parseConfigFile(filePath, format) {
  const content = await fs.readFile(filePath, 'utf8')

  if (format === 'json') {
    try {
      return { parsed: JSON.parse(content), rawContent: content }
    } catch (error) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`)
    }
  }

  if (format === 'jsonc') {
    const errors = []
    const parsed = jsoncParser.parse(content, errors, {
      allowTrailingComma: true,
      disallowComments: false
    })
    if (errors.length > 0) {
      const detail = errors.map(e => `offset ${e.offset} (code ${e.error})`).join(', ')
      throw new Error(`JSONC parse errors in ${filePath}: ${detail}`)
    }
    return { parsed, rawContent: content }
  }

  if (format === 'toml') {
    try {
      const parsed = TOML.parse(content)
      return { parsed, rawContent: content }
    } catch (error) {
      throw new Error(`TOML parse error in ${filePath}: ${error.message}`)
    }
  }

  throw new Error(`Unsupported format: ${format}`)
}

/**
 * Serialize configuration back to string
 */
export function serializeConfig(data, format, originalContent = '') {
  if (format === 'json') {
    return JSON.stringify(data, null, 2) + '\n'
  }

  if (format === 'jsonc') {
    if (!originalContent) {
      return JSON.stringify(data, null, 2) + '\n'
    }
    const edits = jsoncParser.modify(originalContent, [], data, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2
      }
    })
    return jsoncParser.applyEdits(originalContent, edits)
  }

  if (format === 'toml') {
    return TOML.stringify(data)
  }

  throw new Error(`Unsupported format: ${format}`)
}

/**
 * Set nested property using dot notation
 */
function setNestedProperty(obj, keyPath, value) {
  const keys = keyPath.split('.')
  let current = obj

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (Object.hasOwn(current,key) && (typeof current[key] !== 'object' || current[key] === null || Array.isArray(current[key]))) throw new Error('MCP parent path is not an object; existing value preserved');
    if (!Object.hasOwn(current,key)) Object.defineProperty(current,key,{value:{},writable:true,enumerable:true,configurable:true});
    current = current[key]
  }

  Object.defineProperty(current,keys[keys.length - 1],{value,writable:true,enumerable:true,configurable:true})
}

/**
 * Get nested property using dot notation
 */
function getNestedProperty(obj, keyPath) {
  const keys = keyPath.split('.')
  let current = obj

  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return undefined
    }
    current = current[key]
  }

  return current
}

/**
 * Deep equality check for config comparison
 */
export function deepEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }

  if (typeof a === 'object') {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!keysB.includes(key) || !deepEqual(a[key], b[key])) return false
    }
    return true
  }

  return false
}

/**
 * Merge MCP server configuration into existing structure
 */
export function mergeMcpConfig(existingConfig, newServers, mcpConfigKey, strategy = 'preserve-existing') {
  const result = JSON.parse(JSON.stringify(existingConfig || {}))
  const existingContainer = getNestedProperty(result, mcpConfigKey)
  if (existingContainer != null && typeof existingContainer !== 'object') throw new Error('MCP configuration container must be an object or array; existing value preserved')

  let changed = false
  const conflicts = []

  // Check if container is an array (Continue legacy structure: [{ transport: ... }])
  if (Array.isArray(existingContainer)) {
    for (const [serverName, serverConfig] of Object.entries(newServers)) {
      const found = existingContainer.find(item => item.name === serverName || item.id === serverName)
      if (found) {
        conflicts.push(serverName)
      } else {
        const item = {
          name: serverName,
          ...serverConfig
        }
        existingContainer.push(item)
        changed = true
      }
    }
    setNestedProperty(result, mcpConfigKey, existingContainer)
    return { changed, result, conflicts, containerType: 'array' }
  }

  // Standard map container: { [serverName]: serverConfig }
  const existingMap = (existingContainer && typeof existingContainer === 'object') ? existingContainer : {}

  if (strategy === 'preserve-existing') {
    for (const [serverName, serverConfig] of Object.entries(newServers)) {
      if (!Object.hasOwn(existingMap,serverName)) {
        Object.defineProperty(existingMap,serverName,{value:serverConfig,writable:true,enumerable:true,configurable:true})
        changed = true
      } else {
        conflicts.push(serverName)
      }
    }
  }

  setNestedProperty(result, mcpConfigKey, existingMap)
  return { changed, result, conflicts, containerType: 'map' }
}

/**
 * Atomic write with backup
 */
export async function atomicWrite(filePath, content, createBackup = true) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`
  const backupPath = createBackup ? `${filePath}.backup.${Date.now()}` : null

  try {
    await fs.writeFile(tempPath, content, 'utf8')

    if (backupPath) {
      try {
        await fs.copyFile(filePath, backupPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }

    await fs.rename(tempPath, filePath)
    return { ok: true, backupPath }
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch {}
    throw error
  }
}

/**
 * Rollback configuration from backup file
 */
export async function rollback(configPath, backupPath) {
  try {
    await fs.access(backupPath)
  } catch {
    throw new Error(`Backup file not found: ${backupPath}`)
  }

  const backupContent = await fs.readFile(backupPath, 'utf8')
  await atomicWrite(configPath, backupContent, false)

  return { ok: true, restoredFrom: backupPath, targetPath: configPath }
}

/**
 * Install MCP server configuration to a specific host
 */
export async function installMcpServer({
  hostId,
  serverName,
  serverConfig,
  dryRun = false,
  configPath = null,
  customDescriptor = null
}) {
  const descriptor = customDescriptor
    ? resolveHostDescriptor(customDescriptor)
    : resolveHostDescriptor(hostId)

  const resolvedPath = descriptor.getConfigPath(configPath)
  const format = descriptor.formats[0]

  let isNewFile = false
  let existingConfig = {}
  let originalContent = ''

  try {
    const parseResult = await parseConfigFile(resolvedPath, format)
    existingConfig = parseResult.parsed
    originalContent = parseResult.rawContent
  } catch (error) {
    if (error.code === 'ENOENT') {
      isNewFile = true
      existingConfig = {}
      originalContent = ''
    } else {
      throw error
    }
  }

  serverConfig = { ...descriptor.serverDefaults, ...serverConfig };
  const newServers = { [serverName]: serverConfig }
  const { changed, result, conflicts, containerType } = mergeMcpConfig(
    existingConfig,
    newServers,
    descriptor.mcpConfigKey,
    descriptor.mcpMergeStrategy
  )

  const alreadyExists = conflicts.includes(serverName)
  const isConflictWithDiff = alreadyExists && !deepEqual(
    containerType === 'array'
      ? (getNestedProperty(existingConfig, descriptor.mcpConfigKey) || []).find(i => i.name === serverName || i.id === serverName)
      : (getNestedProperty(existingConfig, descriptor.mcpConfigKey) || {})[serverName],
    containerType === 'array' ? { name: serverName, ...serverConfig } : serverConfig
  )

  const detectedStatus = await detectHostConfigStatus(descriptor, configPath)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      hostId: hostId || descriptor.name,
      hostName: descriptor.name,
      configPath: resolvedPath,
      format,
      serverName,
      alreadyExists,
      conflictWithDiff: isConflictWithDiff,
      isNewFile,
      wouldChange: changed,
      verified: detectedStatus,
      notes: descriptor.notes
    }
  }

  // Skip disk writes when nothing changed (idempotent no-op)
  if (!changed && !isNewFile) {
    return {
      ok: true,
      hostId: hostId || descriptor.name,
      hostName: descriptor.name,
      configPath: resolvedPath,
      format,
      serverName,
      alreadyExists: true,
      unchanged: true,
      changed: false,
      conflict: alreadyExists,
      conflictWithDiff: isConflictWithDiff,
      verified: detectedStatus
    }
  }

  // Format and serialize preserving user comments and structure
  let content = ''
  if (format === 'jsonc' && !isNewFile && originalContent) {
    const pathKeys = descriptor.mcpConfigKey.split('.')
    const targetPath = containerType === 'array'
      ? [...pathKeys, -1]
      : [...pathKeys, serverName]

    const edits = jsoncParser.modify(originalContent, targetPath, containerType === 'array' ? { name: serverName, ...serverConfig } : serverConfig, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2
      }
    })
    content = jsoncParser.applyEdits(originalContent, edits)
  } else if (format === 'toml' && !isNewFile && originalContent) {
    const parts = descriptor.mcpConfigKey.split('.')
    let wrapped = { [serverName]: serverConfig }
    for (let i = parts.length - 1; i >= 0; i--) {
      wrapped = { [parts[i]]: wrapped }
    }
    const snippet = TOML.stringify(wrapped).trim()
    content = originalContent.trimEnd() + '\n\n' + snippet + '\n'
  } else {
    content = serializeConfig(result, format, originalContent)
  }

  const { backupPath } = await atomicWrite(resolvedPath, content, !isNewFile)

  return {
    ok: true,
    hostId: hostId || descriptor.name,
    hostName: descriptor.name,
    configPath: resolvedPath,
    format,
    serverName,
    alreadyExists,
    conflictWithDiff: isConflictWithDiff,
    isNewFile,
    changed: true,
    conflict: alreadyExists,
    backupPath,
    verified: detectedStatus
  }
}

/**
 * Export MCP configuration snippet for manual installation or unsupported host
 */
export function exportMcpConfig({ hostId, serverName, serverConfig, customDescriptor = null }) {
  const descriptor = customDescriptor
    ? resolveHostDescriptor(customDescriptor)
    : resolveHostDescriptor(hostId)

  const config = {}
  setNestedProperty(config, descriptor.mcpConfigKey, { [serverName]: { ...descriptor.serverDefaults, ...serverConfig } })

  const format = descriptor.formats[0]
  const configSnippet = serializeConfig(config, format)

  return {
    hostId: hostId || descriptor.name,
    hostName: descriptor.name,
    configPath: descriptor.getConfigPath(),
    format,
    configSnippet,
    mergeInstructions: `Merge this snippet into ${descriptor.getConfigPath()} under '${descriptor.mcpConfigKey}' preserving existing entries. For unverified host versions, inspect target configuration syntax first.`,
    verified: descriptor.verified
  }
}

/**
 * Locate project root dynamically without hardcoded personal user paths
 */
export function locateProjectRoot(startDir = null) {
  if (process.env.YINZI_WORKFLOW_PROJECT_ROOT) {
    const candidate = path.resolve(process.env.YINZI_WORKFLOW_PROJECT_ROOT)
    const target = path.join(
      candidate,
      'codex-yinzi-universal-video-workflow',
      'plugins',
      'codex-yinzi-universal-video-workflow',
      'scripts',
      'install-skills.mjs'
    )
    if (fsSync.existsSync(target)) return candidate
  }

  const baseDir = startDir ? path.resolve(startDir) : path.dirname(fileURLToPath(import.meta.url))
  let cur = baseDir
  for (let i = 0; i < 15; i++) {
    const candidate = path.join(
      cur,
      'codex-yinzi-universal-video-workflow',
      'plugins',
      'codex-yinzi-universal-video-workflow',
      'scripts',
      'install-skills.mjs'
    )
    if (fsSync.existsSync(candidate)) return cur
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }

  return null
}

/**
 * Skills installation integration
 * Reuses main repo install-skills.mjs rules:
 * - Dynamically resolves projectRoot without hardcoded user paths
 * - Preflights all destinations
 * - Protects non-symlink user modifications (throws rather than overwrites)
 * - Allows custom target roots (skillsRoots) and custom codexHome
 * - Preserves user configuration and symlinks
 */
export async function installSkillsIntegration({
  projectRoot = undefined,
  skillsRoots = undefined,
  codexHome = undefined,
  runtimeDir = undefined
} = {}) {
  const resolvedProjectRoot = projectRoot ? path.resolve(projectRoot) : locateProjectRoot()
  if (!resolvedProjectRoot) {
    throw new Error(
      'Could not locate projectRoot containing codex-yinzi-universal-video-workflow. Please specify --project-root or set YINZI_WORKFLOW_PROJECT_ROOT.'
    )
  }

  const mainScriptPath = path.join(
    resolvedProjectRoot,
    'codex-yinzi-universal-video-workflow',
    'plugins',
    'codex-yinzi-universal-video-workflow',
    'scripts',
    'install-skills.mjs'
  )

  await fs.access(mainScriptPath)

  if (runtimeDir) {
    process.env.YINZI_WORKFLOW_RUNTIME_DIR = path.resolve(runtimeDir)
  }

  const fileUrl = pathToFileURL(mainScriptPath).href
  const mod = await import(fileUrl)

  if (typeof mod.installSkills !== 'function') {
    throw new Error(`installSkills function not found in ${mainScriptPath}`)
  }

  const receipt = await mod.installSkills({
    projectRoot: resolvedProjectRoot,
    skillsRoots: skillsRoots ? skillsRoots.map(r => path.resolve(r)) : undefined,
    codexHome: codexHome ? path.resolve(codexHome) : undefined
  })

  return receipt
}
