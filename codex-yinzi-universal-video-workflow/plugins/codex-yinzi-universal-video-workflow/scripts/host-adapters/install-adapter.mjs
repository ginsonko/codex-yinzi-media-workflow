#!/usr/bin/env node
/**
 * MCP and Skills installation adapter CLI
 * Supports multiple host environments with idempotent, atomic configuration updates
 * Supports custom descriptors, skills installation, rollback, and export
 */

import { parseArgs } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { ensureDependencies } from './ensure-deps.mjs'
ensureDependencies({ quiet: true });
const {
  HOST_DESCRIPTORS,
  detectHostConfigStatus,
  installMcpServer,
  exportMcpConfig,
  rollback,
  installSkillsIntegration
} = await import('./host-config.mjs')

const USAGE = `
Multi-host MCP & Skills installation adapter

Usage:
  node install-adapter.mjs install --host <host-id> --server-name <name> [options]
  node install-adapter.mjs export --host <host-id> --server-name <name> [options]
  node install-adapter.mjs install-skills [options]
  node install-adapter.mjs list-hosts
  node install-adapter.mjs rollback --host <host-id> --backup <path>

Commands:
  install         Install MCP server configuration to host
  export          Export configuration snippet for manual installation
  install-skills  Install skills with destination preflight & user-edit protection
  list-hosts      List supported host environments and verification status
  rollback        Restore configuration from backup

Options:
  --host <id>             Host environment (codex-cli, claude-desktop, cline, roo-code, cursor, continue, zed)
  --server-name <name>    MCP server name
  --command <cmd>         Server command (e.g., "node")
  --args <json>           Server arguments as JSON array
  --cwd <path>            Server working directory
  --env <json>            Environment variables as JSON object
  --config-path <path>    Override default config path (for testing/custom installs)
  --custom-desc <path>    Path to JSON file containing a custom host descriptor
  --dry-run               Show what would be done without making changes
  --backup <path>         Backup file path for rollback
  --skills-root <path>    Custom skills destination root (can be specified multiple times)
  --codex-home <path>     Custom CODEX_HOME directory
  --project-root <path>   Public-release root directory (defaults to auto-discovered root)

Examples:
  # Install for Codex CLI (TOML, respects CODEX_HOME)
  node install-adapter.mjs install --host codex-cli --server-name yinzi_video \\
    --command node --args '["./mcp/server.mjs"]' --cwd /path/to/plugin

  # Install for Cursor (.cursor/mcp.json)
  node install-adapter.mjs install --host cursor --server-name yinzi_video \\
    --command node --args '["./mcp/server.mjs"]'

  # Install skills with isolation
  node install-adapter.mjs install-skills --skills-root ./isolated-skills --codex-home ./isolated-codex

  # Dry run
  node install-adapter.mjs install --host claude-desktop --server-name yinzi \\
    --command node --args '["server.mjs"]' --dry-run

  # List supported hosts
  node install-adapter.mjs list-hosts
`

