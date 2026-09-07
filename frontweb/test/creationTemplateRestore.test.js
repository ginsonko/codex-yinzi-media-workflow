import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCreationTemplate } from '../src/utils/creationTemplateRestore.js'

test('keeps a project-specific draft ahead of the global last-used template', () => {
  assert.equal(resolveCreationTemplate({ restoredDraft: { templateId: 'novel-drama' }, globalTemplateId: 'outfit-change' }), 'novel-drama')
})

test('an explicit route template intentionally overrides the project draft', () => {
  assert.equal(resolveCreationTemplate({ routeTemplateId: 'ecommerce', restoredDraft: { templateId: 'novel-drama' }, globalTemplateId: 'outfit-change' }), 'ecommerce')
})

test('a saved free-template draft is not overwritten by a global preference', () => {
  assert.equal(resolveCreationTemplate({ restoredDraft: { templateId: '' }, globalTemplateId: 'outfit-change' }), '')
})

test('uses the global preference only for a project without a saved draft', () => {
  assert.equal(resolveCreationTemplate({ globalTemplateId: 'outfit-change' }), 'outfit-change')
})
