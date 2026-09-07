import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = execFileSync('git', ['ls-files','-z'], {cwd:root, encoding:'utf8'}).split('\0').filter(Boolean)
const findings = []
const fakeTokens = new Set(['sk-abcdefghijklmnop','sk-abcdefgh12345678','sk-secretvalue','sk-test-placeholder','sk-test-secret-value','sk-abcdefghijklmno','sk-thisisatestcredential123456789','sk-thisisatestcredential'])
let textCount = 0, bytes = 0
for (const relative of files) {
  if (/(^|\/)(node_modules|logs|uploads|storage|\.env)(\/|$)|\.(?:db|sqlite3?|log|pem|pfx|key)(?:-wal|-shm)?$|\.receipt\.json$/.test(relative)) findings.push({file:relative,issue:'private/runtime file'})
  const content = fs.readFileSync(path.join(root,relative)); bytes += content.length
  if (content.length > 20*1024*1024) findings.push({file:relative,issue:'unexpected large binary'})
  if (/\.(?:png|jpe?g|webp|ico|mp4|glb|woff2?)$/i.test(relative)) continue
  const value = content.toString('utf8');textCount++
  for (const token of value.match(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g)||[]) {
    if (!fakeTokens.has(token)) findings.push({file:relative,issue:'potential credential; value suppressed'})
  }
  if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(value)) findings.push({file:relative,issue:'private key'})
  if (/[CH]:[\\/]Users[\\/](?:Administrator|ADMINI~1)|H:[\\/]C_Drive_Relocated/.test(value)) findings.push({file:relative,issue:'maintainer local path or runtime identifier'})
  if (value.startsWith('version https://git-lfs.github.com/spec/v1')) findings.push({file:relative,issue:'unmaterialized LFS pointer'})
  if (relative.endsWith('.md')) {
    for (const match of value.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link=match[1].replace(/^<|>$/g,'').split('#')[0]
      if (!link || /^(?:https?:|mailto:|codex:|#)/.test(link) || link.startsWith('../../issues') || link.startsWith('../../security')) continue
      if (!fs.existsSync(path.resolve(root,path.dirname(relative),decodeURIComponent(link)))) findings.push({file:relative,issue:`missing local link: ${link}`})
    }
  }
}
console.log(JSON.stringify({ok:!findings.length,files:files.length,text_files:textCount,bytes,findings},null,2))
if (findings.length) process.exitCode=1
