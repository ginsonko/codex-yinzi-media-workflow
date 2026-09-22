# 电商热门视频：平台采集、参考分析与创作

用于“找这个商品的爆款视频”“分析同类带货拍法”“根据参考做自己的商品广告”。用户无需记工具名；不要要求他在工作台重新描述需求。

## Agent 直接调用

先沿主 Skill 确认当前运行时并登记媒体任务。优先用 `product_video_research`：

1. `action:create,input:{request_key:"本次需求的稳定标识",query:{product:"用户的商品",platforms:["douyin"]},parameters:{limit:30}}`。返回 `job.id`、相对工作台地址与状态。与实际运行时 frontend_url 拼接地址，不猜端口。
2. `action:get,job_id` 读取进度；同一请求不要循环 create。按状态等待合理间隔，拿到部分结果就可继续分析。
3. `action:records,job_id,input:{offset:0,limit:50}` 读取全部样本，按 `next_offset` 翻页；`action:brief` 读取当前创意交接。`job.artifacts` 为版本固定的报告地址，`job.download_url` 为离线 ZIP。
4. 需要登录/验证时 `research_platform_connection` 的 `list/open/check`，由用户完成官方窗口操作；随后 `action:resume,job_id,input:{platforms:["douyin"]}`。保留原任务和部分数据，失效后才重新登录。
5. 实际观片后 `action:update,job_id,input:{selected_ids:[...],observations:[...]}` 保存观看范围及分析，更新商品事实。`action:handoff` 返回策划 session_id；读取 brief 后继续用户原本的创作任务，使用主 Skill 的计划、执行、剪辑与验收工具。交接自身不启动付费生成，也不替代视频制作。

若当前 MCP 未刷新，在本 Skill 目录执行等价 CLI，无须临时编写 HTTP 脚本：

```text
node scripts/orchestration-cli.mjs research create --input research-request.json
node scripts/orchestration-cli.mjs research get JOB_ID
node scripts/orchestration-cli.mjs research records JOB_ID --input page.json
node scripts/orchestration-cli.mjs research brief JOB_ID
node scripts/orchestration-cli.mjs research update JOB_ID --input observations.json
node scripts/orchestration-cli.mjs research resume JOB_ID --input resume.json
node scripts/orchestration-cli.mjs research handoff JOB_ID
node scripts/orchestration-cli.mjs research-platform list
node scripts/orchestration-cli.mjs research-platform open douyin
node scripts/orchestration-cli.mjs research-platform check douyin
```

`research-request.json` 是上面 create 的 input；`page.json` 例如 `{"offset":50,"limit":50}`；`resume.json` 例如 `{"platforms":["douyin"]}`。凭据不写入这些文件。研究不要求生成模型 Key；媒体制作按用户已授权渠道与预算执行。

## 先选平台，再选采集方式

商品、平台、目标市场、时间范围是主要输入。缺少平台时可先广泛找样本并分平台展示；缺少价格、人群或商品实物资料不妨碍调研，但不能据此编造卖点。时间范围缺省可用近30天并说明；不足时单列历史参考，不拿旧作品凑当前榜单。

使用当前模块目录核查以下执行器：

| 入口 | 模块 | 方法与重点 |
| --- | --- | --- |
| 通用采集 | `local.research.collect-videos` | 自动识别支持的平台详情；陌生站点由 Agent 找公开来源并验证适配 |
| 抖音 | `local.research.collect-douyin` | 商品演示、前几秒留存、实物证明、评论购买疑问 |
| 小红书 | `local.research.collect-xiaohongshu` | 使用场景、搜索意图、收藏理由、选购疑问 |
| B站 | `local.research.collect-bilibili` | 评测、对比、可信讲解与观看时长；不把长评测当竖屏带货同类 |
| TikTok | `local.research.collect-tiktok` | 按地区/语言区分，观察本地表达、演示和创作者语气 |
| YouTube | `local.research.collect-youtube` | Shorts 与长评测分组；比较钩子、解释深度和商品问题 |
| 整理参考包 | `local.research.product-references` | 去重、证据分层、同平台排序、导出清单和创意交接文件 |

