<template>
  <div class="app-shell">
    <aside :class="['shell-sidebar', { open: mobileOpen }]" aria-label="主导航">
      <div class="shell-brand">
        <span class="shell-brand-mark" aria-hidden="true"><i>银</i></span>
        <div class="shell-brand-text">
          <strong>银子媒体工作流</strong>
          <small>AI 媒体工作台 · MCP &amp; Skills</small>
        </div>
      </div>

      <nav class="shell-nav" aria-label="主要导航">
        <div v-for="group in navGroups" :key="group.label" class="shell-nav-group">
          <span class="shell-nav-label" aria-hidden="true">{{ group.label }}</span>
          <router-link
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="shell-nav-item"
            @click="mobileOpen = false"
          >
            <span class="shell-nav-icon"><el-icon><component :is="item.icon" /></el-icon></span>
            <span>{{ item.label }}</span>
          </router-link>
        </div>
      </nav>

      <div class="shell-sidebar-footer">
        <a href="https://yinziapi.top/" target="_blank" rel="noopener noreferrer" class="shell-yinzi-link">
          <span>yinziapi.top</span>
          <el-icon><TopRight /></el-icon>
        </a>
        <a href="https://github.com/ginsonko/codex-yinzi-media-workflow" target="_blank" rel="noopener noreferrer" class="shell-footer-link">
          社区版 · ginsonko
        </a>
      </div>
    </aside>

    <div v-if="mobileOpen" class="shell-scrim" @click="mobileOpen = false" aria-hidden="true"></div>

    <div class="shell-content">
      <header class="shell-topbar">
        <div class="shell-topbar-start">
          <button class="shell-menu" type="button" aria-label="打开导航" :aria-expanded="mobileOpen" @click="mobileOpen = !mobileOpen">
            <el-icon><Menu /></el-icon>
          </button>
          <div class="shell-page-id">
            <h1>{{ title }}</h1>
            <p v-if="description">{{ description }}</p>
          </div>
        </div>

        <div class="shell-topbar-end">
          <el-select
            :model-value="qualityProfile"
            class="shell-quality"
            aria-label="新任务质量档位"
            title="新任务质量档位"
            :disabled="qualitySaving"
            @change="$emit('quality-change', $event)"
          >
            <el-option label="质量优先" value="quality" />
            <el-option label="均衡" value="balanced" />
            <el-option label="速度优先" value="speed" />
          </el-select>

          <span :class="['runtime-chip', runtimeError || !runtimeReady ? 'warning' : 'ok']" role="status">
            <i aria-hidden="true"></i>
            {{ runtimeError ? '需要检查' : runtimeReady ? '在线' : '连接中' }}
          </span>

          <button class="shell-fx" type="button" :class="{ auto: fxAutoDegraded }" :title="`界面效果：${fxCurrent.label}`" @click="fxOpen = !fxOpen">
            <el-icon><MagicStick /></el-icon>
            <span>{{ fxCurrent.label }}</span>
          </button>

          <button class="shell-icon-btn" type="button" :disabled="refreshing" title="刷新" @click="$emit('refresh')">
            <el-icon :class="{ spin: refreshing }"><Refresh /></el-icon>
          </button>
          <button class="shell-icon-btn" type="button" title="切换主题" @click="toggleTheme">
            <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
          </button>
        </div>
      </header>

      <div v-if="fxOpen" class="shell-fx-scrim" @click="fxOpen = false" aria-hidden="true"></div>
      <section v-if="fxOpen" class="shell-fx-panel" role="dialog" aria-label="界面效果与性能">
        <header>
          <strong>界面效果</strong>
          <span>效果越少，界面越省电、鼠标越跟手</span>
          <button class="shell-icon-btn" type="button" aria-label="关闭" @click="fxOpen = false"><el-icon><Close /></el-icon></button>
        </header>
        <div class="shell-fx-list">
          <button v-for="item in fxLevels" :key="item.id" type="button"
            :class="['shell-fx-item', { on: item.id === fxLevel }]"
            @click="setFxLevel(item.id)">
            <i class="mark" aria-hidden="true"></i>
            <span class="text"><strong>{{ item.label }}</strong><small>{{ item.note }}</small></span>
          </button>
        </div>
        <footer>
          <span class="shell-fx-now">{{ fxNote }}</span>
          <button class="shell-fx-measure" type="button" :disabled="fxMeasuring" @click="runFxMeasure">
            {{ fxMeasuring ? '采样中…' : '测一下帧率' }}
          </button>
        </footer>
      </section>

      <main class="shell-main"><slot /></main>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useTheme } from '@/composables/useTheme'
