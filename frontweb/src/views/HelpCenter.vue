<template>
  <div class="help-center">
    <header class="help-header">
      <div class="help-header-inner">
        <el-button :icon="ArrowLeft" circle aria-label="返回首页" @click="router.push('/')" />
        <div><strong>银子AI视频工作流 · 说明书</strong><span>从第一次配置到最终交付</span></div>
        <el-input v-model="helpSearch" class="help-search" clearable placeholder="搜索配置、首帧、3D、字幕...">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-button type="primary" @click="router.push('/guided-demo')"><el-icon><VideoPlay /></el-icon>零成本模拟</el-button>
      </div>
      <div v-if="helpSearch.trim()" class="search-results">
        <button v-for="topic in matchedTopics" :key="topic.id" type="button" @click="jumpTo(topic.id)"><strong>{{ topic.title }}</strong><span>{{ topic.keywords }}</span></button>
        <span v-if="!matchedTopics.length">没有找到相关章节，试试更短的关键词。</span>
      </div>
    </header>

    <div class="help-layout">
      <aside class="help-toc">
        <strong>目录</strong>
        <nav>
          <button v-for="topic in topics" :key="topic.id" type="button" @click="jumpTo(topic.id)">{{ topic.title }}</button>
        </nav>
        <div class="toc-support">
          <span>服务与模型</span>
          <a v-if="distributionProfile.smart_routing_entry" href="https://www.yinziapi.top" target="_blank" rel="noopener noreferrer">www.yinziapi.top<el-icon><TopRight /></el-icon></a>
          <span v-else>通用 NewAPI / sub2 与老李兼容站点</span>
        </div>
      </aside>

      <main class="help-content">
        <section id="overview" class="help-section">
          <p class="section-label">01 · 工作流原理</p>
          <h1>不是一次提示词生成，而是一条可审批的制作链</h1>
          <p class="lead">每一步都保存可追溯版本。人工模式由你确认；AI 审批会自动打回、修改并复审；全自动模式跳过主观确认。只有同一对象达到上限、预算或资源不足、外部结果不明确时才停下来找你。</p>
          <div class="flow-list">
            <article v-for="(stage, index) in workflow" :key="stage.name">
              <span>{{ index + 1 }}</span>
              <div><h2>{{ stage.name }}</h2><p>{{ stage.description }}</p></div>
              <small>{{ stage.output }}</small>
            </article>
          </div>
          <div class="principle-note"><el-icon><CircleCheckFilled /></el-icon><p><strong>默认顺序拍摄</strong>分镜脚本先给出全片草案，真实素材按镜头依次生成。前一镜通过后，下一镜才能引用它的末帧、场景状态和已批准资产，避免同时建包造成版本竞态。</p></div>
        </section>

        <section id="modes" class="help-section">
          <p class="section-label">02 · 审批模式</p>
          <h2>选择人参与到什么程度</h2>
          <div class="mode-table" role="table" aria-label="审批模式对比">
            <div class="mode-row mode-head" role="row"><span>模式</span><span>谁审批</span><span>适合场景</span><span>你要做什么</span></div>
            <div class="mode-row" role="row"><strong>人工审批</strong><span>用户</span><span>默认；需要质量与可控性</span><span>逐步确认，打回时写评价</span></div>
            <div class="mode-row" role="row"><strong>AI 审批</strong><span>多模态文本模型</span><span>质量优先的无人值守制作</span><span>全程自审、自改、再审；同一对象连续耗尽上限才一次性找你</span></div>
            <div class="mode-row" role="row"><strong>全自动</strong><span>系统自动放行主观内容</span><span>低成本试稿或成熟模板</span><span>只输入故事，到成片前不要人工确认；技术校验仍保留</span></div>
            <div class="mode-row" role="row"><strong>手动下一步</strong><span>用户创作</span><span>已有自制资产或精细镜头</span><span>在任一步选择不自动生成</span></div>
          </div>
          <div class="autonomy-loop" aria-label="无人值守异常处理流程">
            <div class="autonomy-steps">
              <span><strong>1 · 发现问题</strong><small>审核不通过或生成明确失败</small></span>
              <span><strong>2 · AI 诊断</strong><small>分析审核意见、错误码与媒体能力</small></span>
              <span><strong>3 · 有界修复</strong><small>修提示词、重做或切换已授权的兼容模型</small></span>
              <span><strong>4 · 再次审核</strong><small>通过则继续，未通过则累加当前对象次数</small></span>
            </div>
            <p>只有同一对象连续达到上限、预算或必要资源不足、无兼容模型、外部任务结果不明确，或 AI 判断继续只会重复失败时，才停下来请人工处理。高价模型始终需要项目明确授权。</p>
          </div>
        </section>

        <section id="configuration" class="help-section">
          <p class="section-label">03 · 模型与 Key</p>
          <div class="section-title-row"><div><h2>真实制作需要四项核心配置</h2><p>首页的“已配置”只检查本地保存状态，不会自动联网，也不会提交付费生成。</p></div><el-button type="primary" @click="goConfigure">打开一键配置</el-button></div>
          <div class="config-grid">
            <article v-for="item in configs" :key="item.type">
              <span>{{ item.order }}</span><div><h3>{{ item.name }}</h3><p>{{ item.purpose }}</p><small>建议模型：{{ item.model }}</small></div>
            </article>
          </div>
          <div class="configuration-steps">
            <h3>{{ distributionProfile.smart_routing_entry ? '使用银子 API 一键配置' : '通用版：分别配置文本、图片、视频服务' }}</h3>
            <ol v-if="distributionProfile.smart_routing_entry">
              <li>在 <a href="https://www.yinziapi.top" target="_blank" rel="noopener noreferrer">www.yinziapi.top</a> 创建对应分组的 Key。文本、生图、视频可以使用不同 Key。</li>
              <li>首页点击“缺 N 项配置”或“一键配置银子API”，分别填写文本、图片、视频三个 Base URL。</li>
              <li>分别填写文本 Key、生图 Key 和视频 Key，再选择对应模型；不要使用智能路由 Key。资源图与分镜图会共用生图服务，但保存为两个独立默认服务。</li>
              <li>保存后返回首页确认显示 4/4。只有需要排查 Key 或网络时，才在配置页主动点击“测试”。</li>
            </ol>
            <ol v-else>
              <li>文本服务单独填写一个兼容 OpenAI Chat Completions 的 Base URL 和 Key；老李站点没有文本模型。</li>
              <li>图片服务填写老李站点的 Base URL 和图片 Key；该 Key 同时用于资源图与分镜图。</li>
              <li>视频服务填写老李站点的 Base URL 和视频 Key；3.5 固定 30 秒，3.0 支持 5 / 10 / 15 秒。</li>
              <li>保存后返回首页确认四项配置已就绪；每项 URL 和 Key 都独立保存，互不串用。</li>
            </ol>
            <div class="field-guide"><div><strong>Base URL</strong><span>接口根地址，通常以 <code>/v1</code> 结尾。</span></div><div><strong>API Key</strong><span>仅保存在本地后端；前端只会收到“是否已填写”。</span></div><div><strong>模型</strong><span>可配置多个候选，但必须有一个默认模型。</span></div><div><strong>默认 / 启用</strong><span>每个服务类型需要一条同时启用且设为默认的配置。</span></div></div>
          </div>
          <div class="optional-config"><strong>可选配置</strong><span>TTS 用于旁白；内置 Xiaoyi 音色无需 Python、零 API 费用但需要联网。3D 导演台完全本地；即梦角色认证和 ModelArk 只在对应模型需要时配置。它们都不阻止开始制作。</span></div>
        </section>

        <section id="consistency" class="help-section">
          <p class="section-label">04 · 一致性与镜头衔接</p>
          <h2>角色、场景和动作连续分别靠什么</h2>
          <div class="rule-list">
            <article><el-icon><User /></el-icon><div><h3>角色一致性</h3><p>确认角色多视图、脸部、体型、服装与色彩锚点；后续镜头只引用已批准版本，不把新生成图静默替换旧资产。</p></div></article>
            <article><el-icon><PictureFilled /></el-icon><div><h3>场景一致性</h3><p>场景设定图固定空间结构、时间、天气、主光方向和背景锚点。花草、建筑、门窗等容易漂移的物体必须写入资产约束。</p></div></article>
            <article><el-icon><Camera /></el-icon><div><h3>镜头连续性</h3><p>同一个长镜头尽量在一次视频任务中完成；独立任务应在正常切镜点拼接，不设计金光覆盖、遮挡镜头等刻意转场。</p></div></article>
            <article><el-icon><Link /></el-icon><div><h3>严格动作衔接</h3><p>只有确需跨任务延续同一动作时，才截取上一段最后一帧作为下一段严格首帧。正常切镜不必强行携带尾帧。</p></div></article>
          </div>
          <div class="model-note"><strong>模型路由</strong><p>短于 5 秒的独立镜头优先使用支持自由时长和首帧图的模型；5–15 秒、需要运动参考的长镜头再使用支持参考视频的模型。工作流自动选择，用户仍可随时手动改模型和分组。</p></div>
        </section>

        <section id="assets" class="help-section">
          <p class="section-label">05 · 素材复用与项目管理</p>
          <h2>成片、审批资产和草稿都保留来源</h2>
          <div class="two-column">
            <div><h3>素材库</h3><ul><li>“已批准生产资产”按项目、阶段和修订展示，只读保留来源。</li><li>从其它项目复用时，系统会复制为当前项目的新素材并记录跨项目来源。</li><li>“手工上传”用于你自己的图、视频和音频，可以独立删除。</li></ul><el-button @click="router.push('/media-library')">打开素材库</el-button></div>
            <div><h3>归档与恢复</h3><ul><li>归档只把项目移到“已归档”，不会改变草稿、生成中或完成状态。</li><li>成片与所有素材文件继续保留，可以预览、导出和恢复。</li><li>删除才是不可恢复操作，因此需要二次确认。</li></ul><el-button @click="router.push('/#projects')">返回项目工作台</el-button></div>
          </div>
        </section>

        <section id="director" class="help-section">
          <p class="section-label">06 · 3D 导演台</p>
          <div class="section-title-row"><div><h2>先用简单模型确定空间和镜头</h2><p>3D 预演是可选参考，不是生成门控。镜头简单或图片参考已经足够时，直接跳过。</p></div><el-button type="primary" @click="router.push('/director?tutorial=1')">打开交互教程</el-button></div>
          <ol class="director-steps">
            <li><span>1</span><div><strong>添加对象</strong><p>从素材库或基础对象加入角色、道具、地面、灯光和摄像机。</p></div></li>
            <li><span>2</span><div><strong>摆放构图</strong><p>移动、旋转、缩放对象，切到镜头预览检查画面边缘和视线方向。</p></div></li>
            <li><span>3</span><div><strong>设置关键帧</strong><p>在时间轴上改变对象和摄像机状态，生成位置与运动关键帧。</p></div></li>
            <li><span>4</span><div><strong>预览与评价</strong><p>播放后检查构图、节奏和遮挡；打回时说明问题，文本模型可重写场景 JSON。</p></div></li>
            <li><span>5</span><div><strong>录制或跳过</strong><p>录制 WebM 参考视频，或明确选择不生成/不携带。最终参考包以当下选择为准。</p></div></li>
          </ol>
          <div class="when-grid"><div><strong>建议使用</strong><span>复杂走位、多人空间关系、长镜头、镜头运动、道具交互。</span></div><div><strong>建议跳过</strong><span>表情特写、静态场景展示、2–4 秒短镜头、模型不支持参考视频。</span></div></div>
        </section>

        <section id="troubleshooting" class="help-section">
          <p class="section-label">07 · 常见问题</p>
          <h2>遇到阻塞时先看这里</h2>
          <el-collapse accordion>
            <el-collapse-item v-for="item in faq" :key="item.title" :title="item.title" :name="item.title"><p>{{ item.answer }}</p></el-collapse-item>
          </el-collapse>
        </section>

        <section id="about" class="help-section about-section">
          <p class="section-label">08 · 关于</p>
          <h2>银子AI视频工作流</h2>
          <dl><div><dt>作者</dt><dd>银子</dd></div><div><dt>GitHub</dt><dd><a href="https://github.com/ginsonko" target="_blank" rel="noopener noreferrer">ginsonko<el-icon><TopRight /></el-icon></a></dd></div><div><dt>联系 QQ</dt><dd>474764004</dd></div><div v-if="distributionProfile.smart_routing_entry"><dt>API 中转站</dt><dd><a href="https://www.yinziapi.top" target="_blank" rel="noopener noreferrer">www.yinziapi.top<el-icon><TopRight /></el-icon></a></dd></div></dl>
          <p>本项目基于开源项目持续开发。原始许可证、提交历史与上游作者信息保留在仓库中；此处展示的是当前产品品牌和维护联系信息。</p>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Camera, CircleCheckFilled, Link, PictureFilled, Search, TopRight, User, VideoPlay } from '@element-plus/icons-vue'
