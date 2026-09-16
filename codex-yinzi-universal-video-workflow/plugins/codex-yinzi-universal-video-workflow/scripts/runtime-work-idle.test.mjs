import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {assertIdleWorkStatus, interpretWorkStatus} from './runtime-work-idle.mjs'
import {requireIdle} from './runtime-processes.mjs'
import {checkUpdate} from './check-update.mjs'

function legacy(counts, busy = true) {
  return {data: {busy, counts}}
}

test('new schema uses explicit busy and blocking, not leftover analysis drafts', () => {
  const idle = interpretWorkStatus({
    data: {schema: 'yinzi.runtime-work-status/v2', busy: false, blocking: [], counts: {analysis: 7, local_media_jobs: 0}},
  })
  assert.equal(idle.idle, true)
  const busy = interpretWorkStatus({
    data: {schema: 'yinzi.runtime-work-status/v2', busy: true, blocking: ['execution'], counts: {local_media_jobs: 1, analysis: 0}},
  })
  assert.equal(busy.idle, false)
  assert.equal(busy.reason, 'execution')
  const unreadable = interpretWorkStatus({
    data: {schema: 'yinzi.runtime-work-status/v2', busy: false, blocking: ['unreadable'], readable: false, counts: {}},
  })
  assert.equal(unreadable.idle, false)
  assert.equal(unreadable.reason, 'unreadable')
})

test('legacy backends with complete zero queues treat leftover analysis as recoverable context', () => {
  const counts = {
    async_tasks: 0,
    media_batches: 0,
    production_runs: 0,
    orchestration_blender_jobs: 0,
    local_media_jobs: 0,
    analysis: 7,
  }
  assert.equal(interpretWorkStatus(legacy(counts)).idle, true)
  assert.equal(interpretWorkStatus(legacy(counts)).reason, 'legacy_analysis_context')
})

test('legacy backends with live queues, unknown paid work, or incomplete counts stay protected', () => {
  const base = {async_tasks: 0, media_batches: 0, production_runs: 0, orchestration_blender_jobs: 0, local_media_jobs: 0, analysis: 7}
  assert.equal(interpretWorkStatus(legacy({...base, local_media_jobs: 1})).idle, false)
  assert.equal(interpretWorkStatus(legacy({...base, unknown_paid_requests: 1})).idle, false)
  assert.equal(interpretWorkStatus(legacy({analysis: 7})).idle, false)
  assert.equal(interpretWorkStatus({data: {busy: true}}).idle, false)
  assert.equal(interpretWorkStatus({data: {busy: 'yes'}}).idle, false)
  assert.equal(interpretWorkStatus({data: {schema: 'yinzi.runtime-work-status/v2', busy: true, blocking: ['unknown_paid_request']}}).idle, false)
})

test('RUNTIME-REVIEW-20260913 idle false-positives stay protected', () => {
  const queues = {async_tasks: 0, media_batches: 0, production_runs: 0, orchestration_blender_jobs: 0, local_media_jobs: 0, analysis: 0}
  const unexplained = interpretWorkStatus(legacy(queues, true))
  assert.equal(unexplained.idle, false)
  assert.equal(unexplained.reason, 'legacy_busy_unexplained')

  const paidUnknown = interpretWorkStatus(legacy({...queues, unknown_paid_requests: 1}, false))
  assert.equal(paidUnknown.idle, false)
  assert.equal(paidUnknown.reason, 'legacy_unknown_paid_request')

  const extended = interpretWorkStatus(legacy({...queues, image_generations: 1}, false))
  assert.equal(extended.idle, false)
  assert.equal(extended.reason, 'legacy_execution')

  const contradictory = interpretWorkStatus({
    data: {
      schema: 'yinzi.runtime-work-status/v2',
      busy: false,
      blocking: ['execution'],
      readable: true,
      counts: {...queues, local_media_jobs: 1},
    },
  })
  assert.equal(contradictory.idle, false)
  assert.equal(contradictory.reason, 'execution')

  const unknownBlock = interpretWorkStatus({
    data: {schema: 'yinzi.runtime-work-status/v2', busy: false, blocking: ['provider_unknown'], readable: true, counts: queues},
  })
  assert.equal(unknownBlock.idle, false)
  assert.equal(unknownBlock.reason, 'provider_unknown')

  const countConflict = interpretWorkStatus({
    data: {schema: 'yinzi.runtime-work-status/v2', busy: false, blocking: [], readable: true, counts: {...queues, local_media_jobs: 1}},
  })
  assert.equal(countConflict.idle, false)
  assert.equal(countConflict.reason, 'execution')
})

test('kept idle cases remain idle after conflict protection', () => {
  const queues = {async_tasks: 0, media_batches: 0, production_runs: 0, orchestration_blender_jobs: 0, local_media_jobs: 0}
  assert.equal(interpretWorkStatus(legacy({...queues, analysis: 7}, true)).idle, true)
  assert.equal(interpretWorkStatus(legacy({...queues, analysis: 7}, true)).reason, 'legacy_analysis_context')
  assert.equal(interpretWorkStatus({
    data: {schema: 'yinzi.runtime-work-status/v2', busy: false, blocking: [], counts: {...queues, analysis: 7, local_media_jobs: 0}},
  }).idle, true)
  assert.equal(interpretWorkStatus({data: {busy: false}}).idle, true)
})