import { useEffects, startFpsWatch } from '@/composables/useEffects'

defineProps({
  title:        { type: String, default: '工作台' },
  eyebrow:      { type: String, default: 'AI 工作台' },
  description:  { type: String, default: '' },
  runtimeError: { type: String, default: '' },
  refreshing:   Boolean,
  runtimeReady: Boolean,
  qualityProfile: { type: String, default: 'quality' },
  qualitySaving:  Boolean,
})
defineEmits(['refresh', 'quality-change'])

const { isDark, toggle: toggleTheme } = useTheme()
const mobileOpen = ref(false)

/* 界面效果档位；帧率持续偏低时自动降一档，只提示一次 */
// 顶层解构，模板里才能自动解包 ref（嵌套在对象里的 ref 不会）
const { level: fxLevel, autoDegraded: fxAutoDegraded, levels: fxLevels, current: fxCurrent, setLevel: setFxLevel, measureFps: measureFpsRate } = useEffects()
const fxOpen = ref(false)
const fxMeasuring = ref(false)
const fxResult = ref('')
const fxNote = computed(() => {
  if (fxResult.value) return fxResult.value
  if (fxAutoDegraded.value) return `已自动降到「${fxCurrent.value.label}」，可在上面改回`
  return `当前：${fxCurrent.value.label}`
})
startFpsWatch()
// Esc 关掉效果面板：它是浮层，键盘用户不该只能靠鼠标点遮罩
function onFxKey(event) {
  if (event.key === 'Escape' && fxOpen.value) fxOpen.value = false
}
onMounted(() => document.addEventListener('keydown', onFxKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onFxKey))
if (typeof window !== 'undefined') {
  window.addEventListener('yinzi:effects-degraded', (event) => {
    const { label, fps } = event.detail || {}
    ElMessage.warning(`界面有点吃力（约 ${fps} 帧），已降到「${label}」`)
  })
}
async function runFxMeasure() {
  fxMeasuring.value = true
  fxResult.value = ''
  const fps = await measureFpsRate(1200)
  const verdict = fps >= 55 ? '很流畅' : fps >= 40 ? '还可以' : fps >= 25 ? '偏慢，建议降到「轻量」' : '明显卡顿，建议选「极简」'
  fxResult.value = `实测约 ${fps} 帧/秒 · ${verdict}`
  fxMeasuring.value = false
}

const navGroups = computed(() => [
  {
    label: '工作台',
    items: [
      { to: '/',              label: '总览首页',   icon: 'House' },
      { to: '/codex-console', label: '任务与计划', icon: 'List' },
      { to: '/batch',         label: '批量生成',   icon: 'CopyDocument' },
    ],
  },
  {
    label: '素材与制作',
    items: [
      { to: '/create-canvas', label: '画布创作',     icon: 'Grid' },
      { to: '/media-library', label: '素材库',       icon: 'Picture' },
      { to: '/director',      label: '3D 导演台',    icon: 'VideoCamera' },
      { to: '/projects',      label: '项目与剧集',   icon: 'Film' },
      { to: '/tools',         label: '工具目录',     icon: 'Grid' },
      { to: '/research',      label: '商品视频研究', icon: 'Search' },
      { to: '/supervisors',   label: '作品监督',     icon: 'User' },
    ],
  },
  {
    label: '管理',
    items: [
      { to: '/history',           label: '历史记录', icon: 'Clock' },
      { to: '/ai-config',         label: '模型与 Key', icon: 'Connection' },
      { to: '/advanced-settings', label: '高级设置', icon: 'Setting' },
    ],
  },
])
</script>

