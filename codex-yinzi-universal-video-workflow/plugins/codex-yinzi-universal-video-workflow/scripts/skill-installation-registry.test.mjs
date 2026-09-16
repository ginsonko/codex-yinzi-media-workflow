import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {installSkills} from './install-skills.mjs'

async function fixture(fn) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'yinzi-skill-registry-'))
  const previous=process.env.YINZI_WORKFLOW_RUNTIME_DIR
  const state=path.join(root,'state')
  process.env.YINZI_WORKFLOW_RUNTIME_DIR=state
  try {
    const project=path.join(root,'source')
    const plugin=path.join(project,'codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow')
    const skill=path.join(plugin,'skills/example')
    await fs.mkdir(skill,{recursive:true})
    await fs.writeFile(path.join(skill,'SKILL.md'),'version one')
    await fn({root,state,project,skill,record:path.join(state,'skill-installation.json')})
  } finally {
    if(previous===undefined) delete process.env.YINZI_WORKFLOW_RUNTIME_DIR
    else process.env.YINZI_WORKFLOW_RUNTIME_DIR=previous
    await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  }
}

test('a custom host install preserves earlier discovery roots across upgrades',()=>fixture(async({root,project,skill})=>{
  const hosts=[path.join(root,'codex'),path.join(root,'agents')]
  const first=await installSkills({projectRoot:project,skillsRoots:hosts})
  const isolated=path.join(root,'isolated')
  const second=await installSkills({projectRoot:project,skillsRoots:[isolated]})
  assert.equal(second.links.length,3)
  await fs.writeFile(path.join(skill,'SKILL.md'),'version two')
  const third=await installSkills({projectRoot:project,skillsRoots:hosts})
  assert.notEqual(first.digest,third.digest)
  assert.equal(third.links.length,3)
  for(const host of hosts) assert.equal(await fs.readFile(path.join(host,'example/SKILL.md'),'utf8'),'version two')
  assert.equal(await fs.readFile(path.join(isolated,'example/SKILL.md'),'utf8'),'version one')
}))

test('legacy missing links recover only from the recorded completed snapshot',()=>fixture(async({root,project,skill,record})=>{
  const hosts=[path.join(root,'codex'),path.join(root,'agents')]
  const first=await installSkills({projectRoot:project,skillsRoots:hosts})
  await fs.writeFile(record,JSON.stringify({...first,links:[]}))
  await fs.writeFile(path.join(skill,'SKILL.md'),'version two')
  const updated=await installSkills({projectRoot:project,skillsRoots:hosts})
  assert.equal(updated.links.length,2)
  for(const host of hosts) assert.equal(await fs.readFile(path.join(host,'example/SKILL.md'),'utf8'),'version two')
  assert.equal(await fs.readFile(path.join(first.installed_plugin,'skills/example/SKILL.md'),'utf8'),'version one')
}))

test('external links and incomplete prior snapshots are not claimed',()=>fixture(async({root,project,skill,record})=>{
  const hosts=[path.join(root,'codex'),path.join(root,'agents')]
  const first=await installSkills({projectRoot:project,skillsRoots:hosts})
  await fs.writeFile(record,JSON.stringify({...first,links:[]}))
  await fs.writeFile(path.join(skill,'SKILL.md'),'version two')
  const completed=path.join(path.dirname(first.installed_plugin),'complete.json')
  await fs.writeFile(completed,JSON.stringify({digest:'mismatch'}))
  await assert.rejects(installSkills({projectRoot:project,skillsRoots:hosts}),/来源未知/)
  assert.equal(await fs.readlink(first.links[0].path),first.links[0].target)
  await fs.writeFile(completed,JSON.stringify({digest:first.digest}))
  const foreign=path.join(root,'user-owned')
  await fs.mkdir(foreign)
  await fs.writeFile(path.join(foreign,'SKILL.md'),'keep mine')
  await fs.unlink(first.links[1].path)
  await fs.symlink(foreign,first.links[1].path,process.platform==='win32'?'junction':'dir')
  await assert.rejects(installSkills({projectRoot:project,skillsRoots:hosts}),/来源未知/)
  assert.equal(await fs.readlink(first.links[0].path),first.links[0].target)
  assert.equal(await fs.readFile(path.join(foreign,'SKILL.md'),'utf8'),'keep mine')
}))

test('temporary Windows link contention retries without losing the installed skill',t=>fixture(async({root,project,skill})=>{
  const host=path.join(root,'codex'),args={projectRoot:project,skillsRoots:[host]}
  await installSkills(args)
  await fs.writeFile(path.join(skill,'SKILL.md'),'version two')
  const rename=fs.rename;let attempts=0
  const mock=t.mock.method(fs,'rename',async(from,to)=>{
    if(from.includes('.new-')&&attempts++===0)throw Object.assign(Error('busy'),{code:'EBUSY'})
    return rename(from,to)
  })
  try {await installSkills(args)} finally {mock.mock.restore()}
  assert.equal(await fs.readFile(path.join(host,'example/SKILL.md'),'utf8'),'version two')
  assert.equal(attempts,2)
  assert.deepEqual(await fs.readdir(host),['example'])
}))

test('interrupted multi-link installation rolls back the failing path and resumes earlier links',t=>fixture(async({root,project,skill,state})=>{
  const hosts=[path.join(root,'first'),path.join(root,'second')],args={projectRoot:project,skillsRoots:hosts}
  const first=await installSkills(args)
  await fs.writeFile(path.join(skill,'SKILL.md'),'version two')
  const rename=fs.rename
  const mock=t.mock.method(fs,'rename',async(from,to)=>{
    if(from.includes('.new-')&&to===path.join(hosts[1],'example'))throw Object.assign(Error('injected move failure'),{code:'EACCES'})
    return rename(from,to)
  })
  try {await assert.rejects(installSkills(args),/injected move failure/)} finally {mock.mock.restore()}
  assert.equal(await fs.readFile(path.join(hosts[0],'example/SKILL.md'),'utf8'),'version two')
  assert.equal(await fs.readFile(path.join(hosts[1],'example/SKILL.md'),'utf8'),'version one')
  assert.equal(JSON.parse(await fs.readFile(path.join(state,'skill-installation.json'),'utf8')).digest,first.digest)
  const recovered=await installSkills(args)
  assert.notEqual(recovered.digest,first.digest)
  for(const host of hosts)assert.equal(await fs.readFile(path.join(host,'example/SKILL.md'),'utf8'),'version two')
  await assert.rejects(fs.access(path.join(state,'skill-installation.pending.json')),{code:'ENOENT'})
}))
