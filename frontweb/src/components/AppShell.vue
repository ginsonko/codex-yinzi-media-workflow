<template>
  <div class="app-shell">
    <aside :class="['shell-sidebar', { open: mobileOpen }]" aria-label="主导航">
      <div class="shell-brand">
        <span class="shell-brand-mark">银</span>
        <span><strong>银子媒体工作流</strong><small>Codex 驱动的创作控制台</small></span>
      </div>
      <nav class="shell-nav">
        <div v-for="group in navGroups" :key="group.label" class="shell-nav-group">
          <small>{{ group.label }}</small>
          <router-link v-for="item in group.items" :key="item.to" :to="item.to" class="shell-nav-item" @click="mobileOpen = false">
            <el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span>
          </router-link>
        </div>
      </nav>
      <div class="shell-help">
        <span class="shell-help-icon"><el-icon><QuestionFilled /></el-icon></span>
        <div><strong>第一次使用？</strong><small>先说目标，Codex 会先给计划。</small></div>
        <router-link to="/help" @click="mobileOpen = false">查看说明</router-link>
        <a href="https://github.com/ginsonko/codex-yinzi-media-workflow" target="_blank" rel="noopener noreferrer">银子 / ginsonko · 非商业社区版</a>
      </div>
    </aside>
    <div v-if="mobileOpen" class="shell-scrim" @click="mobileOpen = false"></div>
    <div class="shell-content">
      <header class="shell-topbar">
        <div class="shell-topbar-main">
          <button class="shell-menu" type="button" aria-label="打开导航" :aria-expanded="mobileOpen" @click="mobileOpen = !mobileOpen"><el-icon><Menu /></el-icon></button>
          <div><span class="shell-eyebrow">{{ eyebrow }}</span><h1>{{ title }}</h1><p v-if="description">{{ description }}</p></div>
        </div>
        <div class="shell-topbar-actions">
          <el-select :model-value="qualityProfile" class="shell-quality" aria-label="新任务质量档位" title="新任务质量档位，保存后 Codex 规划时自动读取" :disabled="qualitySaving" @change="$emit('quality-change',$event)"><el-option label="质量优先" value="quality" /><el-option label="均衡" value="balanced" /><el-option label="速度优先" value="speed" /></el-select>
          <span :class="['runtime-chip', runtimeError || !runtimeReady ? 'warning' : 'ok']"><i></i>{{ runtimeError ? '需要检查连接' : runtimeReady ? '工作台在线' : '正在连接' }}</span>
          <button class="shell-refresh" type="button" :disabled="refreshing" title="刷新当前页面" @click="$emit('refresh')"><el-icon :class="{ spin: refreshing }"><Refresh /></el-icon><span>刷新</span></button>
          <button class="shell-theme" type="button" title="切换明暗主题" @click="toggleTheme"><el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon></button>
        </div>
      </header>
      <main class="shell-main"><slot /></main>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useTheme } from '@/composables/useTheme'

defineProps({
  title: { type: String, default: '工作台' },
  eyebrow: { type: String, default: 'Codex 工作台' },
  description: { type: String, default: '' },
  runtimeError: { type: String, default: '' },
  refreshing: Boolean,
  runtimeReady: Boolean,
  qualityProfile: { type:String, default:'quality' },
  qualitySaving: Boolean,
})
defineEmits(['refresh','quality-change'])
const { isDark, toggle: toggleTheme } = useTheme()
const mobileOpen = ref(false)
const navGroups = computed(() => [
  { label: '工作台', items: [
    { to: '/', label: '总览首页', icon: 'House' },
    { to: '/codex-console', label: '任务与计划', icon: 'List' },
    { to: '/batch', label: '批量生成', icon: 'CopyDocument' },
  ] },
  { label: '素材与制作', items: [
    { to: '/media-library', label: '素材库', icon: 'Picture' },
    { to: '/director', label: '3D 导演台', icon: 'VideoCamera' },
    { to: '/projects', label: '项目与剧集', icon: 'Film' },
    { to: '/tools', label: '工具目录', icon: 'Grid' },
  ] },
  { label: '管理', items: [
    { to: '/history', label: '历史记录', icon: 'Clock' },
    { to: '/ai-config', label: '模型与 Key', icon: 'Connection' },
    { to: '/advanced-settings', label: '高级设置', icon: 'Setting' },
  ] },
])
</script>