<style scoped>
/* ── Shell frame ──────────────────────────────────────────────── */
.app-shell {
  min-height:100vh;
  display:flex;
  background:var(--bg-page);
  color:var(--text-primary);
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Microsoft YaHei",sans-serif;
}

/* ── Sidebar ──────────────────────────────────────────────────── */
.shell-sidebar {
  position:sticky; top:0; z-index:30;
  width:228px; height:100vh;
  display:flex; flex-direction:column;
  background:var(--bg-card);
  border-right:1px solid var(--border-color);
  overflow:hidden;
}

/* Brand */
.shell-brand {
  display:flex; align-items:center; gap:12px;
  padding:20px 16px 16px;
  border-bottom:1px solid var(--border-color);
  flex-shrink:0;
}
.shell-brand-mark {
  width:34px; height:34px;
  display:grid; place-items:center;
  position:relative; overflow:hidden;
  background:var(--gradient-accent);
  color:var(--on-accent);
  font-size:16px; font-weight:900;
  border-radius:9px;
  flex-shrink:0;
  box-shadow:0 0 0 1px rgba(255,255,255,.22) inset, 0 6px 16px -10px rgba(220,228,240,.45);
  letter-spacing:-.02em;
}
.shell-brand-mark i { position:relative; z-index:1; font-style:normal; }
.shell-brand-mark::after {
  content:""; position:absolute; inset:-40%;
  background:linear-gradient(115deg, transparent 42%, rgba(255,255,255,.85) 50%, transparent 58%);
  transform:translateX(-70%);
  animation:sweep 7s cubic-bezier(.65,0,.35,1) infinite;
}
/* 扫光是持续动效，只在「完整」档跑；均衡档留住静态铬面 */
:root[data-fx="balanced"] .shell-brand-mark::after { animation:none; }
:root[data-fx="eco"] .shell-brand-mark::after,
:root[data-fx="off"] .shell-brand-mark::after { display:none; }

/* 胶片齿孔：贴在侧栏右缘，滚动时也不动 */
.shell-sidebar::after {
  content:""; position:absolute; top:0; bottom:0; right:7px; width:7px;
  background:repeating-linear-gradient(to bottom, transparent 0 10px, var(--bg-hover) 10px 19px, transparent 19px 26px);
  -webkit-mask:linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent);
          mask:linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent);
  border-radius:2px; opacity:.85; pointer-events:none;
}
:root[data-fx="off"] .shell-sidebar::after { display:none; }

.shell-brand-text { min-width:0; }
.shell-brand-text strong {
  display:block;
  font-size:12.5px; font-weight:700;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  letter-spacing:.005em;
}
.shell-brand-text small {
  display:block; margin-top:2px;
  color:var(--text-subtle); font-size:10.5px; line-height:1.4;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}

/* Navigation */
.shell-nav {
  flex:1; overflow-y:auto; overflow-x:hidden;
  padding:12px 10px;
  display:flex; flex-direction:column; gap:18px;
  scrollbar-width:thin; scrollbar-color:var(--border-color) transparent;
}
.shell-nav-group { display:flex; flex-direction:column; gap:2px; }
.shell-nav-label {
  display:block;
  padding:0 8px 5px;
  font-size:10px; font-weight:600;
  color:var(--text-faint);
  letter-spacing:.08em;
  text-transform:uppercase;
}
.shell-nav-item {
  display:flex; align-items:center; gap:9px;
  min-height:36px; padding:0 8px;
  border-radius:8px;
  color:var(--text-muted);
  text-decoration:none; font-size:13px;
  border-left:2px solid transparent;
  transition:background .13s, color .13s, border-color .13s;
}
.shell-nav-item:hover {
  background:var(--bg-hover); color:var(--text-primary);
}
.shell-nav-item.router-link-active,
.shell-nav-item.router-link-exact-active {
  background:var(--ui-accent-soft);
  color:var(--text-primary);
  font-weight:600;
  border-left-color:var(--ui-accent);
  padding-left:6px;
}
.shell-nav-icon {
  display:flex; align-items:center;
  font-size:15px; flex-shrink:0;
}
/* icon group tints */
.shell-nav-group:nth-child(1) .shell-nav-item .el-icon { color:var(--ui-accent); }
.shell-nav-group:nth-child(2) .shell-nav-item .el-icon { color:var(--ui-info); }
.shell-nav-group:nth-child(3) .shell-nav-item .el-icon { color:var(--text-subtle); }
.shell-nav-item.router-link-active .el-icon,
.shell-nav-item.router-link-exact-active .el-icon { color:inherit; }