test('fingerprint mismatch and unreadable status remain busy without pretending idle', async () => {
  assert.throws(() => assertIdleWorkStatus({data: {busy: true, counts: {analysis: 7}}}), /仍有运行或待核对任务/)
  const git = async args => args[0] === 'remote' ? 'https://github.com/ginsonko/codex-yinzi-media-workflow.git' : args[0] === 'ls-remote' ? `${'b'.repeat(40)} refs/heads/main` : args[0] === 'status' ? '' : args[0] === 'branch' ? 'main' : 'a'.repeat(40)
  const deferred = await checkUpdate({projectRoot: '/test/repo', registry: {}, git, busy: async () => true, apply: true})
  assert.equal(deferred.status, 'deferred')
})

test('busyRuntime treats a database fingerprint mismatch as busy and never claims idle', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/runtime-identity') return res.end(JSON.stringify({data:{database:{fingerprint:'other-db'}}}))
    if (req.url === '/api/v1/runtime-work-status') return res.end(JSON.stringify({data:{schema:'yinzi.runtime-work-status/v2',busy:false,blocking:[],counts:{analysis:0}}}))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const git = async args => args[0] === 'remote' ? 'https://github.com/ginsonko/codex-yinzi-media-workflow.git' : args[0] === 'ls-remote' ? `${'b'.repeat(40)} refs/heads/main` : args[0] === 'status' ? '' : args[0] === 'branch' ? 'main' : 'a'.repeat(40)
    const result = await checkUpdate({projectRoot:'/test/repo',registry:{api_base:origin,database_fingerprint:'expected-db'},git,apply:true})
    assert.equal(result.status,'deferred')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('an interrupted merge keeps the existing checkout and later idle analysis can resume', async () => {
  const {execFileSync}=await import('node:child_process');const fs=await import('node:fs');const path=await import('node:path');const os=await import('node:os')
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-update-recover-'))
  const remote=path.join(root,'origin.git'),seed=path.join(root,'seed'),client=path.join(root,'client')
  const run=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  try {
    run(root,['init','--bare',remote]);fs.mkdirSync(seed);run(seed,['init','-b','main'])
    const commit=()=>{run(seed,['add','.']);run(seed,['-c','user.name=Update Test','-c','user.email=update-test@example.invalid','commit','-m','fixture'])}
    fs.writeFileSync(path.join(seed,'app.txt'),'one');commit();run(seed,['remote','add','origin',remote]);run(seed,['push','origin','main']);run(root,['clone','--branch','main',remote,client])
    fs.writeFileSync(path.join(seed,'app.txt'),'two');commit();run(seed,['push','origin','main'])
    const git=async args=>{
      if(args[0]==='remote')return 'https://github.com/ginsonko/codex-yinzi-media-workflow.git'
      if(args[0]==='merge')throw Object.assign(new Error('merge interrupted'),{code:'MERGE_INTERRUPTED'})
      return run(client,args)
    }
    const failed=await checkUpdate({projectRoot:client,registry:{},git,busy:async()=>false,apply:true})
    assert.equal(failed.status,'unavailable')
    assert.equal(fs.readFileSync(path.join(client,'app.txt'),'utf8'),'one')
    const recovered=await checkUpdate({projectRoot:client,registry:{},git:async args=>args[0]==='remote'?'https://github.com/ginsonko/codex-yinzi-media-workflow.git':run(client,args),busy:async()=>false,apply:true})
    assert.equal(recovered.status,'updated')
    assert.equal(fs.readFileSync(path.join(client,'app.txt'),'utf8'),'two')
  } finally {fs.rmSync(root,{recursive:true,force:true})}
})

test('unreadable work-status with a live health endpoint stays protected', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({status:'ok'}))
    res.statusCode = 500
    res.end('broken')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const git = async args => args[0] === 'remote' ? 'https://github.com/ginsonko/codex-yinzi-media-workflow.git' : args[0] === 'ls-remote' ? `${'b'.repeat(40)} refs/heads/main` : args[0] === 'status' ? '' : args[0] === 'branch' ? 'main' : 'a'.repeat(40)
    const result = await checkUpdate({projectRoot:'/test/repo',registry:{api_base:origin},git,apply:true})
    assert.equal(result.status,'deferred')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('requireIdle talks HTTP and distinguishes analysis-only legacy from live execution', async () => {
  const counts = {async_tasks: 0, media_batches: 0, production_runs: 0, orchestration_blender_jobs: 0, local_media_jobs: 0, analysis: 3}
  let mode = 'analysis'
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/runtime-work-status') {
      const busy = mode !== 'analysis'
      const payload = mode === 'v2'
        ? {schema: 'yinzi.runtime-work-status/v2', busy: true, blocking: ['execution'], counts: {...counts, local_media_jobs: 1, analysis: 0}}
        : {busy, counts: mode === 'live' ? {...counts, local_media_jobs: 1} : counts}
      res.end(JSON.stringify({data: payload}))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    await requireIdle(origin)
    mode = 'live'
    await assert.rejects(requireIdle(origin), /仍有运行或待核对任务/)
    mode = 'v2'
    await assert.rejects(requireIdle(origin), /仍有运行或待核对任务/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
