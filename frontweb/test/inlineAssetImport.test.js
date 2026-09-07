import test from 'node:test'
import assert from 'node:assert/strict'
import { freshScanDescriptors, pendingUploadItems, restoredRelativePaths } from '../src/utils/inlineAssetImport.js'

test('zero-byte browser picker placeholders are not treated as uploadable files', () => {
  const stale = new Blob([], { type: 'image/png' }); Object.defineProperty(stale, 'name', { value: 'stale.png' })
  const valid = new Blob(['ok'], { type: 'image/png' }); Object.defineProperty(valid, 'name', { value: 'valid.png' })
  const items = [
    { file: stale, relative_path: 'stale.png' },
    { file: valid, relative_path: 'valid.png' },
  ]
  assert.deepEqual(pendingUploadItems(items).map((item) => item.file.name), ['valid.png'])
})

test('restored session rows are never appended to FormData as fake files', () => {
  const restored = { restored: true, relative_path: 'old/hero.png', file: { name: 'hero.png', size: 12, type: 'image/png' } }
  const freshBlob = new Blob(['new'], { type: 'text/plain' })
  Object.defineProperty(freshBlob, 'name', { value: 'notes.txt' })
  const fresh = { restored: false, relative_path: 'new/notes.txt', file: freshBlob, source_token: null }
  assert.deepEqual(pendingUploadItems([restored, fresh]), [fresh])
  assert.deepEqual(restoredRelativePaths([restored, fresh]), ['old/hero.png'])
})

test('only newly staged browser files are sent as explicit scan descriptors', () => {
  const restored = { restored: true, relative_path: 'old/hero.png', file: { name: 'hero.png' } }
  const freshBlob = new Blob(['new'], { type: 'text/plain' })
  Object.defineProperty(freshBlob, 'name', { value: 'notes.txt' })
  const fresh = { restored: false, relative_path: 'new/notes.txt', file: freshBlob, source_token: 'opaque-new' }
  assert.deepEqual(freshScanDescriptors([restored, fresh]), [{
    relative_path: 'new/notes.txt', file_name: 'notes.txt', source_token: 'opaque-new', bytes: 3, mime_type: 'text/plain',
  }])
})

test('restored rows are idempotent when the user selects the same file again', () => {
  const rows = [{ relative_path: 'character.png', file: { name: 'character.png', size: 100 } }]
  const incoming = [{ name: 'character.png', size: 100, lastModified: 2 }]
  const identities = new Set(rows.map((item) => `${item.relative_path}:${item.file.size}`))
  for (const file of incoming) identities.add(`${file.name}:${file.size}`)
  assert.equal(identities.size, 1)
})
