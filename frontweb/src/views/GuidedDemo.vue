<template>
  <div class="guided-demo">
    <header class="demo-header">
      <div class="demo-header-inner">
        <el-button :icon="ArrowLeft" circle aria-label="返回首页" @click="router.push('/')" />
        <div class="demo-title">
          <strong>零成本流程模拟</strong>
          <span>真实项目离线副本 · 《璞玉潜龙》</span>
        </div>
        <div class="demo-mode"><el-icon><Lock /></el-icon>本地演示 · 不调用模型</div>
        <el-button :icon="QuestionFilled" @click="router.push('/help')">查看说明书</el-button>
      </div>
    </header>

    <main class="demo-main">
      <nav class="demo-steps" aria-label="模拟制作步骤">
        <button
          v-for="(item, index) in steps"
          :key="item.key"
          type="button"
          :class="['demo-step', { active: index === currentStep, complete: index < currentStep }]"
          :disabled="index > currentStep"
          @click="currentStep = index"
        >
          <span>{{ index < currentStep ? '✓' : index + 1 }}</span>
          <strong>{{ item.label }}</strong>
          <small>{{ item.short }}</small>
        </button>
      </nav>

      <div class="demo-status-line">
        <span><el-icon><InfoFilled /></el-icon>素材来自已完成的本地“测试”项目；审批、打回和下载都不会创建生产任务。</span>
        <span>当前修订：R{{ revisions[currentStep] }}</span>
      </div>

      <section v-if="currentStep === 0" class="demo-stage" aria-labelledby="demo-script-title">
        <div class="stage-heading">
          <div><p>第一步</p><h1 id="demo-script-title">阅读并审批剧本</h1></div>
          <span class="approval-state">待你确认</span>
        </div>
        <div class="script-layout">
          <article class="script-document">
            <header><strong>《璞玉潜龙》短片剧本</strong><span>21.12 秒 · 写实古装 · 16:9</span></header>
            <h2>故事梗概</h2>
            <p>古朴书院讲堂中，一名身着月白浅青改良汉服的年轻女子，面对画外质疑者从容论辩。三个独立机位逐步推高语势，以平静而笃定的目光收尾。</p>
            <h2>镜头草案</h2>
            <ol>
              <li><strong>镜头 1 · 金钟鸿鹄</strong><span>正面略低机位由中景缓慢推近，女子完成第一轮反问后停稳。</span></li>
              <li><strong>镜头 2 · 璞玉潜龙</strong><span>硬切到左侧前方近景，半步转身、按案和抬手在一个镜头内完成。</span></li>
              <li><strong>镜头 3 · 盲者辨日</strong><span>硬切到正面中景偏全景，完成最后陈词、半步向前与稳定收势。</span></li>
            </ol>
          </article>
          <aside class="review-summary">
            <h2>自动检查摘要</h2>
            <dl>
              <div><dt>角色</dt><dd>1 名 · 贯穿 3 镜头</dd></div>
              <div><dt>场景</dt><dd>1 个 · 书院讲堂</dd></div>
              <div><dt>视觉锚点</dt><dd>月白浅青服装 · 左侧暖光</dd></div>
              <div><dt>剪辑点</dt><dd>2 次普通硬切 · 不强制尾帧续拍</dd></div>
            </dl>
            <p>真实流程中，你可以逐段修改，或给文本模型一条帮写要求后自动回填。</p>
          </aside>
        </div>
      </section>

      <section v-else-if="currentStep === 1" class="demo-stage" aria-labelledby="demo-assets-title">
        <div class="stage-heading">
          <div><p>第二步</p><h1 id="demo-assets-title">确认角色与场景</h1></div>
          <span class="approval-state">2 项待确认</span>
        </div>
        <div class="asset-grid">
          <article v-for="asset in assets" :key="asset.name" class="asset-item">
            <button type="button" class="asset-image" @click="previewImage = asset.src" :aria-label="`放大查看${asset.name}`">
              <img :src="asset.src" :alt="asset.name" />
            </button>
            <div>
              <span>{{ asset.type }}</span>
              <h2>{{ asset.name }}</h2>
              <p>{{ asset.description }}</p>
              <small><el-icon><CircleCheckFilled /></el-icon>{{ asset.rule }}</small>
            </div>
          </article>
        </div>
        <p class="stage-footnote">这些图片在真实流程中会带着来源、修订和审批状态进入分镜生成；被打回的单项可以独立重做，不必重跑其它资产。</p>
      </section>

      <section v-else-if="currentStep === 2" class="demo-stage" aria-labelledby="demo-board-title">
        <div class="stage-heading">
          <div><p>第三步</p><h1 id="demo-board-title">审批分镜与可选 3D 预演</h1></div>
          <el-radio-group v-model="directorMode">
            <el-radio-button v-for="option in directorOptions" :key="option" :value="option">{{ option }}</el-radio-button>
          </el-radio-group>
        </div>
        <div class="storyboard-grid">
          <article v-for="(shot, index) in shots" :key="shot.name" class="storyboard-item">
            <img :src="shot.poster" :alt="`镜头${index + 1}分镜参考图`" />
            <div><strong>镜头 {{ index + 1 }} · {{ shot.name }}</strong><span>{{ shot.boardSummary }}</span></div>
          </article>
        </div>
        <div v-if="directorMode === '携带 3D 预演'" class="director-demo">
          <video src="/demo/director-preview.mp4" controls playsinline preload="metadata" />
          <div>
            <span>独立教程样例 · 本地录制 4.98 秒</span>
            <h2>3D 预演只负责构图与运动</h2>
            <p>真实“测试”项目本身关闭了 3D；这里的视频仅用于演示开启后的可选效果，不会冒充该项目的参考包。</p>
            <el-button :icon="VideoCamera" @click="router.push('/director?tutorial=1')">打开导演台教程</el-button>
          </div>
        </div>
        <div v-else class="skip-director-note"><el-icon><CircleCheckFilled /></el-icon><span><strong>已选择跳过 3D 预演</strong>这个镜头会只携带审批后的参考图和文字约束，不会把参考视频加入模型请求。</span></div>
      </section>

      <section v-else-if="currentStep === 3" class="demo-stage" aria-labelledby="demo-video-title">
        <div class="stage-heading">
          <div><p>第四步</p><h1 id="demo-video-title">逐镜头审核视频片段</h1></div>
          <span class="approval-state">自动路由模型</span>
        </div>
        <div class="shot-review-list">
          <article v-for="(shot, index) in shots" :key="shot.name">
            <video :src="shot.src" :poster="shot.poster" controls playsinline preload="metadata" />
            <div class="shot-review-body">
              <span class="shot-number">{{ index + 1 }}</span>
              <div><h2>{{ shot.name }}</h2><p>{{ shot.description }}</p></div>
              <dl><div><dt>时长</dt><dd>{{ shot.duration }}</dd></div><div><dt>参考</dt><dd>{{ demoShotReferenceLabel(index, directorMode, shot.transitionMode) }}</dd></div></dl>
              <span class="shot-approved"><el-icon><CircleCheckFilled /></el-icon>真实产物副本</span>
            </div>
          </article>
        </div>
        <div class="continuity-note"><el-icon><Link /></el-icon><div><strong>连续性策略</strong><p>同一长镜头尽量一次生成；不同任务之间优先在正常切镜点拼接。确需动作连续时，才把上一片段末帧作为下一片段严格首帧。</p></div></div>
      </section>

      <section v-else class="demo-stage" aria-labelledby="demo-final-title">
        <div class="stage-heading">
          <div><p>第五步</p><h1 id="demo-final-title">检查成片并交付</h1></div>
          <span class="approval-state is-approved"><el-icon><CircleCheckFilled /></el-icon>模拟完成</span>
        </div>
        <div class="final-layout">
          <video src="/demo/test-final-film.mp4" poster="/demo/test-storyboard-1.webp" controls playsinline preload="metadata" />
          <aside>
            <h2>交付包</h2>
            <ul><li>最终成片 · 21.12 秒 · 720p</li><li>2 份资产图与 3 张分镜图</li><li>3 段已批准镜头，普通硬切衔接</li><li>{{ directorMode === '携带 3D 预演' ? '教程预演已选（非原项目产物）' : '原项目跳过 3D 预演' }}</li><li>保留视频模型原声，本片无另加旁白和字幕</li></ul>
            <a class="download-demo" href="/demo/test-final-film.mp4" download="银子AI视频工作流-璞玉潜龙-演示成片.mp4"><el-icon><Download /></el-icon>下载演示成片</a>
            <p>{{ readiness.isReady ? '当前四项核心配置已齐，可以开始真实制作。' : `真实制作还缺 ${readiness.missing.length} 项核心配置。` }}</p>
          </aside>
        </div>
      </section>

      <footer class="demo-actions">
        <el-button :disabled="currentStep === 0" @click="currentStep--"><el-icon><ArrowLeft /></el-icon>上一步</el-button>
        <div>
          <el-button v-if="currentStep < steps.length - 1" @click="openRejectDialog">打回看看</el-button>
          <el-button v-if="currentStep < steps.length - 1" type="primary" @click="approveCurrent">确认并继续<el-icon><ArrowRight /></el-icon></el-button>
          <el-button v-else @click="restartDemo">重新体验</el-button>
          <el-button v-if="currentStep === steps.length - 1" type="primary" @click="startReal">{{ readiness.isReady ? '开始真实制作' : '完成核心配置' }}<el-icon><ArrowRight /></el-icon></el-button>
        </div>
      </footer>
    </main>

    <el-dialog v-model="rejectVisible" title="模拟打回" width="min(520px, 92vw)" :close-on-click-modal="false">
      <p class="reject-intro">真实流程会把你的评价保存为本阶段下一轮生成依据；这里只模拟修订，不会发出请求。</p>
      <el-input v-model="rejectReason" type="textarea" :rows="4" maxlength="300" show-word-limit placeholder="例如：第二镜发饰与角色资产不一致，请保持素银玉簪与半挽发型。" />
      <template #footer><el-button @click="rejectVisible = false">取消</el-button><el-button type="primary" :disabled="!rejectReason.trim()" @click="simulateReject">提交评价并模拟重做</el-button></template>
    </el-dialog>

    <Teleport to="body">
      <div v-if="previewImage" class="demo-image-preview" @click="previewImage = ''"><img :src="previewImage" alt="演示资产大图" /></div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowLeft, ArrowRight, CircleCheckFilled, Download, InfoFilled, Link, Lock,
  QuestionFilled, VideoCamera,
} from '@element-plus/icons-vue'
import { aiAPI } from '@/api/ai'
import { getConfigReadiness } from '@/utils/configReadiness'
import { demoShotReferenceLabel } from '@/utils/guidedDemo'