import { aiAPI } from '@/api/ai'

const router = useRouter()
const distributionProfile = ref({ id: 'universal', smart_routing_entry: false })
const helpSearch = ref('')
const topics = [
  { id: 'overview', title: '工作流原理', keywords: '故事 剧本 审批 版本 顺序生成' },
  { id: 'modes', title: '审批模式', keywords: '人工 AI 自动托管 手动' },
  { id: 'configuration', title: '模型与 Key', keywords: '配置 Base URL API Key 文本 生图 视频 TTS' },
  { id: 'consistency', title: '一致性与衔接', keywords: '角色 场景 首帧 尾帧 切镜 参考视频' },
  { id: 'assets', title: '素材复用与归档', keywords: '素材库 跨项目 来源 归档 恢复 导出' },
  { id: 'director', title: '3D 导演台', keywords: '3D 对象 镜头 关键帧 录制 跳过 JSON' },
  { id: 'troubleshooting', title: '常见问题', keywords: '排队 审核 失败 时长 合成 字幕 旁白' },
  { id: 'about', title: '作者与联系', keywords: '银子 ginsonko QQ yinziapi' },
]
const matchedTopics = computed(() => {
  const query = helpSearch.value.trim().toLowerCase()
  if (!query) return []
  return topics.filter((topic) => `${topic.title} ${topic.keywords}`.toLowerCase().includes(query))
})

