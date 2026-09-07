import { normalizeRoute } from './videoRouting.js'

export const CONTINUITY_MODES = Object.freeze([
  {
    value: 'hard_cut',
    label: '独立切镜',
    shortLabel: '不携带尾帧',
    description: '上一镜动作结束后直接切到新机位；下一段从独立构图开始。',
  },
  {
    value: 'reference_continuation',
    label: '尾帧参考',
    shortLabel: '普通 reference',
    description: '提取上一镜正式视频末帧，作为普通参考图；有助于一致性，但不保证生成视频第一帧逐像素相同。',
  },
  {
    value: 'strict_continuation',
    label: '严格首帧续拍',
    shortLabel: '严格 first_frame',
    description: '把同一张末帧以 first_frame 角色发送；本地能力提示只用于说明风险，不限制手动提交。',
  },
])

const MODE_VALUES = new Set(['opening', ...CONTINUITY_MODES.map((item) => item.value)])

function currentArtifact(item) {
  return item && item.current !== false && !['invalidated', 'failed'].includes(item.status)
}

function shotNumber(item) {
  return Number(item?.content?.number ?? item?.scope_id ?? Number.MAX_SAFE_INTEGER)
}

function newestFirst(left, right) {
  return Number(right?.revision || 0) - Number(left?.revision || 0)
    || Number(right?.id || 0) - Number(left?.id || 0)
}

export function normalizeContinuityMode(value, number = null) {
  if (Number(number) === 1) return 'opening'
  return MODE_VALUES.has(value) && value !== 'opening' ? value : 'hard_cut'
}

export function continuityModeMeta(value, number = null) {
  const mode = normalizeContinuityMode(value, number)
  if (mode === 'opening') {
    return {
      value: 'opening', label: '成片开场', shortLabel: '无上一镜',
      description: '这是成片第一镜，从独立开场画面开始，不读取任何上一镜尾帧。',
    }
  }
  return CONTINUITY_MODES.find((item) => item.value === mode) || CONTINUITY_MODES[0]
}

export function previousStoryboardArtifact(artifacts = [], target = {}) {
  const shots = (artifacts || [])
    .filter((item) => item.stage === 'storyboard_plan' && currentArtifact(item) && item.content?.included !== false)
    .sort((left, right) => shotNumber(left) - shotNumber(right) || Number(left.id || 0) - Number(right.id || 0))
  const index = shots.findIndex((item) => Number(item.id) === Number(target.id)
    || String(item.scope_id) === String(target.scope_id))
  return index > 0 ? shots[index - 1] : null
}

function artifactById(artifacts, id) {
  const target = Number(id)
  if (!Number.isFinite(target) || target <= 0) return null
  return (artifacts || []).find((item) => Number(item.id) === target) || null
}

function newestScopedArtifact(artifacts, stage, scopeId, statuses = null) {
  return (artifacts || [])
    .filter((item) => item.stage === stage
      && String(item.scope_id) === String(scopeId)
      && item.current !== false
      && (!statuses || statuses.includes(item.status)))
    .sort(newestFirst)[0] || null
}

function transportMeta(code) {
  if (code === 'strict_first_frame') {
    return { code, label: '严格 first_frame', tone: 'strict', description: '尾帧走 first_frame 专用字段，生成后还会比较实际首帧。' }
  }
  if (code === 'generic_image_reference') {
    return { code, label: '普通 reference 图片', tone: 'reference', description: '尾帧位于参考图片列表，不承诺它就是生成视频第一帧。' }
  }
  if (code === 'pending') {
    return { code, label: '等待建包', tone: 'pending', description: '上一镜确认后才会提取尾帧并形成可审批参考包。' }
  }
  return { code: 'none', label: '未携带', tone: 'none', description: '本镜头按正常切镜生成，不读取上一镜尾帧。' }
}

function routeSupportsFirstFrame(route) {
  const roles = route?.roles?.image
  if (!Array.isArray(roles)) return null
  return roles.includes('first_frame')
}