<style scoped>
.shell-quality { width:118px; }
@media(max-width:600px) { .shell-topbar {flex-wrap:wrap} .shell-quality {width:106px} .shell-topbar-actions {margin-left:auto} }
.app-shell{min-height:100vh;display:flex;background:var(--shell-bg);color:var(--shell-text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Microsoft YaHei",sans-serif}.shell-sidebar{position:sticky;top:0;z-index:30;width:244px;height:100vh;display:flex;flex-direction:column;padding:23px 15px 17px;background:var(--bg-card);border-right:1px solid var(--shell-line)}.shell-brand{display:flex;align-items:center;gap:10px;padding:0 10px 25px}.shell-brand-mark{width:34px;height:34px;display:grid;place-items:center;color:var(--on-accent);background:var(--shell-accent);font-weight:900;font-size:17px}.shell-brand strong,.shell-brand small{display:block}.shell-brand strong{font-size:13px;letter-spacing:.02em}.shell-brand small{margin-top:4px;color:var(--shell-muted);font-size:12px}.shell-nav{display:grid;gap:22px;overflow:auto}.shell-nav-group{display:grid;gap:5px}.shell-nav-group>small{padding:0 11px 5px;color:var(--text-muted);font-size:12px;letter-spacing:.1em}.shell-nav-item{min-height:40px;display:flex;align-items:center;gap:10px;padding:0 11px;color:var(--text-muted);text-decoration:none;font-size:14px;transition:background .16s,color .16s}.shell-nav-item:hover{background:var(--bg-hover);color:var(--text-primary)}.shell-nav-item.router-link-exact-active,.shell-nav-item.router-link-active{color:var(--on-accent);background:var(--shell-accent);font-weight:700}.shell-help{margin-top:auto;padding:12px;border:1px solid var(--border-color);background:var(--bg-inner);display:grid;grid-template-columns:27px minmax(0,1fr);gap:8px}.shell-help-icon{width:27px;height:27px;display:grid;place-items:center;color:var(--ui-accent);background:var(--bg-inner)}.shell-help strong,.shell-help small{display:block}.shell-help strong{font-size:12px}.shell-help small{margin-top:3px;color:var(--text-muted);font-size:11px;line-height:1.45}.shell-help a{grid-column:2;color:var(--shell-accent);font-size:12px;text-decoration:none}.shell-content{min-width:0;flex:1}.shell-topbar{position:sticky;top:0;z-index:20;min-height:82px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px clamp(18px,3vw,42px);background:var(--bg-card);border-bottom:1px solid var(--shell-line);backdrop-filter:blur(16px)}.shell-topbar-main{display:flex;align-items:center;gap:12px;min-width:0}.shell-topbar h1{margin:3px 0 0;font-size:20px;line-height:1.2;letter-spacing:0}.shell-topbar p{margin:5px 0 0;color:var(--shell-muted);font-size:12px}.shell-eyebrow{color:var(--shell-accent);font-size:11px;letter-spacing:.12em}.shell-topbar-actions{display:flex;align-items:center;gap:10px}.runtime-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid var(--border-color);color:var(--ui-accent);font-size:12px}.runtime-chip.warning{color:var(--ui-warning);border-color:var(--border-color)}.runtime-chip i{width:7px;height:7px;border-radius:50%;background:var(--ui-accent);box-shadow:0 0 0 4px rgba(77,224,186,.12)}.runtime-chip.warning i{background:var(--bg-card);box-shadow:0 0 0 4px rgba(246,186,87,.12)}.shell-refresh,.shell-theme,.shell-menu{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--shell-line);background:transparent;color:var(--text-primary);cursor:pointer}.shell-refresh{height:34px;padding:0 10px;font-size:12px}.shell-theme{width:34px;height:34px}.shell-refresh:hover,.shell-theme:hover,.shell-menu:hover{border-color:var(--border-color);color:var(--shell-accent)}.shell-menu{display:none;width:34px;height:34px}.shell-main{max-width:1500px;margin:0 auto;padding:28px clamp(18px,3vw,42px) 60px}.shell-scrim{display:none}.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:880px){.shell-sidebar{position:fixed;left:-270px;transition:left .2s ease;box-shadow:12px 0 30px rgba(0,0,0,.2)}.shell-sidebar.open{left:0}.shell-scrim{position:fixed;inset:0;z-index:25;display:block;background:var(--bg-card)}.shell-menu{display:inline-flex}.shell-topbar{padding:12px 18px}.shell-topbar h1{font-size:17px}.shell-main{padding:22px 18px 48px}}@media(max-width:520px){.runtime-chip{display:none}.shell-refresh span{display:none}.shell-main{padding-left:13px;padding-right:13px}}
</style>
