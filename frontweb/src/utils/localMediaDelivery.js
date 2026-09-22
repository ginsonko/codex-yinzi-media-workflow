// A completed document job is not necessarily a rendered movie.
export function localMediaDelivery(job) {
  const details = job?.result?.details || {}
  if (job?.status === 'succeeded' && details.stage === 'draft_ready') {
    const editor = details.editor_delivery || {}
    const ready = editor.status === 'editor_copy_prepared'
    return { stage: ready ? '剪映工程已放入草稿位置' : '剪映工程已准备好', status: '待在剪映预览与导出', link: '查看工程与接续说明', name: editor.project_name || details.project_name || '', path: ready ? editor.draft_path : details.draft_path || '', next: editor.next_action || details.next_action || '确认工程已放入剪映当前草稿保存位置，从首页草稿列表打开；素材导入窗口不能打开工程 JSON。核对素材、字体与效果后导出视频。' }
  }
  if (job?.status === 'succeeded' && details.stage === 'environment_inspected') {
    return { stage: '剪映环境检查完成', status: '尚未制作视频', link: '查看环境检查结果', path: '', next: details.next_action || '' }
  }
  return null
}
