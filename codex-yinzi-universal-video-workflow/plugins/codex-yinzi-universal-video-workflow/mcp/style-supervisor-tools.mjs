export const selectionSchema = {
  type:'object', properties:{mode:{enum:['suggested','auto','manual','off']},supervisor_id:{type:'string'},reason:{type:'string'}},
}
export const styleSupervisorTools = [
  {name:'style_supervisors',description:'查询20位内置及自定义作品监督，按目标推荐一主两备；支持纯数据的增删改查、导入导出和恢复内置。不会调用模型或执行导入内容。修改、删除、恢复需要当前 expected_revision。导入总是新增副本。单包4 MiB UTF-8，目录不限总数；超限用export的q/offset/limit分批。',inputSchema:{type:'object',required:['action'],properties:{action:{enum:['list','get','recommend','create','update','delete','restore','import','export']},supervisor_id:{type:'string'},input:{type:'object',description:'list: q/enabled_only/include_deleted；export: q/enabled_only/offset/limit，offset从0开始，省略范围导出全部且不会截断；recommend: user_goal；create: name/style/suitable_for/audience_feeling/tradeoff/tags/visual_rules/audio_rules/review_criteria/enabled；update:同字段+expected_revision；delete/restore:expected_revision；import:schema_version=1,kind=yinzi-style-supervisors,profiles=[纯数据人格]'}}}},
  {name:'task_supervisor',description:'获取任务冻结的监督快照、创作上下文、选择历史和审片记录；select可自动选择、指定或关闭。review记录方案/粗剪/成片的证据与具体修改建议，作者自评不冒充独立验收。不改变任务权限或自动完成任务。',inputSchema:{type:'object',required:['action','session_id'],properties:{action:{enum:['get','select','review']},session_id:{type:'string'},input:{type:'object',description:'select: mode=auto/manual/off,supervisor_id,expected_revision,reason,actor；review: request_key,selection_revision,stage=plan/rough_cut/final,outcome=not_reviewed/changes_requested/passed,summary,evidence_refs,findings=[{timecode,issue,change,severity:note/major/blocking}],reviewer'}}}},
]

export function styleSupervisorRequest(name,args={}) {
  const input=args.input || {}, id=encodeURIComponent(args.supervisor_id || '')
  if (name==='style_supervisors') {
    if(['get','update','delete','restore'].includes(args.action) && !args.supervisor_id) throw new Error('supervisor_id is required')
    const routes={list:['GET',`/api/v1/media-supervisors?${new URLSearchParams(input)}`],get:['GET',`/api/v1/media-supervisors/${id}`],recommend:['POST','/api/v1/media-supervisors/recommend',input],create:['POST','/api/v1/media-supervisors',input],update:['PUT',`/api/v1/media-supervisors/${id}`,input],delete:['DELETE',`/api/v1/media-supervisors/${id}`,input],restore:['POST',`/api/v1/media-supervisors/${id}/restore`,input],import:['POST','/api/v1/media-supervisors/import',input],export:['GET',`/api/v1/media-supervisors/export?${new URLSearchParams(input)}`]}
    if(!routes[args.action]) throw new Error('Unknown supervisor action')
    return routes[args.action]
  }
  if(name==='task_supervisor') {
    if(!args.session_id) throw new Error('session_id is required')
    const base=`/api/v1/orchestration-sessions/${encodeURIComponent(args.session_id)}/supervisor`
    const routes={get:['GET',base],select:['PUT',base,input],review:['POST',`${base}/reviews`,input]}
    if(!routes[args.action]) throw new Error('Unknown task supervisor action')
    return routes[args.action]
  }
  throw new Error('Unknown supervisor tool')
}
