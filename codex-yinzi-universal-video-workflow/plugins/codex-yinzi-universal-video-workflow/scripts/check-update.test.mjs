import {test} from 'node:test'
import assert from 'node:assert/strict'
import {checkUpdate} from './check-update.mjs'
function fixture({dirty=false,busy=false,remote='https://github.com/ginsonko/codex-yinzi-media-workflow.git',offline=false}={}) {
 const commands=[];let merged=false;const old='a'.repeat(40),latest='b'.repeat(40)
 const git=async args=>{commands.push(args.join(' '));if(args[0]==='remote')return remote;if(args[0]==='ls-remote'){if(offline)throw Object.assign(new Error('offline'),{code:'ENETUNREACH'});return latest+' refs/heads/main'};if(args[0]==='status')return dirty?' M custom.js':'';if(args[0]==='branch')return 'main';if(args[0]==='rev-parse')return args[1]==='FETCH_HEAD'||merged?latest:old;if(args[0]==='merge')merged=true;return ''}
 return {commands,options:{projectRoot:'/test/repo',registry:{},git,busy:async()=>busy,apply:true}}
}
test('official clean idle checkout fast forwards and requires installer activation',async()=>{const f=fixture();const r=await checkUpdate(f.options);assert.equal(r.status,'updated');assert.equal(r.install_required,true);assert.ok(f.commands.some(c=>c.startsWith('merge --ff-only')));assert.ok(!f.commands.some(c=>/reset|stash|clean/.test(c)))})
for(const [name,options,status] of [['edited',{dirty:true},'local_changes'],['active',{busy:true},'deferred'],['fork',{remote:'https://github.com/user/fork.git'},'custom_repository'],['offline',{offline:true},'unavailable']])test(name+' keeps existing installation usable',async()=>{const f=fixture(options);assert.equal((await checkUpdate(f.options)).status,status);assert.ok(!f.commands.some(c=>c.startsWith('merge ')))})

test('an interrupted activation is requested again even when HEAD is current',async()=>{
 const f=fixture();await checkUpdate(f.options)
 const result=await checkUpdate({...f.options,pending:{project_root:'/test/repo',revision:'b'.repeat(40),previous:'a'.repeat(40)}})
 assert.equal(result.status,'activation_required');assert.equal(result.install_required,true)
})

test('fast-forward uses real Git history and preserves later source edits',async()=>{
 const {execFileSync}=await import('node:child_process');const fs=await import('node:fs');const path=await import('node:path');const os=await import('node:os');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-update-git-'));const remote=path.join(root,'origin.git'),seed=path.join(root,'seed'),client=path.join(root,'client');
 const run=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  run(root,['init','--bare',remote]);fs.mkdirSync(seed);run(seed,['init','-b','main']);
  const commit=()=>{run(seed,['add','.']);run(seed,['-c','user.name=Update Test','-c','user.email=update-test@example.invalid','commit','-m','fixture'])};
  fs.writeFileSync(path.join(seed,'app.txt'),'one');commit();run(seed,['remote','add','origin',remote]);run(seed,['push','origin','main']);run(root,['clone','--branch','main',remote,client]);
  fs.writeFileSync(path.join(seed,'app.txt'),'two');commit();run(seed,['push','origin','main']);
  const git=async args=>args[0]==='remote'?'https://github.com/ginsonko/codex-yinzi-media-workflow.git':run(client,args);
  const options={projectRoot:client,registry:{},git,busy:async()=>false,apply:true};
  assert.equal((await checkUpdate(options)).status,'updated');assert.equal(fs.readFileSync(path.join(client,'app.txt'),'utf8'),'two');
  fs.writeFileSync(path.join(client,'app.txt'),'my personal edit');fs.writeFileSync(path.join(seed,'app.txt'),'three');commit();run(seed,['push','origin','main']);
  assert.equal((await checkUpdate(options)).status,'local_changes');assert.equal(fs.readFileSync(path.join(client,'app.txt'),'utf8'),'my personal edit');
 } finally {fs.rmSync(root,{recursive:true,force:true})}
})
