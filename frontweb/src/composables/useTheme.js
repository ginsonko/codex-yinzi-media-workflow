import { ref, watchEffect } from 'vue'
import {
  applyRootThemeAndAccent,
  detectAndPersistEmbed,
  parseEmbedParams,
  parseOmniThemeMessage,
  sanitizeAccentColor,
} from '@/utils/omniEmbed'

const STORAGE_KEY = 'lmd-theme'
const ACCENT_STORAGE_KEY = 'lmd-accent'

// 读取初始 URL 参数（?embed=1|omni&theme=dark|light&accent=...），支持首次加载即对齐宿主皮肤
const initialUrlParams = typeof window !== 'undefined'
  ? parseEmbedParams(window.location.search, window.location.hash)
  : { embed: '', theme: '', accent: '' }

const initialThemeFromStorage = typeof localStorage !== 'undefined'
  ? localStorage.getItem(STORAGE_KEY)
  : null
const initialAccentFromStorage = typeof sessionStorage !== 'undefined'
  ? (() => { try { return sessionStorage.getItem(ACCENT_STORAGE_KEY) || '' } catch (_) { return '' } })()
  : ''

const isDark = ref(
  initialUrlParams.theme === 'light'
    ? false
    : initialUrlParams.theme === 'dark'
      ? true
      : initialThemeFromStorage !== 'light'
)
const accentColor = ref(
  sanitizeAccentColor(initialUrlParams.accent) || sanitizeAccentColor(initialAccentFromStorage)
)
const isEmbedded = ref(detectAndPersistEmbed())

/**
 * 将当前响应式主题状态与强调色同步应用到 html 根节点与本地存储
 */
function apply() {
  if (typeof document !== 'undefined') {
    applyRootThemeAndAccent({
      isDark: isDark.value,
      accent: accentColor.value,
      doc: document,
    })
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, isDark.value ? 'dark' : 'light')
    }
    if (accentColor.value && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(ACCENT_STORAGE_KEY, accentColor.value)
    }
  } catch (_) {
    /* 忽略受限存储环境异常 */
  }
}

/**
 * 设置明暗主题（'dark' | 'light'）
 */
export function setTheme(mode) {
  const normalized = String(mode || '').trim().toLowerCase()
  if (normalized === 'dark') isDark.value = true
  else if (normalized === 'light') isDark.value = false
}

/**
 * 设置宿主强调色（写入 --accent / --ui-accent / --shell-accent / --el-color-primary）
 */
export function setAccent(rawAccent) {
  const safe = sanitizeAccentColor(rawAccent)
  if (safe) accentColor.value = safe
}

/**
 * 在路由切换时同步 query 中的 embed / theme / accent 参数
 */
export function syncEmbedFromRoute(routeQuery = {}) {
  if (detectAndPersistEmbed({ routeQuery })) {
    isEmbedded.value = true
  }
  if (routeQuery?.theme) setTheme(routeQuery.theme)
  if (routeQuery?.accent) setAccent(routeQuery.accent)
  return isEmbedded.value
}

// 初始立即应用一次并注册响应式监听
apply()
watchEffect(apply)

// 监听宿主窗口通过 postMessage 发送的 { type: 'omni:theme', theme: 'dark' | 'light', accent?: string } 实时换肤指令
if (typeof window !== 'undefined' && !window.__OMNI_THEME_LISTENER_BOUND__) {
  window.__OMNI_THEME_LISTENER_BOUND__ = true
  window.addEventListener('message', (event) => {
    const parsed = parseOmniThemeMessage(event?.data)
    if (!parsed) return
    if (parsed.theme) setTheme(parsed.theme)
    if (parsed.accent) setAccent(parsed.accent)
    apply()
  })
}

export function useTheme() {
  function toggle() {
    isDark.value = !isDark.value
  }
  return {
    isDark,
    isEmbedded,
    accentColor,
    toggle,
    setTheme,
    setAccent,
    syncEmbedFromRoute,
  }
}
