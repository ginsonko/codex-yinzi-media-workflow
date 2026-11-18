import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OMNI_EMBED_SESSION_KEY,
  applyRootThemeAndAccent,
  detectAndPersistEmbed,
  parseEmbedParams,
  parseOmniThemeMessage,
  resolveEmbedRedirect,
} from '../src/utils/omniEmbed.js'

function createMockStorage() {
  const map = new Map()
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null },
    setItem(k, v) { map.set(k, String(v)) },
  }
}

function createMockDoc() {
  const classes = new Set()
  const styles = new Map()
  return {
    classes,
    styles,
    documentElement: {
      dataset: {},
      classList: {
        add(c) { classes.add(c) },
        remove(c) { classes.delete(c) },
        contains(c) { return classes.has(c) },
      },
      style: {
        setProperty(k, v) { styles.set(k, v) },
      },
    },
  }
}

test('detects embed=1 / embed=omni and persists session state across internal navigation', () => {
  const storage = createMockStorage()
  const doc = createMockDoc()

  assert.equal(detectAndPersistEmbed({
    win: { location: { search: '?embed=1&theme=dark', hash: '' } },
    doc,
    storage,
  }), true)
  assert.equal(storage.getItem(OMNI_EMBED_SESSION_KEY), '1')
  assert.equal(doc.documentElement.dataset.omniEmbed, '1')
  assert.equal(doc.classes.has('omni-embed'), true)

  // 内部路由跳转丢失 query 后仍能从 sessionStorage 保持嵌入态
  assert.equal(detectAndPersistEmbed({
    win: { location: { search: '', hash: '' } },
    doc,
    storage,
  }), true)

  // 独立浏览器普通访问不进入嵌入模式
  assert.equal(detectAndPersistEmbed({
    win: { location: { search: '', hash: '' } },
    doc: createMockDoc(),
    storage: createMockStorage(),
  }), false)
})

test('redirects admin/management routes to /create-canvas only when embedded', () => {
  for (const blocked of ['/ai-config', '/advanced-settings', '/projects', '/projects/42', '/series-groups', '/supervisors']) {
    assert.equal(resolveEmbedRedirect(blocked, true), '/create-canvas', blocked)
    assert.equal(resolveEmbedRedirect(blocked, false), null, `standalone ${blocked}`)
  }
  for (const allowed of ['/create-canvas', '/create-canvas/abc', '/media-library', '/director', '/codex-console']) {
    assert.equal(resolveEmbedRedirect(allowed, true), null, allowed)
  }
})

test('parses initial URL params and postMessage theme/accent updates cleanly', () => {
  const params = parseEmbedParams('?embed=omni&theme=light&accent=%234f8cff', '')
  assert.deepEqual(params, { embed: 'omni', theme: 'light', accent: '#4f8cff' })

  const msg = parseOmniThemeMessage({ type: 'omni:theme', theme: 'dark', accent: '#ff7a45' })
  assert.deepEqual(msg, { theme: 'dark', accent: '#ff7a45' })
  assert.equal(parseOmniThemeMessage({ type: 'unrelated', theme: 'dark' }), null)

  const doc = createMockDoc()
  applyRootThemeAndAccent({ isDark: false, accent: '#4f8cff', doc })
  assert.equal(doc.classes.has('light'), true)
  assert.equal(doc.classes.has('dark'), false)
  assert.equal(doc.documentElement.dataset.theme, 'light')
  assert.equal(doc.styles.get('--accent'), '#4f8cff')
  assert.equal(doc.styles.get('--ui-accent'), '#4f8cff')
  assert.equal(doc.styles.get('--shell-accent'), '#4f8cff')
  assert.equal(doc.styles.get('--el-color-primary'), '#4f8cff')
  assert.equal(doc.styles.get('--ui-accent-soft'), 'rgba(79, 140, 255, 0.14)')
})
