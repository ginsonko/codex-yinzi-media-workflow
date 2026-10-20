// Host agents and the manual canvas share the same persistent backend.
export const canvasTools = [{
  name: 'creation_canvas',
  description: '无限画布与独立创作Agent。宿主可创建/读取/修改画布、选择已保存的文本配置、发消息/纠正/停止、检查真实任务和成片；手动界面为 /create-canvas/:id。generation及消息请求要request_id：网络恢复复用原值，用户显式再生成用新值。配置Key使用已有模型配置入口，不写进画布。',
  inputSchema: { type: 'object', required: ['action'], properties: {
    action: { enum: ['list','create','get','configure','tools','models','operations','generate','messages','send','run','stop','job','pause_job','resume_job','cancel_job','import_assets','import_research','inspect','extract_frame','export_video','export'] },
    canvas_id: { type: 'string' }, run_id: { type: 'string' }, job_id: { type: 'string' }, node_id: { type: 'string' },
    input: { type: 'object', description: 'create:{title}；configure:{title?,agent:{config_id,model,mode:tools/json_actions,instructions?,max_turns?,timeout_ms?}}；send:{request_id,message,selected_node_ids?}；messages:{after?,limit?}；operations:{request_id,operations:[{type:add_node/update_node/move_node/delete_node/connect/disconnect/select_attempt,...}]}，update/delete/select_attempt须expected_version。generate:{request_id,node_ids}；import_assets:{request_id,asset_ids}；import_research:{request_id,job_id,revision?}；export_video:{request_id,node_ids(按顺序),title?,aspect_ratio?}；extract_frame:{request_id,node_id,position?:first/last(默认last)}把已完成视频节点的首/尾帧提取成图片节点，connect给下一镜头作首帧或参考，实现镜头衔接。tools读取专用Agent领域工具详细合同。' }
  } }
}]
export function canvasRequest(args = {}) {
  const base = '/api/v1/creation-canvases', input = args.input || {}, e = encodeURIComponent
  if (args.action === 'list') return ['GET', base]
  if (args.action === 'create') return ['POST', base, input]
  if (args.action === 'tools' || args.action === 'models') return ['GET', `${base}/${args.action}`]
  if (!args.canvas_id) throw Error('需要 canvas_id；先 list 或 create')
  const canvas = `${base}/${e(args.canvas_id)}`
  const routes = {
    get: ['GET', canvas], configure: ['PATCH', canvas, input], operations: ['POST', `${canvas}/operations`, input],
    generate: ['POST', `${canvas}/generate`, input], send: ['POST', `${canvas}/messages`, input],
    messages: ['GET', `${canvas}/messages?${new URLSearchParams(Object.entries(input).filter(([key]) => ['after','limit'].includes(key)))}`],
    import_assets: ['POST', `${canvas}/import-assets`, input], import_research: ['POST', `${canvas}/import-research`, input],
    export_video: ['POST', `${canvas}/export-video`, input], export: ['GET', `${canvas}/export.json`],
  }
  if (['run','stop'].includes(args.action)) {
    if (!args.run_id) throw Error('需要原 run_id')
    return args.action === 'run' ? ['GET', `${canvas}/runs/${e(args.run_id)}`] : ['POST', `${canvas}/runs/${e(args.run_id)}/stop`, input]
  }
  if (['job','pause_job','resume_job','cancel_job'].includes(args.action)) {
    if (!args.job_id) throw Error('需要原 job_id')
    return args.action === 'job' ? ['GET', `${canvas}/jobs/${e(args.job_id)}`] : ['POST', `${canvas}/jobs/${e(args.job_id)}/${args.action.split('_')[0]}`, input]
  }
  if (args.action === 'inspect') {
    if (!args.node_id) throw Error('需要 node_id')
    return ['POST', `${canvas}/nodes/${e(args.node_id)}/inspect`, input]
  }
  if (args.action === 'extract_frame') {
    if (!args.node_id) throw Error('需要 node_id')
    return ['POST', `${canvas}/nodes/${e(args.node_id)}/extract-frame`, input]
  }
  if (!routes[args.action]) throw Error('不支持的画布操作')
  return routes[args.action]
}