export function buildShotContinuityView({ artifact = {}, draft = null, artifacts = [], route = {} } = {}) {
  const content = draft || artifact.content || {}
  const number = content.number ?? artifact.scope_id
  const mode = normalizeContinuityMode(content.transition_mode, number)
  const modeMeta = continuityModeMeta(mode, number)
  const previousShot = previousStoryboardArtifact(artifacts, artifact)
  const explicitPreviousVideo = artifactById(artifacts, content.continuity_in_artifact_id)
  const previousVideo = explicitPreviousVideo || (previousShot
    ? newestScopedArtifact(artifacts, 'shot_video', previousShot.scope_id, ['approved'])
    : null)

  const bundle = artifact.stage === 'reference_bundle'
    ? artifact
    : newestScopedArtifact(artifacts, 'reference_bundle', artifact.scope_id)
  const video = artifact.stage === 'shot_video'
    ? artifact
    : newestScopedArtifact(artifacts, 'shot_video', artifact.scope_id)
  const continuityFrameId = content.continuity_frame_artifact_id
    || content.strict_first_frame_artifact_id
    || bundle?.content?.continuity_frame_artifact_id
    || bundle?.content?.strict_first_frame_artifact_id
  const continuityFrame = artifactById(artifacts, continuityFrameId)
    || (artifacts || []).filter((item) => item.stage === 'continuity_frame'
      && String(item.scope_id) === String(artifact.scope_id)
      && item.current !== false)
      .sort(newestFirst)[0]
    || null

  const normalizedRoute = normalizeRoute(route, artifact)
  const firstFrameSupport = routeSupportsFirstFrame(normalizedRoute)
  const plannedTransport = mode === 'strict_continuation'
    ? transportMeta('strict_first_frame')
    : mode === 'reference_continuation'
      ? transportMeta('generic_image_reference')
      : transportMeta('none')

  const dispatch = video?.content?.dispatch_transport || {}
  const bundleTransport = bundle?.content?.continuity_frame_transport
  let actualCode = 'pending'
  if (dispatch.first_frame) actualCode = 'strict_first_frame'
  else if (bundleTransport === 'generic_image_reference') actualCode = 'generic_image_reference'
  else if (bundleTransport === 'strict_first_frame') actualCode = 'strict_first_frame'
  else if (video || bundle) actualCode = 'none'
  else if (mode === 'opening' || mode === 'hard_cut') actualCode = 'none'
  const actualTransport = transportMeta(actualCode)

  let advisory = ''
  if (!['opening', 'hard_cut'].includes(mode) && !previousVideo?.media_path) {
    advisory = '当前没有可提取的上一镜正式视频；仍可提交不带尾帧的参考包，但镜头连续性可能下降。'
  } else if (!['opening', 'hard_cut'].includes(mode) && bundle && !continuityFrame?.media_path) {
    advisory = '参考包尚未取得有效尾帧文件；仍可按当前媒体清单提交，也可以重新建包后再试。'
  } else if (mode === 'strict_continuation' && normalizedRoute.model && firstFrameSupport === false) {
    advisory = `本地提示显示 ${normalizedRoute.model} 可能不支持 first_frame；仍可提交，若上游拒绝会保留原始原因并允许调整后重试。`
  } else if (mode === 'strict_continuation' && !normalizedRoute.model) {
    advisory = '尚未取得当前模型的 first_frame 能力提示；仍可提交，最终以上游响应为准。'
  }

  const mismatch = Boolean(video && plannedTransport.code !== actualTransport.code)
  const frameValidation = continuityFrame?.content?.validation || null
  const boundaryValidation = video?.content?.boundary_validation || null
  return {
    mode,
    modeMeta,
    previousShot,
    previousVideo,
    continuityFrame,
    bundle,
    video,
    route: normalizedRoute,
    firstFrameSupport,
    plannedTransport,
    actualTransport,
    dispatch,
    blocker: '',
    advisory,
    mismatch,
    frameValidation,
    boundaryValidation,
    requiresPreviousFrame: ['reference_continuation', 'strict_continuation'].includes(mode),
  }
}