/* Footer links */
.shell-sidebar-footer {
  flex-shrink:0;
  padding:10px 12px 14px;
  border-top:1px solid var(--border-color);
  display:flex; flex-direction:column; gap:4px;
}
.shell-yinzi-link {
  display:inline-flex; align-items:center; gap:5px;
  font-size:11.5px; font-weight:600;
  color:var(--ui-accent); text-decoration:none;
  transition:opacity .13s;
}
.shell-yinzi-link:hover { opacity:.8; }
.shell-yinzi-link .el-icon { font-size:11px; }
.shell-footer-link {
  font-size:10.5px; color:var(--text-faint);
  text-decoration:none;
  transition:color .13s;
}
.shell-footer-link:hover { color:var(--text-muted); }

/* ── Content area ─────────────────────────────────────────────── */
.shell-content { min-width:0; flex:1; display:flex; flex-direction:column; }

/* Topbar */
.shell-topbar {
  position:sticky; top:0; z-index:20;
  min-height:56px;
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:8px clamp(16px,3vw,32px);
  background:var(--bg-page);
  border-bottom:1px solid var(--border-color);
  backdrop-filter:blur(12px);
}
.shell-topbar-start { display:flex; align-items:center; gap:10px; min-width:0; }
.shell-page-id { min-width:0; }
.shell-page-id h1 {
  margin:0; font-size:17px; font-weight:700;
  line-height:1.25; letter-spacing:-.015em;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.shell-page-id p {
  margin:2px 0 0; font-size:11.5px;
  color:var(--text-muted); line-height:1.5;
}
.shell-topbar-end {
  display:flex; align-items:center; gap:7px; flex-shrink:0;
}

/* Quality selector */
.shell-quality { width:108px; }

/* Runtime chip */
.runtime-chip {
  display:inline-flex; align-items:center; gap:5px;
  padding:4px 9px;
  border:1px solid var(--border-color);
  border-radius:20px;
  font-size:11px; letter-spacing:.01em;
  color:var(--ui-accent);
  white-space:nowrap;
}
.runtime-chip.warning { color:var(--ui-warning); }
.runtime-chip i {
  width:6px; height:6px; border-radius:50%;
  background:var(--ui-accent); flex-shrink:0;
  animation:dot-pulse 2.8s ease infinite;
}
.runtime-chip.warning i { background:var(--ui-warning); animation:none; }
@keyframes dot-pulse {
  0%,100% { opacity:.6; transform:scale(1); }
  50%      { opacity:1;  transform:scale(1.25); }
}

/* Icon buttons */
.shell-icon-btn {
  width:34px; height:34px;
  display:grid; place-items:center;
  border:1px solid var(--border-color);
  background:transparent;
  color:var(--text-muted);
  border-radius:8px; cursor:pointer;
  font-size:15px;
  transition:border-color .13s, color .13s, background .13s;
}
.shell-icon-btn:hover {
  border-color:var(--ui-accent);
  color:var(--ui-accent);
  background:var(--ui-accent-soft);
}
.shell-icon-btn:disabled { opacity:.4; cursor:default; }

/* Menu button (mobile only) */
.shell-menu {
  display:none;
  width:34px; height:34px; place-items:center;
  border:1px solid var(--border-color); background:transparent;
  color:var(--text-primary); border-radius:8px; cursor:pointer;
  font-size:16px;
  transition:border-color .13s, background .13s;
}
.shell-menu:hover { border-color:var(--ui-accent); background:var(--ui-accent-soft); }

/* Main */
.shell-main {
  flex:1;
  max-width:1480px; margin:0 auto;
  padding:24px clamp(16px,3vw,40px) 64px;
  width:100%;
}

/* Scrim */
.shell-scrim { display:none; }

/* Spin animation */
.spin { animation:spin 1s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* ── 效果档位 ───────────────────────────────────────────────── */
.shell-fx {
  display:inline-flex; align-items:center; gap:6px;
  height:30px; padding:0 11px;
  border:1px solid var(--border-color);
  background:transparent; color:var(--text-muted);
  border-radius:15px; cursor:pointer;
  font-size:11.5px; font-weight:600;
  transition:border-color .13s, color .13s, background .13s;
}
.shell-fx:hover { border-color:var(--border-bright); color:var(--text-primary); }
.shell-fx .el-icon { font-size:13px; }
.shell-fx.auto { border-color:var(--ui-warning); color:var(--ui-warning); }

.shell-fx-scrim { position:fixed; inset:0; z-index:38; }

.shell-fx-panel {
  position:absolute; z-index:39; top:58px; right:clamp(16px,3vw,32px);
  width:330px; padding:0;
  background:var(--bg-card); border:1px solid var(--border-color);
  border-radius:var(--radius-lg); box-shadow:var(--shadow-float);
  animation:fade-up .22s ease both;
}
.shell-fx-panel header {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding:14px 14px 12px; border-bottom:1px solid var(--border-color);
}
.shell-fx-panel header strong { font-size:13.5px; }
.shell-fx-panel header span { flex:1 1 100%; order:3; font-size:11.5px; color:var(--text-muted); }
.shell-fx-list { padding:6px; }
.shell-fx-item {
  display:flex; align-items:center; gap:10px; width:100%;
  padding:10px 11px; border:0; border-radius:var(--radius-sm);
  background:transparent; color:var(--text-muted);
  text-align:left; cursor:pointer; transition:background .15s, color .15s;
}
.shell-fx-item:hover { background:var(--bg-hover); color:var(--text-primary); }
.shell-fx-item.on { color:var(--text-primary); }
.shell-fx-item .mark {
  width:15px; height:15px; flex:none; border-radius:50%;
  border:1px solid var(--border-muted); position:relative;
}
.shell-fx-item.on .mark { border-color:var(--border-bright); }
.shell-fx-item.on .mark::after {
  content:""; position:absolute; inset:3px; border-radius:50%;
  background:var(--gradient-accent);
}
.shell-fx-item .text { flex:1; min-width:0; }
.shell-fx-item .text strong { display:block; font-size:13px; font-weight:600; }
.shell-fx-item .text small { color:var(--text-subtle); font-size:11px; }
.shell-fx-panel footer {
  display:flex; align-items:center; gap:10px;
  padding:10px 14px; border-top:1px solid var(--border-color);
  font-size:11.5px; color:var(--text-muted);
}
.shell-fx-now { flex:1; min-width:0; }
.shell-fx-measure {
  border:1px solid var(--border-color); background:transparent;
  color:var(--text-primary); border-radius:var(--radius-sm);
  padding:5px 10px; font-size:11.5px; cursor:pointer;
}
.shell-fx-measure:hover { border-color:var(--border-bright); }
.shell-fx-measure:disabled { opacity:.55; cursor:default; }

/* ── Responsive ───────────────────────────────────────────────── */
@media(max-width:900px) {
  .shell-sidebar {
    position:fixed; left:-240px;
    transition:left .22s ease;
    box-shadow:20px 0 48px rgba(0,0,0,.40);
  }
  .shell-sidebar.open { left:0; }
  .shell-scrim {
    position:fixed; inset:0; z-index:25;
    display:block; background:rgba(0,0,0,.55);
    backdrop-filter:blur(3px);
  }
  .shell-menu { display:grid; }
  .shell-topbar { padding:8px 14px; }
}
@media(max-width:560px) {
  .runtime-chip { display:none; }
  .shell-fx span { display:none; }
  .shell-fx-panel { left:12px; right:12px; width:auto; }
  .shell-quality { width:90px; }
  .shell-main { padding-left:12px; padding-right:12px; }
}
@media(prefers-reduced-motion:reduce) {
  .shell-sidebar { transition:none; }
  .spin { animation:none; }
  .dot-pulse { animation:none; }
}
</style>
