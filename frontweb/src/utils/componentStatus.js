const stages = {
  preparing: '准备中', repair: '修复组件', cache_reused: '复用下载', download: '正在下载',
  verify: '校验下载', install: '正在安装', healthcheck: '启动检查',
}

export function componentStatus(component = {}) {
  const progress = component.progress || {}
  // Older runtimes report the installed version separately from install progress.
  let status = component.status || 'missing'
  if (component.status_source !== 'component_runtime' && !['unsupported', 'interrupted', 'repair_required', 'update_available'].includes(status)) {
    if (progress.stage === 'failed') status = 'failed'
    else if (stages[progress.stage]) status = 'preparing'
  }
  const label = {
    ready: '已安装', preparing: stages[progress.stage] || '准备中', failed: '准备失败',
    interrupted: '准备已中断', repair_required: '组件需要修复', update_available: '有组件更新',
    unsupported: '当前平台待验证', missing: component.auto_install ? '按需自动安装' : '当前平台待验证',
  }[status] || '状态未知'
  const percent = status === 'preparing' && Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, progress.percent)) : null
  const detail = status === 'interrupted' ? '准备进程已退出，原任务和下载进度已保留'
    : status === 'repair_required' ? '组件文件未通过检查，下次执行会自动修复；原任务已保留'
      : component.available && progress.stage === 'failed' ? `本次准备失败，已安装版本仍可使用。${progress.message || ''}`
        : ['preparing', 'failed'].includes(status) ? progress.message || '' : ''
  return { status, label, percent, detail, active: status === 'preparing' }
}