这些分析重点是起点，随目标和真实样本调整，不是固定人群画像。专用采集器复用维护中的 yt-dlp 站点提取器；公开关键词搜索与单条详情支持情况不同，读取模块返回的 `collection.status`、attempts 和 next_steps。工具存在不等于当前网络/平台能访问，也不等于有完整排行数据库。

YouTube/B站优先尝试提取器原生关键词搜索；其它平台或原生搜索失败时，默认自动尝试公开视频索引，再采集匹配平台的原链接详情。索引未返回可靠日期/地区时保留未知，不把相对时间猜成发布日期。B站标准详情链接优先读取公开页面JSON；其它详情沿yt-dlp。平台标签、host和分析重点集中在 `videoPlatformProfiles.json`，用户需求与实证优先于默认策略。

参数 `discovery` 可选 `auto`（默认）、`native`、`public_index`、`none`；`limit` 为1–200（界面默认30），`max_pages` 为1–20，`timeout_ms` 为单请求1000–120000毫秒。有urls时直接采集详情，无urls时按关键词发现。通用入口可传 `platform` 复用专用适配。需要更完整公开字段时，可在工具页通过官方平台窗口扫码登录；登录态保存在应用独立档案，不读取日常浏览器Cookie，过期后重新扫码。每次任务有界执行，不接受任意提取器命令行或自动读取浏览器Cookie。

`collection.status=collected` 表示本次读到原站元数据，`partial` 表示部分路径失败，`discovery_only` 只有索引候选，`empty` 表示没有匹配项，`requires_discovery` 则保留具体错误和搜索入口供Agent继续。未取得数据不能称作采集成功。返回下一步时执行下一步，不原样重复失败请求；登录、验证码、限流、无权限和网络故障分别记录，换用户已授权的可用来源后继续。

## 一份数据格式贯穿全链路

优先使用工作台 `/research` 或持久研究接口 `POST /api/v1/research/jobs`，不用每次重新编写采集与报告脚本。body 为 `{request_key,query:{product,platforms,region?,since?,until?},urls?,product_facts?,parameters:{limit,max_pages,timeout_ms,auth_mode,discovery},mode:"collect"}`。已有采集 JSON 可用 `mode:"import",items:[...]` 在本地重建。相同内容的网络恢复沿用 request_key；改动查询用新 key。返回 job.id 后只读取 `GET /api/v1/research/jobs/:id`，勿循环 POST。

任务按平台保存每次采集与报告版本；`POST /:id/resume` 默认补采未完成的平台，显式 `platforms:[...]` 可更新指定平台。`POST /:id/cancel` 保存当前请求结果后停止，不丢成功数据。界面掉线或进程重启后从 GET 列表恢复；`interrupted` 可继续，不能把 GET 旧任务称作新采集。平台返回 `verification_required/access_required/rate_limited` 时分别引导官方验证、扫码登录、稍后重试；已有报告可以先用。

用户完成验证后，先检查原平台窗口，再继续同一研究；不要每次新开标签页导致再次验证。采集器保留并优先复用官方页面，任一官方页存在可见验证时仍停下，不处理验证码。研究页连接组件的成功事件会自动恢复当前任务里对应的待验证/登录平台；Agent通过API继续时也用同一job的resume，不再重新创建任务。检查登录成功只表示登录态可用；实际新增数据以新的采集结果为准。

报告默认 `auto` 为各平台选覆盖充分的真实指标：缺少播放量时可以按点赞排名，但标题和单位必须写“点赞”，不可借名变成播放量。搜索摘要即使有数字也不进入原站榜单。链接的 `?v=N` 固定报告版本，旧策划继续引用旧快照。

