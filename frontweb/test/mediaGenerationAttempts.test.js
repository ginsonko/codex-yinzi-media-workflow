import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { batchSubmission } from '../src/utils/batchRequestKey.js'
import { computed, reactive, ref } from 'vue'

const storeSource = fs.readFileSync(new URL('../src/stores/generationTaskStore.js', import.meta.url), 'utf8')
const filmSource = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const freeSource = fs.readFileSync(new URL('../src/views/FreeCreate.vue', import.meta.url), 'utf8')
function makeStore() {
  const timers = []
  const context = {
    ref: value => ({ value }), computed: getter => ({ get value() { return getter() } }),
    defineStore: (name, setup) => setup, crypto: { randomUUID }, console,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }) },
    taskAPI: { get: async () => ({ status: 'processing' }) },
    imagesAPI: {}, videosAPI: {},
  }
  vm.createContext(context)
  vm.runInContext(storeSource.replace(/^import .*\r?\n/gm, '').replaceAll('export const ', 'const ') + '\nthis.store = useGenerationTaskStore()', context)
  return { store: context.store, context, timers }
}
const baseMeta = () => ({ dramaId: 1, episodeId: 2, resourceType: 'sb_video', resourceId: 3 })
function extract(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) }

test('production regeneration distinguishes a fresh historical click from a lost retry receipt', async () => {
  const source = fs.readFileSync(new URL('../src/views/ProductionWorkflow.vue', import.meta.url), 'utf8')
  const calls = []
  let loseReceipt = false
  const context = {
    activeRun: { value: { id: 'run-1' } }, regeneratingActionId: { value: null },
    regenerationRequests: new Map(), crypto: { randomUUID },
    productionAPI: { retry: async (id, body) => { calls.push({ id, ...body }); if (loseReceipt) throw new Error('lost receipt') } },
    loadRun: async () => {}, driveRun: async () => {}, ElMessage: { info() {}, error() {} },
  }
  vm.createContext(context)
  vm.runInContext(extract(source, 'async function regenerateAction', '\nasync function retryDirectorFailure'), context)
  await context.regenerateAction({ id: 17 })
  await context.regenerateAction({ id: 17 })
  assert.notEqual(calls[0].request_key, calls[1].request_key)
  loseReceipt = true
  await context.regenerateAction({ id: 17 })
  loseReceipt = false
  await context.regenerateAction({ id: 17 })
  assert.equal(calls[2].request_key, calls[3].request_key)
  assert.equal(context.regenerationRequests.size, 0)
  assert.equal(context.regeneratingActionId.value, null)
})

function productionRegenerationFixture() {
  const source = fs.readFileSync(new URL('../src/views/ProductionWorkflow.vue', import.meta.url), 'utf8')
  const calls = []
  const context = {
    activeRun: ref({ id: 'run-1' }), regeneratingActionId: ref(null),
    regenerationRequests: reactive(new Map()), crypto: { randomUUID },
    productionAPI: { retry: async (id, body) => { calls.push({ id, ...body }); throw new Error('lost receipt') } },
    loadRun: async () => {}, driveRun: async () => {}, ElMessage: { info() {}, error() {} },
  }
  vm.createContext(context)
  vm.runInContext(extract(source, 'function hasPendingRegeneration', '\nasync function retryDirectorFailure'), context)
  return { context, calls }
}

