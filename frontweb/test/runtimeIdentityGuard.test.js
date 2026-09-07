import assert from 'node:assert/strict'
import test from 'node:test'
import { canWriteRuntime, runtimeIdentityKey } from '../src/utils/runtimeIdentityGuard.js'

const identity = {
  schema: 'yinzi.workflow-runtime-identity/v1',
  app_version: '0.1.4',
  source_revision: 'source-a',
  database: { fingerprint: 'db-a' },
  orchestration_router: true,
}

test('runtime identity key is stable and bounded to pairing fields', () => {
  assert.equal(runtimeIdentityKey(identity), 'yinzi.workflow-runtime-identity/v1|0.1.4|source-a|db-a|true')
  assert.equal(runtimeIdentityKey(null), '')
})

test('runtime writes require a matching baseline and no diagnostic error', () => {
  const baselineKey = runtimeIdentityKey(identity)
  assert.equal(canWriteRuntime({ identity, baselineKey }), true)
  assert.equal(canWriteRuntime({ identity: { ...identity, source_revision: 'source-b' }, baselineKey }), false)
  assert.equal(canWriteRuntime({ identity, baselineKey, error: 'identity unavailable' }), false)
  assert.equal(canWriteRuntime({ identity, baselineKey, mismatch: true }), false)
})