重点观片后用 `PATCH /:id` 保存 `observations:[{id,analysis_basis:"video_viewed"或"user_supplied",analysis:{viewed_range,hook,proof,pacing,cta,...}}]`、商品事实和 `selected_ids`。观看范围缺失不能当已观片。框架来自 `productResearchFrameworks.json`，可调整；默认三种拍摄框架是草稿，不是根据标题推断出的爆款结构。用户清空选择后不能偷偷恢复默认选择。

`POST /:id/handoff` 将文件目录、真实来源和完整 brief 交给制作工作台，返回真实 `/codex-console/:session_id`；同一报告版本重复点击复用同一 draft。这一步建立策划任务，不会启动后台模型。宿主 Agent 继续读取 `source_context.work_dir` 的 `video-plan.md`、`creative-brief.json` 和报告，执行已授权的观片、原创脚本、分镜与制作。没有自己的商品资料时可完成研究与条件式方案，不编造商品实物或销售效果；已有预算授权继续有效。

采集工具的 result.json 可直接作为 `local.research.product-references` 的 input_path。手工浏览或用户导出也整理成相同输入：

```json
{
  "query": {"product":"用户商品", "platforms":["douyin"], "region":"CN", "since":"2026-09-01", "until":"2026-09-30"},
  "product_facts": [],
  "items": [{
    "id":"reference-01", "url":"https://www.douyin.com/video/实际视频ID",
    "platform":"douyin", "title":"原视频标题", "author":"实际作者",
    "published_at":null, "region":null, "observed_at":"实际采集ISO时间",
    "metrics":{"views":null,"likes":null,"comments":null,"shares":null,"saves":null},
    "evidence":{"kind":"search_snippet","url":"实际证据网址","note":"只读到索引摘要，未核验原站指标"},
    "analysis_basis":"metadata_only", "selected":false
  }]
}
```

使用正常 `local_media_run`，已有session_id、稳定request_key、module_id、input_path与参数；没有新付费生成或发布。读逐项结果，混合失败不丢掉成功样本。保留未知值与原始指标，不能用点赞替代播放，不能从作者所在地推断投放市场。某条没有日期/地区时，不能宣称通过该筛选。搜索命中“爆款”标签不构成热度证明；缺少公开销量、点击与订单数据时不能给转化率。

整理包默认包含report.html、result.json、references.md、references.csv和creative-brief.json。report.html是工具本地自动生成的自包含交互报告，不需要Agent每次另写网页。result.items和CSV保留去重后的全部线索，groups/candidates按平台和地区分组排序，excluded保留未排名或筛选不符原因。选中条目的analysis与analysis_basis交给创意环节，填写了分析不代表实际观片。同链接优先原站/授权导出，再选择较新的同级观察；其余快照保留，不能混拼成虚假的增长量。

## 透明研究报告是默认交付

执行顺序为：扩展公开检索与详情补充 → 去重及口径核验 → `local.research.product-references` → 打开并交付交互报告 → 观片与创意方案。用户只给商品名时也应提供能直接看的成果，而不只回复“已分析”。先努力收集数据，再决定画什么图；不能为套模板补造数据，也不能因为第一个采集路径失败就停止所有公开研究。更换合理关键词、搜索索引或公开页面，保留有效结果，避免原样反复请求受限路径。

报告按实际数据选择视图：平台/来源分布、同平台同指标比较、样本发布分布、已有观片分析及实验提案。未取得数据的图表不展示；只有一条可比较记录时展示已有数值，数值相同不硬做排行榜；未知不计作零，真实零值正常保留。主展示区不铺空表，来源详情中保留未取得字段与原因。全部无数据时明确本次没有匹配结果，并说明下一步。