for (const path of ['active provider', 'historical artifact']) {
  test(`production ${path} exposes reactive pending choice and an explicit fresh request`, async () => {
    const { context: c, calls } = productionRegenerationFixture()
    const action = path === 'active provider' ? { id: 17, status: 'waiting' } : { id: 29 }
    const showChoice = computed(() => c.hasPendingRegeneration(action.id) && c.regeneratingActionId.value === null)
    c.regenerationRequests.set('other-run:17', 'untouched')
    assert.equal(showChoice.value, false)
    await c.regenerateAction(action)
    assert.equal(showChoice.value, true, 'failed POST reveals the choice without reloading')
    const oldKey = calls[0].request_key
    await c.regenerateAction(action, { type: 'click' })
    assert.equal(calls[1].request_key, oldKey, 'ordinary click recovers the pending request')
    let finish
    c.productionAPI.retry = (id, body) => { calls.push({ id, ...body }); return new Promise(resolve => { finish = resolve }) }
    const fresh = c.regenerateAction(action, true)
    assert.equal(showChoice.value, false)
    assert.notEqual(calls[2].request_key, oldKey)
    assert.equal(calls[2].action_id, action.id)
    assert.equal(calls[2].id, 'run-1')
    await c.regenerateAction(action, true)
    assert.equal(calls.length, 3, 'fresh double-click cannot create another pending POST')
    c.loadRun = async () => { throw new Error('refresh failed after receipt') }
    finish({})
    await fresh
    assert.equal(showChoice.value, false, 'refresh failure cannot revive the acknowledged request')
    assert.equal(c.regenerationRequests.has(`run-1:${action.id}`), false)
    assert.equal(c.regenerationRequests.get('other-run:17'), 'untouched')
    c.productionAPI.retry = async (id, body) => { calls.push({ id, ...body }) }
    await c.regenerateAction(action)
    assert.notEqual(calls[3].request_key, calls[2].request_key, 'ordinary click after receipt is a new attempt')
    assert.equal(c.regeneratingActionId.value, null)
  })
}

test('production receipt releases POST lock before refreshing and old refresh cannot clear a newer POST', async () => {
  const { context: c, calls } = productionRegenerationFixture()
  let finishRefresh, finishSecond
  c.productionAPI.retry = async (id, body) => { calls.push({ id, ...body }) }
  c.loadRun = () => new Promise(resolve => { finishRefresh = resolve })
  const first = c.regenerateAction({ id: 17 })
  await flush()
  assert.equal(c.regeneratingActionId.value, null)
  c.productionAPI.retry = (id, body) => { calls.push({ id, ...body }); return new Promise(resolve => { finishSecond = resolve }) }
  const second = c.regenerateAction({ id: 17 })
  assert.equal(c.regeneratingActionId.value, 17)
  finishRefresh()
  await first
  assert.equal(c.regeneratingActionId.value, 17, 'old follow-up cannot unlock the new POST')
  c.loadRun = async () => {}
  finishSecond({})
  await second
  assert.equal(c.regeneratingActionId.value, null)
  assert.notEqual(calls[0].request_key, calls[1].request_key)
})

test('completed old attempts and their delayed cleanup cannot finish or delete the newer attempt', () => {
  const { store, timers } = makeStore()
  const old = baseMeta(), current = baseMeta()
  store.markRunning(old)
  store.markRunning(current)
  assert.notEqual(old.attemptId, current.attemptId)
  store.markDone(old)
  assert.equal(store.isRunning(current), true)
  assert.equal(store.isCurrentAttempt(old), false)
  assert.equal(store.isCurrentAttempt(current), true)
  for (const timer of timers) timer.callback()
  assert.equal(store.isRunning(current), true)
  assert.equal(store.tasks.value.size, 1)
})

test('POST pending releases independently from provider running and recovered tasks never impose it', () => {
  const { store } = makeStore()
  const meta = { ...baseMeta(), submitting: true }
  store.markRunning(meta)
  assert.equal(store.isSubmitting(baseMeta()), true)
  store.finishSubmission(meta)
  assert.equal(store.isSubmitting(baseMeta()), false)
  assert.equal(store.isRunning(baseMeta()), true)
  store.markRunning({ ...baseMeta(), recovering: true, taskId: 'old-provider' })
  assert.equal(store.isSubmitting(baseMeta()), false)
  assert.equal(store.isCurrentAttempt(meta), true)
})

