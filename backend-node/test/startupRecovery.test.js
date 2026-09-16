const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startupRecoveryMode } = require('../src/services/startupRecovery');

test('startup recovery configuration is explicit, persistent and rejects misspellings', () => {
  assert.equal(startupRecoveryMode({}, {}), 'auto');
  assert.equal(startupRecoveryMode({ runtime: { startup_recovery: 'manual' } }, {}), 'manual');
  assert.equal(startupRecoveryMode({ runtime: { startup_recovery: 'manual' } },
    { YINZI_WORKFLOW_STARTUP_RECOVERY: 'auto' }), 'auto');
  assert.throws(() => startupRecoveryMode({ runtime: { startup_recovery: 'manuel' } }, {}),
    { code: 'INVALID_STARTUP_RECOVERY' });
});

for (const mode of ['manual', 'auto']) test('real app startup in ' + mode + ' mode retains history and exposes its recovery behavior', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-startup-recovery-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    app: { name: 'startup acceptance', version: 'test' },
    server: { cors_origins: [] },
    database: { path: path.join(dir, 'test.db') },
    storage: { local_path: path.join(dir, 'storage') },
    runtime: { startup_recovery: mode },
  }));
  // A separate process uses the real app and migration lifecycle. The one
  // provider recovery adapter is observed without contacting a real provider.
  const child = String.raw`
    const assert = require('node:assert/strict');
    const {loadConfig}=require('./src/config');
    const {getDb,closeDb}=require('./src/db');
    const db=getDb(loadConfig().database);
    require('./src/db/migrate').runMigrationsAndEnsure(db);
    db.prepare("INSERT INTO image_generations (prompt,model,status) VALUES (?,?,?)")
      .run('retained completed legacy asset','fixture','completed');
    const orchestration=require('./src/services/orchestrationService').createOrchestrationService(db);
    const session=orchestration.beginWork({idempotency_key:'keep-session',user_goal:'keep paused work',intent:'analyze'}).session;
    db.prepare("UPDATE orchestration_sessions SET status='paused' WHERE id=?").run(session.id);
    const before=db.prepare('SELECT * FROM image_generations').all();
    let videoRecovery=0;
    require('./src/services/videoService').resumeProcessingVideoGenerations=()=>{videoRecovery++};
    let localRecovery=0, orphanRecovery=0;
    const localModule=require('./src/services/localMediaJobs');
    const createLocal=localModule.createLocalMediaJobs;
    localModule.createLocalMediaJobs=(...args)=>{
      const service=createLocal(...args), recover=service.recover;
      service.recover=(...values)=>{localRecovery++;return recover(...values)};
      return service;
    };
    const taskModule=require('./src/services/taskService');
    const failOrphans=taskModule.failOrphanedAsyncTasksOnStartup;
    taskModule.failOrphanedAsyncTasksOnStartup=(...args)=>{orphanRecovery++;return failOrphans(...args)};
    const {app,productionAutonomyRunner}=require('./src/app').createApp();
    const listener=app.listen(0,'127.0.0.1',async()=>{
      try {
        const response=await fetch('http://127.0.0.1:'+listener.address().port+'/api/v1/runtime-identity');
        const identity=(await response.json()).data;
        assert.deepEqual(db.prepare('SELECT * FROM image_generations').all(),before);
        const result={mode:identity.startup_recovery,videoRecovery,localRecovery,orphanRecovery,autonomy:Boolean(productionAutonomyRunner?.isRunning()),
          batches:db.prepare('SELECT COUNT(*) n FROM media_batches').get().n,
          session:db.prepare('SELECT status FROM orchestration_sessions WHERE id=?').get(session.id).status};
        process.stdout.write('\nRESULT:'+JSON.stringify(result)+'\n');
      }catch(error){console.error(error);process.exitCode=1}
      finally{
        productionAutonomyRunner?.stop();app.locals.mediaBatchService.stop();
        await app.locals.blenderService.stop();await new Promise(resolve=>listener.close(resolve));closeDb();
      }
    });
  `;
  try {
    const env = { ...process.env, YINZI_WORKFLOW_CONFIG: configFile };
    delete env.YINZI_WORKFLOW_STARTUP_RECOVERY;
    delete env.PRODUCTION_AUTONOMY_DISABLED;
    const result = spawnSync(process.execPath, ['-e', child], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 25000, windowsHide: true,
    });
    assert.equal(result.status, 0, (result.error?.message || '') + result.stderr + result.stdout.slice(-2500));
    const marker = result.stdout.split('\n').find(line => line.startsWith('RESULT:'));
    assert.ok(marker, result.stdout.slice(-2500));
    const outcome = JSON.parse(marker.slice(7));
    assert.equal(outcome.mode, mode);
    assert.equal(outcome.videoRecovery, mode === 'auto' ? 1 : 0);
    assert.equal(outcome.localRecovery, mode === 'auto' ? 1 : 0);
    assert.equal(outcome.orphanRecovery, mode === 'auto' ? 1 : 0);
    assert.equal(outcome.autonomy, mode === 'auto');
    assert.equal(outcome.batches, mode === 'auto' ? 1 : 0);
    assert.equal(outcome.session, 'paused');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