const router = useRouter()
const currentStep = ref(0)
const revisions = ref([1, 1, 1, 1, 1])
const rejectVisible = ref(false)
const rejectReason = ref('')
const previewImage = ref('')
const directorMode = ref('跳过 3D 预演')
const directorOptions = ['携带 3D 预演', '跳过 3D 预演']
const configs = ref([])
const readiness = computed(() => getConfigReadiness(configs.value))
const distributionProfile = ref({ id: 'universal', smart_routing_entry: false })

const steps = [
  { key: 'story', label: '故事', short: '剧本审批' },
  { key: 'assets', label: '资产', short: '角色与场景' },
  { key: 'storyboard', label: '分镜', short: '构图与预演' },
  { key: 'video', label: '视频', short: '逐镜审核' },
  { key: 'delivery', label: '交付', short: '剪辑与下载' },
]

const assets = [
  { type: '角色', name: '古风女子', src: '/demo/test-character-sheet.webp', description: '清秀鹅蛋脸、半挽黑发、素银玉簪与月白浅青改良短裙汉服，四视图用于稳定人脸、发型和服装。', rule: '四视图和 7 项身份锚点已确认' },
  { type: '场景', name: '书院讲堂', src: '/demo/test-scene-sheet.webp', description: '左侧木格窗暖光、后墙书架、整齐案几、灰褐木地板和空气浮尘，四视图固定空间方位。', rule: '场景结构、光线与空间锚点已确认' },
]

