// Shared MCP/CLI routing for durable research; no platform credentials cross this bridge.
export const researchTools = [
  { name: 'product_video_research', description: '电商/带货/同类热门视频研究：按平台采集公开或用户登录后数据，持久保存进度、可视化报告和重点参考，补充实际观片记录后交接原创视频策划。无需生成模型Key，不发起付费生成。create返回job.id；后续get/records/brief/update/resume/handoff使用同一ID。', inputSchema: { type: 'object', required: ['action'], properties: {
    action: { enum: ['create','list','get','records','brief','update','resume','cancel','handoff'] }, job_id: { type: 'string' },
    input: { type: 'object', description: 'create: request_key,query:{product,platforms:[douyin/tiktok/xiaohongshu/bilibili/youtube/generic],keywords?,since?,until?,region?},product_facts?,urls?,parameters:{limit:1..200,max_pages:1..20,auth_mode:auto/public/browser},mode:collect/import,items?。update: product_facts,selected_ids,observations:[{id,analysis_basis:video_viewed/user_supplied,analysis:{viewed_range,hook,proof,pacing,cta,changes,limitations}}]。resume: platforms?。records: offset,limit(1..100),v?。brief: v?。保留来源和未知指标，不把metadata当观片。' }
  } } },
  { name: 'research_platform_connection', description: '查询研究平台登录状态，open打开独立官方浏览器让用户扫码或完成验证；check重新检查保存的登录态。仅在本机保留登录信息，不需要用户复制Cookie。验证完成后用product_video_research resume接续原任务。disconnect仅在用户要求退出时使用。', inputSchema: { type: 'object', required: ['action'], properties: {
    action: { enum: ['list','open','check','disconnect'] }, platform: { type: 'string', description: 'douyin/tiktok/xiaohongshu/bilibili/youtube' }
  } } }
]

export function researchRequest(name, args = {}) {
  const input = args.input || {}
  if (name === 'research_platform_connection') {
    const base = '/api/v1/research/platform-sessions'
    if (args.action === 'list') return ['GET', base]
    if (!['open','check','disconnect'].includes(args.action) || !args.platform) throw new Error('请选择平台和有效连接操作')
    return ['POST', `${base}/${encodeURIComponent(args.platform)}/${args.action}`, {}]
  }
  if (name !== 'product_video_research') throw new Error('Unknown research tool')
  const base = '/api/v1/research/jobs'
  if (args.action === 'list') return ['GET', base]
  if (args.action === 'create') return ['POST', base, input]
  if (!args.job_id) throw new Error('请传入原研究 job_id')
  const job = `${base}/${encodeURIComponent(args.job_id)}`
  const params = new URLSearchParams(Object.entries(input).filter(([key,value]) => ['offset','limit','v'].includes(key) && value != null))
  const routes = {
    get: ['GET', job], records: ['GET', `${job}/records?${params}`],
    brief: ['GET', `${job}/files/creative-brief.json?${new URLSearchParams(input.v == null ? {} : {v:input.v})}`],
    update: ['PATCH', job, input], resume: ['POST', `${job}/resume`, input],
    cancel: ['POST', `${job}/cancel`, {}], handoff: ['POST', `${job}/handoff`, {}]
  }
  if (!routes[args.action]) throw new Error('请选择有效研究操作')
  return routes[args.action]
}
