<template>
  <section class="platform-connections" aria-labelledby="platform-connections-title">
    <header><div><h3 id="platform-connections-title">平台账号</h3><p>登录官方页面后，可读取账号有权访问的视频数据。登录态仅保存在这台电脑。</p></div><el-button :icon="Refresh" :loading="loading" @click="refresh">刷新状态</el-button></header>
    <p v-if="error" role="alert" class="connection-error">{{ error }}</p>
    <div v-if="loading && !platforms.length" role="status">正在读取平台状态...</div>
    <div v-for="platform in platforms" :key="platform.id" class="connection-row" :data-platform="platform.id">
      <div class="connection-name"><el-icon :class="{ connected: platform.state === 'connected' }"><CircleCheck v-if="platform.state === 'connected'" /><Connection v-else /></el-icon><strong>{{ platform.name }}</strong></div>
      <div class="connection-state"><span>{{ labels[platform.state] || platform.state }}</span><small v-if="platform.last_verified_at">最近取得数据：{{ formatTime(platform.last_verified_at) }}</small><small v-if="platform.message && (platform.state !== 'connected' || !platform.last_verified_at)">{{ platform.message }}</small></div>
      <div class="connection-actions">
        <template v-if="platform.browser_available">
          <el-button v-if="platform.state !== 'connected'" size="small" :icon="Connection" :loading="busy[platform.id]" @click="action(platform.id, 'open')">{{ platform.state === 'not_connected' ? '扫码登录' : '打开平台窗口' }}</el-button>
          <el-button v-if="platform.state !== 'not_connected'" size="small" :icon="Refresh" :loading="busy[platform.id]" @click="action(platform.id, 'check')">{{ platform.state === 'verification_required' ? '我已完成验证' : '检查登录' }}</el-button>
          <el-button v-if="platform.state === 'connected' || platform.state === 'expired'" size="small" :icon="SwitchButton" :disabled="busy[platform.id]" @click="action(platform.id, 'disconnect')">退出此连接</el-button>
        </template>
        <a v-else href="https://www.google.com/chrome/" target="_blank" rel="noopener noreferrer">安装 Chrome</a>
      </div>
      <p v-if="actionErrors[platform.id]" role="alert" class="connection-error">{{ actionErrors[platform.id] }}</p>
    </div>
    <p v-if="platforms.some(p => p.state === 'login_pending')" role="status" class="connection-hint">{{ checks >= maxChecks ? '自动检查已结束，扫码完成后点“检查登录”即可。' : '在官方窗口完成扫码后，这里会自动更新。' }}</p>
    <p v-if="platforms.some(p => p.state === 'verification_required')" role="status" class="connection-hint">打开平台窗口，完成页面提示后点“我已完成验证”。已经取得的数据会保留。</p>
  </section>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { Connection, Refresh, CircleCheck, SwitchButton } from '@element-plus/icons-vue'
const emit = defineEmits(['connected'])
const platforms = ref([]), loading = ref(false), error = ref(''), checks = ref(0)
const busy = reactive({}), actionErrors = reactive({})
const labels = { not_connected: '未连接', login_pending: '等待扫码', connected: '已保存登录', expired: '登录已过期', verification_required: '需要平台验证', unavailable: '浏览器不可用' }
const maxChecks = 24
let timer, disposed = false
const controllers = new Set()
async function request(suffix = '', method = 'GET') {
  const controller = new AbortController(); controllers.add(controller)
  const timeout = setTimeout(() => controller.abort(), 45000)
  try {
    const response = await fetch('/api/v1/research/platform-sessions' + suffix, { method, credentials: 'same-origin', signal: controller.signal })
    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.success || !Array.isArray(result.data?.platforms)) throw new Error(result?.error?.message || (response.status === 404 ? '平台连接接口尚未启动，请更新并重启工作流。' : '暂时无法读取平台状态，请重试。'))
    if (!disposed) platforms.value = result.data.platforms
  } finally { clearTimeout(timeout); controllers.delete(controller) }
}
function schedule() {
  clearTimeout(timer)
  if (disposed || checks.value >= maxChecks || !platforms.value.some(p => p.state === 'login_pending')) return
  timer = setTimeout(async () => {
    checks.value++
    for (const platform of platforms.value.filter(p => p.state === 'login_pending')) await action(platform.id, 'check', true)
    schedule()
  }, 5000)
}
async function refresh() {
  if (loading.value) return
  loading.value = true; error.value = ''
  try { await request(); schedule() } catch (e) { if (!disposed) error.value = e.name === 'AbortError' ? '读取超时，请重试。' : e.message } finally { loading.value = false }
}
async function action(id, command, automatic = false) {
  if (busy[id] || disposed) return
  busy[id] = true; actionErrors[id] = ''
  try {
    await request('/' + encodeURIComponent(id) + '/' + command, 'POST')
    if (!disposed && command !== 'disconnect' && platforms.value.find(p => p.id === id)?.state === 'connected') emit('connected', id)
    if (command === 'open') checks.value = 0
    if (!automatic) schedule()
  } catch (e) { if (!disposed) actionErrors[id] = e.name === 'AbortError' ? '请求超时，可在平台窗口完成后重新检查。' : e.message } finally { busy[id] = false }
}
function formatTime(value) { const date = new Date(value); return Number.isFinite(+date) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '' }
onMounted(refresh)
onUnmounted(() => { disposed = true; clearTimeout(timer); for (const controller of controllers) controller.abort() })
</script>

<style scoped>
.platform-connections{display:grid;gap:0;padding:20px 24px;border:1px solid var(--border-color);background:var(--bg-card);min-width:0;letter-spacing:0}.platform-connections header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:14px}.platform-connections h3{margin:0 0 6px;font-size:17px}.platform-connections header p,.connection-hint{margin:0;font-size:12px;line-height:1.7;color:var(--text-muted)}.connection-row{display:grid;grid-template-columns:105px minmax(160px,1fr) auto;gap:14px;align-items:center;border-top:1px solid var(--border-color);padding:14px 0;min-width:0}.connection-name{display:flex;align-items:center;gap:8px;font-size:14px}.connection-name .el-icon{color:var(--text-muted)}.connection-name .connected{color:var(--el-color-success)}.connection-state{display:grid;gap:4px;font-size:12px;min-width:0}.connection-state small{color:var(--text-muted);line-height:1.6;overflow-wrap:anywhere}.connection-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.connection-actions .el-button+.el-button{margin:0}.connection-actions a{color:var(--ui-accent);font-size:12px}.connection-error{grid-column:1/-1;margin:6px 0;font-size:12px;color:var(--el-color-danger);overflow-wrap:anywhere}.connection-hint{padding-top:8px}@media(max-width:700px){.connection-row{grid-template-columns:100px minmax(0,1fr)}.connection-actions{grid-column:1/-1;justify-content:flex-start}.platform-connections{padding:16px}.platform-connections header{align-items:flex-start}.platform-connections header p{max-width:40ch}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
