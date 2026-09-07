const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(process.argv[2] || '.');
try {
 const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
 const installed=JSON.parse(fs.readFileSync(path.join(root,'node_modules/.package-lock.json'),'utf8'));
 if(!lock.packages || !installed.packages)throw new Error('lock unavailable');
 for(const [relative,entry] of Object.entries(lock.packages)) {
  if(!relative)continue;
  const prior=installed.packages[relative];
  if(entry.optional && !prior)continue;
  if(!prior || prior.version!==entry.version || prior.integrity!==entry.integrity)throw new Error('lock changed');
  const pkg=JSON.parse(fs.readFileSync(path.join(root,relative,'package.json'),'utf8'));
  if(pkg.version!==entry.version)throw new Error('installed version mismatch');
 }
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 if(pkg.dependencies?.['better-sqlite3']) {
  // Probe in a child so this checker never keeps a Windows native module locked during npm ci.
  const probe=spawnSync(process.execPath,['-e',"const DB=require('better-sqlite3');const d=new DB(':memory:');d.prepare('select 1').get();d.close();require('sharp')"],{cwd:root,stdio:'ignore',windowsHide:true,timeout:10000});
  if(probe.status!==0)throw new Error('native dependency probe failed');
 }
 process.stdout.write('Locked dependencies verified; reusing existing installation.\n');
} catch {process.exitCode=1}
