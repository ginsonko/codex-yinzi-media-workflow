import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

test('effect changes rebuild the hero on the same canvas and release listeners/resources', () => {
  const listeners = new Map()
  const stats = { created: 0, deleted: 0, lost: 0 }
  const level = { value: 'balanced' }
  let dispose
  const gl = new Proxy({
    createShader: () => ({}), getShaderParameter: () => true,
    createProgram: () => { stats.created++; return {} },
    deleteProgram: () => { stats.deleted++ },
    getExtension: () => ({ loseContext: () => { stats.lost++ } }),
  }, { get: (target, key) => key in target ? target[key] : () => {} })
  const window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) },
    matchMedia: () => ({ matches: false }), devicePixelRatio: 1,
  }
  const context = vm.createContext({
    window, document: {}, performance, ref: value => ({ value }),
    onBeforeUnmount: fn => { dispose = fn }, useEffects: () => ({ level }),
    EFFECT_LEVELS: [], fxEnabled: name => name === 'anim' ? level.value === 'high' : level.value !== 'off',
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    IntersectionObserver: class { observe() {} disconnect() {} },
  })
  const source = fs.readFileSync(new URL('../src/composables/useSilverHero.js', import.meta.url), 'utf8')
  vm.runInContext(source.replace(/^import .*\r?\n/gm, '').replaceAll('export function ', 'function ') + '\nthis.hero = useSilverHero()', context)
  context.hero.heroCanvas.value = {
    getContext: () => { assert.equal(stats.lost, 0); return gl },
    addEventListener() {}, removeEventListener() {},
  }
  context.hero.mount()
  assert.equal(stats.created, 1)
  for (const value of ['high', 'off', 'balanced']) {
    level.value = value
    assert.equal(typeof listeners.get('yinzi:effects-changed'), 'function')
    listeners.get('yinzi:effects-changed')()
  }
  assert.equal(stats.created, 3)
  assert.equal(stats.deleted, 2)
  dispose()
  assert.equal(stats.deleted, 3)
  assert.equal(stats.lost, 0)
  assert.equal(listeners.size, 0)
})