平台、来源、候选类型、关键词和日期筛选统一作用于图表、清单及CSV/JSON导出。日期筛选以报告中最新观察时间为基准，未核验发布日期的线索不进入近期比较。原站/授权指标与搜索摘要分开；样本内排序不等于全平台爆款榜单，历史累计指标不等于当前增长。按平台、地区、内容类型和片长分组，不把教程、娱乐表演、长评测与商品短片混为同一组。候选类别若仅据标题/简介判断，注明依据，不冒充观片结论。

每条参考应能展开原链接、采集时间、来源说明、有效数值、分析依据与保留快照；报告默认无需联网即可读取与筛选，打开原视频才跳转外部网站。交付时使用实际产物地址打开报告，验证图表、筛选后导出、回到全部、移动端布局以及无匹配状态。报告是当前观察快照，重新采集后重新生成；不要虚构自动实时刷新、增长趋势、转化率或销量。

## 看过样本，才拆镜头

先筛同品类/用途/价格带和目标受众，再看热度。把编织教程、娱乐视频、带货演示和评测分开。选有代表性且互不重复的样本，记录实际观看范围、前3秒钩子、问题、卖点证据、镜头时长、声音、字幕、转场、CTA；仅有标题时写成候选观察，不虚构逐秒分析。下载与分析沿 `local.media.download`、镜头分析、反推/故事板、转写和既有素材库进行，不擅自把第三方视频认作可商用原片。

使用 `research.record-source` 保存出处，`research.extract-patterns` 提炼可借鉴结构；用 `product.extract-facts` 把参考卖点与自有商品事实分开，再交给 `creative.generate-directions`、`shot.plan-grid`、`copy.generate`。至少比较几种有实际差异的表达（例如场景试穿、选购问题、实物细节证明），按任务复杂度决定数量。不能仅换字幕/颜色当不同创意。

输出每个方向的来源ID、借鉴结构、原创变化、需要的商品证据、时长/画幅、素材缺口和验收点，再走已授权的制作与剪辑主流程。材料、价格、规格、logo和功效不自动沿用竞品。

## 让实验积累证据

有运营数据时，分开记录曝光、3秒留存/完播、商品点击、落地页/支付与退款；明确分母、样本量、自然/付费流量、受众和归因窗口。播放低与点击后不买不是同一个问题。对照测试优先改变一个关键因素（开头、证明方式、CTA），保持其它条件尽量可比；样本不足时保留不确定，不承诺稳定爆款。

## 新平台如何成为下次可复用的工具

专用路径不可用或没有适配器时，由Agent研究当前公开页面/官方协议，保存最小请求、响应字段、成功及失败fixture、版本与实际验证日期，复用共享规范化输出。脚本在隔离目录检查后接入受维护执行器；平台配置包括方法、参数、时间/地区口径、错误/下一步和分析侧重点。工具目录的自定义合同只是能力描述，不会自动执行其中的任意脚本，也不能把未实现合同标成已接通。

成功经验、站点变化与具体失败分别保存。更新一个平台只改该适配和fixture，共享比较/导出无需复制；未知站点仍可由Agent完成，不被平台列表挡住。

### 官方验证后的接续经验

抖音验证完成后可能停在新版 /jingxuan/search 页面。已有匹配关键词的官方页应继续读取/滚动，不重新按Enter搜索。用持久研究原ID resume；不要再创建同关键词任务冒充恢复。专用浏览器的公开搜索响应缓存用于接住用户验证期间已返回的记录，按查询隔离，原观察时间保留；不输出登录凭据或原始请求。真实验证码存在则保存已有数据、保留原页。

实际观片可以分阶段推进：先选一条与用户商品用途相关的参考，明确记录查看的时间点或区间，以及是否核听音频。视觉抽样不能写成完整逐帧/音频验收。通过 PATCH observations 保存后，确认report.html、creative-brief.json、video-plan.md与制作交接的相同版本都包含观察正文。热门教程/情绪内容未必适合带货，先按用途选样本，再用公开指标比较。缺客户商品事实时交可编辑脚本，不借用竞品材质、价格或效果。
