import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installMcpServer, parseConfigFile, detectHostConfigStatus } from './host-config.mjs'
const here=path.dirname(fileURLToPath(import.meta.url))
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yinzi host acceptance '));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir}

test('current Continue JSON block preserves unrelated servers and is idempotent',async t=>{
 const dir=await temporary(t),file=path.join(dir,'mcp.json');
 await fs.writeFile(file,JSON.stringify({mcpServers:{other:{command:'existing'}},custom:true}));
 const request={hostId:'continue',configPath:file,serverName:'yinzi',serverConfig:{command:'node',args:['has spaces/server.mjs']}};
 await installMcpServer(request);const first=await fs.readFile(file,'utf8');
 assert.equal(JSON.parse(first).mcpServers.yinzi.command,'node');assert.equal(JSON.parse(first).custom,true);
 assert.equal((await installMcpServer(request)).unchanged,true);assert.equal(await fs.readFile(file,'utf8'),first);
});
test('Zed and VS Code preserve JSONC comments and install the documented structures',async t=>{
 const dir=await temporary(t);
 for(const [host,key]of [['zed','context_servers'],['vscode','servers']]){
  const file=path.join(dir,host+'.json');await fs.writeFile(file,'{\n// keep user notes\n"theme":"unchanged",\n}');
  await installMcpServer({hostId:host,configPath:file,serverName:'yinzi',serverConfig:{command:'node',args:['server.mjs']}});
  const {parsed,rawContent}=await parseConfigFile(file,'jsonc');assert.ok(rawContent.includes('// keep user notes'));assert.equal(parsed.theme,'unchanged');
  assert.equal(parsed[key].yinzi.command,'node');if(host==='vscode')assert.equal(parsed[key].yinzi.type,'stdio');
 }
});
test('JSONC array insertion preserves name and repeated equivalent request reports no conflict',async t=>{
 const dir=await temporary(t),file=path.join(dir,'array.json');await fs.writeFile(file,'{ // keep\n "items": []\n}');
 const req={customDescriptor:{name:'custom',formats:['jsonc'],mcpConfigKey:'items'},configPath:file,serverName:'a',serverConfig:{command:'node'}};
 await installMcpServer(req);assert.equal((await parseConfigFile(file,'jsonc')).parsed.items[0].name,'a');
 const again=await installMcpServer(req);assert.equal(again.unchanged,true);assert.equal(again.conflictWithDiff,false);
});
test('scalar target or parent is never replaced with an MCP object',async t=>{
 const dir=await temporary(t),file=path.join(dir,'scalar.json');
 for(const key of ['items','items.servers']){const before='{"items":"user content"}';await fs.writeFile(file,before);
  await assert.rejects(installMcpServer({customDescriptor:{name:'custom',formats:['json'],mcpConfigKey:key},configPath:file,serverName:'a',serverConfig:{command:'node'}}),/preserved/);
  assert.equal(await fs.readFile(file,'utf8'),before);
 }
});
test('configuration observation is based on the requested file and never implies host execution',async t=>{
 const dir=await temporary(t),file=path.join(dir,'settings.json');
 assert.equal(await detectHostConfigStatus('codex-cli',file),'adapter-tested');await fs.writeFile(file,'{}');
 assert.equal(await detectHostConfigStatus('codex-cli',file),'config-observed');
});
test('one host command uses absolute executable and MCP entry; dry run leaves no config',async t=>{
 const dir=await temporary(t),file=path.join(dir,'mcp.json'),entry=path.resolve(here,'../install-host.mjs');
 const args=[entry,'--host','vscode','--config-path',file];
 const dry=spawnSync(process.execPath,[...args,'--dry-run'],{encoding:'utf8',windowsHide:true});assert.equal(dry.status,0,dry.stderr);await assert.rejects(fs.access(file));
 const done=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});assert.equal(done.status,0,done.stderr);
 const cfg=JSON.parse(await fs.readFile(file,'utf8')).servers.yinzi_video_workflow;assert.equal(cfg.command,process.execPath);assert.ok(path.isAbsolute(cfg.args[0]));await fs.access(cfg.args[0]);
});