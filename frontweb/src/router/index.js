import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    if (to.path === from.path) return false
    return { top: 0 }
  },
  routes: [
    {
      path: '/',
      name: 'list',
      component: () => import('@/views/HomeDashboard.vue'),
      meta: { title: '总览首页' }
    },
    {
      path: '/projects',
      name: 'projects',
      component: () => import('@/views/ProjectsWorkspace.vue'),
      meta: { title: '项目与剧集' }
    },
    {
      path: '/drama/:id',
      name: 'drama-detail',
      redirect: (to) => ({ name: 'production-workflow', params: { id: to.params.id }, query: to.query }),
      meta: { title: '剧集管理' }
    },
    {
      path: '/film/:id',
      name: 'film',
      redirect: (to) => ({ name: 'production-workflow', params: { id: to.params.id }, query: to.query }),
      meta: { title: 'AI 视频生成' }
    },
    {
      path: '/film/:id/canvas',
      name: 'film-canvas',
      component: () => import('@/views/DramaCanvas.vue'),
      meta: { title: '画布模式' }
    },
    {
      path: '/director/:id?',
      name: 'director-studio',
      component: () => import('@/views/DirectorStudio.vue'),
      meta: { title: '3D 导演台' }
    },
    {
      path: '/workflow/:id',
      name: 'production-workflow',
      component: () => import('@/views/ProductionWorkflow.vue'),
      meta: { title: 'AI 视频制作向导' }
    },
    {
      path: '/ai-config',
      name: 'ai-config',
      component: () => import('@/views/AiConfig.vue'),
      meta: { title: '模型与 Key' }
    },
    {
      path: '/advanced-settings',
      name: 'advanced-settings',
      component: () => import('@/views/AdvancedSettings.vue'),
      meta: { title: '高级设置' }
    },
    {
      path: '/free-create',
      name: 'free-create',
      component: () => import('@/views/FreeCreate.vue'),
      meta: { title: '自由创作' }
    },
    {
      path: '/media-library',
      name: 'media-library',
      component: () => import('@/views/MediaLibrary.vue'),
      meta: { title: '媒体素材库' }
    },
    {
      path: '/guided-demo',
      name: 'guided-demo',
      component: () => import('@/views/GuidedDemo.vue'),
      meta: { title: '零成本流程模拟' }
    },
    {
      path: '/help',
      name: 'help-center',
      component: () => import('@/views/HelpCenter.vue'),
      meta: { title: '使用指南' }
    },
    {
      path: '/asset-import',
      name: 'asset-import',
      component: () => import('@/views/AssetImport.vue'),
      meta: { title: '智能资产导入' }
    },
    {
      path: '/series-groups',
      name: 'series-groups',
      component: () => import('@/views/SeriesGroups.vue'),
      meta: { title: '剧集组与续集' }
    },
    {
      path: '/codex-console/:id?',
      name: 'codex-console',
      component: () => import('@/views/CodexOrchestration.vue'),
      meta: { title: '任务与计划' }
    },
    {
      path: '/batch',
      name: 'batch-control',
      component: () => import('@/views/BatchControl.vue'),
      meta: { title: '批量生成' }
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@/views/History.vue'),
      meta: { title: '历史记录' }
    },
    {
      path: '/tools',
      name: 'tools-catalog',
      component: () => import('@/views/ToolsCatalog.vue'),
      meta: { title: '工具目录' }
    }
  ]
})

router.beforeEach((to) => {
  if (to.meta.title) {
    document.title = `${to.meta.title} - Codex 银子万能媒体工作流`
  }
  return true
})

export default router
