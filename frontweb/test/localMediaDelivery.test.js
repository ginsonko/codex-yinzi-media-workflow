import test from 'node:test'
import assert from 'node:assert/strict'
import { localMediaDelivery } from '../src/utils/localMediaDelivery.js'

test('draft success tells the user export is still pending and keeps the real directory', () => {
  const result = localMediaDelivery({ status:'succeeded', result:{details:{stage:'draft_ready', draft_path:'D:/草稿/独立工程', next_action:'在剪映预览'}} })
  assert.equal(result.path, 'D:/草稿/独立工程')
  assert.match(result.status, /待.*导出/)
  assert.doesNotMatch(result.link, /已验证成果|成片/)
  assert.equal(result.next, '在剪映预览')
})
test('environment inspection is not media delivery; failures and regular jobs keep existing flow', () => {
  assert.match(localMediaDelivery({status:'succeeded',result:{details:{stage:'environment_inspected'}}}).status, /尚未制作/)
  assert.equal(localMediaDelivery({status:'failed',result:{details:{stage:'draft_ready'}}}),null)
  assert.equal(localMediaDelivery({status:'succeeded',result:{details:{quality_status:'review_required'}}}),null)
})
test('prepared editor copy exposes its own name and directory while leaving export pending', () => {
  const result = localMediaDelivery({status:'succeeded',result:{details:{stage:'draft_ready',draft_path:'D:/original',editor_delivery:{status:'editor_copy_prepared',draft_path:'D:/editor/副本',project_name:'副本',next_action:'从首页打开'}}}})
  assert.equal(result.path,'D:/editor/副本'); assert.equal(result.name,'副本')
  assert.equal(result.next,'从首页打开'); assert.match(result.status,/待.*导出/)
  assert.match(result.stage,/放入草稿位置/)
})
