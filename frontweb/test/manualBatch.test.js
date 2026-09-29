import test from 'node:test'
import assert from 'node:assert/strict'
import { newManualItem, cloneManualItem, manualItemRequest, manualItemIssue, persistedManualDraft, restoreManualDraft, manualCapability, capabilityNotes } from '../src/utils/manualBatch.js'
import { batchSubmission } from '../src/utils/batchRequestKey.js'

const defaults = { model: 'global', settings: { aspect_ratio: '16:9', duration: 5 } }
const options = [{ value: 'site-a', config_id: 1, model: 'a', provider: 'yinzi', preferred: true }, { value: 'site-b', config_id: 2, model: 'b', provider: 'custom' }]
function reference(type, path, role = 'reference') { return { id: path, type, role, local_path: path, status: 'ready', filename: path } }

test('each manual item preserves prompt, credential, settings and separate image/video/audio references', () => {
  const a = newManualItem({ prompt: '  商品转身  ', model: 'site-a', duration: 8, resolution: '720p', references: [reference('image','a.png'),reference('video','a.mp4'),reference('audio','a.wav')] })
  const b = newManualItem({ prompt: '第二镜头', model: 'site-b', aspect_ratio: '9:16', references: [reference('image','b.png')] })
  const requests = [a,b].map(item => manualItemRequest(item,'video',defaults,options))
  assert.deepEqual(requests[0], { prompt:'商品转身',model:'a',provider:'yinzi',video_config_id:1,aspect_ratio:'16:9',duration:8,resolution:'720p',reference_image_urls:['a.png'],reference_video_urls:['a.mp4'],reference_audio_urls:['a.wav'] })
  assert.equal(requests[1].video_config_id,2)
  assert.equal(requests[1].aspect_ratio,'9:16')
  assert.deepEqual(requests[1].reference_image_urls,['b.png'])
  assert.deepEqual(requests[1].reference_video_urls,[])
  assert.deepEqual(requests[1].reference_audio_urls,[])
})
test('first/last frames use the video route fields without duplicating generic references', () => {
  const item=newManualItem({prompt:'连接', references:[reference('image','start.png','first_frame'),reference('image','end.png','last_frame'),reference('image','ref.png')]})
  const request=manualItemRequest(item,'video',defaults,options)
  assert.equal(request.first_frame_url,'start.png'); assert.equal(request.last_frame_url,'end.png')
  assert.deepEqual(request.reference_image_urls,['ref.png'])
  item.references.push(reference('image','extra.png','first_frame'))
  assert.match(manualItemIssue(item,'video'),/首帧/)
})
test('image generation retains image references and does not leak video parameters', () => {
  const item=newManualItem({prompt:'修图',model:'site-a',references:[reference('image','a.png','first_frame'),reference('video','a.mp4')]})
  const request=manualItemRequest(item,'image',defaults,options)
  assert.equal(request.image_config_id,1); assert.equal(request.video_config_id,undefined)
  assert.deepEqual(request.reference_images,['a.png']); assert.equal(request.reference_image_urls,undefined); assert.equal(request.duration,undefined); assert.equal(request.reference_video_urls,undefined)
})
test('uploads waiting or failed cannot be silently omitted while ready files remain', () => {
  const item=newManualItem({prompt:'镜头',references:[reference('image','ready.png'),{id:'pending',type:'video',status:'uploading'}]})
  assert.match(manualItemIssue(item,'video'),/正在上传/)
  item.references[1].status='failed'; assert.match(manualItemIssue(item,'video'),/未上传成功/)
  item.references.pop(); assert.equal(manualItemIssue(item,'video'),'')
})
test('reference-only generation is available without a prompt, but an empty task needs an input', () => {
  assert.match(manualItemIssue(newManualItem(), 'video'), /提示词或添加参考素材/)
  assert.equal(manualItemIssue(newManualItem({ references: [reference('video', 'clip.mp4')] }), 'video'), '')
  assert.equal(manualItemIssue(newManualItem({ references: [reference('image', 'photo.png')] }), 'image'), '')
})
test('copy has independent task and reference identities; editing/removing never changes the original', () => {
  const item=newManualItem({prompt:'original',references:[reference('image','a.png')]})
  const copy=cloneManualItem(item)
  assert.notEqual(copy.id,item.id); assert.notEqual(copy.references[0].id,item.references[0].id)
  copy.references[0].role='last_frame'; copy.prompt='changed'
  assert.equal(item.references[0].role,'reference'); assert.equal(item.prompt,'original')
})
test('draft restores durable references and exposes interrupted upload instead of losing it', () => {
  const item=newManualItem({prompt:'草稿',references:[reference('image','a.png'),{id:'pending',type:'video',status:'uploading',filename:'unfinished.mp4',file:{secret:'bytes'},progress:75}]})
  const json=JSON.stringify(persistedManualDraft([item]))
  assert.equal(json.includes('secret'),false)
  const restored=restoreManualDraft(json)
  assert.equal(restored[0].id,item.id); assert.equal(restored[0].references[0].local_path,'a.png')
  assert.equal(restored[0].references[1].status,'interrupted'); assert.match(manualItemIssue(restored[0],'video'),/未上传成功/)
  assert.equal(restoreManualDraft('broken').length,1)
  assert.equal(restoreManualDraft('[{}]').length,1)
})
test('selected credential effective capability wins and other providers never borrow public catalog metadata', () => {
  const catalog=[{model:'a',capabilities:{max_images:9}},{model:'b',capabilities:{max_images:99}}]
  assert.equal(manualCapability('site-a',options,{1:[{model:'a',capability:{max_images:2},override:{max_audios:1}}]},catalog).max_images,2)
  assert.equal(manualCapability('site-b',options,{},catalog),null)
  assert.equal(manualCapability('',options,{},catalog),null)
  assert.equal(manualCapability('future',options,{},catalog),null)
})
test('unknown/zero capability is advisory; requested model, duration and attachments remain intact', () => {
  const item=newManualItem({prompt:'继续',model:'future-model',duration:75,references:[reference('video','v.mp4')]})
  assert.match(capabilityNotes({max_videos:0},item).join(' '),/不支持/)
  assert.equal(manualItemIssue(item,'video'),'')
  const request=manualItemRequest(item,'video',defaults,options)
  assert.equal(request.model,'future-model'); assert.equal(request.duration,75); assert.deepEqual(request.reference_video_urls,['v.mp4'])
})
test('same exact payload recovers submission identity; changed references and explicit fresh attempts get new identities', () => {
  const item=newManualItem({prompt:'一条',references:[reference('image','a.png')]})
  const body={items:[manualItemRequest(item,'video',defaults,options)]}
  const pending=batchSubmission(body)
  assert.equal(batchSubmission(body,pending).key,pending.key)
  assert.notEqual(batchSubmission(body).key,pending.key)
  item.references[0].local_path='b.png'
  assert.notEqual(batchSubmission({items:[manualItemRequest(item,'video',defaults,options)]},pending).key,pending.key)
})
