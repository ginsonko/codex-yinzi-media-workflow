#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ensureDependencies } from './host-adapters/ensure-deps.mjs'

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    host: { type: 'string' }, 'config-path': { type: 'string' }, 'server-name': { type: 'string', default: 'yinzi_video_workflow' },
    'skills-root': { type: 'string' }, 'project-root': { type: 'string' }, 'runtime-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean' },
  } })
  if (values.help || !values.host) {
    console.log('node scripts/install-host.mjs --host <grok|codex-cli|claude-desktop|cursor|cline|roo-code|continue|vscode|zed> [--config-path PATH] [--skills-root PATH] [--dry-run]')
    return
  }
  ensureDependencies({ quiet: true })
  const { installMcpServer, installSkillsIntegration, locateProjectRoot, resolveHostDescriptor } = await import('./host-adapters/host-config.mjs')
  const descriptor = resolveHostDescriptor(values.host)
  const skillsRoot = values['skills-root'] || (descriptor.autoInstallSkills
    ? descriptor.skillsPath(path.dirname(descriptor.getConfigPath(values['config-path']))) : null)
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.mjs')
  const result = await installMcpServer({ hostId: values.host, serverName: values['server-name'],
    serverConfig: { command: process.execPath, args: [entry] }, configPath: values['config-path'] || null, dryRun: values['dry-run'] })
  if (skillsRoot) result.skills_root = path.resolve(skillsRoot)
  if (skillsRoot && !values['dry-run'] && !result.conflictWithDiff) {
    result.skills = await installSkillsIntegration({ projectRoot: values['project-root'] || locateProjectRoot(process.cwd()) || locateProjectRoot(),
      skillsRoots: [skillsRoot], runtimeDir: values['runtime-dir'] })
  }
  console.log(JSON.stringify(result, null, 2))
  if (result.conflictWithDiff) process.exitCode = 2
  return result
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.code ? `${error.code}: ${error.message}` : error.message); process.exitCode = 1 })
}