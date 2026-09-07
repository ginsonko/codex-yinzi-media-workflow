import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const checker=fileURLToPath(new URL('./dependencies-current.cjs',import.meta.url))
test('reuses only a matching installed lock and detects partial removals',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-dependency-check-'))
 const run=()=>spawnSync(process.execPath,[checker,dir],{windowsHide:true,stdio:'ignore'}).status
 try {
  const packages={'node_modules/fixture':{version:'1.0.0',integrity:'sha512-fixture'}}
  fs.mkdirSync(path.join(dir,'node_modules/fixture'),{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),'{}');fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({packages}));fs.writeFileSync(path.join(dir,'node_modules/.package-lock.json'),JSON.stringify({packages}));fs.writeFileSync(path.join(dir,'node_modules/fixture/package.json'),JSON.stringify({version:'1.0.0'}));assert.equal(run(),0)
  fs.unlinkSync(path.join(dir,'node_modules/fixture/package.json'));assert.equal(run(),1)
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
