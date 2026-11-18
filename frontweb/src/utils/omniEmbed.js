/**
 * 万能创作终端（Omni）无壳嵌入模式与主题同步工具
 *
 * 设计要点：
 * 1. 当 iframe 以 ?embed=1 或 ?embed=omni 打开（或注入 window.__OMNI_EMBED__）时进入无壳嵌入模式，
 *    立即持久化写入 sessionStorage('omni_embed' = '1')，避免页面内部 router.replace 丢失 query 参数；
 * 2. 在嵌入模式下隐藏左侧主导航与顶栏，并将后台管理类路由重定向至 /create-canvas；
 * 3. 支持首次 URL 参数（?theme=dark|light&accent=...）与运行期 postMessage({ type: 'omni:theme', theme, accent })
 *    实时同步深浅色类名、data-theme 及 CSS 主色变量（--accent / --ui-accent / --shell-accent / --el-color-primary）。
 */

export const OMNI_EMBED_SESSION_KEY = 'omni_embed'

/** 嵌入模式下禁止直接展示的管理后台类路由前缀，统一重定向至画布页 */
export const EMBED_REDIRECT_PREFIXES = Object.freeze([
  '/ai-config',
  '/advanced-settings',
  '/projects',
  '/series-groups',
  '/supervisors',
])

/**
 * 解析 URL search 与 hash 中的嵌入参数（兼容 history 与 hash 两种拼接形式）
 */
export function parseEmbedParams(search = '', hash = '') {
  const merged = new URLSearchParams()
  const appendQuery = (raw) => {
    if (!raw || typeof raw !== 'string') return
    const qIndex = raw.indexOf('?')
    const queryStr = qIndex >= 0 ? raw.slice(qIndex + 1) : raw.replace(/^[?#]+/, '')
    if (!queryStr) return
    const params = new URLSearchParams(queryStr)
    for (const [k, v] of params.entries()) {
      merged.set(k, v)
    }
  }
  appendQuery(search)
  if (typeof hash === 'string' && hash.includes('?')) {
    appendQuery(hash)
  }
  return {
    embed: (merged.get('embed') || '').trim().toLowerCase(),
    theme: (merged.get('theme') || '').trim().toLowerCase(),
    accent: (merged.get('accent') || '').trim(),
  }
}

/**
 * 判断单个 embed 参数值是否表示开启无壳嵌入模式
 */
export function isEmbedFlagValue(value) {
  if (value === true || value === 1) return true
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'omni' || normalized === 'true'
}

/**
 * 校验并清洗外部传入的主色值（仅允许合法的 #hex / rgb / rgba / hsl / hsla 颜色，防止注入非法样式）
 */
export function sanitizeAccentColor(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
    return value
  }
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]+\)$/i.test(value)) {
    return value
  }
  return ''
}

/**
 * 将 #RRGGBB 或 rgb() 转为带透明度的 rgba 字符串，供 --ui-accent-soft 与 --ui-accent-glow 使用
 */
export function buildAlphaColor(color, alpha) {
  const clean = sanitizeAccentColor(color)
  if (!clean) return ''
  if (clean.startsWith('#')) {
    let hex = clean.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.slice(0, 3).split('').map((c) => c + c).join('')
    } else if (hex.length === 8) {
      hex = hex.slice(0, 6)
    }
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    if ([r, g, b].every(Number.isFinite)) {
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
  }
  return ''
}

/**
 * 检测当前上下文是否处于 Omni 无壳嵌入模式，并在首次命中时持久化至 sessionStorage 与 html 属性
 */
export function detectAndPersistEmbed(options = {}) {
  const win = options.win !== undefined ? options.win : (typeof window !== 'undefined' ? window : null)
  const doc = options.doc !== undefined ? options.doc : (typeof document !== 'undefined' ? document : null)
  const storage = options.storage !== undefined
    ? options.storage
    : (() => {
        try { return win?.sessionStorage || null } catch (_) { return null }
      })()

  const routeEmbed = options.routeQuery?.embed
  const parsed = parseEmbedParams(win?.location?.search || '', win?.location?.hash || '')
  const fromGlobal = Boolean(win && isEmbedFlagValue(win.__OMNI_EMBED__))
  const fromUrl = isEmbedFlagValue(routeEmbed) || isEmbedFlagValue(parsed.embed)

  let fromSession = false
  try {
    fromSession = storage?.getItem(OMNI_EMBED_SESSION_KEY) === '1'
  } catch (_) {
    fromSession = false
  }

  const embedded = Boolean(fromGlobal || fromUrl || fromSession)
  if (embedded) {
    try {
      storage?.setItem(OMNI_EMBED_SESSION_KEY, '1')
    } catch (_) {
      /* 忽略沙箱隐私模式下 sessionStorage 写入异常 */
    }
    if (doc?.documentElement) {
      doc.documentElement.dataset.omniEmbed = '1'
      doc.documentElement.classList.add('omni-embed')
    }
  }
  return embedded
}

/**
 * 解析宿主 postMessage 消息载荷，提取标准化主题与强调色指令
 */
export function parseOmniThemeMessage(data) {
  if (!data || typeof data !== 'object') return null
  const msgType = String(data.type || '').trim()
  if (msgType !== 'omni:theme' && msgType !== 'omni-theme') return null
  const rawTheme = String(data.theme || '').trim().toLowerCase()
  const theme = rawTheme === 'dark' || rawTheme === 'light' ? rawTheme : ''
  const accent = sanitizeAccentColor(data.accent)
  if (!theme && !accent) return null
  return { theme, accent }
}

/**
 * 将主题（dark/light）与可选强调色同步写入根节点 DOM（html.dark / html.light / data-theme / CSS 变量）
 */
export function applyRootThemeAndAccent({ isDark, accent = '', doc } = {}) {
  const targetDoc = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : null)
  const root = targetDoc?.documentElement
  if (!root) return
  if (isDark) {
    root.classList.remove('light')
    root.classList.add('dark')
    root.dataset.theme = 'dark'
  } else {
    root.classList.remove('dark')
    root.classList.add('light')
    root.dataset.theme = 'light'
  }
  const safeAccent = sanitizeAccentColor(accent)
  if (safeAccent && root.style && typeof root.style.setProperty === 'function') {
    root.style.setProperty('--accent', safeAccent)
    root.style.setProperty('--ui-accent', safeAccent)
    root.style.setProperty('--shell-accent', safeAccent)
    root.style.setProperty('--el-color-primary', safeAccent)
    const soft = buildAlphaColor(safeAccent, 0.14)
    const glow = buildAlphaColor(safeAccent, 0.24)
    if (soft) root.style.setProperty('--ui-accent-soft', soft)
    if (glow) root.style.setProperty('--ui-accent-glow', glow)
  }
}

/**
 * 在无壳嵌入模式下拦截管理后台路由并重定向至 /create-canvas；独立浏览器访问保持不变
 */
export function resolveEmbedRedirect(pathname, embedded) {
  if (!embedded) return null
  const cleanPath = String(pathname || '').trim() || '/'
  const hit = EMBED_REDIRECT_PREFIXES.some((prefix) => (
    cleanPath === prefix || cleanPath.startsWith(`${prefix}/`)
  ))
  return hit ? '/create-canvas' : null
}
