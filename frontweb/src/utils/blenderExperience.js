export const blenderActive = (job) => ['queued', 'preparing', 'rendering', 'encoding', 'cancelling'].includes(job?.status)
export const blenderResumable = (job) => ['recoverable', 'partial', 'failed', 'cancelled', 'blocked'].includes(job?.status)
export function blenderStatusLabel(value) {
  return ({ queued: '排队中', preparing: '准备中', rendering: '渲染中', encoding: '编码中', cancelling: '正在停止', recoverable: '等待恢复', succeeded: '已完成', partial: '部分完成', failed: '需要处理', cancelled: '已停止', blocked: '需要安装 Blender' })[value] || value || '等待状态'
}
export function blenderPhaseLabel(value) {
  return ({ queued: '等待启动', preparing: '准备场景', modeling: '搭建场景与相机', exporting: '导出工程和 3D 预览', rendering: '逐帧渲染', encoding: '编码运镜视频', cancelling: '等待进程退出', recoverable: '等待恢复', completed: '已完成', partial: '保留已有成果', failed: '执行失败', cancelled: '本地已停止', blocked: 'Blender 暂不可用' })[value] || '读取进度'
}
export function blenderFrameProgress(job) {
  const total = Number(job?.progress?.total_frames)
  const done = Number(job?.progress?.completed_frames)
  return total > 0 && Number.isFinite(done) ? Math.min(100, Math.max(0, Math.round(done / total * 100))) : null
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f?#]/.test(value) || value.startsWith('/')) return ''
  try {
    return value.split('/').map((part) => {
      const decoded = decodeURIComponent(part)
      if (!decoded || decoded === '.' || decoded === '..' || /[/\\:\x00-\x1f?#]/.test(decoded)) throw new Error('invalid path')
      return encodeURIComponent(decoded)
    }).join('/')
  } catch (_) { return '' }
}
export function blenderLinks(result) {
  if (!result) return []
  const directory = relativePath(result.output_dir || result.command?.output_dir || (result.plan_id ? 'blender/render/' + result.plan_id : ''))
  if (!directory) return []
  const manifest = result.manifest || result.blender || result
  const video = result.video || manifest.video
  return [
    [manifest.blend, 'file', '下载可编辑工程'],
    [manifest.glb, 'glb', '查看 3D 预览'],
    [video?.status === 'succeeded' && video.relative_path, 'video', '播放运镜视频'],
    [manifest.frames?.[0], 'image', '查看参考图'],
  ].flatMap(([value, type, label]) => {
    const file = relativePath(value)
    return file ? [{ type, label, href: '/static/' + directory + '/' + file }] : []
  })
}