test('late old polling result preserves current run and cannot execute its display callback', async () => {
  const { store, context, timers } = makeStore()
  let oldDisplays = 0, newDisplays = 0
  const old = baseMeta(), current = baseMeta()
  const oldPoll = store.pollTask('old-task', old, () => oldDisplays++)
  const newPoll = store.pollTask('new-task', current, () => newDisplays++)
  context.taskAPI.get = async id => ({ status: 'completed', result: id })
  await timers[0].callback()
  await oldPoll
  assert.equal(oldDisplays, 0)
  assert.equal(store.isRunning(current), true)
  await timers[1].callback()
  await newPoll
  assert.equal(newDisplays, 1)
})

test('registering the same old task for recovery cannot supersede a new explicit attempt', () => {
  const { store } = makeStore()
  const old = { ...baseMeta(), taskId: 'old-task' }
  const current = { ...baseMeta(), taskId: 'new-task' }
  store.markRunning(old)
  store.markRunning(current)
  store.markRunning({ ...baseMeta(), taskId: 'old-task', recovering: true })
  assert.equal(store.isCurrentAttempt(current), true)
  store.markDone({ ...baseMeta(), taskId: 'old-task' })
  assert.equal(store.isRunning(current), true)
})

test('manual references are accepted beyond unknown or advisory catalog counts', async () => {
  const uploaded = []
  const references = { value: [] }
  const context = {
    collectionFor: () => references,
    uploadAPI: { uploadReferenceMedia: async file => { uploaded.push(file); return { filename: file.name, local_path: file.name } } },
    uploadingType: { value: '' },
  }
  vm.createContext(context)
  vm.runInContext(extract(freeSource, 'async function onReferenceFiles', '\nfunction removeReference'), context)
  await context.onReferenceFiles('image', { target: { files: Array.from({ length: 9 }, (_, id) => ({ name: id + '.png', type: 'image/png' })) } })
  assert.equal(uploaded.length, 9)
  assert.equal(references.value.length, 9)
  assert.equal(context.uploadingType.value, '')
  assert.match(freeSource, /filterable allow-create/)
  assert.doesNotMatch(freeSource, /durationBounds|Math\.min\(bounds\.max/)
})

test('manual explicit retry accepts old processing/completed/uncertain items without confirmation', async () => {
  const calls = []
  const context = {
    retrying: new Set(),
    mediaBatchAPI: { retry: async (...args) => calls.push(args) },
    loadHistory: async () => {},
    ElMessage: { success() {}, error() {} },
  }
  vm.createContext(context)
  vm.runInContext(extract(freeSource, 'async function retryGeneration', '\nlet historyRead'), context)
  for (const status of ['processing', 'completed', 'needs_review']) {
    await context.retryGeneration({ batch_id: 'batch', id: status, attempt: 2, status })
  }
  assert.equal(calls.length, 3)
  assert.equal(calls[0][2].expected_attempt, 2)
  assert.equal(context.retrying.size, 0)
})

function filmFixture() {
  const { store } = makeStore()
  const submits = [], polls = [], notices = []
  const context = {
    dramaId: { value: 1 }, sbCanSubmitVideo: sb => !!sb.video_prompt,
    isMediaSubmitting: id => store.isSubmitting({ ...baseMeta(), resourceId: id }),
    buildSbGenMeta: (sb, resourceType) => ({ ...baseMeta(), resourceId: sb.id, resourceType }),
    GEN_RESOURCE: { SB_VIDEO: 'sb_video' }, genStore: store,
    isSbUniversalMode: () => true, collectSbOmniReferenceAbsoluteUrls: () => [],
    getSbFirstFrameUrl: () => '', getActiveVideoAiConfig: async () => null,
    canUseUniversalOmniVideoApi: () => false,
    ElMessage: { info: message => notices.push(message), success: message => notices.push(message), error: message => notices.push(message) },
    generatingSbVideoIds: new Set(), sbVideoErrors: { value: {} }, sbSelectedVideoId: { value: {} },
    storyboardsAPI: { update: async () => {} },
    storyboardMediaReads: new Map(),
    sbVideoFirstLastUrls: () => ({ first: undefined, last: undefined }),
    buildSbVideoPromptForApi: sb => sb.video_prompt,
    getSelectedStyle: () => '', projectAspectRatio: { value: '16:9' }, videoResolution: { value: '' }, getSbVideoDurationForApi: () => 5,
    videosAPI: { create: body => new Promise(resolve => submits.push({ body, resolve })) },
    pollTask: (id, onDone, meta) => { meta.taskId = id; return new Promise(resolve => polls.push({ resolve, meta, id })) },
    loadSingleStoryboardMedia: async () => {},
  }
  vm.createContext(context)
  vm.runInContext(extract(filmSource, 'async function onGenerateSbVideo', '/** 尾帧衔接'), context)
  return { context, submits, polls, notices, store }
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

test('film unknown capability and absent optional references submit once per click, allowing a new running attempt', async () => {
  const { context: c, submits, polls, store } = filmFixture()
  const sb = { id: 3, video_prompt: 'cloud movement' }
  const first = c.onGenerateSbVideo(sb)
  await flush()
  assert.equal(submits.length, 1)
  await c.onGenerateSbVideo(sb)
  assert.equal(submits.length, 1, 'same POST pending prevents duplicate click')
  submits[0].resolve({ task_id: 'old-task' })
  await flush()
  assert.equal(polls.length, 1)
  assert.equal(store.isSubmitting(baseMeta()), false)
  const second = c.onGenerateSbVideo(sb)
  await flush()
  assert.equal(submits.length, 2, 'old provider wait does not lock explicit retry')
  submits[1].resolve({ task_id: 'new-task' })
  await flush()
  polls[0].resolve({ status: 'failed', error: 'late old failure' })
  await first
  assert.equal(c.sbVideoErrors.value[3], '')
  assert.equal(store.isCurrentAttempt(polls[1].meta), true)
  polls[1].resolve({ status: 'completed' })
  await second
})

test('film retry controls use POST pending and expose explicit full-batch regeneration', () => {
  assert.doesNotMatch(filmSource, /:disabled="[^"]*isSbVideoGenerating/)
  assert.doesNotMatch(filmSource, /:loading="isSbVideoGenerating/)
  assert.match(filmSource, /startBatchImageGeneration\(true\)/)
  assert.match(filmSource, /startBatchVideoGeneration\(true\)/)
  const orchestration = fs.readFileSync(new URL('../src/views/CodexOrchestration.vue', import.meta.url), 'utf8')
  assert.match(orchestration, /retryPending\.has\(node\.id\) \|\| !assertRuntimeReady\(\)/)
  assert.match(orchestration, /canDirectlyRetryNode\(node, latestReceipt/)
})

test('a failed film submission releases pending and retains failure instead of a false completion', async () => {
  const { context: c, store } = filmFixture()
  c.videosAPI.create = async () => { throw new Error('connection lost') }
  await c.onGenerateSbVideo({ id: 3, video_prompt: 'cloud movement' })
  assert.equal(store.isSubmitting(baseMeta()), false)
  assert.equal(c.sbVideoErrors.value[3], 'connection lost')
  assert.equal([...store.tasks.value.values()][0].status, 'failed')
})

test('explicit film batch regeneration remains available after submit while prior results are pending', async () => {
  const { store } = makeStore()
  const submits = [], polls = []
  const c = {
    currentEpisodeId: { value: 2 }, batchImagePreparing: { value: false }, batchImageSubmitting: { value: 0 },
    batchImageErrors: { value: [] }, batchImageStopping: { value: false }, batchImageRunning: { value: false },
    batchImageProgress: { value: {} }, sbImages: { value: { 3: [] } },
    store: { storyboards: [{ id: 3, description: 'image' }] }, hasSbImage: () => true,
    pipelineConcurrency: { value: 1 }, storyboardUseFirstLastFrame: { value: false },
    isSbUniversalMode: () => false,
    buildSbGenMeta: (sb, resourceType) => ({ ...baseMeta(), resourceId: sb.id, resourceType }),
    GEN_RESOURCE: { SB_FIRST_IMAGE: 'sb_first_image', SB_IMAGE: 'sb_image' }, genStore: store,
    gridMode: { value: 'single' }, dramaId: { value: 1 }, getSelectedStyle: () => '', projectAspectRatio: { value: '16:9' },
    imagesAPI: { create: body => new Promise(resolve => submits.push({ resolve, body })) },
    pollTask: (id, callback, meta) => { meta.taskId = id; return new Promise(resolve => polls.push({ resolve })) },
    loadSingleStoryboardMedia: async () => {}, restoreSelectionsFromBackend() {},
    ElMessage: { info() {}, success() {}, warning() {} },
  }
  vm.createContext(c)
  vm.runInContext('let batchImageRun = 0;\n' + extract(filmSource, 'async function startBatchImageGeneration', '\nasync function startBatchVideoGeneration'), c)
  const first = c.startBatchImageGeneration(true)
  await flush()
  assert.equal(submits.length, 1)
  await c.startBatchImageGeneration(true)
  assert.equal(submits.length, 1)
  submits[0].resolve({ task_id: 'old' })
  await flush()
  const second = c.startBatchImageGeneration(true)
  await flush()
  assert.equal(submits.length, 2)
  submits[1].resolve({ task_id: 'new' })
  await flush()
  polls[0].resolve({ status: 'failed', error: 'old' })
  await first
  assert.equal(c.batchImageErrors.value.length, 0)
  assert.equal(c.batchImageRunning.value, true)
  polls[1].resolve({ status: 'completed' })
  await second
  assert.equal(c.batchImageRunning.value, false)
  assert.equal(c.batchImageSubmitting.value, 0)
})

test('regenerate frame pair regenerates an existing first frame before the last frame', async () => {
  const calls = []
  const c = {
    onGenerateSbFrameImage: async (sb, slot) => calls.push(slot),
    getSbFirstImage: () => ({ id: 5 }),
  }
  vm.createContext(c)
  vm.runInContext(extract(filmSource, 'async function onGenerateSbFramePair', '\n// ─────'), c)
  await c.onGenerateSbFramePair({ id: 3 })
  assert.deepEqual(calls, ['first', 'last'])
})

test('related-image retry releases its submit lock while the provider is still processing', async () => {
  const { store } = makeStore()
  const polls = [], submits = []
  const c = {
    regenSbImagesForAsset: new Set(), regenSbImagesProgress: { value: {} },
    storyboardUseFirstLastFrame: { value: false }, isSbUniversalMode: () => false,
    buildSbGenMeta: (sb, resourceType) => ({ ...baseMeta(), resourceId: sb.id, resourceType }),
    GEN_RESOURCE: { SB_IMAGE: 'sb_image', SB_FIRST_IMAGE: 'sb_first_image' }, genStore: store,
    imagesAPI: { create: async body => { submits.push(body); return { task_id: 'task-' + submits.length } } },
    dramaId: { value: 1 }, projectAspectRatio: { value: '16:9' }, getSelectedStyle: () => '',
    pollTask: (id, callback, meta) => { meta.taskId = id; return new Promise(resolve => polls.push({ resolve })) },
    loadSingleStoryboardMedia: async () => {}, ElMessage: { success() {}, warning() {} },
  }
  vm.createContext(c)
  vm.runInContext(extract(filmSource, 'const relatedImageRuns', '\nfunction updateStoryboardDialogue'), c)
  const first = c.onRegenAffectedSbImages('char-1', [{ id: 3, description: 'reference' }])
  await flush()
  assert.equal(c.regenSbImagesForAsset.has('char-1'), false)
  const second = c.onRegenAffectedSbImages('char-1', [{ id: 3, description: 'reference' }])
  await flush()
  assert.equal(submits.length, 2)
  polls[0].resolve({ status: 'failed' })
  await first
  assert.equal(c.regenSbImagesProgress.value['char-1'].current, 0)
  polls[1].resolve({ status: 'completed' })
  await second
  assert.equal(c.regenSbImagesProgress.value['char-1'], undefined)
})

for (const kind of ['manual', 'batch']) {
  test(`${kind} lost receipt keeps ordinary recovery but explicit fresh uses a new key immediately`, async () => {
    const calls = [], saved = new Map()
    const pending = { value: null }, submitting = { value: false }
    let finish
    const context = {
      crypto: { randomUUID }, batchSubmission,
      sessionStorage: { setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
      mediaBatchAPI: { create: async body => { calls.push(body); throw new Error('lost receipt') } },
      ElMessage: { success() {}, error() {} },
      loadHistory: async () => {}, refresh: async () => {}, historyPage: { value: 1 },
      submission: pending, generating: submitting,
      prompt: { value: 'new attempt' }, mode: { value: 'image' }, style: { value: '' },
      aspectRatio: { value: '16:9' }, imageReferences: { value: [] },
      pendingSubmission: pending, submitting, submitError: { value: '' }, canSubmit: { value: true },
      form: { prompt: 'new attempt', lines: '', kind: 'image', count: 1, concurrency: 1, model: '', settings: { aspect_ratio: '16:9' } },
      batchModelSelection: () => ({}), modelOptions: { value: [] },
      selectionRead: 0, activeBatch: { value: null }, selectedBatchId: { value: '' }, itemPage: { value: 1 },
    }
    vm.createContext(context)
    const source = kind === 'manual' ? freeSource : fs.readFileSync(new URL('../src/views/BatchControl.vue', import.meta.url), 'utf8')
    const name = kind === 'manual' ? 'generate' : 'createBatch'
    vm.runInContext(extract(source, `async function ${name}`, kind === 'manual' ? '\nuseLiveRefresh' : '\nasync function updateBatch'), context)
    const submit = context[name]
    await submit()
    const originalKey = calls[0].idempotency_key
    assert.equal(pending.value.key, originalKey, 'failed request remains available immediately')
    assert.equal(submitting.value, false)
    assert.equal(JSON.parse([...saved.values()][0]).key, originalKey)
    await submit({ type: 'click' })
    assert.equal(calls[1].idempotency_key, originalKey, 'ordinary click event recovers the same request')
    context.prompt.value = ''
    context.canSubmit.value = false
    await submit(true)
    assert.equal(calls.length, 2)
    assert.equal(pending.value.key, originalKey, 'invalid form cannot discard the old identity')
    context.prompt.value = 'new attempt'
    context.canSubmit.value = true
    context.mediaBatchAPI.create = body => { calls.push(body); return new Promise(resolve => { finish = resolve }) }
    const fresh = submit(true)
    assert.equal(calls.length, 3)
    assert.notEqual(calls[2].idempotency_key, originalKey)
    assert.equal(pending.value.key, calls[2].idempotency_key)
    assert.equal(JSON.parse([...saved.values()][0]).key, calls[2].idempotency_key)
    await submit(true)
    assert.equal(calls.length, 3, 'fresh double-click cannot create a second in-flight request')
    finish({ id: 'new-batch' })
    await fresh
    assert.equal(pending.value, null)
    assert.equal(submitting.value, false)
    assert.equal(saved.size, 0)
    const stripKey = body => { const copy = { ...body }; delete copy.idempotency_key; return copy }
    assert.deepEqual(stripKey(calls[0]), stripKey(calls[2]), 'explicit fresh preserves the requested payload')
  })
}