const shots = [
  { name: '金钟鸿鹄', duration: '6.08 秒', src: '/demo/test-shot-1.mp4', poster: '/demo/test-storyboard-1.webp', transitionMode: 'opening', boardSummary: '正面略低机位 · 6 秒 · 推近后停稳', description: '一次缓慢推近完成首轮反问与视线转移，结尾不预演下一镜动作。' },
  { name: '璞玉潜龙', duration: '8.08 秒', src: '/demo/test-shot-2.mp4', poster: '/demo/test-storyboard-2.webp', transitionMode: 'hard_cut', boardSummary: '左侧前方近景 · 8 秒 · 普通硬切', description: '独立新机位承接故事姿态，半步转身、按案和抬手在单个镜头内完成。' },
  { name: '盲者辨日', duration: '7.08 秒', src: '/demo/test-shot-3.mp4', poster: '/demo/test-storyboard-3.webp', transitionMode: 'hard_cut', boardSummary: '正面中景偏全景 · 7 秒 · 普通硬切', description: '从上一镜结束姿态开始，收低手势、向前半步并在稳定画面上切黑。' },
]

function approveCurrent() {
  currentStep.value = Math.min(steps.length - 1, currentStep.value + 1)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function openRejectDialog() {
  rejectReason.value = ''
  rejectVisible.value = true
}

function simulateReject() {
  revisions.value[currentStep.value] += 1
  rejectVisible.value = false
  ElMessage.success(`已模拟生成 R${revisions.value[currentStep.value]}，评价会成为下一轮约束`)
}

function restartDemo() {
  currentStep.value = 0
  revisions.value = [1, 1, 1, 1, 1]
  directorMode.value = '跳过 3D 预演'
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function startReal() {
  router.push({ path: '/', query: readiness.value.isReady ? { start: '1' } : { config: distributionProfile.value.smart_routing_entry ? 'yinzi' : 'laoli' } })
}

onMounted(async () => {
  try { configs.value = await aiAPI.list() } catch (_) { configs.value = [] }
  try { distributionProfile.value = await aiAPI.getDistributionProfile() } catch (_) { /* universal-safe fallback */ }
})
</script>

<style scoped>
.guided-demo { min-height: 100vh; color: var(--text-primary); background: var(--bg-card); }
.demo-header { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--border-color); background: var(--bg-card); backdrop-filter: blur(10px); }
.demo-header-inner { max-width: 1320px; min-height: 62px; margin: 0 auto; padding: 8px 18px; display: flex; align-items: center; gap: 12px; }
.demo-title { min-width: 0; display: grid; margin-right: auto; }
.demo-title strong { font-size: 15px; }
.demo-title span { color: var(--text-muted); font-size:12px; }
.demo-mode { display: inline-flex; align-items: center; gap: 5px; padding: 6px 9px; border: 1px solid var(--border-color); border-radius: 5px; color: var(--ui-accent); background: var(--bg-card); font-size:12px; white-space: nowrap; }
.demo-main { max-width: 1320px; margin: 0 auto; padding: 22px 18px 46px; }
.demo-steps { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); margin-bottom: 14px; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--bg-card); }
.demo-step { min-width: 0; min-height: 72px; display: grid; grid-template-columns: 28px minmax(0,1fr); align-content: center; column-gap: 8px; padding: 9px 12px; border: 0; border-right: 1px solid var(--border-color); color: var(--text-muted); background: transparent; text-align: left; cursor: pointer; }
.demo-step:last-child { border-right: 0; }
.demo-step > span { grid-row: 1 / span 2; width: 26px; height: 26px; display: grid; place-items: center; align-self: center; border: 1px solid var(--border-color); border-radius: 50%; color: var(--text-muted); font-size:12px; }
.demo-step strong { color: var(--text-primary); font-size: 13px; }
.demo-step small { font-size:12px; }
.demo-step.active { background: var(--bg-card); }
.demo-step.active > span { border-color: var(--border-color); color: var(--text-primary); background: var(--ui-accent-soft); }
.demo-step.complete > span { border-color: var(--border-color); color: var(--ui-accent); }
.demo-step:disabled { cursor: default; opacity: .58; }
.demo-status-line { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 18px; color: var(--text-muted); font-size:12px; }
.demo-status-line span { display: inline-flex; align-items: center; gap: 5px; }
.demo-stage { min-height: 520px; padding: 26px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); }
.stage-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
.stage-heading p { margin: 0 0 4px; color: var(--ui-accent); font-size:12px; font-weight: 700; }
.stage-heading h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
.approval-state { display: inline-flex; align-items: center; gap: 5px; padding: 6px 9px; border: 1px solid var(--border-color); border-radius: 5px; color: var(--ui-warning); background: var(--bg-card); font-size:12px; white-space: nowrap; }
.approval-state.is-approved { border-color: var(--border-color); color: var(--ui-accent); background: var(--bg-card); }
.script-layout { display: grid; grid-template-columns: minmax(0,1.8fr) minmax(260px,.7fr); gap: 24px; }
.script-document { padding-right: 24px; border-right: 1px solid var(--border-color); }
.script-document header { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 15px; border-bottom: 1px solid var(--border-color); }
.script-document header span { color: var(--text-muted); font-size:12px; }
.script-document h2, .review-summary h2, .asset-item h2, .director-demo h2, .shot-review-list h2, .final-layout h2 { margin: 18px 0 7px; font-size: 14px; }
.script-document p, .script-document li, .review-summary p { color: var(--text-muted); font-size: 13px; line-height: 1.75; }
.script-document ol { display: grid; gap: 9px; padding-left: 20px; }
.script-document li span { display: block; }
.review-summary dl { margin: 0; }
.review-summary dl > div { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-color); font-size: 12px; }
.review-summary dt { color: var(--text-muted); }
.review-summary dd { margin: 0; color: var(--text-primary); text-align: right; }
.asset-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; }
.asset-item { overflow: hidden; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); }
.asset-image { width: 100%; aspect-ratio: 16/10; display: block; padding: 0; border: 0; overflow: hidden; background: var(--bg-card); cursor: zoom-in; }
.asset-image img { width: 100%; height: 100%; display: block; object-fit: cover; }
.asset-item > div { padding: 14px; }
.asset-item > div > span { color: var(--ui-accent); font-size:12px; font-weight: 700; }
.asset-item h2 { margin: 4px 0 6px; }
.asset-item p { min-height: 54px; margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
.asset-item small { display: flex; align-items: center; gap: 5px; margin-top: 10px; color: var(--ui-accent); }
.stage-footnote { margin: 16px 0 0; color: var(--text-muted); font-size:12px; }
.storyboard-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; }
.storyboard-item { overflow: hidden; border: 1px solid var(--border-color); border-radius: 7px; }
.storyboard-item img { width: 100%; aspect-ratio: 16/9; display: block; object-fit: cover; background: var(--bg-card); }
.storyboard-item div { display: flex; justify-content: space-between; gap: 10px; padding: 12px; }
.storyboard-item span { color: var(--text-muted); font-size:12px; text-align: right; }
.director-demo { display: grid; grid-template-columns: minmax(0,1.45fr) minmax(260px,.75fr); gap: 18px; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border-color); }
.director-demo video { width: 100%; aspect-ratio: 16/9; background: var(--bg-card); }
.director-demo > div > span { color: var(--ui-accent); font-size:12px; }
.director-demo h2 { margin-top: 6px; }
.director-demo p { color: var(--text-muted); font-size: 12px; line-height: 1.65; }
.skip-director-note, .continuity-note { display: flex; gap: 10px; margin-top: 18px; padding: 16px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--ui-accent); background: var(--bg-card); }
.skip-director-note span { display: grid; gap: 4px; color: var(--text-muted); font-size: 12px; }
.skip-director-note strong { color: var(--ui-accent); }
.shot-review-list { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
.shot-review-list article { min-width: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: 7px; background: var(--bg-card); }
.shot-review-list article > video { width: 100%; aspect-ratio: 16/9; display: block; background: var(--bg-card); }
.shot-review-body { display: grid; grid-template-columns: 34px minmax(0,1fr); align-items: start; gap: 10px; padding: 13px; }
.shot-number { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; color: var(--ui-accent); background: var(--bg-card); font-size: 12px; }
.shot-review-list h2 { margin: 0 0 3px; }
.shot-review-list p { margin: 0; color: var(--text-muted); font-size:12px; }
.shot-review-list dl { grid-column: 2; display: flex; flex-wrap: wrap; gap: 12px 20px; margin: 0; }
.shot-review-list dl div { display: grid; gap: 2px; }
.shot-review-list dt { color: var(--text-muted); font-size:12px; }
.shot-review-list dd { margin: 0; color: var(--text-primary); font-size:12px; }
.shot-approved { grid-column: 2; display: inline-flex; align-items: center; gap: 4px; color: var(--ui-accent); font-size:12px; white-space: nowrap; }
.continuity-note { border-color: var(--border-color); color: var(--ui-info); background: var(--bg-card); }
.continuity-note strong { font-size: 12px; }
.continuity-note p { margin: 3px 0 0; color: var(--text-muted); font-size:12px; line-height: 1.6; }
.final-layout { display: grid; grid-template-columns: minmax(0,1.7fr) minmax(280px,.65fr); gap: 22px; }
.final-layout > video { width: 100%; aspect-ratio: 16/9; background: var(--bg-card); }
.final-layout aside { padding: 4px 0; }
.final-layout h2 { margin-top: 0; }
.final-layout ul { display: grid; gap: 8px; padding-left: 18px; color: var(--text-muted); font-size: 12px; }
.final-layout aside > p { color: var(--text-muted); font-size:12px; }
.download-demo { min-height: 38px; display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 0 13px; border-radius: 6px; color: var(--text-primary); background: var(--ui-accent-soft); text-decoration: none; font-size: 12px; }
.demo-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.demo-actions > div { display: flex; gap: 8px; }
.reject-intro { margin-top: 0; color: var(--text-muted); font-size: 12px; line-height: 1.65; }
.demo-image-preview { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; padding: 24px; background: var(--bg-card); cursor: zoom-out; }
.demo-image-preview img { max-width: 94vw; max-height: 92vh; object-fit: contain; }
@media (max-width: 900px) {
  .demo-steps { overflow-x: auto; grid-template-columns: repeat(5,minmax(160px,1fr)); }
  .script-layout, .director-demo, .final-layout { grid-template-columns: 1fr; }
  .script-document { padding-right: 0; border-right: 0; border-bottom: 1px solid var(--border-color); }
  .asset-grid { grid-template-columns: 1fr 1fr; }
  .storyboard-grid { grid-template-columns: 1fr 1fr; }
  .shot-review-list { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .demo-header-inner { flex-wrap: wrap; }
  .demo-mode { order: 3; width: 100%; justify-content: center; }
  .demo-main { padding: 14px 10px 32px; }
  .demo-steps { grid-template-columns: repeat(5, minmax(0, 1fr)); overflow: visible; }
  .demo-step { min-height: 62px; display: grid; grid-template-columns: 1fr; justify-items: center; align-content: center; gap: 3px; padding: 7px 3px; text-align: center; }
  .demo-step > span { grid-row: auto; width: 23px; height: 23px; }
  .demo-step strong { font-size:12px; }
  .demo-step small { display: none; }
  .demo-status-line, .stage-heading, .demo-actions { align-items: flex-start; flex-direction: column; }
  .demo-stage { min-height: 0; padding: 17px 14px; }
  .asset-grid, .storyboard-grid { grid-template-columns: 1fr; }
  .storyboard-item div { flex-direction: column; }
  .storyboard-item span { text-align: left; }
  .demo-actions > div { width: 100%; flex-wrap: wrap; }
}
</style>