const workflow = [
  { name: '故事与剧本', description: '输入故事构想或导入小说，生成可阅读剧本；可以编辑、AI 帮写、确认或打回。', output: '剧本 + 资源清单' },
  { name: '角色、场景、道具', description: '人工模式可逐项确认、删除或复用；AI 与全自动模式会自行生成并处理审核结果。', output: '批准的资产版本' },
  { name: '分镜与可选预演', description: '先审镜头脚本和分镜图，再按镜头选择生成、跳过或录制 3D 参考视频。', output: '逐镜头参考包' },
  { name: '视频片段', description: '系统按镜头时长与参考能力选模型；无人模式下审核、诊断、重试和兼容切换全部自动。', output: '批准的视频镜头' },
  { name: '剪辑交付', description: '按镜头切点合成，补旁白、字幕和音频；AI 与全自动模式下直到成片完成才通知你。', output: '成片 + 完整交付包' },
]
const configs = [
  { order: '01', type: 'text', name: '文本模型', purpose: '写剧本、抽取资源、生成分镜与审核建议。', model: 'gpt-5.6-sol 或兼容文本模型' },
  { order: '02', type: 'image', name: '资源生图', purpose: '生成角色多视图、场景和道具设定图。', model: 'gpt-image-2' },
  { order: '03', type: 'storyboard_image', name: '分镜生图', purpose: '按已批准资产生成每个镜头参考图。', model: 'gpt-image-2' },
  { order: '04', type: 'video', name: '视频模型', purpose: '根据参考包生成逐镜头视频片段。', model: '按镜头自动路由，也可手动选择' },
]
const faq = [
  { title: 'AI 审批第一次要求人工会立即停吗？', answer: '不会。首次 rejected 或 needs_human 都会作为当前对象的修改意见，由系统自动打回、重做并再次审核。只有同一对象的连续次数达到设定上限后，页面才出现一次“需要你处理”。' },
  { title: '全自动制作遇到模型报错会怎么做？', answer: '单次明确失败会先脱敏诊断，再在预算和次数内修改提示词、重试或切换到项目已授权的普通兼容模型。若外部提交结果不明确，系统会停止重提以避免重复扣费；高价渠道不会被默认选用。' },
  { title: '为什么即梦视频填写 4 秒会报错？', answer: '当前常用即梦视频模型的最短时长是 5 秒，范围通常为 5–15 秒。工作流会自动把该模型的镜头时长吸附到至少 5 秒；真正需要 2–4 秒的镜头应路由到支持自由时长的模型。' },
  { title: '视频任务一直排队，是不是失败了？', answer: '视频生成通常需要排队。只要任务仍是排队或处理中，就应继续轮询并保留任务 ID；刷新页面后也能恢复。只有上游明确返回失败或超过合理超时，才进入重试。' },
  { title: '审核失败或内容审核错误怎么办？', answer: '先检查提示词和参考图是否包含容易触发审核的内容，再在打回评价里说明需要替换的表达。普通模型多次审核失败时才考虑更贵的特殊渠道，避免无谓成本。' },
  { title: '为什么 3D 导演台不应该阻止下一步？', answer: '3D 是构图和运动参考工具，不是所有模型和镜头都需要。项目级可以关闭，镜头级可以选择跳过；跳过后参考包不得继续携带旧的 3D 视频。' },
  { title: '生成的视频与旁白对不上怎么办？', answer: '先在最终剪辑阶段重新计算镜头时长和旁白时间轴，再重新合成。修改已批准的旁白或镜头后，旧成片会变为过期，页面必须提供重新剪辑按钮，不能把旧成片继续当作当前结果。' },
  { title: '我关闭页面后还能继续吗？', answer: '真实项目、审批版本和异步任务保存在本地数据库与项目目录中，首页可继续进入。零成本模拟只保存在当前页面内，刷新后从第一步重新开始。' },
]

