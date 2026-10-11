import { ref, computed, watch } from 'vue'

/**
 * 界面效果与性能档位。
 *
 * 界面好看不能以吃掉鼠标为代价。所有昂贵的装饰性效果 —— 毛玻璃、
 * 网格底纹、扫光、脉动 —— 都挂在同一个档位上，用户可以在顶栏随时切换，
 * 程序也会在帧率持续偏低时自动降一档（只提示一次）。
 *
 * theme.css 用 :root[data-fx="..."] 读取这个值。
 */

export const EFFECT_LEVELS = [
  { id: 'high',     label: '完整', note: '全部效果：网格底纹、毛玻璃、扫光' },
  { id: 'balanced', label: '均衡', note: '保留毛玻璃与底纹，去掉持续动效' },
  { id: 'eco',      label: '轻量',   note: '去掉毛玻璃，面板改实色' },
  { id: 'off',      label: '极简',   note: '只留基本样式与必要的状态提示' },
]

const KEY = 'yinzi-effects-level'
const RANK = { high: 0, balanced: 1, eco: 2, off: 3 }

const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
const level = ref(EFFECT_LEVELS.some((l) => l.id === saved) ? saved : 'balanced')
const autoDegraded = ref(false)

function apply(id) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.fx = id
}

apply(level.value)
watch(level, (value) => {
  apply(value)
  try { localStorage.setItem(KEY, value) } catch (_) {}
  // 页面里自带的昂贵视觉（首页的液态银 hero 等）靠这个事件按新档位重建自己
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('yinzi:effects-changed', { detail: { level: value } }))
  }
})

/** 某个效果在当前档位下是否启用 */
export function fxEnabled(name) {
  const l = level.value
  switch (name) {
    case 'grain':  return l === 'high'
    case 'blur':   return l === 'high' || l === 'balanced'
    case 'anim':   return l === 'high'
    case 'decor':  return l !== 'off'
    default:       return l !== 'off'
  }
}

function setLevel(id, { auto = false } = {}) {
  if (!EFFECT_LEVELS.some((l) => l.id === id)) return
  level.value = id
  if (!auto) autoDegraded.value = false
}

/* ── 帧率看门狗 ──────────────────────────────────────────────
   只在页面可见时采样（标签页隐藏时 rAF 不触发，天然排除）。
   连续 3 个一秒窗口低于 45 帧就降一档，并只提示一次。 */
let started = false
export function startFpsWatch({ floor = 45, windows = 3 } = {}) {
  if (started || typeof window === 'undefined') return
  started = true
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

  let frames = 0, windowStart = performance.now(), slow = 0
  const tick = (now) => {
    frames++
    if (now - windowStart >= 1000) {
      const fps = frames * 1000 / (now - windowStart)
      frames = 0; windowStart = now
      if (fps < floor && level.value !== 'off') {
        if (++slow >= windows) {
          slow = 0
          const next = EFFECT_LEVELS[Math.min(RANK[level.value] + 1, EFFECT_LEVELS.length - 1)]
          if (next.id !== level.value) {
            const from = EFFECT_LEVELS.find((l) => l.id === level.value)?.label
            setLevel(next.id, { auto: true })
            autoDegraded.value = true
            // 只在自动降级时提示一次，避免打扰
            window.dispatchEvent(new CustomEvent('yinzi:effects-degraded', {
              detail: { from, to: next.id, label: next.label, fps: Math.round(fps) },
            }))
          }
        }
      } else slow = 0
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** 手动采样：设置面板里「测一下帧率」用 */
export function measureFps(ms = 1200) {
  return new Promise((resolve) => {
    let frames = 0
    const t0 = performance.now()
    const tick = (t) => {
      frames++
      if (t - t0 >= ms) resolve(Math.round(frames * 1000 / (t - t0)))
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

export function useEffects() {
  return {
    level,
    autoDegraded,
    levels: EFFECT_LEVELS,
    current: computed(() => EFFECT_LEVELS.find((l) => l.id === level.value) || EFFECT_LEVELS[1]),
    setLevel,
    measureFps,
  }
}
