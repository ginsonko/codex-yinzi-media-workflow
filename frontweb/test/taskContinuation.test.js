import test from 'node:test'
import assert from 'node:assert/strict'
import { codexTaskLink, taskContinuationPrompt } from '../src/utils/taskContinuation.js'

const id = '11111111-2222-3333-4444-555555555555'
test('continuation targets the saved task without copying credentials or source instructions', () => {
  const prompt = taskContinuationPrompt({ id, title: 'private-title', user_goal: 'secret-value', source_context: { api_key: 'never-copy-me' } })
  assert.ok(prompt.includes(id))
  assert.match(prompt, /回执和检查点/)
  assert.match(prompt, /不重复提交/)
  assert.doesNotMatch(prompt, /private-title|secret-value|never-copy-me/)
  assert.equal(taskContinuationPrompt({}), '')
  assert.equal(taskContinuationPrompt({ id: 'id\nnew instructions' }), '')
})

test('only an explicit valid Codex task identity creates a deep link', () => {
  assert.equal(codexTaskLink({ id }), null)
  assert.equal(codexTaskLink({ source_context: { codex_thread_id: id } }), `codex://threads/${id}`)
  for (const value of ['https://foreign.invalid', 'javascript:alert(1)', `${id}?new=value`, { id }]) {
    assert.equal(codexTaskLink({ source_context: { codex_thread_id: value } }), null)
  }
})