function jumpTo(id) {
  helpSearch.value = ''
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function goConfigure() {
  router.push({ path: '/', query: { config: distributionProfile.value.smart_routing_entry ? 'yinzi' : 'laoli' } })
}

onMounted(async () => {
  try { distributionProfile.value = await aiAPI.getDistributionProfile() } catch (_) { /* universal-safe fallback */ }
})
</script>

<style scoped>
.help-center { min-height: 100vh; color: var(--text-primary); background: var(--bg-inner); }
.help-header { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--border-color); background: var(--bg-inner); backdrop-filter: blur(10px); }
.help-header-inner { max-width: 1380px; min-height: 64px; margin: 0 auto; padding: 8px 18px; display: flex; align-items: center; gap: 12px; }
.help-header-inner > div { min-width: 210px; display: grid; margin-right: auto; }
.help-header-inner > div strong { font-size: 15px; }
.help-header-inner > div span { color: var(--text-muted); font-size:12px; }
.help-search { width: min(360px, 32vw); }
.search-results { position: absolute; top: 58px; left: 50%; width: min(620px, calc(100vw - 28px)); max-height: 280px; overflow-y: auto; padding: 8px; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); box-shadow: 0 14px 34px rgba(20,40,32,.14); transform: translateX(-28%); }
.search-results button { width: 100%; display: grid; gap: 2px; padding: 10px; border: 0; border-radius: 5px; color: var(--text-primary); background: transparent; text-align: left; cursor: pointer; }
.search-results button:hover { background: var(--bg-hover); }
.search-results span { color: var(--text-muted); font-size:12px; }
.help-layout { max-width: 1380px; margin: 0 auto; display: grid; grid-template-columns: 220px minmax(0,1fr); gap: 38px; padding: 28px 18px 80px; }
.help-toc { position: sticky; top: 92px; align-self: start; }
.help-toc > strong { display: block; margin-bottom: 10px; color: var(--text-primary); font-size: 12px; }
.help-toc nav { display: grid; border-left: 1px solid var(--border-color); }
.help-toc nav button { padding: 8px 12px; border: 0; color: var(--text-muted); background: transparent; text-align: left; cursor: pointer; font-size: 12px; }
.help-toc nav button:hover { color: var(--ui-accent); background: var(--bg-hover); }
.toc-support { display: grid; gap: 5px; margin-top: 18px; padding: 12px; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); }
.toc-support span { color: var(--text-muted); font-size:12px; }
.toc-support a { display: flex; align-items: center; gap: 4px; color: var(--ui-info); font-size:12px; text-decoration: none; }
.help-content { min-width: 0; max-width: 980px; }
.help-section { scroll-margin-top: 90px; padding: 4px 0 48px; margin-bottom: 44px; border-bottom: 1px solid var(--border-color); }
.help-section:last-child { margin-bottom: 0; border-bottom: 0; }
.section-label { margin: 0 0 8px; color: var(--ui-accent); font-size:12px; font-weight: 700; }
.help-section h1 { max-width: 780px; margin: 0; font-size: 28px; letter-spacing: 0; }
.help-section > h2, .section-title-row h2 { margin: 0 0 8px; font-size: 21px; letter-spacing: 0; }
.lead, .section-title-row p { max-width: 820px; margin: 10px 0 24px; color: var(--text-muted); font-size: 14px; line-height: 1.75; }
.flow-list { display: grid; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--bg-card); }
.flow-list article { display: grid; grid-template-columns: 34px minmax(0,1fr) 160px; align-items: center; gap: 12px; padding: 15px; border-bottom: 1px solid var(--border-color); }
.flow-list article:last-child { border-bottom: 0; }
.flow-list article > span { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; color: var(--ui-accent); background: var(--bg-card); font-size:12px; }
.flow-list h2 { margin: 0 0 4px; font-size: 13px; }
.flow-list p { margin: 0; color: var(--text-muted); font-size:12px; line-height: 1.55; }
.flow-list small { color: var(--ui-info); text-align: right; }
.principle-note { display: flex; gap: 10px; margin-top: 14px; padding: 14px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--ui-accent); background: var(--bg-card); }
.principle-note p { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.65; }
.principle-note strong { color: var(--ui-accent); }
.mode-table { border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--bg-card); }
.mode-row { display: grid; grid-template-columns: 130px 150px 1fr 1fr; border-bottom: 1px solid var(--border-color); }
.mode-row:last-child { border-bottom: 0; }
.mode-row > * { padding: 12px; color: var(--text-muted); font-size:12px; }
.mode-row strong { color: var(--text-primary); }
.mode-head { background: var(--bg-card); }
.mode-head span { color: var(--text-primary); font-weight: 700; }
.autonomy-loop { margin-top: 14px; padding: 15px; border-left: 3px solid var(--border-color); background: var(--bg-card); }
.autonomy-steps { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); }
.autonomy-steps span { min-width: 0; display: grid; gap: 4px; padding: 2px 12px; border-right: 1px solid var(--border-color); }
.autonomy-steps span:first-child { padding-left: 0; }
.autonomy-steps span:last-child { border-right: 0; }
.autonomy-steps strong { color: var(--ui-accent); font-size:12px; }
.autonomy-steps small { color: var(--text-muted); font-size:12px; line-height: 1.5; }
.autonomy-loop > p { margin: 13px 0 0; padding-top: 12px; border-top: 1px solid var(--border-color); color: var(--text-muted); font-size:12px; line-height: 1.7; }
.section-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.section-title-row p { margin: 5px 0 0; font-size: 12px; }
.config-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.config-grid article { min-width: 0; display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 10px; padding: 14px; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); }
.config-grid article > span { color: var(--ui-accent); font-size:12px; }
.config-grid h3 { margin: 0 0 4px; font-size: 13px; }
.config-grid p { min-height: 34px; margin: 0; color: var(--text-muted); font-size:12px; line-height: 1.55; }
.config-grid small { display: block; margin-top: 7px; color: var(--ui-info); }
.configuration-steps { margin-top: 18px; padding: 20px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); }
.configuration-steps h3 { margin: 0 0 10px; font-size: 14px; }
.configuration-steps ol { display: grid; gap: 8px; padding-left: 20px; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.configuration-steps a, .about-section a { color: var(--ui-info); }
code { padding: 2px 4px; border-radius: 3px; color: var(--ui-info); background: var(--bg-card); }
.field-guide { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; margin-top: 14px; }
.field-guide div { display: grid; gap: 3px; padding: 10px; background: var(--bg-card); }
.field-guide strong { font-size:12px; }
.field-guide span { color: var(--text-muted); font-size:12px; }
.optional-config { display: grid; gap: 4px; margin-top: 12px; padding: 13px; border-left: 3px solid var(--border-color); color: var(--text-muted); background: var(--bg-card); font-size:12px; }
.optional-config strong { color: var(--ui-danger); }
.rule-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.rule-list article { display: grid; grid-template-columns: 30px minmax(0,1fr); gap: 10px; padding: 15px; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); }
.rule-list article > .el-icon { color: var(--ui-accent); font-size: 21px; }
.rule-list h3 { margin: 0 0 5px; font-size: 13px; }
.rule-list p, .model-note p { margin: 0; color: var(--text-muted); font-size:12px; line-height: 1.65; }
.model-note { display: grid; gap: 4px; margin-top: 12px; padding: 14px; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); }
.model-note strong { color: var(--ui-info); font-size: 12px; }
.two-column { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.two-column > div { padding: 18px; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); }
.two-column h3 { margin: 0 0 8px; font-size: 14px; }
.two-column ul { min-height: 120px; display: grid; gap: 7px; padding-left: 18px; color: var(--text-muted); font-size:12px; line-height: 1.6; }
.director-steps { display: grid; gap: 8px; padding: 0; list-style: none; }
.director-steps li { display: grid; grid-template-columns: 32px minmax(0,1fr); gap: 10px; padding: 12px; border-bottom: 1px solid var(--border-color); }
.director-steps li > span { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--ui-accent); background: var(--bg-card); font-size:12px; }
.director-steps strong { font-size: 12px; }
.director-steps p { margin: 3px 0 0; color: var(--text-muted); font-size:12px; }
.when-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-top: 14px; }
.when-grid div { display: grid; gap: 4px; padding: 13px; border-radius: 6px; background: var(--bg-card); }
.when-grid strong { color: var(--ui-accent); font-size:12px; }
.when-grid span { color: var(--text-muted); font-size:12px; line-height: 1.55; }
.help-section :deep(.el-collapse-item__header) { padding: 0 10px; background: transparent; }
.help-section :deep(.el-collapse-item__content) { padding: 0 12px 14px; color: var(--text-muted); line-height: 1.7; }
.about-section dl { max-width: 620px; margin: 16px 0; border-top: 1px solid var(--border-color); }
.about-section dl div { display: grid; grid-template-columns: 140px 1fr; padding: 10px 0; border-bottom: 1px solid var(--border-color); font-size: 12px; }
.about-section dt { color: var(--text-muted); }
.about-section dd { margin: 0; }
.about-section dd a { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
.about-section > p:last-child { color: var(--text-muted); font-size:12px; line-height: 1.65; }
@media (max-width: 860px) {
  .help-header-inner { flex-wrap: wrap; }
  .help-header-inner > div { min-width: 0; }
  .help-search { order: 3; width: 100%; }
  .search-results { top: 104px; transform: translateX(-50%); }
  .help-layout { grid-template-columns: 1fr; gap: 16px; padding-top: 18px; }
  .help-toc { position: static; }
  .help-toc nav { grid-template-columns: repeat(4,minmax(0,1fr)); border: 1px solid var(--border-color); }
  .help-toc nav button { text-align: center; }
  .toc-support { display: none; }
  .autonomy-steps { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px 0; }
  .autonomy-steps span:nth-child(2) { border-right: 0; }
}
@media (max-width: 620px) {
  .help-section h1 { font-size: 23px; }
  .help-toc nav { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .flow-list article { grid-template-columns: 32px minmax(0,1fr); }
  .flow-list small { grid-column: 2; text-align: left; }
  .mode-table { overflow-x: auto; }
  .mode-row { min-width: 690px; }
  .autonomy-steps { grid-template-columns: 1fr; }
  .autonomy-steps span { padding: 7px 0; border-right: 0; border-bottom: 1px solid var(--border-color); }
  .autonomy-steps span:last-child { border-bottom: 0; }
  .section-title-row { flex-direction: column; }
  .config-grid, .field-guide, .rule-list, .two-column, .when-grid { grid-template-columns: 1fr; }
  .two-column ul { min-height: 0; }
}
</style>