function parseJsonArg(value, argName) {
  try {
    return JSON.parse(value)
  } catch (error) {
    console.error(`Error: Invalid JSON for ${argName}: ${error.message}`)
    process.exit(1)
  }
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE)
    process.exit(0)
  }

  const command = args[0]

  if (command === 'list-hosts') {
    console.log('\nSupported host environments:\n')
    for (const [id, descriptor] of Object.entries(HOST_DESCRIPTORS)) {
      const observedStatus = await detectHostConfigStatus(id);
      const verifiedLabel = observedStatus === 'config-observed' ? '✓ Config observed on local host'
                          : observedStatus === 'adapter-tested' ? '✓ Adapter tested'
                          : '○ Not tested'
      console.log(`  ${id.padEnd(18)} ${descriptor.name.padEnd(25)} ${verifiedLabel}`)
      if (descriptor.notes) {
        console.log(`  ${' '.repeat(18)} Note: ${descriptor.notes}`)
      }
      console.log(`  ${' '.repeat(18)} Primary Config: ${descriptor.getConfigPath()}`)
      console.log()
    }
    return
  }

  const parsed = parseArgs({
    args: args.slice(1),
    options: {
      host: { type: 'string' },
      'server-name': { type: 'string' },
      command: { type: 'string' },
      args: { type: 'string' },
      cwd: { type: 'string' },
      env: { type: 'string' },
      'config-path': { type: 'string' },
      'custom-desc': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      backup: { type: 'string' },
      enabled: { type: 'boolean', default: true },
      'skills-root': { type: 'string' },
      'codex-home': { type: 'string' },
      'project-root': { type: 'string' },
      'runtime-dir': { type: 'string' }
    },
    allowPositionals: false
  })

  const options = parsed.values

  if (command === 'install') {
    if ((!options.host && !options['custom-desc']) || !options['server-name']) {
      console.error('Error: --host (or --custom-desc) and --server-name are required')
      console.error('Run with --help for usage information')
      process.exit(1)
    }

    let customDescriptor = null
    if (options['custom-desc']) {
      const descContent = await fs.readFile(options['custom-desc'], 'utf8')
      customDescriptor = JSON.parse(descContent)
    }

    const serverConfig = {
      command: options.command || 'node',
      ...(options.enabled ? {} : { enabled: false })
    }

    if (options.args) {
      serverConfig.args = parseJsonArg(options.args, '--args')
    }

    if (options.cwd) {
      serverConfig.cwd = path.resolve(options.cwd)
    }

    if (options.env) {
      serverConfig.env = parseJsonArg(options.env, '--env')
    }

    try {
      const result = await installMcpServer({
        hostId: options.host,
        serverName: options['server-name'],
        serverConfig,
        dryRun: options['dry-run'],
        configPath: options['config-path'] || null,
        customDescriptor
      })

      console.log(JSON.stringify(result, null, 2))

      if (result.dryRun) {
        console.error('\n[DRY RUN] No changes were made')
      } else if (result.unchanged) {
        console.error(`\n✓ Server '${result.serverName}' already present and identical in ${result.hostName} - file untouched`)
      } else if (result.conflictWithDiff) {
        console.error(`\n⚠ Server '${result.serverName}' already exists in ${result.hostName} with differing configuration - existing user settings preserved, file untouched`)
      } else {
        console.error(`\n✓ Successfully installed '${result.serverName}' to ${result.hostName}`)
        if (result.backupPath) {
          console.error(`  Backup created: ${result.backupPath}`)
        }
      }

      if (result.verified !== 'config-observed') {
        console.error(`\n⚠ Status: ${result.hostName} adapter is ${result.verified} - configuration file written, host runtime execution unverified`)
      }
    } catch (error) {
      console.error(`\nError: ${error.message}`)
      process.exit(1)
    }
  } else if (command === 'export') {
    if ((!options.host && !options['custom-desc']) || !options['server-name']) {
      console.error('Error: --host (or --custom-desc) and --server-name are required')
      process.exit(1)
    }

    let customDescriptor = null
    if (options['custom-desc']) {
      const descContent = await fs.readFile(options['custom-desc'], 'utf8')
      customDescriptor = JSON.parse(descContent)
    }

    const serverConfig = {
      command: options.command || 'node',
      ...(options.enabled ? {} : { enabled: false })
    }

    if (options.args) {
      serverConfig.args = parseJsonArg(options.args, '--args')
    }

    if (options.cwd) {
      serverConfig.cwd = path.resolve(options.cwd)
    }

    if (options.env) {
      serverConfig.env = parseJsonArg(options.env, '--env')
    }

    try {
      const result = exportMcpConfig({
        hostId: options.host,
        serverName: options['server-name'],
        serverConfig,
        customDescriptor
      })

      console.log(`\nConfiguration snippet for ${result.hostName} (${result.format.toUpperCase()}):\n`)
      console.log(result.configSnippet)
      console.log(`\nTarget path: ${result.configPath}`)
      console.log(`${result.mergeInstructions}\n`)

      if (result.verified !== 'config-observed') {
        console.error(`⚠ Status: ${result.verified}\n`)
      }
    } catch (error) {
      console.error(`\nError: ${error.message}`)
      process.exit(1)
    }
  } else if (command === 'install-skills') {
    try {
      const skillsRoots = options['skills-root'] ? [options['skills-root']] : undefined
      const receipt = await installSkillsIntegration({
        projectRoot: options['project-root'] || undefined,
        skillsRoots,
        codexHome: options['codex-home'] || undefined,
        runtimeDir: options['runtime-dir'] || undefined
      })
      console.log(JSON.stringify(receipt, null, 2))
      console.error(`\n✓ Skills installed successfully (${receipt.links?.length || 0} links)`)
    } catch (error) {
      console.error(`\nError installing skills: ${error.message}`)
      process.exit(1)
    }
  } else if (command === 'rollback') {
    if (!options.host || !options.backup) {
      console.error('Error: --host and --backup are required')
      process.exit(1)
    }

    try {
      const descriptor = HOST_DESCRIPTORS[options.host]
      if (!descriptor) {
        throw new Error(`Unknown host: ${options.host}`)
      }

      const configPath = descriptor.getConfigPath(options['config-path'] || null)
      const result = await rollback(configPath, options.backup)

      console.log(JSON.stringify({ ok: true, host: options.host, configPath, backupPath: options.backup }, null, 2))
      console.error(`\n✓ Successfully restored ${descriptor.name} configuration from backup`)
    } catch (error) {
      console.error(`\nError: ${error.message}`)
      process.exit(1)
    }
  } else {
    console.error(`Error: Unknown command '${command}'`)
    console.log(USAGE)
    process.exit(1)
  }
}

main().catch(error => {
  console.error(`Fatal: ${error.message}`)
  process.exit(1)
})
