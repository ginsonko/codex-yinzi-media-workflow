<template>
  <div class="workflow-page" v-loading="loading">
    <header class="workflow-header">
      <div class="header-main">
        <el-button :icon="ArrowLeft" circle title="返回项目工作台" @click="router.push('/')" />
        <div class="project-identity">
          <strong>{{ drama?.title || 'AI 视频制作' }}</strong>
          <span>{{ activeRun ? `制作任务 ${shortRunId}` : '从故事到成片' }}</span>
        </div>
      </div>
      <div class="header-actions">
        <template v-if="activeRun">
          <span :class="['run-status', `is-${activeRun.status}`]">
            <el-icon><component :is="statusIcon(activeRun.status)" /></el-icon>
            {{ displayRunStatusLabel }}
          </span>
          <el-button :icon="Clock" circle title="任务历史" @click="historyVisible = true" />
          <el-button :icon="View" circle title="打开项目画布" @click="router.push(`/film/${dramaId}/canvas`)" />
          <el-button :icon="Setting" title="模型、Key 与制作设置" @click="openSettings">模型与 Key</el-button>
          <el-button
            v-if="!['paused', 'completed', 'cancelled'].includes(activeRun.status)"
            :icon="Close"
            title="停止当前页面等待；后台任务继续"
            @click="detachView"
          >停止查看</el-button>
          <el-button v-if="activeRun.status === 'paused'" :icon="VideoPlay" title="继续制作" @click="resumeRun">继续</el-button>
          <el-button v-else-if="!['completed', 'cancelled'].includes(activeRun.status)" :icon="VideoPause" title="暂停制作" @click="pauseRun">暂停</el-button>
        </template>
        <el-button v-else :icon="Setting" title="配置图片、文本和视频模型" @click="router.push({ name: 'ai-config' })">模型与 Key</el-button>
        <el-button v-if="!activeRun" :icon="Clock" @click="historyVisible = true">继续历史任务</el-button>
      </div>
    </header>

    <template v-if="!activeRun">
      <nav class="macro-rail start-rail" aria-label="制作流程">
        <div v-for="(macro, index) in graph.macros" :key="macro.key" :class="['macro-step', { active: index === 0 }]">
          <span>{{ index + 1 }}</span>
          <strong>{{ macro.label }}</strong>
        </div>
      </nav>

      <main class="start-main">
        <section v-if="latestResumeRun" class="resume-card" aria-live="polite">
          <div>
            <span class="section-kicker">上次未完成的制作</span>
            <strong>{{ latestResumeRun.input?.story?.slice(0, 100) || '未命名制作任务' }}</strong>
            <small>{{ stageLabel(latestResumeRun.current_stage) }} · {{ statusLabel(latestResumeRun.status) }} · {{ formatTime(latestResumeRun.updated_at) }}</small>
          </div>
          <el-button type="primary" :icon="FolderOpened" @click="selectRun(latestResumeRun.id)">继续这个任务</el-button>
        </section>
        <section class="start-source">
          <div class="section-heading">
            <div>
              <span class="section-kicker">第一步</span>
              <h1>输入故事，先生成可阅读的剧本</h1>
            </div>
            <el-radio-group v-model="newRun.sourceType" size="small">
              <el-radio-button value="idea">故事构想</el-radio-button>
              <el-radio-button value="novel">导入小说</el-radio-button>
            </el-radio-group>
          </div>

          <template v-if="newRun.sourceType === 'idea'">
            <FieldAssist
              v-model="sourceDraft"
              field-key="story_idea"
              label="故事内容"
              required
              :rows="10"
              :context="{ style: newRun.style, target_shots: newRun.targetShots }"
              constraints="写成清晰的故事梗概，保留人物、目标、阻力、转折与结局"
              placeholder="例如：一位宇航员在月面温室发现最后一颗会发光的种子，但基地氧气只剩一分钟……"
            />
          </template>
          <template v-else>
            <div class="novel-import-row">
              <el-button :icon="Upload" @click="novelInput?.click()">选择 TXT / Markdown</el-button>
              <input ref="novelInput" type="file" accept=".txt,.md,text/plain,text/markdown" hidden @change="importNovel" />
              <span>{{ novelFileName || '尚未选择文件' }}</span>
            </div>
            <div v-if="novelChapters.length" class="chapter-picker">
              <label>改编章节</label>
              <el-select v-model="selectedChapterIndexes" multiple collapse-tags collapse-tags-tooltip placeholder="选择章节" @change="syncSelectedChapters">
                <el-option v-for="chapter in novelChapters" :key="chapter.index" :label="chapter.title" :value="chapter.index" />
              </el-select>
            </div>
            <FieldAssist
              v-model="sourceDraft"
              field-key="novel_adaptation_source"
              label="选中章节与改编要求"
              required
              :rows="12"
              :context="{ chapters: selectedChapterIndexes, style: newRun.style }"
              constraints="保留原作事实，可补充改编重点，但不要虚构未提供的核心设定"
              placeholder="导入小说后，可在这里删减原文或补充改编要求"
            />
          </template>
        </section>

        <section class="start-template" aria-labelledby="template-title">
          <div class="section-heading">
            <div><span class="section-kicker">可选模板</span><h2 id="template-title">选择一个制作方向</h2></div>
            <span class="template-hint">不选择也可以直接使用通用工作流</span>
          </div>
          <el-select v-model="newRun.templateId" clearable filterable placeholder="通用创作（不套用模板）" :loading="templatesLoading">
            <el-option v-for="item in templates" :key="item.id" :label="item.name" :value="item.id">
              <span class="template-option"><strong>{{ item.name }}</strong><small>{{ item.inputs?.join('、') }}</small></span>
            </el-option>
          </el-select>
          <p v-if="selectedTemplate">{{ selectedTemplate.guardrails?.[0] }}；开始前仍可在导入计划中调整槽位。</p>
        </section>

        <section class="start-assets" aria-labelledby="asset-entry-title">
          <div class="section-heading">
            <div><span class="section-kicker">第二步（可选）</span><h2 id="asset-entry-title">先把已有素材交给 AI 整理</h2></div>
            <span class="template-hint">{{ selectedTemplate ? `当前模板：${selectedTemplate.name}` : '自由创作' }}</span>
          </div>
          <p class="start-assets-copy">上传图片、视频或文档后，AI 会给每个文件安排用途。素材会留在本页的待应用计划中，你可以继续补充故事；点击“生成剧本”后才会正式加入任务。</p>
          <InlineAssetImportPanel
            ref="inlineAssetImport"
            :drama-id="dramaId"
            :template-id="newRun.templateId"
            :template-name="selectedTemplate?.name || ''"
            :episode-id="Number(route.query.episode) || drama?.episodes?.[0]?.id || null"
            :user-intent="sourceDraft"
            :target-shots="newRun.targetShots"
            :target-shots-user-edited="targetShotsUserEdited"
            :initial-session-id="initialInlineImportSessionId"
            @planned="onInlineImportPlanned"
            @update:session="onInlineImportSessionUpdated"
          />
          <div v-if="selectedTemplate" class="template-slot-hints">
            <span><strong>建议提供</strong>{{ (selectedTemplate.inputs || []).slice(0, 3).join('、') || '故事内容、视觉参考' }}</span>
            <span><strong>AI 会补齐</strong>{{ selectedTemplate.outputs?.slice(0, 2)?.join('、') || '缺失的角色、场景和镜头设定' }}</span>
          </div>
        </section>

        <section class="start-options">
          <div class="option-block">
            <label>第三步：选择审批方式</label>
            <el-radio-group v-model="newRun.reviewOwner" class="mode-selector">
              <el-radio-button value="human">我逐步确认</el-radio-button>
              <el-radio-button value="ai">AI 审批托管</el-radio-button>
              <el-radio-button value="auto_accept">全自动制作</el-radio-button>
            </el-radio-group>
            <p>{{ modeDescription(newRun.reviewOwner) }}</p>
          </div>
          <div class="option-grid">
            <FieldAssist
              v-model="newRun.style"
              field-key="visual_style"
              label="整体视觉风格"
              :rows="2"
              compact
              constraints="一句可执行的美术风格说明"
            />
            <div class="numeric-option">
              <label>目标镜头数</label>
              <el-input-number v-model="newRun.targetShots" :min="1" :max="999" controls-position="right" @input="markTargetShotsEdited" @change="markTargetShotsEdited" />
              <small class="setting-owner-hint">{{ targetShotsUserEdited ? '已由你设置，AI 不会覆盖' : targetShotsSuggestionLabel }}</small>
            </div>
            <div class="numeric-option">
              <label>资产并发生图</label>
              <el-input-number v-model="newRun.imageConcurrency" :min="1" :precision="0" controls-position="right" />
            </div>
            <div class="numeric-option">
              <label>视频总时长上限</label>
              <el-input-number v-model="newRun.maxSeconds" :min="5" :max="180" :step="1" controls-position="right" />
            </div>
          </div>
          <div class="option-block aspect-choice">
            <label>成片画幅</label>
            <el-radio-group v-model="newRun.aspectRatio" class="aspect-selector">
              <el-radio-button v-for="item in creationAspectOptions" :key="item.value" :value="item.value">
                {{ item.label }}
              </el-radio-button>
            </el-radio-group>
            <p>默认继承项目设置；分镜图、3D 摄影机、预演录制和视频请求会共同使用这一画幅。</p>
          </div>
          <div class="option-block director-mode-choice">
            <label>3D 导演台参考</label>
            <el-radio-group v-model="newRun.directorMode" class="mode-selector">
              <el-radio-button value="auto">按镜头智能使用</el-radio-button>
              <el-radio-button value="off">完全不使用</el-radio-button>
            </el-radio-group>
            <p v-if="newRun.directorMode === 'off'">不生成导演台 JSON、不录制本地预演、不向视频模型携带导演台参考视频，最终导出也不包含导演台文件。</p>
            <p v-else>只有确实需要连续动作控制的长镜头才进入导演台；每个分镜仍可单独选择跳过。</p>
          </div>
          <div class="option-block series-context-choice">
            <label>续集资源复用（可选）</label>
            <div class="series-context-row">
              <el-select v-model="newRun.seriesGroupId" clearable filterable placeholder="不加入剧集组" @change="loadSeriesAssets">
                <el-option v-for="group in seriesGroups" :key="group.id" :label="group.name" :value="group.id" />
              </el-select>
              <el-button v-if="newRun.seriesGroupId" :loading="seriesAssetsLoading" @click="loadSeriesAssets">查看可复用资产</el-button>
              <el-button link @click="router.push('/series-groups')">管理剧集组</el-button>
            </div>
            <p v-if="newRun.seriesGroupId">已选择的剧集组资产会作为一致性上下文传给文本模型；未明确复用的候选只会给出建议，不会静默覆盖。</p>
            <p v-else>不需要续集时保持空白；已有项目不会被改动。</p>
            <div v-if="newRun.seriesGroupId && seriesAssets.length" class="series-assets-picker">
              <el-checkbox v-for="asset in seriesAssets" :key="asset.id" v-model="asset.selected">{{ asset.title }} · {{ asset.asset_type }} · v{{ asset.current_version || '—' }}</el-checkbox>
            </div>
          </div>
          <div class="routing-promise">
            <el-icon><MagicStick /></el-icon>
            <div>
              <strong>镜头模型由系统自动选择</strong>
              <span>模型执行时长以实时能力为准：即梦 2.5 使用固定 30 秒执行单元并可在本地裁剪，即梦 2.0 使用 5 / 10 / 15 秒。独立切镜不携带上一镜尾帧，连续画面可显式选择尾帧参考续接。</span>
            </div>
          </div>
        </section>

        <section v-if="preflightResult" class="preflight-result" :class="{ failed: !preflightResult.ok }">
          <div class="preflight-title">
            <el-icon><component :is="preflightResult.ok ? CircleCheck : Warning" /></el-icon>
            <strong>{{ preflightResult.ok ? '制作环境已就绪' : '部分后续能力尚未就绪' }}</strong>
          </div>
          <div class="preflight-checks">
            <span v-for="check in preflightResult.checks" :key="check.key" :class="{ failed: !check.ok }">
              <el-icon><component :is="check.ok ? CircleCheck : Warning" /></el-icon>{{ check.label }}：{{ check.detail }}
            </span>
          </div>
        </section>

        <footer class="start-footer">
          <div v-if="starting" class="start-progress" role="status" aria-live="polite">
            <div><el-icon class="is-loading"><Loading /></el-icon><strong>正在保存故事并准备制作任务</strong></div>
            <el-progress :percentage="100" :indeterminate="true" :show-text="false" :duration="1.4" />
            <span>如果本页有已分析素材，系统会先把可用项纳入任务，再开始生成剧本。</span>
          </div>
          <div>
            <strong>{{ startButtonLabel }}</strong>
            <span>总视频预算 {{ newRun.maxSeconds }} 秒；先生成剧本，再按所选审批方式继续。所有阶段都可回看、跳过或稍后处理。</span>
          </div>
          <el-button type="primary" size="large" :icon="VideoPlay" :loading="starting" :disabled="!sourceDraft.trim()" @click="createAndStartRun">
            {{ startButtonLabel }}
          </el-button>
        </footer>
      </main>
    </template>

    <template v-else>
      <nav class="macro-rail" aria-label="制作进度">
        <button
          v-for="(macro, index) in graph.macros"
          :key="macro.key"
          type="button"
          :class="['macro-step', macroState(macro)]"
          :disabled="!canOpenMacro(macro)"
          @click="openMacro(macro)"
        >
          <span><el-icon v-if="macroState(macro).done"><Check /></el-icon><template v-else>{{ index + 1 }}</template></span>
          <strong>{{ macro.label }}</strong>
          <small>{{ macroProgress(macro) }}</small>
        </button>
      </nav>

      <main class="workflow-main">
        <section v-if="runProjectAspectMismatch" class="run-aspect-notice" data-workflow-anchor="aspect-notice">
          <el-icon><Warning /></el-icon>
          <div>
            <strong>项目现在是 {{ projectAspect.label }}，这个历史任务仍按 {{ activeRunAspect.label }} 制作</strong>
            <span>任务画幅在创建时固定，已有分镜图、3D 预演和视频不会被静默裁切或改写。</span>
          </div>
          <el-button :icon="Plus" @click="startNewRunWithProjectAspect">用项目画幅新建任务</el-button>
        </section>
        <section class="run-overview" data-workflow-anchor="run-overview">
          <div v-if="isViewingHistory" class="history-view-banner" role="status">
            <el-icon><View /></el-icon>
            <span><strong>正在查看：{{ currentStage?.label || displayStageKey }}</strong> · 后台执行：{{ executionStage?.label || activeRun.current_stage }}。这里只读浏览，不会打断后台生成。</span>
            <el-button link type="primary" @click="returnToExecutionStage">返回当前执行阶段</el-button>
          </div>
          <div class="current-stage-copy">
            <span class="section-kicker">{{ currentMacro?.label }}</span>
            <h1>{{ currentStage?.label || activeRun.current_stage }}</h1>
            <p>{{ stageDescription(displayStageKey) }}</p>
            <small v-if="activeRun.waiting_reason" class="waiting-reason">{{ waitingReasonLabel(activeRun.waiting_reason) }}</small>
          </div>
          <div class="run-metrics">
            <div><span>镜头</span><strong>{{ approvedShotCount }} / {{ activeRun.policy?.target_shots || 0 }}</strong></div>
            <div><span>视频额度</span><strong>{{ activeRun.usage?.video_seconds_reserved || 0 }} / {{ activeRun.budget?.max_video_seconds || 0 }}s</strong></div>
            <div><span>当前路由</span><strong>{{ currentShotArtifact ? `${currentRoute.duration || '?'}s` : '准备中' }}</strong></div>
          </div>
          <div class="mode-control">
            <label>当前审批</label>
            <el-radio-group :model-value="activeRun.review_owner" size="small" @change="changeReviewOwner">
              <el-radio-button value="human">人工</el-radio-button>
              <el-radio-button value="ai">AI</el-radio-button>
              <el-radio-button value="auto_accept">自动</el-radio-button>
            </el-radio-group>
          </div>
        </section>

        <section v-if="activeRun" class="user-guidance-card" :class="`is-${userGuidance.tone}`" aria-live="polite" data-workflow-anchor="user-guidance">
          <div class="user-guidance-icon"><el-icon><component :is="userGuidance.icon" /></el-icon></div>
          <div class="user-guidance-copy">
            <strong>{{ userGuidance.title }}</strong>
            <p>{{ userGuidance.detail }}</p>
            <small v-if="userGuidance.cost">费用状态：{{ userGuidance.cost }}</small>
          </div>
          <div class="user-guidance-next"><span>下一步</span><b>{{ userGuidance.next }}</b></div>
        </section>

        <section class="run-input-access" aria-label="创作输入与素材">
          <div>
            <strong>创作输入与素材</strong>
            <span>可随时查看故事、模板和已整理素材；补充素材不会停止后台生成。</span>
          </div>
          <el-button :icon="FolderOpened" @click="openInputReview">查看 / 补充创作输入</el-button>
        </section>

        <section v-if="displayStageKey === 'story_input'" class="story-input-view" aria-label="故事输入只读查看">
          <div class="input-review-heading"><strong>故事输入</strong><small>只读查看 · 后台制作继续运行</small></div>
          <p>{{ activeRun.input?.story || '这个任务没有保存故事文本。你可以在“查看 / 补充创作输入”中补充素材，或撤回后重新编辑故事。' }}</p>
          <div class="input-review-facts">
            <span><small>模板</small><strong>{{ runTemplateLabel }}</strong></span>
            <span><small>视觉风格</small><strong>{{ activeRun.policy?.style || '未设置' }}</strong></span>
            <span><small>目标镜头</small><strong>{{ activeRun.policy?.target_shots || '—' }}</strong></span>
          </div>
          <div class="story-input-view-actions"><el-button type="primary" :icon="FolderOpened" @click="openInputReview">查看 / 补充素材</el-button><el-button v-if="activeRun.status !== 'completed' && activeRun.status !== 'cancelled'" link type="danger" @click="reopenStoryForRevision">撤回确认并修改故事</el-button></div>
        </section>

        <section v-if="activeRun" class="cost-summary" data-workflow-anchor="cost-summary" aria-label="任务费用">
          <div class="cost-summary-main">
            <el-icon><Wallet /></el-icon>
            <div>
              <strong>任务费用</strong>
              <span>{{ costSummaryLabel }}</span>
            </div>
          </div>
          <div class="cost-summary-metrics">
            <span><small>已结算</small><b>{{ formatUsd(costsSummary.settled_usd) }}</b></span>
            <span><small>已预留</small><b>{{ formatUsd(costsSummary.reserved_usd) }}</b></span>
            <span v-if="costsSummary.uncertain_usd > 0"><small>待对账</small><b class="is-warning">{{ formatUsd(costsSummary.uncertain_usd) }}</b></span>
            <span v-if="costsSummary.unpriced_count > 0"><small>未定价</small><b class="is-warning">{{ costsSummary.unpriced_count }} 项</b></span>
            <span v-if="costsSummary.limit_usd != null"><small>剩余额度</small><b>{{ formatUsd(costsSummary.remaining_usd) }}</b></span>
          </div>
          <el-button link type="primary" :loading="costsLoading" @click="openCosts">查看明细</el-button>
        </section>

        <section
          v-if="isUnattendedMode"
          :class="['autonomy-strip', { 'needs-attention': Boolean(autonomyIntervention) }]"
          aria-live="polite"
        >
          <el-icon :class="{ 'is-loading': !autonomyIntervention && !['completed', 'paused'].includes(activeRun.status) }">
            <component :is="autonomyIntervention ? Warning : activeRun.status === 'completed' ? CircleCheck : activeRun.status === 'paused' ? VideoPause : Loading" />
          </el-icon>
          <div class="autonomy-copy">
            <strong>{{ autonomyView.title }}</strong>
            <span>{{ autonomyView.detail }}</span>
          </div>
          <dl class="autonomy-facts">
            <div><dt>当前对象</dt><dd>{{ autonomyView.currentObject }}</dd></div>
            <div><dt>连续尝试</dt><dd>{{ autonomyView.attempt }} / {{ autonomyView.attemptLimit }}</dd></div>
            <div><dt>最近处理</dt><dd>{{ autonomyRecentText }}</dd></div>
          </dl>
        </section>

        <section v-if="autonomyIntervention" class="autonomy-intervention" role="alert" data-workflow-anchor="autonomy-intervention">
          <div class="intervention-main">
            <span class="section-kicker">自动流程已安全停止</span>
            <h2>{{ autonomyIntervention.summary?.title || '需要你处理一次' }}</h2>
            <p>{{ autonomyView.detail }}</p>
            <small v-if="autonomyIntervention.summary?.reason">最后原因：{{ autonomyIntervention.summary.reason }}</small>
            <small v-if="autonomyIntervention.summary?.suggestion">下一步：{{ autonomyIntervention.summary.suggestion }}</small>
            <details v-if="autonomyIntervention.summary?.attempted?.length">
              <summary>查看系统已经尝试过的处理</summary>
              <ul>
                <li v-for="(attempt, index) in autonomyIntervention.summary.attempted" :key="`${attempt.at}-${index}`">
                  {{ attempt.action || attempt.kind || '自动处理' }}{{ attempt.model ? ` · ${attempt.model}` : '' }}{{ attempt.reason ? ` · ${attempt.reason}` : '' }}
                </li>
              </ul>
            </details>
          </div>
          <div class="intervention-actions">
            <el-button :icon="Setting" @click="openSettings">检查模型与配置</el-button>
            <el-button v-if="activeRun.review_owner !== 'human'" :icon="Edit" @click="changeReviewOwner('human')">转为人工处理</el-button>
            <template v-if="activeRun.review_owner === 'human'">
              <el-button :loading="resolvingIntervention" @click="resolveIntervention('ai')">已处理，恢复 AI 审批</el-button>
              <el-button type="primary" :loading="resolvingIntervention" @click="resolveIntervention('auto_accept')">已处理，恢复全自动</el-button>
            </template>
            <el-button v-else type="primary" :loading="resolvingIntervention" @click="resolveIntervention(activeRun.review_owner)">
              已处理，继续{{ activeRun.review_owner === 'ai' ? ' AI 审批' : '全自动' }}
            </el-button>
          </div>
        </section>

        <section v-if="shotStrip.length" class="shot-strip" aria-label="镜头制作队列">
          <button
            v-for="shot in shotStrip"
            :key="shot.id"
            type="button"
            :class="['shot-chip', {
              active: String(shot.scope_id) === String(selectedShotId || activeRun.current_scope_id),
              approved: shot.status === 'approved' && shot.content?.included !== false,
              skipped: shot.content?.included === false,
            }]"
            :aria-pressed="String(shot.scope_id) === String(selectedShotId || activeRun.current_scope_id)"
            :title="routeHeadline(artifactRoute(shot), shot)"
            @click="selectShot(shot)"
          >
            <span>#{{ shot.content?.number || shot.scope_id }}</span>
            <strong>{{ shot.content?.title || shot.title }}</strong>
            <small>{{ routeHeadline(artifactRoute(shot), shot) }}</small>
            <em>{{ shotStateLabel(shot) }}</em>
          </button>
        </section>

        <ShotRouteCard
          v-if="currentShotArtifact"
          :artifact="currentRouteSource.artifact || currentShotArtifact"
          :route="currentRoute"
          :editing="videoRoutingLoading && String(videoRoutingShotId) === String(currentViewScopeId)"
          :editable="!isViewingHistory && (!isUnattendedMode || Boolean(autonomyIntervention))"
          compact
          @edit="openVideoModelPicker"
        />
        <section v-if="currentShotArtifact" class="shot-operations" aria-label="当前镜头操作">
          <div class="shot-operation-copy">
            <span class="section-kicker">镜头 #{{ currentShotArtifact.content?.number || currentShotArtifact.scope_id }}</span>
            <strong>{{ shotStateLabel(currentShotArtifact) }}</strong>
            <small v-if="currentShotArtifact.content?.included === false">此镜头已退出主序列；已外发任务完成后只进入素材库，不会阻塞后续镜头。</small>
            <small v-else>操作只影响当前镜头；全自动和 AI 审批会在操作完成后继续无人值守流程。</small>
          </div>
          <div class="shot-operation-actions">
            <el-button
              v-if="currentShotArtifact.content?.included === false"
              :icon="Refresh"
              :loading="shotOperationBusy"
              @click="restoreShotOperation(currentShotArtifact)"
            >恢复镜头</el-button>
            <template v-else>
              <el-button :icon="Edit" :loading="shotOperationBusy" @click="reviseShotOperation(currentShotArtifact)">按意见修改</el-button>
              <el-button :icon="Files" :loading="shotOperationBusy" @click="splitShotOperation(currentShotArtifact)">拆成两镜</el-button>
              <el-button :icon="VideoCamera" :loading="shotOperationBusy" @click="pickupShotOperation(currentShotArtifact)">补拍一镜</el-button>
              <el-button type="danger" plain :icon="Remove" :loading="shotOperationBusy" @click="skipShotOperation(currentShotArtifact)">跳过整个镜头</el-button>
            </template>
          </div>
        </section>
        <ProviderStatus
          v-if="activeRun.status === 'waiting_provider' || activeProviderAction"
          class="provider-status-spacing"
          :run="activeRun"
          :action="activeProviderAction"
          :configured-model="currentRoute.model"
          :bundle-model="currentRoute.receipt_model || currentRouteSource.route?.model || ''"
        />
        <section v-if="ambiguousProviderAction" class="ambiguous-recovery-card" aria-live="polite" aria-label="视频提交结果核对">
          <div class="ambiguous-recovery-heading">
            <div>
              <span class="section-kicker">这次提交需要你确认一下</span>
              <h2>上游没有明确返回任务号，不能直接重复生成</h2>
              <p>视频可能已经在云端创建，也可能根本没有创建。系统已停在这里防止重复扣费，你的镜头、参考包和失败记录都还在。</p>
            </div>
            <el-tag type="warning" effect="plain">费用待核对</el-tag>
          </div>
          <div class="ambiguous-recovery-facts">
            <span><small>实际模型</small><strong>{{ ambiguousProviderAction.request?.model || currentRoute.model || '未记录' }}</strong></span>
            <span><small>提交时间</small><strong>{{ formatTime(ambiguousProviderAction.created_at) || '未知' }}</strong></span>
            <span><small>本地记录</small><strong>任务 #{{ ambiguousProviderAction.id }}<template v-if="ambiguousProviderAction.generation_id"> · 视频 #{{ ambiguousProviderAction.generation_id }}</template></strong></span>
          </div>
          <el-alert
            v-if="ambiguousRecoveryResult?.message"
            :type="ambiguousRecoveryResult.status === 'still_ambiguous' ? 'warning' : 'success'"
            :closable="false"
            show-icon
            :title="ambiguousRecoveryResult.message"
          />
          <div class="ambiguous-primary-action">
            <el-button
              v-if="ambiguousRecoveryStage === 'retry_ready'"
              type="primary"
              :loading="ambiguousRecoveryBusy"
              @click="startAmbiguousRetry"
            >创建一次新尝试</el-button>
            <el-button
              v-else-if="ambiguousRecoveryStage === 'checked_unresolved'"
              type="primary"
              :loading="ambiguousRecoveryBusy"
              @click="confirmAmbiguousNotCreated"
            >确认上游无任务，解锁一次重试</el-button>
            <el-button
              v-else
              type="primary"
              :loading="ambiguousRecoveryBusy"
              @click="reconcileAmbiguousAction('check_existing')"
            >重新核对原任务</el-button>
            <span v-if="ambiguousRecoveryStage === 'retry_ready'">将先展示最新模型、执行时长、执行单元和预计费用；你再次确认后才会继续。</span>
            <span v-else-if="ambiguousRecoveryStage === 'checked_unresolved'">核对仍没有找到任务。只有你确认已检查上游记录后，系统才会解锁；这一步仍不会创建视频。</span>
            <span v-else>只查询现有记录，不会创建新视频，也不会再次扣费。</span>
          </div>
          <details class="ambiguous-other-actions">
            <summary>其它解决办法</summary>
            <div>
              <el-button :disabled="ambiguousRecoveryBusy" @click="attachAmbiguousProviderTask">我有上游任务 ID</el-button>
              <el-button v-if="ambiguousRecoveryStage !== 'retry_ready'" :disabled="ambiguousRecoveryBusy" @click="reconcileAmbiguousAction('check_existing')">再次核对原任务</el-button>
              <el-button :disabled="ambiguousRecoveryBusy" @click="openVideoModelPicker(currentShotArtifact)">修改视频模型</el-button>
              <el-button :disabled="ambiguousRecoveryBusy" @click="returnToReferenceBundle">返回检查参考包</el-button>
              <el-button type="danger" plain :disabled="ambiguousRecoveryBusy || !currentShotArtifact" @click="skipShotOperation(currentShotArtifact)">跳过这个镜头</el-button>
              <el-button link :disabled="ambiguousRecoveryBusy" @click="reconcileAmbiguousAction('keep_pending')">稍后再处理</el-button>
            </div>
          </details>
          <details class="failure-details">
            <summary>查看技术回执</summary>
            <code>{{ ambiguousProviderAction.error_code || 'VIDEO_CREATE_AMBIGUOUS' }} · {{ ambiguousProviderAction.error_message || '上游创建结果不明确' }}</code>
          </details>
        </section>
        <el-alert
          v-if="activeProviderAction && ['reserved', 'submitted', 'waiting'].includes(activeProviderAction.status)"
          class="provider-cancel-strip"
          type="info"
          :closable="false"
          show-icon
        >
          <template #title>云端任务正在处理</template>
          <template #default>
            <span>可以停止本页等待，不影响后台生成；如需请求供应商取消，请展开操作。</span>
            <el-button link type="primary" :loading="actionCancelling" @click="cancelCurrentAction">停止当前请求</el-button>
          </template>
        </el-alert>

        <div class="substage-row" aria-label="当前阶段明细">
          <button
            v-for="stage in currentMacroStages"
            :key="stage.key"
            type="button"
            :class="substageClass(stage)"
            :disabled="isDirectorStageDisabled(stage) || stageIndex(stage.key) > stageIndex(activeRun.current_stage)"
            @click="returnToStage(stage)"
          >
            <el-icon><component :is="substageIcon(stage)" /></el-icon>{{ stage.label }}{{ isDirectorStageDisabled(stage) ? '（已关闭）' : '' }}
          </button>
        </div>

        <el-alert
          v-if="generationFailureMessage && !isUnattendedMode && !ambiguousProviderAction"
          class="run-alert"
          type="error"
          :closable="false"
          show-icon
          :title="generationFailureMessage"
        >
          <template #default>
            <details v-if="generationFailureDetail && generationFailureDetail !== generationFailureMessage" class="failure-details">
              <summary>查看技术错误</summary>
              <code>{{ generationFailureDetail }}</code>
            </details>
            <div v-if="isDirectorFailure" class="director-failure-recovery">
              <p>这是本地免费 3D 预演失败，不代表分镜、上传图片或后续视频不可用。你可以修复后重试，也可以只跳过预演继续；这三个操作都不会提交视频或产生视频费用。</p>
              <div class="director-failure-actions">
                <el-button size="small" type="primary" :loading="directorRecoveryBusy" @click="retryDirectorFailure">修复并重试导演台</el-button>
                <el-button size="small" :loading="directorRecoveryBusy" @click="skipDirectorForCurrentShot">只跳过本镜头导演台</el-button>
                <el-button size="small" plain :loading="directorRecoveryBusy" @click="disableDirectorForRun">关闭本项目导演台并继续</el-button>
              </div>
              <small>只跳过导演台不会删除当前镜头；上传图片、分镜图仍会进入后续参考包。若要把整个镜头移出成片，请使用上方“跳过整个镜头”。</small>
            </div>
            <div v-else-if="latestFailedAction" class="retry-controls">
              <el-input v-model="retryReason" size="small" placeholder="可选：说明这次要修改什么" @keyup.enter="retryFailedGeneration" />
              <el-button size="small" type="primary" :loading="driving" @click="retryFailedGeneration">一键重试</el-button>
              <el-button
                v-if="canRecoverStoryboard"
                size="small"
                :loading="driving"
                @click="recoverStoryboard"
              >使用已确认粗分镜恢复</el-button>
            </div>
            <el-button v-else size="small" @click="resumeRun">修正后继续</el-button>
          </template>
        </el-alert>

        <section v-if="pendingClientAction && activeRun.policy?.director_mode !== 'off'" class="client-action-section" data-workflow-anchor="client-action">
          <div class="section-heading compact-heading">
            <div>
              <span class="section-kicker">本地免费预演</span>
              <h2>录制镜头 {{ pendingClientAction.shot_id }} 的 3D 分镜视频</h2>
            </div>
            <el-button v-if="!isUnattendedMode" :icon="Edit" @click="openDirectorEditor(pendingClientAction)">在导演台精调</el-button>
          </div>
          <DirectorCapture
            :key="pendingClientAction.action_id"
            :run-id="activeRun.id"
            :drama-id="dramaId"
            :client-action="pendingClientAction"
            :auto-start="activeRun.review_owner !== 'human'"
            @submitted="onClientCaptureSubmitted"
          />
        </section>

        <section class="stage-surface">
          <div class="stage-toolbar">
            <div>
              <strong>{{ activeArtifacts.length }} 项内容</strong>
              <span v-if="runSummary.unresolved?.unresolved?.length">{{ runSummary.unresolved.unresolved.length }} 项待处理</span>
              <span v-else>本阶段没有阻塞项</span>
            </div>
            <div class="stage-toolbar-actions">
            <el-button v-if="previousStage" :icon="ArrowLeft" @click="returnToStage(previousStage)">{{ isViewingHistory ? '继续查看上一步' : '查看上一步' }}</el-button>
              <el-button :icon="Refresh" :loading="driving" @click="refreshAndAdvance">{{ isViewingHistory ? '刷新查看' : '刷新状态' }}</el-button>
              <div v-if="activeRun.current_stage === 'asset_images' && !isUnattendedMode" class="concurrency-control">
                <label for="asset-image-concurrency">并发生图</label>
                <el-input-number id="asset-image-concurrency" v-model="imageConcurrencyDraft" :min="1" :precision="0" size="small" controls-position="right" @change="saveImageConcurrency" />
              </div>
              <el-dropdown v-if="!isViewingHistory && supportsAdd(activeRun.current_stage) && !isUnattendedMode" trigger="click" @command="addManualArtifact">
                <el-button :icon="Plus">新增<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="option in addOptions(activeRun.current_stage)" :key="option.value" :command="option.value">{{ option.label }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-dropdown
                v-if="!isViewingHistory && manualTargetOptions.length && !isUnattendedMode"
                trigger="click"
                @command="handleManualTarget"
              >
                <el-button :icon="supportsMediaUpload(activeRun.current_stage) ? Upload : Plus" :loading="manualAdding">
                  {{ supportsMediaUpload(activeRun.current_stage) ? '手动上传' : '手动创建' }}
                  <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="target in manualTargetOptions" :key="target.key" :command="target">
                      {{ target.label }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>

          <section v-if="displayStageKey === 'final_edit'" class="final-edit-status" :class="{ 'is-actionable': finalEditState.canRebuild && !isViewingHistory }">
            <div class="final-edit-status-copy">
              <div><el-icon><Headset /></el-icon><strong>最终剪辑与旁白</strong><small>{{ finalEditState.plan ? `旁白修订 ${finalEditState.plan.revision || ''}` : '等待旁白设置' }}</small></div>
              <span>{{ finalEditState.message }}</span>
              <small v-if="finalEditState.pendingAction">本地 TTS 与 FFmpeg 正在处理，不会重复创建任务。</small>
              <small v-else>旁白按每个镜头的画面时长锁定，过长内容只在本镜头内有限加速，不会顺延到下一镜。</small>
            </div>
            <el-button
              v-if="finalEditState.canRebuild && !isUnattendedMode && !isViewingHistory"
              type="primary"
              :icon="Refresh"
              :loading="driving"
              :disabled="finalEditPlanDirty"
              @click="rebuildFinalEdit"
            >重新剪辑合成</el-button>
          </section>

          <div v-if="!activeArtifacts.length" class="empty-stage">
            <el-icon><Files /></el-icon>
            <strong>{{ emptyStageTitle }}</strong>
            <span v-if="activeRun.current_scope_id && graph.stages.find((item) => item.key === activeRun.current_stage)?.scope === 'shot'">当前查看镜头 #{{ selectedShotId || activeRun.current_scope_id }}，不会显示其它镜头的旧媒体。</span>
            <el-button
              v-if="!isViewingHistory && activeRun.next_stage_strategy !== 'manual_add' && !isUnattendedMode"
              type="primary"
              :loading="driving"
              :disabled="activeRun.status === 'waiting_provider'"
              @click="driveRun"
            >{{ activeRun.status === 'waiting_provider' ? '云端生成中' : '开始生成' }}</el-button>
            <span v-if="isViewingHistory" class="unattended-empty-note">当前是历史阶段只读查看；返回执行阶段后才可以推进任务。</span>
            <span v-else-if="isUnattendedMode && activeRun.status === 'paused'" class="unattended-empty-note">制作已暂停，本地不会继续创建或提交任务。点击右上角“继续”后恢复。</span>
            <span v-else-if="isUnattendedMode" class="unattended-empty-note">系统会在后台自动创建、校验并审核本阶段内容，无需点击开始。</span>
          </div>

          <div v-else :class="['artifact-list', `stage-${displayStageKey}`, { 'is-readonly-view': isViewingHistory }]">
            <article
              v-for="artifact in activeArtifacts"
              :key="artifact.id"
              :id="artifact.scope_type === 'shot' ? `workflow-shot-${artifact.scope_id}` : undefined"
              :data-workflow-anchor="`artifact-${artifact.id}`"
              :class="['artifact-item', { excluded: artifact.content?.included === false, 'is-focused': String(artifact.scope_id) === String(selectedShotId) && artifact.scope_type === 'shot' }]"
            >
              <header class="artifact-header">
                <div class="artifact-title">
                  <span v-if="artifact.scope_type === 'shot'">#{{ artifact.scope_id }}</span>
                  <strong>{{ artifact.title || scopeLabel(artifact.scope_type) }}</strong>
                  <small>修订 {{ artifact.revision }}</small>
                </div>
                <div class="artifact-state-actions">
                  <span :class="['artifact-status', `is-${artifact.status}`]">
                    <el-icon><component :is="artifactStatusIcon(artifact.status)" /></el-icon>{{ artifactStatusLabel(artifact) }}
                  </span>
                  <el-button :icon="Clock" circle title="修订历史" @click="openRevisionHistory(artifact)" />
                </div>
              </header>

              <div v-if="artifact.content?.local_recovery_notice" class="local-recovery-note">
                <el-icon><CircleCheck /></el-icon>
                <span><strong>顺序修订已恢复</strong>{{ artifact.content.local_recovery_notice }}；普通硬切未使用上一视频尾帧。</span>
              </div>

              <ShotRouteCard
                v-if="['storyboard_plan', 'reference_bundle', 'shot_video'].includes(artifact.stage)"
                class="artifact-route-card"
                :artifact="artifact"
                :route="artifactRoute(artifact)"
                :editing="videoRoutingLoading && String(videoRoutingShotId) === String(artifact.scope_id)"
                :editable="!isViewingHistory && (!isUnattendedMode || Boolean(autonomyIntervention))"
                @edit="openVideoModelPicker"
              />

              <ShotContinuityPanel
                v-if="['storyboard_plan', 'reference_bundle', 'shot_video'].includes(artifact.stage)"
                :artifact="artifact"
                :draft="drafts[artifact.id] || artifact.content"
                :artifacts="runSummary.artifacts || []"
                :route="artifactRoute(artifact)"
                :media-url="mediaUrl"
                :editable="!isViewingHistory && !isUnattendedMode && artifact.stage === 'storyboard_plan' && artifact.status !== 'invalidated'"
                @update:mode="setContinuityMode(artifact, $event)"
              />

              <div
                v-if="artifact.stage === 'reference_bundle' && !normalizeRoute(artifactRoute(artifact), artifact).requiresDirectorPreview"
                class="skipped-previs"
              >
                <el-icon><CircleCheck /></el-icon>
                 <span><strong>{{ activeRun.policy?.director_mode === 'off' ? '本任务已关闭 3D 导演台' : '本镜头已跳过 3D 预演' }}</strong>只使用已确认的分镜图、角色/场景资源图、音频和文本描述，不添加参考视频。</span>
              </div>

              <div v-if="artifact.media_path" class="artifact-media">
                <img v-if="isImageArtifact(artifact)" :src="mediaUrl(artifact.media_path)" :alt="artifact.title || '生成图片'" />
                <video v-else controls preload="metadata" :src="mediaUrl(artifact.media_path)" />
                <a :href="mediaUrl(artifact.media_path)" download>
                  <el-icon><Download /></el-icon>下载文件
                </a>
                <template v-if="isImageArtifact(artifact) && !isUnattendedMode && !isViewingHistory">
                  <el-select v-model="privacyMode" size="small" aria-label="隐私派生模式" style="width: 170px">
                    <el-option label="灰度 + 随机绕线" value="line_grayscale" />
                    <el-option label="面部九宫格细节" value="face_grid" />
                  </el-select>
                  <el-input-number v-if="privacyMode === 'line_grayscale'" v-model="privacyDensity" :min="0.02" :max="0.6" :step="0.02" size="small" controls-position="right" aria-label="隐私线条密度" />
                  <el-button link :loading="privacyBusyId === artifact.id" @click="derivePrivacyImage(artifact)">{{ privacyMode === 'face_grid' ? '生成九宫格派生图' : '生成隐私派生图' }}</el-button>
                </template>
              </div>

              <div v-if="artifact.content?.kind === 'final_video' && (artifact.content?.narration_audio_path || artifact.content?.subtitle_path)" class="final-sidecars">
                <a v-if="artifact.content.narration_audio_path" :href="mediaUrl(artifact.content.narration_audio_path)" download><el-icon><Headset /></el-icon>下载旁白 MP3</a>
                <a v-if="artifact.content.subtitle_path" :href="mediaUrl(artifact.content.subtitle_path)" download><el-icon><Document /></el-icon>下载字幕 SRT</a>
              </div>

              <div v-if="artifact.content?.included === false" class="excluded-message">
                <el-icon><Remove /></el-icon>
                <span>{{ artifact.content?.direct_clip_candidate ? 'AI 建议把此视频作为直接片段；确认后才会进入最终剪辑' : '此项不会继续生成或进入参考包' }}</span>
                <el-button v-if="artifact.content?.direct_clip_candidate && !isUnattendedMode && !isViewingHistory" link type="primary" @click="confirmDirectClip(artifact)">确认作为直接片段</el-button>
                <el-button v-if="!isUnattendedMode && !isViewingHistory" link type="primary" @click="restoreArtifact(artifact)">恢复使用</el-button>
              </div>

              <template v-else>
                <div v-if="artifact.content?.kind === 'narration_plan'" class="narration-editor">
                  <div class="narration-banner">
                    <el-icon><Headset /></el-icon>
                    <div>
                      <strong>{{ drafts[artifact.id]?.narration_enabled ? '将合成中文旁白并保留环境声' : '当前仅保留视频原声，不会调用 TTS' }}</strong>
                      <span>{{ isUnattendedMode
                        ? '系统会自动校验旁白时长、字幕和混音；分镜或旁白变化后自动重做旧成片。'
                        : '这是最终 FFmpeg 前的独立确认；分镜或旁白文字变化后，旧确认会自动失效。' }}</span>
                    </div>
                  </div>
                  <div class="narration-settings-grid">
                    <div class="numeric-field">
                      <label>生成旁白</label>
                      <el-switch v-model="drafts[artifact.id].narration_enabled" :disabled="isViewingHistory || isUnattendedMode" active-text="开启" inactive-text="关闭" @change="markDirty(artifact.id)" />
                    </div>
                    <div class="numeric-field">
                      <label>音色提供方</label>
                      <el-select v-model="drafts[artifact.id].voice_provider" :disabled="isViewingHistory || isUnattendedMode" @change="markDirty(artifact.id)">
                        <el-option label="Edge Neural（需联网）" value="edge" />
                        <el-option label="OpenAI 兼容 TTS（需已配置）" value="openai" />
                        <el-option label="MiniMax TTS（需已配置）" value="minimax" />
                      </el-select>
                    </div>
                    <div class="numeric-field">
                      <label>音色 ID</label>
                      <el-input v-model="drafts[artifact.id].voice_id" :disabled="isViewingHistory || isUnattendedMode" placeholder="zh-CN-XiaoyiNeural" @input="markDirty(artifact.id)" />
                    </div>
                    <div class="numeric-field">
                      <label>语速</label>
                      <el-input-number v-model="drafts[artifact.id].speed" :disabled="isViewingHistory || isUnattendedMode" :min="0.75" :max="1.5" :step="0.05" controls-position="right" @change="markDirty(artifact.id)" />
                    </div>
                    <div class="numeric-field">
                      <label>字幕交付</label>
                      <el-select v-model="drafts[artifact.id].subtitle_mode" :disabled="isViewingHistory || isUnattendedMode || !drafts[artifact.id].narration_enabled" @change="markDirty(artifact.id)">
                        <el-option label="烧录并另存 SRT" value="burn" />
                        <el-option label="仅另存 SRT" value="sidecar" />
                        <el-option label="不生成字幕" value="off" />
                      </el-select>
                    </div>
                    <div class="numeric-field">
                      <label>原声自动压低</label>
                      <el-switch v-model="drafts[artifact.id].ducking_enabled" :disabled="isViewingHistory || isUnattendedMode || !drafts[artifact.id].narration_enabled" active-text="开启" inactive-text="关闭" @change="markDirty(artifact.id)" />
                    </div>
                  </div>
                  <details class="narration-expert-settings">
                    <summary>混音细节</summary>
                    <div class="narration-settings-grid">
                      <div class="numeric-field">
                        <label>视频原声音量</label>
                        <el-input-number v-model="drafts[artifact.id].provider_audio_volume" :disabled="isViewingHistory || isUnattendedMode" :min="0" :max="1.5" :step="0.05" controls-position="right" @change="markDirty(artifact.id)" />
                      </div>
                      <div class="numeric-field">
                        <label>旁白音量</label>
                        <el-input-number v-model="drafts[artifact.id].narration_volume" :disabled="isViewingHistory || isUnattendedMode" :min="0" :max="2" :step="0.05" controls-position="right" @change="markDirty(artifact.id)" />
                      </div>
                      <div class="numeric-field">
                        <label>自然加速上限</label>
                        <el-input-number v-model="drafts[artifact.id].max_speed_ratio" :disabled="isViewingHistory || isUnattendedMode" :min="1" :max="1.35" :step="0.05" controls-position="right" @change="markDirty(artifact.id)" />
                      </div>
                    </div>
                  </details>
                  <div class="narration-segments">
                    <div class="narration-segments-heading">
                      <strong>逐镜旁白</strong>
                    <small>每段旁白锁定在自己的镜头内；过长只在本镜头内有限加速，不会跨切点顺延。</small>
                    </div>
                    <div v-for="segment in (drafts[artifact.id]?.segments || [])" :key="segment.shot_id" class="narration-segment">
                      <div class="narration-segment-heading">
                        <strong>镜头 #{{ segment.shot_id }} · {{ segment.title }}</strong>
                        <small>{{ Number(segment.duration || 0).toFixed(1) }} 秒</small>
                      </div>
                      <FieldAssist
                        v-model="segment.narration"
                        :run-id="activeRun.id"
                        field-key="narration"
                        label="旁白文本"
                        :rows="3"
                        :context="{ stage: 'final_edit', shot_id: segment.shot_id, title: segment.title, current_value: segment.narration }"
                        constraints="中文旁白，简洁、可听清，不新增剧本没有的事实"
                        :disabled="isViewingHistory || isUnattendedMode"
                        @update:model-value="markDirty(artifact.id)"
                      />
                    </div>
                  </div>
                </div>
                <div v-if="artifactFields(artifact).length" class="artifact-form">
                  <template v-for="field in artifactFields(artifact)" :key="field.key">
                    <div v-if="field.type === 'number'" class="numeric-field">
                      <label>{{ field.label }}</label>
                      <el-input-number
                        v-model="drafts[artifact.id][field.key]"
                       :disabled="isViewingHistory || isUnattendedMode"
                        :min="field.min"
                        :max="field.max"
                        :step="field.step || 1"
                        controls-position="right"
                        @change="markDirty(artifact.id)"
                      />
                      <small v-if="field.help" class="field-help">{{ field.help }}</small>
                    </div>
                    <div v-else-if="field.type === 'select'" class="numeric-field">
                      <label>{{ field.label }}</label>
                      <el-select v-model="drafts[artifact.id][field.key]" :disabled="isViewingHistory || isUnattendedMode" @change="markDirty(artifact.id)">
                        <el-option v-for="option in field.options" :key="option.value" :label="option.label" :value="option.value" />
                      </el-select>
                    </div>
                    <FieldAssist
                      v-else
                      v-model="drafts[artifact.id][field.key]"
                      :run-id="activeRun.id"
                      :field-key="field.key"
                      :label="field.label"
                      :required="field.required"
                      :rows="field.rows || 3"
                      :multiline="field.multiline !== false"
                      :compact="field.compact"
                      :constraints="field.constraints || ''"
                      :context="fieldContext(artifact, field)"
                      :disabled="isViewingHistory || isUnattendedMode || artifact.status === 'invalidated'"
                      @update:model-value="markDirty(artifact.id)"
                    />
                  </template>
                </div>

                <div v-if="artifact.stage === 'reference_bundle'" class="reference-editor">
                  <section :class="['autolink-panel', { 'has-warning': referenceAutoLinkView(artifact).warningCount > 0 }]">
                    <div class="autolink-heading">
                      <div>
                        <el-icon><MagicStick /></el-icon>
                        <span><strong>镜头资产自动引用</strong><small>{{ referenceAutoLinkView(artifact).originLabel }}</small></span>
                      </div>
                      <small v-if="referenceAutoLinkView(artifact).capacityText">{{ referenceAutoLinkView(artifact).capacityText }}</small>
                    </div>
                    <p>{{ referenceAutoLinkView(artifact).summaryText }}</p>
                    <div v-if="referenceAutoLinkView(artifact).items.length" class="autolink-items">
                      <div
                        v-for="item in referenceAutoLinkView(artifact).items"
                        :key="`${item.asset_type}-${item.normalized_name}-${item.status}`"
                        :class="['autolink-item', `is-${item.status_meta.tone}`]"
                      >
                        <el-icon><component :is="item.status === 'matched' ? CircleCheck : Warning" /></el-icon>
                        <span><strong>{{ item.label }}</strong><small>{{ item.status_meta.label }} · {{ item.reason }}</small></span>
                      </div>
                    </div>
                  </section>
                  <div v-for="bucket in referenceBuckets(artifact)" :key="bucket.key" class="reference-bucket">
                    <div class="bucket-title">
                      <span>{{ bucket.label }}</span><small>{{ bucket.limit == null ? `${bucket.items.length} · 上游校验` : `${bucket.items.length} / ${bucket.limit}（建议）` }}</small>
                    </div>
                    <div class="reference-list">
                      <div v-for="item in bucket.items" :key="item.path" class="reference-row">
                        <el-icon><component :is="bucket.key === 'images' ? Picture : bucket.key === 'videos' ? VideoCamera : Headset" /></el-icon>
                        <span><strong>{{ item.label || fileName(item.path) }}</strong><small>{{ referenceSourceText(item) }}</small></span>
                        <a :href="mediaUrl(item.path)" target="_blank" title="查看"><el-icon><View /></el-icon></a>
                        <el-icon v-if="item.locked" class="reference-lock" title="由上一镜头派生；仍可按需移除"><Lock /></el-icon>
                        <el-button v-if="!isUnattendedMode && !isViewingHistory" :icon="Close" circle :title="item.locked ? '移除派生参考' : '移除'" @click="removeReference(artifact, bucket.key, item.path)" />
                      </div>
                      <span v-if="!bucket.items.length" class="bucket-empty">暂无文件</span>
                     </div>
                      <div v-if="!isUnattendedMode && !isViewingHistory" class="reference-add-actions">
                       <el-button :icon="Plus" size="small" @click="uploadBundleReference(artifact, bucket.key)">添加{{ bucket.label }}</el-button>
                       <el-button :icon="FolderOpened" size="small" @click="openMediaPicker(artifact, bucket.key)">从素材库</el-button>
                     </div>
                  </div>
                </div>

                <details v-if="latestReview(artifact)" class="review-evidence">
                  <summary>
                    <el-icon><DocumentChecked /></el-icon>
                    {{ reviewerLabel(latestReview(artifact).reviewer_type) }}：{{ reviewDecisionLabel(latestReview(artifact).decision) }}
                  </summary>
                  <p>{{ latestReview(artifact).reason }}</p>
                  <div v-if="latestReview(artifact).scores && Object.keys(latestReview(artifact).scores).length" class="score-row">
                    <span v-for="(score, key) in latestReview(artifact).scores" :key="key">{{ scoreLabel(key) }} {{ score }}</span>
                  </div>
                </details>

                <footer class="artifact-actions">
                  <div v-if="artifact.content?.kind !== 'final_video' && !isUnattendedMode" class="edit-actions">
                    <el-button v-if="!isViewingHistory" :icon="MagicStick" :loading="suggestingId === artifact.id" @click="suggestWholeArtifact(artifact)">AI 重写此项</el-button>
                    <el-button v-if="!isViewingHistory" :icon="DocumentChecked" :disabled="!isDirty(artifact.id)" :loading="savingId === artifact.id" @click="saveArtifact(artifact)">保存为新修订</el-button>
                    <el-button v-if="!isViewingHistory && canExclude(artifact)" :icon="Delete" type="danger" plain @click="excludeArtifact(artifact)">不使用此项</el-button>
                  </div>
                  <div v-if="!isViewingHistory && !isUnattendedMode && artifact.status !== 'approved' && (artifact.content?.kind !== 'final_video' || finalEditState.currentFinalId === artifact.id)" class="review-actions">
                    <el-input v-model="reviewReasons[artifact.id]" size="small" placeholder="打回原因或修改要求" @keyup.enter="rejectArtifact(artifact)" />
                    <el-button type="danger" plain :disabled="!reviewReasons[artifact.id]?.trim()" @click="rejectArtifact(artifact)">打回</el-button>
                    <el-button type="primary" @click="approveArtifact(artifact)">确认</el-button>
                  </div>
                  <div v-else-if="artifact.content?.kind === 'final_video' && finalEditState.currentFinalId !== artifact.id" class="final-history-note">
                    <el-icon><Clock /></el-icon>
                    <span>这是旧版本成片，仅供播放和下载；请修改旁白设置后重新合成。</span>
                  </div>
                  <div v-else-if="artifact.status === 'approved'" class="approved-note">
                    <el-icon><CircleCheck /></el-icon>已确认，可继续
                    <el-button v-if="!isViewingHistory && !isUnattendedMode" link type="danger" @click="reopenArtifact(artifact)">撤销确认并打回</el-button>
                  </div>
                  <div v-else-if="isUnattendedMode && activeRun.status === 'paused'" class="autonomy-artifact-note is-paused">
                    <el-icon><VideoPause /></el-icon>制作已暂停，这一项不会继续处理
                  </div>
                  <div v-else-if="isUnattendedMode" class="autonomy-artifact-note">
                    <el-icon class="is-loading"><Loading /></el-icon>系统正在生成、校验或审核这一项
                  </div>
                </footer>
              </template>
            </article>
          </div>

          <div v-if="runSummary.unresolved?.unresolved?.length" class="unresolved-panel" role="alert">
            <div>
              <el-icon><component :is="isUnattendedMode && activeRun.status === 'paused' ? VideoPause : isUnattendedMode ? Loading : Warning" /></el-icon>
              <strong>{{ isUnattendedMode && activeRun.status === 'paused' ? '制作已暂停，未完成项保持原状' : isUnattendedMode ? '系统正在自动处理未完成项' : '还不能进入下一步' }}</strong>
            </div>
            <span v-for="(item, index) in runSummary.unresolved.unresolved.slice(0, 8)" :key="`${item.artifact_id || item.scope_id}-${index}`">
              {{ item.label || scopeLabel(item.scope_type) }}：{{ unresolvedLabel(item.reason) }}
            </span>
          </div>

          <footer class="stage-footer">
            <div class="stage-footer-copy">
              <strong>{{ runSummary.unresolved?.complete ? '本阶段已经确认完毕' : isUnattendedMode && activeRun.status === 'paused' ? '本阶段已暂停' : isUnattendedMode ? '系统会完成本阶段并自动继续' : '逐项处理后再进入下一步' }}</strong>
              <span>{{ activeRun.status === 'paused' ? '本地不会继续推进或提交新任务；已提交的外部任务不会因暂停自动取消。' : activeRun.review_owner === 'human' ? '下一步仍可选择自动生成或手动添加' : modeDescription(activeRun.review_owner) }}</span>
            </div>
            <div v-if="!isViewingHistory && !isUnattendedMode && (activeRun.current_stage !== 'final_edit' || activeRun.status !== 'completed')" class="stage-next-actions">
              <el-button
                :icon="Edit"
                :disabled="!runSummary.unresolved?.complete"
                @click="confirmStage('manual_add')"
              >确认，下一步手动添加</el-button>
              <el-button
                type="primary"
                :icon="MagicStick"
                :loading="driving"
                :disabled="!runSummary.unresolved?.complete"
                @click="confirmStage('auto_generate')"
              >确认并由 AI 生成下一步</el-button>
            </div>
            <div v-else-if="activeRun.status === 'completed'" class="stage-next-actions">
              <el-button :icon="FolderOpened" @click="exportRun">整理项目文件</el-button>
              <el-button type="primary" :icon="Download" @click="zipRun">生成交付 ZIP</el-button>
            </div>
            <div v-else-if="isUnattendedMode && activeRun.status === 'paused'" class="stage-next-actions unattended-next-state is-paused">
              <el-icon><VideoPause /></el-icon>
              <span>制作已暂停，点击右上角“继续”后再进入下一步。</span>
            </div>
            <div v-else-if="isUnattendedMode" class="stage-next-actions unattended-next-state">
              <el-icon class="is-loading"><Loading /></el-icon>
              <span>无需确认，完成后自动进入下一步</span>
            </div>
          </footer>
        </section>

        <ActivityLog v-if="events.length" class="workflow-activity" :events="events" />
      </main>
    </template>

    <el-drawer v-model="settingsVisible" title="模型、Key 与制作设置" size="min(620px, 96vw)">
      <div v-if="settingsDraft" class="settings-form">
        <label>审批方式</label>
        <el-radio-group v-model="settingsDraft.review_owner">
          <el-radio-button value="human">人工确认</el-radio-button>
          <el-radio-button value="ai">AI 审批</el-radio-button>
          <el-radio-button value="auto_accept">全自动</el-radio-button>
        </el-radio-group>
        <FieldAssist v-model="settingsDraft.style" field-key="visual_style" label="视觉风格" :run-id="activeRun?.id || ''" :rows="3" />
        <section class="image-config-panel" aria-label="图片生成配置">
          <div class="image-config-heading">
            <div>
              <strong>图片生成渠道</strong>
              <span>资源图和分镜图分别使用对应配置。Key 只在本次填写时显示，已保存 Key 不会回显。</span>
            </div>
            <el-button link type="primary" @click="router.push({ name: 'ai-config' })">打开完整 AI 配置</el-button>
          </div>
          <div v-for="kind in imageConfigKinds" :key="kind.serviceType" class="image-config-block">
            <div class="image-config-block-title">
              <label>{{ kind.label }}</label>
              <el-tag v-if="settingsDraft.image_configs?.[kind.serviceType]?.has_api_key" size="small" type="success">已配置 Key</el-tag>
              <el-tag v-else size="small" type="warning">未配置 Key</el-tag>
            </div>
            <el-select
              v-model="settingsDraft.image_configs[kind.serviceType].id"
              filterable
              value-key="id"
              placeholder="选择已保存的图片配置"
              @change="selectImageConfig(kind.serviceType)"
            >
              <el-option
                v-for="config in imageConfigs[kind.serviceType]"
                :key="config.id"
                :label="`${config.name || config.provider || '图片配置'} · ${config.default_model || config.model?.[0] || '未选择模型'}${config.is_default ? '（默认）' : ''}`"
                :value="config.id"
              />
              <el-option label="＋ 新建一套图片配置" :value="`new:${kind.serviceType}`" />
            </el-select>
            <div class="image-config-grid">
              <div>
                <label>Base URL</label>
                <el-input v-model="settingsDraft.image_configs[kind.serviceType].base_url" placeholder="https://api.yinziapi.top/v1" />
              </div>
              <div>
                <label>API Key</label>
                <el-input v-model="settingsDraft.image_configs[kind.serviceType].api_key" type="password" show-password clearable placeholder="留空保持已保存 Key" />
              </div>
            </div>
            <label>模型</label>
            <el-select v-model="settingsDraft.image_configs[kind.serviceType].model" filterable allow-create default-first-option>
              <el-option v-for="item in imageCatalog" :key="item.model" :label="item.name || item.model" :value="item.model" />
            </el-select>
            <div class="image-config-actions">
              <small>{{ settingsDraft.image_configs[kind.serviceType].name || '未选择配置' }} · 保存后设为{{ kind.label }}默认配置</small>
              <span>
                <el-button
                  size="small"
                  :loading="imageConfigTesting === kind.serviceType"
                  :disabled="!settingsDraft.image_configs[kind.serviceType].api_key?.trim() && !settingsDraft.image_configs[kind.serviceType].has_api_key"
                  @click="testImageConfig(kind.serviceType)"
                >测试连接</el-button>
                <el-button size="small" type="primary" :loading="imageConfigSaving === kind.serviceType" @click="saveImageConfig(kind.serviceType)">{{ isNewImageConfig(kind.serviceType) ? '新建并使用' : '保存此配置' }}</el-button>
              </span>
            </div>
          </div>
        </section>
        <div class="option-block director-mode-choice">
          <label>3D 导演台参考</label>
          <el-radio-group v-model="settingsDraft.director_mode">
            <el-radio-button value="auto">按镜头智能使用</el-radio-button>
            <el-radio-button value="off">完全不使用</el-radio-button>
          </el-radio-group>
          <p v-if="settingsDraft.director_mode === 'off'">关闭后不创建导演台 JSON、预演视频或参考视频；已存在的历史导演台产物仅保留审计，不进入最终导出。</p>
          <p v-else>长镜头可进入本地导演台，单个分镜仍可选择跳过。</p>
        </div>
        <section class="video-config-panel" aria-label="视频生成与路由配置">
          <div class="video-config-heading">
            <div>
              <strong>视频生成渠道与默认路由</strong>
              <span>项目默认设置始终可改；每个镜头还可以在路由卡上单独覆盖。切换配置本身不会提交视频任务。</span>
            </div>
            <div class="video-config-heading-actions">
              <el-tag v-if="activeVideoConfig?.has_api_key" size="small" type="success">视频 Key 已配置</el-tag>
              <el-tag v-else size="small" type="warning">视频 Key 待配置</el-tag>
              <el-button link type="primary" @click="router.push({ name: 'ai-config' })">管理 URL 与 Key</el-button>
            </div>
          </div>

          <div class="video-provider-receipt">
            <span><small>提供方</small><strong>{{ activeVideoProviderLabel }}</strong></span>
            <span><small>当前视频配置</small><strong>{{ activeVideoConfig?.name || '未找到启用的视频配置' }}</strong></span>
            <span><small>当前有效镜头模型</small><strong>{{ projectVideoModelLabel }}</strong></span>
            <el-button :icon="Refresh" :loading="videoCatalogLoading" @click="refreshSelectedVideoCatalog">刷新模型目录</el-button>
          </div>
          <el-alert v-if="catalogLoadError" type="warning" :closable="false" show-icon :title="catalogLoadError" />

          <div class="settings-grid video-routing-grid">
            <div class="video-config-select">
              <label>视频 URL / Key 配置</label>
              <el-select
                v-model="settingsDraft.video_config_id"
                filterable
                placeholder="选择已配置的视频渠道"
                :loading="videoConfigsLoading"
                @change="onVideoConfigChange"
              >
                <el-option
                  v-for="config in activeVideoConfigs"
                  :key="config.id"
                  :label="`${config.name || config.provider || '视频配置'} · ${config.base_url || '未填写 URL'}`"
                  :value="config.id"
                >
                  <span class="video-config-option">
                    <strong>{{ config.name || config.provider || `视频配置 #${config.id}` }}</strong>
                    <small>{{ config.base_url || '未填写 Base URL' }} · {{ config.has_api_key ? 'Key 已保存' : '缺少 Key' }}</small>
                  </span>
                </el-option>
              </el-select>
              <small class="field-hint">切换后会按这个 Key 重新读取可用模型；没有选择时不会沿用旧配置。</small>
            </div>
            <div>
              <label>视频分组</label>
              <el-select v-model="settingsDraft.video_group" filterable allow-create default-first-option placeholder="选择或手动输入视频分组" @change="projectExpensiveConfirmed = false">
                <el-option v-for="group in projectVideoGroups" :key="group" :label="group" :value="group" />
              </el-select>
            </div>
            <div>
              <label>质量偏好</label>
              <el-select v-model="settingsDraft.video_quality">
                <el-option label="均衡（推荐）" value="balanced" />
                <el-option label="速度优先" value="speed" />
                <el-option label="质量优先" value="quality" />
                <el-option label="成本优先" value="economy" />
              </el-select>
            </div>
          </div>

          <div class="project-routing-mode">
            <label>项目默认选模方式</label>
            <el-radio-group v-model="settingsDraft.video_routing_mode" @change="projectExpensiveConfirmed = false">
              <el-radio-button value="auto">按镜头自动选择</el-radio-button>
              <el-radio-button value="fixed">固定一个模型</el-radio-button>
            </el-radio-group>
            <p v-if="settingsDraft.video_routing_mode === 'auto'">系统按每镜时长、参考图/视频/音频能力、质量偏好与价格自动选择；镜头级手动覆盖仍然优先。</p>
            <p v-else>固定模型按你的选择保存；本地能力提示只用于说明风险，不会因为未登记、跨分组或参考包不匹配而禁止保存，最终由上游响应决定。</p>
          </div>

          <div v-if="settingsDraft.video_routing_mode === 'fixed'" class="fixed-video-model">
            <label>项目固定模型</label>
            <el-select v-model="settingsDraft.video_model" filterable allow-create default-first-option placeholder="从目录选择或手动输入模型名" @change="projectExpensiveConfirmed = false">
              <el-option
                v-for="option in projectVideoModelOptions"
                :key="option.model"
                :label="`${option.name || option.model} · ${modelDurationLabel(option)} · ${modelPriceLabel(option)}`"
                :value="option.model"
              />
            </el-select>
            <div v-if="projectSelectedVideoOption" class="project-model-receipt">
              <span><strong>{{ projectSelectedVideoOption.model }}</strong><small>{{ modelMediaLabel(projectSelectedVideoOption) }} · {{ modelQualityLabel(projectSelectedVideoOption) }} · {{ modelPriceLabel(projectSelectedVideoOption) }}</small></span>
              <el-tag :type="projectSelectedVideoOption.contract_status === 'known' && projectSelectedVideoOption.group_available !== false ? 'success' : 'warning'" effect="plain">{{ modelCompatibilityLabel(projectSelectedVideoOption) }}</el-tag>
            </div>
            <el-alert v-if="projectSelectedVideoOption?.warnings?.length" type="warning" :closable="false" show-icon :title="modelWarnings(projectSelectedVideoOption).join('；')" />
            <el-alert v-else-if="settingsDraft.video_model && !projectSelectedVideoOption" type="warning" :closable="false" show-icon title="模型能力尚未从当前 Key 目录确认，仍可保存并在提交时由上游校验。" />
            <el-checkbox v-if="projectSelectedVideoOption?.requires_explicit_confirmation" v-model="projectExpensiveConfirmed">
              我已确认这是高价破甲模型，并接受目录显示的价格
            </el-checkbox>
            <div class="model-contract-actions">
              <el-button link type="primary" :loading="videoCatalogLoading" @click="refreshSelectedVideoCatalog">同步当前 Key 模型与能力提示</el-button>
              <el-button link type="primary" @click="router.push({ name: 'advanced-settings', query: { tab: 'prices', model: settingsDraft.video_model || '' } })">编辑价格/契约提示</el-button>
            </div>
          </div>

          <div class="settings-grid">
            <div><label>每镜自动尝试上限</label><el-input-number v-model="settingsDraft.max_video_attempts_per_shot" :min="1" :max="20" /></div>
            <div><label>全片视频任务上限</label><el-input-number v-model="settingsDraft.max_video_attempts" :min="1" :max="120" /></div>
          </div>
          <el-alert type="info" :closable="false" show-icon title="目录和能力提示只用于自动建议与费用预估；手动选中的任意模型都会按原名提交。上游若拒绝，会保留原始原因和参考包，供你调整后重试。高价破甲模型仍需单独确认价格。" />
        </section>
        <div class="settings-grid">
          <div><label>目标镜头</label><el-input-number v-model="settingsDraft.target_shots" :min="1" :max="999" /></div>
          <div><label>总秒数上限</label><el-input-number v-model="settingsDraft.max_video_seconds" :min="5" :max="180" :step="1" /></div>
          <div><label>资产并发生图（自定义上限）</label><el-input-number v-model="settingsDraft.image_concurrency" :min="1" :precision="0" /></div>
          <div><label>文字连续返工上限</label><el-input-number v-model="settingsDraft.max_text_revisions" :min="1" :max="20" /></div>
          <div><label>资源图连续返工上限</label><el-input-number v-model="settingsDraft.max_image_revisions" :min="1" :max="20" /></div>
          <div><label>导演方案/预演返工上限</label><el-input-number v-model="settingsDraft.max_director_revisions" :min="1" :max="20" /></div>
          <div><label>自动故障恢复上限</label><el-input-number v-model="settingsDraft.max_auto_recoveries" :min="1" :max="20" /></div>
          <div class="run-budget-setting">
            <label>本任务金额上限（USD）</label>
            <el-input-number v-model="settingsDraft.max_cost_usd" :min="0" :max="1000000" :precision="6" :step="0.1" controls-position="right" placeholder="不限额" />
            <small>留空表示不限额；不能低于当前已结算、预留和待对账金额。</small>
          </div>
          <div class="run-aspect-lock">
            <label>任务画幅</label>
            <span><strong>{{ activeRunAspect.label }}</strong><el-tag size="small" effect="plain">创建时固定</el-tag></span>
            <small v-if="runProjectAspectMismatch">项目当前为 {{ projectAspect.label }}；如需改用新画幅，请另建任务。</small>
            <small v-else>分镜图、3D 摄影机、预演录制和视频请求共同使用此画幅。</small>
          </div>
        </div>
        <el-checkbox v-model="settingsDraft.allow_unknown_price">允许本任务使用未定价模型（费用会标记为未定价，不会伪装成 0 元）</el-checkbox>
        <el-checkbox v-model="settingsDraft.manual_next_default">之后默认手动添加下一阶段</el-checkbox>
        <label>AI 审批模型</label>
        <el-select v-model="settingsDraft.review_model" filterable allow-create clearable default-first-option placeholder="留空时使用默认文本模型">
          <el-option v-for="item in textCatalog" :key="item.model" :label="item.name || item.model" :value="item.model" />
        </el-select>
        <FieldAssist v-model="settingsDraft.review_prompt" field-key="review_criteria" label="AI 审批标准" :run-id="activeRun?.id || ''" :rows="5" />
        <FieldAssist v-model="settingsDraft.review_skills" field-key="review_skills" label="评审技能与检查清单" :run-id="activeRun?.id || ''" :rows="4" constraints="每行一项可执行的检查规则，例如角色身份锚点、轴线、动作连续性、镜头可制作性" />
        <div class="drawer-actions"><el-button :disabled="settingsSaving" @click="settingsVisible = false">取消</el-button><el-button type="primary" :loading="settingsSaving" :disabled="settingsSaveDisabled" @click="saveSettings">保存</el-button></div>
      </div>
    </el-drawer>

    <el-dialog v-model="inputReviewVisible" title="创作输入与素材" width="min(900px, 96vw)" class="input-review-dialog">
      <div v-if="activeRun" class="input-review">
        <div class="input-review-notice">
          <el-icon><View /></el-icon>
          <span><strong>这是当前任务的输入快照</strong>。查看或补充素材不会撤回确认，也不会停止后台生成；只有明确执行“撤回并修改”才会重做下游内容。</span>
          <el-button v-if="activeRun.status !== 'completed' && activeRun.status !== 'cancelled'" link type="danger" @click="reopenStoryForRevision">撤回确认并修改故事</el-button>
        </div>
        <div class="input-review-grid">
          <section class="input-review-story">
            <div class="input-review-heading"><strong>故事内容</strong><small>已保存 · {{ activeRun.input?.source_type === 'novel' ? '小说改编' : '故事构想' }}</small></div>
            <el-input :model-value="activeRun.input?.story || '尚未填写故事内容'" type="textarea" :rows="9" readonly resize="vertical" />
            <div class="input-review-facts">
              <span><small>模板</small><strong>{{ runTemplateLabel }}</strong></span>
              <span><small>视觉风格</small><strong>{{ activeRun.policy?.style || '未设置' }}</strong></span>
              <span><small>画幅</small><strong>{{ activeRunAspect.label }}</strong></span>
              <span><small>目标镜头</small><strong>{{ activeRun.policy?.target_shots || '—' }}</strong></span>
            </div>
          </section>
          <section class="input-review-assets">
            <div class="input-review-heading"><strong>补充图片、视频或文档</strong><small>新增内容先分析，确认应用后才影响任务</small></div>
            <InlineAssetImportPanel
              ref="runInlineAssetImport"
              :drama-id="dramaId"
              :target-run-id="activeRun.id"
              :initial-session-id="activeRun.input?.asset_import_session_id || activeRun.policy?.asset_import_session_id || activeRun.policy?.execution_plan?.asset_import_session_id"
              :template-id="String(activeRun.policy?.template_id || activeRun.input?.template_id || '')"
              :template-name="runTemplateLabel"
              :episode-id="activeRun.episode_id || null"
              :user-intent="activeRun.input?.story || ''"
              :target-shots="activeRun.policy?.target_shots || 1"
              @planned="onRunInlineImportPlanned"
              @applied="onRunInlineImportApplied"
            />
          </section>
        </div>
      </div>
      <template #footer><el-button @click="inputReviewVisible = false">关闭</el-button><el-button type="primary" @click="returnToExecutionStage">返回当前执行阶段</el-button></template>
    </el-dialog>

    <VideoModelPicker
      v-model="videoModelPickerVisible"
      :routing="videoRouting"
      :error="videoRoutingError"
      :loading="videoRoutingLoading"
      :saving="videoRoutingSaving"
      @refresh="loadVideoRouting(videoRoutingShotId)"
      @manage-capabilities="openVideoCapabilityManager"
      @save="saveVideoRouting"
    />

    <el-dialog v-model="historyVisible" title="制作任务历史" width="min(760px, 94vw)" @closed="applyPendingRunSelection">
      <div class="run-history-list">
        <button v-for="item in runs" :key="item.id" type="button" @click="selectRun(item.id)">
          <span><strong>{{ item.input?.story?.slice(0, 46) || '未命名任务' }}</strong><small>{{ formatTime(item.updated_at) }}</small></span>
          <span><em>{{ stageLabel(item.current_stage) }}</em><em>{{ statusLabel(item.status) }}</em></span>
        </button>
        <el-empty v-if="!runs.length" description="暂无历史任务" :image-size="64" />
      </div>
      <template #footer><el-button @click="historyVisible = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="revisionsVisible" :title="`${revisionTarget?.title || '内容'}的修订历史`" width="min(820px, 94vw)">
      <div class="revision-list">
        <article v-for="item in revisions" :key="item.id">
          <span>修订 {{ item.revision }}</span><strong>{{ artifactStatusLabel(item) }}</strong><small>{{ formatTime(item.updated_at) }}</small>
          <pre>{{ revisionPreview(item) }}</pre>
        </article>
      </div>
    </el-dialog>

    <el-dialog v-model="mediaPickerVisible" title="选择已批准媒体" width="min(860px, 94vw)">
      <div class="media-picker-toolbar">
        <div>
          <span>{{ mediaPickerTarget?.label || '参考媒体' }} · 从素材库选择</span>
          <el-radio-group v-model="mediaPickerScope" size="small" @change="loadReusableMedia">
            <el-radio-button value="project">本项目</el-radio-button>
            <el-radio-button value="global">全部项目</el-radio-button>
          </el-radio-group>
        </div>
        <div>
          <el-input v-model="mediaPickerKeyword" clearable placeholder="搜索名称或项目" @keyup.enter="loadReusableMedia" @clear="loadReusableMedia" />
          <el-button :icon="Refresh" :loading="mediaPickerLoading" @click="loadReusableMedia">刷新</el-button>
        </div>
      </div>
      <div class="media-picker-list">
        <button
          v-for="item in filteredReusableMedia"
          :key="`${item.artifact_id}-${item.media_path}`"
          type="button"
          :class="['media-picker-item', { 'is-unavailable': item.available === false }]"
          :disabled="item.available === false || materializingMediaId != null"
          @click="selectReusableMedia(item)"
        >
          <span class="media-picker-thumb">
            <img v-if="item.ready && item.media_type === 'image'" :src="item.media_url || mediaUrl(item.media_path)" :alt="item.title || '历史图片'" />
            <video v-else-if="item.ready && item.media_type === 'video'" muted preload="metadata" :src="item.media_url || mediaUrl(item.media_path)" />
            <el-icon v-else-if="item.ready"><Headset /></el-icon>
            <el-icon v-else><FolderOpened /></el-icon>
          </span>
          <span class="media-picker-copy">
            <strong>{{ item.title || fileName(item.media_path) }}</strong>
            <small>{{ item.drama_title || `项目 ${item.drama_id}` }} · {{ stageLabel(item.stage) }} · {{ scopeLabel(item.scope_type) }} {{ item.scope_id }}</small>
            <small v-if="isCrossProjectMedia(item, dramaId)" class="media-picker-cross-project">其他项目 · 选择后保留来源记录</small>
            <small class="media-picker-status">{{ item.ready ? '可直接使用' : item.available === false ? '源文件不可用' : '选择后自动准备' }}</small>
          </span>
          <el-icon v-if="materializingMediaId === item.artifact_id" class="is-loading"><Loading /></el-icon>
          <el-icon v-else><Plus /></el-icon>
        </button>
        <el-empty v-if="!filteredReusableMedia.length" description="暂无可复用的已批准媒体" :image-size="72" />
      </div>
    </el-dialog>

    <WorkflowUploadDialog
      v-model="uploadDialogVisible"
      :title="uploadDialogContext?.title || '上传媒体'"
      :description="uploadDialogContext?.description || ''"
      :accept="uploadDialogContext?.accept || '*/*'"
      :expected-media-type="uploadDialogContext?.expectedMediaType || 'image'"
      :endpoint="uploadDialogContext?.endpoint || 'reference'"
      :drama-id="dramaId"
      :capability="uploadDialogContext?.capability || {}"
      :current-items="uploadDialogContext?.currentItems || []"
      :targets="uploadDialogContext?.targets || []"
      :initial-target-key="uploadDialogContext?.initialTargetKey || ''"
      :max-files="uploadDialogContext?.maxFiles ?? null"
      :enforce-contract-limits="uploadDialogContext?.enforceContractLimits !== false"
      :concurrency="3"
      :commit-upload="commitWorkflowUpload"
      @finished="onWorkflowUploadFinished"
    />

    <el-dialog v-model="exportVisible" title="交付文件已整理" width="min(720px, 94vw)">
      <div v-if="exportResult" class="export-result">
        <el-icon><FolderOpened /></el-icon>
        <strong>{{ exportResult.relative_directory || exportResult.relative_zip_path }}</strong>
        <p>{{ activeRun?.policy?.director_mode === 'off'
          ? '包含剧本、资产、分镜、镜头视频、审批记录、技术回执与 manifest；不包含导演台 JSON 或预演文件。'
          : '包含剧本、资产、分镜、导演台 JSON、预演、镜头视频、审批记录、技术回执与 manifest。' }}</p>
        <a v-if="exportResult.relative_zip_path" :href="mediaUrl(exportResult.relative_zip_path)" download><el-icon><Download /></el-icon>下载 ZIP</a>
      </div>
    </el-dialog>

    <el-dialog v-model="costsVisible" title="任务费用明细" width="min(900px, 94vw)">
      <div class="cost-dialog-summary">
        <span><small>已结算</small><strong>{{ formatUsd(costsSummary.settled_usd) }}</strong></span>
        <span><small>已预留</small><strong>{{ formatUsd(costsSummary.reserved_usd) }}</strong></span>
        <span><small>不确定</small><strong :class="{ 'is-warning': costsSummary.uncertain_usd > 0 }">{{ formatUsd(costsSummary.uncertain_usd) }}</strong></span>
        <span><small>任务上限</small><strong>{{ costsSummary.limit_usd == null ? '不限额' : formatUsd(costsSummary.limit_usd) }}</strong></span>
      </div>
      <el-alert v-if="costsSummary.uncertain_usd > 0" type="warning" :closable="false" show-icon title="存在结果不确定的外部提交"><template #default>系统保留了这部分预留金额，避免服务端已扣费而客户端重复提交。</template></el-alert>
      <el-table v-loading="costsLoading" :data="costItems" stripe class="cost-table">
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag size="small" effect="plain" :type="costStatusType(row.status)">{{ costStatusLabel(row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="服务 / 模型" min-width="210"><template #default="{ row }"><span class="cost-model"><strong>{{ row.service_type || '服务' }}</strong><small>{{ row.model || '未指定模型' }}</small></span></template></el-table-column>
        <el-table-column label="用量" width="100"><template #default="{ row }">{{ row.units || 0 }} {{ costUnitLabel(row.billing_unit) }}</template></el-table-column>
        <el-table-column label="金额" width="130"><template #default="{ row }">{{ formatUsd(row.actual_usd ?? row.reserved_usd ?? row.estimated_usd) }}</template></el-table-column>
        <el-table-column prop="note" label="说明" min-width="220" show-overflow-tooltip />
        <el-table-column label="时间" width="170"><template #default="{ row }">{{ formatTime(row.created_at) }}</template></el-table-column>
      </el-table>
      <p v-if="!costItems.length && !costsLoading" class="empty-costs">当前还没有可记录的外部费用；本地模拟和内置 Edge Neural 在线语音不产生 API 费用（需要联网）。</p>
      <template #footer><el-button :icon="Refresh" :loading="costsLoading" @click="loadRunCosts(activeRun?.id)">刷新</el-button><el-button @click="costsVisible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import {
  ArrowDown, ArrowLeft, Check, CircleCheck, Clock, Close, Delete, DocumentChecked,
  Download, Edit, Files, FolderOpened, Headset, Loading, Lock, MagicStick, Picture, Plus, Wallet,
  Refresh, Remove, Setting, Upload, VideoCamera, VideoPause, VideoPlay, View, Warning,
} from '@element-plus/icons-vue'
import { dramaAPI } from '@/api/drama'
import { aiAPI } from '@/api/ai'
import { productionAPI } from '@/api/production'
import { advancedSettingsAPI } from '@/api/advancedSettings'
import { seriesGroupsAPI } from '@/api/seriesGroups'
import { templatesAPI } from '@/api/templates'
import { privacyAPI } from '@/api/privacy'
import FieldAssist from '@/components/production/FieldAssist.vue'
import DirectorCapture from '@/components/production/DirectorCapture.vue'
import ShotContinuityPanel from '@/components/production/ShotContinuityPanel.vue'
import ShotRouteCard from '@/components/production/ShotRouteCard.vue'
import VideoModelPicker from '@/components/production/VideoModelPicker.vue'
import ProviderStatus from '@/components/production/ProviderStatus.vue'
import ActivityLog from '@/components/production/ActivityLog.vue'
import WorkflowUploadDialog from '@/components/production/WorkflowUploadDialog.vue'
import InlineAssetImportPanel from '@/components/production/InlineAssetImportPanel.vue'
import { resolveTemplateStyle } from '@/utils/templateStyleOwnership'
import { resolveTemplateTargetShots, resolvedPlanTargetShots } from '@/utils/templateTargetShotOwnership'
import { resolveCreationTemplate } from '@/utils/creationTemplateRestore'
import { joinSelectedChapters, splitNovelChapters } from '@/utils/novelChapters'
import {
  buildReferenceAutoLinkView,
  referenceSourceLabel,
  selectedAutoLinkDependencyIds,
} from '@/utils/workflowReferences'
import {
  configuredShotModel,
  configuredShotPrevisMode,
  eventLabel,
  eventSummary,
  generationFailureSummary,
  isDisplayableProviderAction,
  isFixtureAction,
  mergeShotDraftPolicy,
  mergeShotRoutePolicy,
  normalizeRoute,
  routeHeadline,
  selectScopedStageArtifacts,
  selectCurrentProviderAction,
  selectAmbiguousRecoveryAction,
  selectShotRouteSource,
} from '@/utils/videoRouting'
import {
  buildProjectVideoRoutingPayload,
  catalogModelOption,
  modelCompatibilityLabel,
  modelDurationLabel,
  modelMediaLabel,
  modelPriceLabel,
  modelQualityLabel,
  modelWarnings,
  projectVideoModelDisplay,
  projectVideoRoutingChanged,
  videoGroupsFromCatalog,
} from '@/utils/videoModelRouting'
import { selectFinalEditState, selectGenerationFailureAction } from '@/utils/finalEdit'
import { isCrossProjectMedia, reusableMaterializeBody } from '@/utils/productionMedia'
import {
  normalizeProductionAspectRatio,
  productionAspectMismatch,
  productionAspectSpec,
  PRODUCTION_ASPECT_RATIOS,
} from '@/utils/aspectRatio'
import { captureWorkflowViewport, restoreWorkflowViewport } from '@/utils/workflowViewport'
import { resolveWorkflowFocus } from '@/utils/workflowFocus'
import {
  derivePendingDirectorAction,
  isUnattendedOwner,
  selectAutonomyPresentation,
} from '@/utils/productionAutonomyView'
import {
  hasSeenProductionNotification,
  normalizeProductionNotificationPreferences,
  playProductionNotificationTone,
  productionNotificationEvent,
  rememberProductionNotification,
} from '@/utils/productionNotifications'
import { productionIdleBackoffDelay, productionSemanticProgressSignature } from '@/utils/productionProgress'

const route = useRoute()
const router = useRouter()
const dramaId = Number(route.params.id)

const loading = ref(true)
const starting = ref(false)
const driving = ref(false)
const semanticIdleCount = ref(0)
const savingId = ref(null)
const suggestingId = ref(null)
const shotOperationBusy = ref(false)
const manualAdding = ref(false)
const drama = ref(null)
const graph = reactive({ stages: [], macros: [] })
const runs = ref([])
const runSummary = ref(null)
const selectedShotId = ref(null)
const selectedRunId = ref(null)
const selectedShotPinned = ref(false)
const lastOutcome = ref(null)
const sourceDraft = ref('')
const novelInput = ref(null)
const novelFileName = ref('')
const novelChapters = ref([])
const selectedChapterIndexes = ref([])
const preflightResult = ref(null)
const videoCatalog = ref([])
const seriesGroups = ref([])
const seriesAssetsLoading = ref(false)
const seriesAssets = ref([])
const templates = ref([])
const templatesLoading = ref(false)
const privacyBusyId = ref(null)
const privacyDensity = ref(0.18)
const privacyMode = ref('line_grayscale')
const videoConfigs = ref([])
const videoCatalogLoading = ref(false)
const videoConfigsLoading = ref(false)
const videoCatalogConfigId = ref(null)
const catalogLoadError = ref('')
const imageCatalog = ref([])
const imageConfigs = reactive({ image: [], storyboard_image: [] })
const imageConfigSaving = ref('')
const imageConfigTesting = ref('')
const textCatalog = ref([])
const drafts = reactive({})
const dirtyArtifacts = reactive(new Set())
const reviewReasons = reactive({})
const retryReason = ref('')
const ambiguousRecoveryBusy = ref(false)
const directorRecoveryBusy = ref(false)
const ambiguousRecoveryResult = ref(null)
const reviews = ref([])
const events = ref([])
const historyVisible = ref(false)
const pendingRunSelection = ref(null)
const settingsVisible = ref(false)
const settingsSaving = ref(false)
const projectExpensiveConfirmed = ref(false)
const revisionsVisible = ref(false)
const exportVisible = ref(false)
const settingsDraft = ref(null)
const revisionTarget = ref(null)
const revisions = ref([])
const exportResult = ref(null)
const imageConcurrencyDraft = ref(4)
const reusableMedia = ref([])
const mediaPickerVisible = ref(false)
const mediaPickerLoading = ref(false)
const mediaPickerTarget = ref(null)
const mediaPickerScope = ref('project')
const mediaPickerKeyword = ref('')
const materializingMediaId = ref(null)
const uploadDialogVisible = ref(false)
const uploadDialogContext = ref(null)
const inlineAssetImport = ref(null)
const runInlineAssetImport = ref(null)
const inlineImportSession = ref(null)
const inlineImportPlan = ref(null)
const initialInlineImportSessionId = ref(null)
const inputReviewVisible = ref(false)
const viewedStageKey = ref(null)
const videoModelPickerVisible = ref(false)
const videoRoutingShotId = ref(null)
const videoRouting = ref(null)
const videoRoutingError = ref('')
const videoRoutingLoading = ref(false)
const videoRoutingSaving = ref(false)
const resolvingIntervention = ref(false)
const actionCancelling = ref(false)
const notificationPreferences = reactive(normalizeProductionNotificationPreferences())
const costsVisible = ref(false)
const costsLoading = ref(false)
const costsItems = ref([])
const costsSummary = reactive({ settled_usd: 0, reserved_usd: 0, uncertain_usd: 0, unpriced_count: 0, limit_usd: null, remaining_usd: null })
let pollTimer = null
let loadRunViewportToken = 0
const notificationBootstrappedRuns = new Set()

const imageConfigKinds = Object.freeze([
  { serviceType: 'image', label: '资源图（角色 / 场景 / 道具）' },
  { serviceType: 'storyboard_image', label: '分镜图（按镜头生成）' },
])

const newRun = reactive({
  sourceType: 'idea',
  templateId: '',
  reviewOwner: 'human',
  style: 'CG 写实风格，电影级构图与真实材质；角色外观、服装、发型和道具保持严格一致，光照方向与色彩逻辑统一；镜头运动有明确动机，空间关系、动作先后和视线方向连续；细节清晰但不过度锐化，不出现多余人物、畸形肢体、漂移文字或不合剧情的装饰。',
  targetShots: 1,
  maxSeconds: 60,
  maxAttempts: 30,
  aspectRatio: '16:9',
  imageModel: 'gpt-image-2',
  imageConcurrency: 4,
  videoModel: '',
  videoQuality: 'balanced',
  directorMode: 'auto',
  seriesGroupId: null,
})
const targetShotsUserEdited = ref(false)
const creationDraftKey = `yinzi-ai-video:creation-draft:${dramaId}`
let restoredCreationDraft = null
try { restoredCreationDraft = JSON.parse(window.localStorage.getItem(creationDraftKey) || 'null') } catch (_) { restoredCreationDraft = null }
if (restoredCreationDraft && typeof restoredCreationDraft === 'object') {
  sourceDraft.value = String(restoredCreationDraft.story || '')
  const safeFields = ['sourceType', 'templateId', 'reviewOwner', 'style', 'targetShots', 'maxSeconds', 'maxAttempts', 'aspectRatio', 'imageModel', 'imageConcurrency', 'videoModel', 'videoQuality', 'directorMode', 'seriesGroupId']
  for (const field of safeFields) if (restoredCreationDraft[field] !== undefined) newRun[field] = restoredCreationDraft[field]
  targetShotsUserEdited.value = restoredCreationDraft.targetShotsUserEdited === true
  initialInlineImportSessionId.value = restoredCreationDraft.assetImportSessionId || null
}
const requestedTemplateId = String(route.query.template_id || '').trim()
let savedGlobalTemplateId = ''
try { savedGlobalTemplateId = window.localStorage.getItem('yinzi-ai-video:last-template-id') || '' } catch (_) {}
newRun.templateId = resolveCreationTemplate({ routeTemplateId: requestedTemplateId, restoredDraft: restoredCreationDraft, globalTemplateId: savedGlobalTemplateId })
// The series page passes only the group identity. The user still chooses
// explicit asset versions in this wizard, so navigation never implies reuse.
const requestedSeriesGroupId = Number(route.query.series_group_id)
if (Number.isSafeInteger(requestedSeriesGroupId) && requestedSeriesGroupId > 0) {
  newRun.seriesGroupId = requestedSeriesGroupId
}
const creationAspectOptions = PRODUCTION_ASPECT_RATIOS.filter((item) => ['16:9', '9:16', '1:1'].includes(item.value))

const activeRun = computed(() => runSummary.value?.run || null)
const selectedTemplate = computed(() => templates.value.find((item) => item.id === newRun.templateId) || null)
const targetShotsSuggestionLabel = computed(() => {
  const recommendation = inlineImportPlan.value?.recommended_settings?.target_shots
  if (recommendation?.reason) return recommendation.reason
  if (selectedTemplate.value?.defaults?.target_shots) return `模板默认 ${selectedTemplate.value.defaults.target_shots} 个，AI 分析后可自动调整`
  return 'AI 分析后可自动填写，你也可以手动修改'
})
const displayStageKey = computed(() => viewedStageKey.value || activeRun.value?.current_stage || 'story_input')
const isViewingHistory = computed(() => Boolean(activeRun.value && viewedStageKey.value && viewedStageKey.value !== activeRun.value.current_stage))
const executionStage = computed(() => graph.stages.find((stage) => stage.key === activeRun.value?.current_stage) || null)
const runTemplateLabel = computed(() => {
  const id = String(activeRun.value?.policy?.template_id || activeRun.value?.input?.template_id || '').trim()
  return templates.value.find((item) => String(item.id) === id)?.name || (id && id !== 'free' ? id : '自由创作')
})
const baseCreationStyle = 'CG 写实风格，电影级构图与真实材质；角色外观、服装、发型和道具保持严格一致，光照方向与色彩逻辑统一；镜头运动有明确动机，空间关系、动作先后和视线方向连续；细节清晰但不过度锐化，不出现多余人物、畸形肢体、漂移文字或不合剧情的装饰。'
const lastTemplateStyle = ref(baseCreationStyle)
watch(() => newRun.templateId, (value) => {
  try { window.localStorage.setItem('yinzi-ai-video:last-template-id', value || 'free') } catch (_) {}
  const templateStyle = selectedTemplate.value?.defaults?.style
  const resolvedStyle = resolveTemplateStyle({ currentStyle: newRun.style, targetStyle: templateStyle, templates: templates.value, baseStyle: baseCreationStyle })
  if (resolvedStyle !== newRun.style) newRun.style = resolvedStyle
  newRun.targetShots = resolveTemplateTargetShots({ currentValue: newRun.targetShots, templateDefault: selectedTemplate.value?.defaults?.target_shots || 1, userEdited: targetShotsUserEdited.value })
  if (templateStyle) lastTemplateStyle.value = templateStyle
}, { immediate: true })
function openAssetImport(picker = '') {
  if (picker === 'folder') inlineAssetImport.value?.openFolder()
  else if (picker === 'files') inlineAssetImport.value?.openFiles()
  else { inlineAssetImport.value?.openFiles(); ElMessage.info('选择素材后，点击“上传并分析”；分析期间仍可继续编辑故事。') }
}

function onInlineImportPlanned(payload) {
  inlineImportSession.value = payload?.session || null
  inlineImportPlan.value = payload?.plan || null
  const suggested = payload?.plan?.template_candidates?.[0]
  if (!newRun.templateId && suggested?.id && templates.value.some((item) => item.id === suggested.id)) {
    newRun.templateId = suggested.id
    ElMessage.info(`AI 建议使用“${selectedTemplate.value?.name || suggested.id}”模板，你仍可手动更改`)
  }
  if (!targetShotsUserEdited.value && payload?.plan?.recommended_settings?.target_shots) {
    newRun.targetShots = resolvedPlanTargetShots(payload.plan, newRun.targetShots)
  }
}
function markTargetShotsEdited() { targetShotsUserEdited.value = true }
function onInlineImportSessionUpdated(value) {
  inlineImportSession.value = value || null
  persistCreationDraft()
}
function creationDraftSnapshot() {
  return {
    story: sourceDraft.value,
    sourceType: newRun.sourceType,
    templateId: newRun.templateId,
    reviewOwner: newRun.reviewOwner,
    style: newRun.style,
    targetShots: newRun.targetShots,
    targetShotsUserEdited: targetShotsUserEdited.value,
    maxSeconds: newRun.maxSeconds,
    maxAttempts: newRun.maxAttempts,
    aspectRatio: newRun.aspectRatio,
    imageModel: newRun.imageModel,
    imageConcurrency: newRun.imageConcurrency,
    videoModel: newRun.videoModel,
    videoQuality: newRun.videoQuality,
    directorMode: newRun.directorMode,
    seriesGroupId: newRun.seriesGroupId,
    assetImportSessionId: inlineImportSession.value?.id || initialInlineImportSessionId.value || null,
    savedAt: new Date().toISOString(),
  }
}
function persistCreationDraft() {
  try { window.localStorage.setItem(creationDraftKey, JSON.stringify(creationDraftSnapshot())) } catch (_) {}
}
function clearCreationDraft() {
  try { window.localStorage.removeItem(creationDraftKey) } catch (_) {}
  initialInlineImportSessionId.value = null
}
watch([sourceDraft, () => ({
  sourceType: newRun.sourceType, templateId: newRun.templateId, reviewOwner: newRun.reviewOwner, style: newRun.style,
  targetShots: newRun.targetShots, maxSeconds: newRun.maxSeconds, maxAttempts: newRun.maxAttempts, aspectRatio: newRun.aspectRatio,
  imageModel: newRun.imageModel, imageConcurrency: newRun.imageConcurrency, videoModel: newRun.videoModel, videoQuality: newRun.videoQuality,
  directorMode: newRun.directorMode, seriesGroupId: newRun.seriesGroupId,
})], persistCreationDraft, { deep: true })
function onRunInlineImportPlanned(payload) {
  inlineImportSession.value = payload?.session || null
  inlineImportPlan.value = payload?.plan || null
}
function onRunInlineImportApplied(payload) {
  inlineImportSession.value = payload?.session || inlineImportSession.value
  inlineImportPlan.value = payload?.execution_plan || inlineImportPlan.value
  ElMessage.success('补充素材已应用到当前任务，后台生成不会被打断')
  if (activeRun.value?.id) loadRun(activeRun.value.id, { loadEvidence: false }).catch(() => {})
}
function openInputReview() {
  inputReviewVisible.value = true
  // Mounting the panel is enough to restore a persisted import session. Ask it
  // explicitly as well so a dialog reopened after a route refresh is reliable.
  nextTick(() => runInlineAssetImport.value?.restoreSession?.())
}
const isUnattendedMode = computed(() => isUnattendedOwner(activeRun.value?.review_owner))
const autonomyView = computed(() => selectAutonomyPresentation(activeRun.value || {}, events.value))
const autonomyIntervention = computed(() => autonomyView.value.intervention)
const autonomyRecentText = computed(() => {
  const event = autonomyView.value.recentEvent
  return event ? `${eventLabel(event)} · ${eventSummary(event)}` : '尚无重试，正常推进中'
})
const displayRunStatusLabel = computed(() => {
  if (isUnattendedMode.value && autonomyIntervention.value) return '需要处理'
  if (isUnattendedMode.value && activeRun.value?.status === 'waiting_review') return 'AI 自动处理中'
  if (isUnattendedMode.value && activeRun.value?.status === 'running') return '无人值守运行中'
  return statusLabel(activeRun.value?.status, isFixtureRun.value)
})
const userGuidance = computed(() => {
  const run = activeRun.value || {}
  const action = activeProviderAction.value
  const stage = currentStage.value?.label || stageLabel(run.current_stage)
  const status = String(run.status || '')
  const waiting = waitingReasonLabel(run.waiting_reason)
  if (status === 'completed') return { tone: 'success', icon: Check, title: '任务已完成', detail: `${stage}已完成，成果和任务记录已保存在本机。`, cost: costSummaryLabel.value, next: '查看成果或导出' }
  if (status === 'failed' || status === 'needs_review' || status === 'partial') return { tone: 'warning', icon: Warning, title: '任务需要处理', detail: run.error || run.message || `任务在“${stage}”遇到问题，原任务记录仍保留。`, cost: costSummaryLabel.value, next: latestFailedAction.value ? '重试失败节点' : '查看失败详情' }
  if (status === 'waiting_provider' || action?.status === 'unknown') return { tone: 'warning', icon: Clock, title: '正在等待供应商确认', detail: '系统会先核对原请求是否已被接受，期间不会自动重复提交。', cost: '待核对', next: '等待核对结果，不要重复提交' }
  if (run.waiting_reason) return { tone: 'info', icon: Clock, title: `正在等待：${waiting}`, detail: `当前阶段是“${stage}”，后台会在条件满足后继续。`, cost: costSummaryLabel.value, next: waiting || '查看任务日志' }
  if (status === 'running' || status === 'planned') return { tone: 'info', icon: Loading, title: `正在进行：${stage}`, detail: run.current_action?.label || run.message || '后台正在处理当前阶段，关闭页面不会清除任务。', cost: costSummaryLabel.value, next: '查看当前阶段进度' }
  return { tone: 'neutral', icon: Clock, title: `任务状态：${displayRunStatusLabel.value}`, detail: run.message || `当前阶段是“${stage}”。`, cost: costSummaryLabel.value, next: '查看任务详情' }
})
const activeRunAspect = computed(() => productionAspectSpec(activeRun.value?.policy?.aspect_ratio))
const projectAspect = computed(() => productionAspectSpec(drama.value?.metadata?.aspect_ratio))
const runProjectAspectMismatch = computed(() => Boolean(activeRun.value)
  && productionAspectMismatch(activeRunAspect.value.value, projectAspect.value.value))
const latestResumeRun = computed(() => (runs.value || []).find((item) => !['completed', 'cancelled'].includes(item.status)) || null)
const currentViewScopeId = computed(() => selectedShotId.value || activeRun.value?.current_scope_id || null)
const activeArtifacts = computed(() => {
  const stage = displayStageKey.value
  const currentStageScope = graph.stages.find((item) => item.key === stage)?.scope
  const selectedScope = currentViewScopeId.value
  return selectScopedStageArtifacts(runSummary.value?.artifacts || [], stage, currentStageScope, selectedScope)
    .sort((a, b) => Number(a.scope_id || 0) - Number(b.scope_id || 0))
})
const currentStage = computed(() => graph.stages.find((stage) => stage.key === displayStageKey.value))
const currentMacro = computed(() => graph.macros.find((macro) => macro.key === currentStage.value?.macro))
const currentMacroStages = computed(() => graph.stages.filter((stage) => stage.macro === currentMacro.value?.key))
const recoveredScopedStoryboard = computed(() => {
  if (activeRun.value?.current_stage !== 'storyboard_plan' || currentViewScopeId.value == null) return null
  return (runSummary.value?.artifacts || []).find((item) => item.stage === 'storyboard_plan'
    && String(item.scope_id || '') === String(currentViewScopeId.value)
    && item.current !== false
    && item.content?.local_recovery_notice) || null
})
const activeProviderAction = computed(() => {
  const summarized = runSummary.value?.current_action
  const viewScope = currentViewScopeId.value
  if (isDisplayableProviderAction(summarized)
    && summarized.stage === activeRun.value?.current_stage
    && (viewScope == null || String(summarized.scope_id || '') === String(viewScope))) {
    return summarized
  }
  return selectCurrentProviderAction(runSummary.value?.actions || [], {
    ...(activeRun.value || {}),
    current_scope_id: viewScope,
  })
})
const ambiguousProviderAction = computed(() => selectAmbiguousRecoveryAction(
  runSummary.value || {},
  activeRun.value || {},
))
const ambiguousRecoveryStage = computed(() => {
  const action = ambiguousProviderAction.value
  if (!action) return 'none'
  if (action.status === 'cancelled' && action.result?.ambiguous_reconciled === true
    && action.result?.retry_authorized === true) return 'retry_ready'
  if (ambiguousRecoveryResult.value?.status === 'still_ambiguous'
    || action.result?.ambiguous_last_check_outcome === 'still_ambiguous') return 'checked_unresolved'
  return 'needs_check'
})
const pendingClientAction = computed(() => derivePendingDirectorAction(
  activeRun.value || {},
  runSummary.value?.actions || [],
  runSummary.value?.artifacts || [],
  lastOutcome.value,
))
const finalEditState = computed(() => selectFinalEditState(
  runSummary.value?.artifacts || [],
  runSummary.value?.actions || [],
))
const costSummaryLabel = computed(() => {
  const settled = formatUsd(costsSummary.settled_usd)
  const reserved = formatUsd(costsSummary.reserved_usd)
  if (costsSummary.limit_usd == null) return `已结算 ${settled} · 预留 ${reserved} · 当前任务不限额`
  return `已占用 ${formatUsd(Number(costsSummary.settled_usd || 0) + Number(costsSummary.reserved_usd || 0) + Number(costsSummary.uncertain_usd || 0))} / ${formatUsd(costsSummary.limit_usd)}`
})
const costItems = computed(() => costsItems.value)
const finalEditPlanDirty = computed(() => Boolean(finalEditState.value.plan && dirtyArtifacts.has(finalEditState.value.plan.id)))
const latestFailedAction = computed(() => {
  return selectGenerationFailureAction(runSummary.value?.actions || [], {
    stage: activeRun.value?.current_stage,
    scopeId: currentViewScopeId.value,
    recoveredScopedStoryboard: Boolean(recoveredScopedStoryboard.value),
    activeProviderAction: activeProviderAction.value,
    finalEditState: finalEditState.value,
  })
})
const canRecoverStoryboard = computed(() => {
  const action = latestFailedAction.value
  if (!action || activeRun.value?.current_stage !== 'storyboard_plan') return false
  if (action.kind !== 'storyboard_refine') return false
  return /分镜结果为空|缺少动作|缺少构图|JSON|parse|truncat|截断|Unexpected/i.test(String(action.error_message || ''))
})
const isDirectorFailure = computed(() => {
  const stage = String(activeRun.value?.current_stage || '')
  return ['director_plan', 'director_preview'].includes(stage)
    && Boolean(activeRun.value?.error_message || latestFailedAction.value)
})
const generationFailureDetail = computed(() => {
  const runScope = activeRun.value?.current_scope_id == null ? null : String(activeRun.value.current_scope_id)
  const viewScope = currentViewScopeId.value == null ? null : String(currentViewScopeId.value)
  const runErrorBelongsToView = runScope == null || viewScope == null || runScope === viewScope
  const finalEditResolved = activeRun.value?.current_stage === 'final_edit'
    && finalEditState.value.contract?.valid
    && (finalEditState.value.action || finalEditState.value.matchingFinal)
    && !latestFailedAction.value
  if (finalEditResolved) return ''
  return (runErrorBelongsToView ? activeRun.value?.error_message : '') || latestFailedAction.value?.error_message || ''
})
const generationFailureMessage = computed(() => {
  // Once a replacement action has been created, keep the historical failure
  // in the activity log but do not show it as the current error card. Showing
  // both at once made a successful retry look permanently blocked while the
  // new provider task was already running.
  if (activeProviderAction.value
    && ['reserved', 'submitted', 'waiting'].includes(activeProviderAction.value.status)) return ''
  if (!generationFailureDetail.value && !latestFailedAction.value) return ''
  return activeRun.value?.current_stage === 'shot_video'
    ? generationFailureSummary(generationFailureDetail.value)
    : generationFailureDetail.value
})
const emptyStageTitle = computed(() => {
  if (activeRun.value?.next_stage_strategy === 'manual_add') return '等待手动添加内容'
  if (activeRun.value?.error_message) return '当前镜头生成失败，可以修正配置后直接重试'
  return '当前镜头尚未生成本阶段内容'
})
const isFixtureRun = computed(() => (runSummary.value?.actions || []).some((item) => isFixtureAction(item)))
const currentShotArtifact = computed(() => {
  const scopeId = selectedShotId.value || activeRun.value?.current_scope_id
  if (!scopeId) return null
  return (runSummary.value?.artifacts || []).find((item) => item.stage === 'storyboard_plan'
    && String(item.scope_id) === String(scopeId) && item.current !== false)
    || (runSummary.value?.artifacts || []).find((item) => item.stage === 'storyboard_plan'
      && String(item.scope_id) === String(scopeId))
    || null
})
const currentConfiguredVideoModel = computed(() => configuredShotModel(
  activeRun.value || {},
  selectedShotId.value || activeRun.value?.current_scope_id,
))
const currentRouteSource = computed(() => selectShotRouteSource(
  runSummary.value?.artifacts || [],
  selectedShotId.value || activeRun.value?.current_scope_id,
  { configuredModel: currentConfiguredVideoModel.value },
))
const currentRoute = computed(() => normalizeRoute(
  mergeShotRoutePolicy(
    currentRouteSource.value.route || {},
    currentRouteSource.value.artifact || currentShotArtifact.value || {},
    activeRun.value || {},
  ),
  currentRouteSource.value.artifact || currentShotArtifact.value || {},
))
function artifactRoute(artifact) {
  const configuredModel = configuredShotModel(activeRun.value || {}, artifact?.scope_id)
  const selected = selectShotRouteSource(
    runSummary.value?.artifacts || [],
    artifact?.scope_id,
    { configuredModel },
  )
  const ownReceipt = artifact?.content?.routing_receipt || artifact?.content?.route || {}
  const receipt = Object.keys(selected.route || {}).length ? selected.route : ownReceipt
  return mergeShotRoutePolicy(
    receipt,
    selected.artifact || artifact || {},
    activeRun.value || {},
  )
}
const activeVideoConfigs = computed(() => videoConfigs.value.filter((item) => item.is_active !== false))
const activeVideoConfig = computed(() => {
  const preferredId = (settingsVisible.value ? settingsDraft.value?.video_config_id : null)
    ?? activeRun.value?.policy?.video_config_id
  return videoConfigs.value.find((item) => item.is_active !== false && Number(item.id) === Number(preferredId))
  || videoConfigs.value.find((item) => item.is_active !== false && item.is_default)
  || videoConfigs.value.find((item) => item.is_active !== false)
  || videoConfigs.value[0]
  || null
})
const activeVideoProviderLabel = computed(() => {
  const config = activeVideoConfig.value
  if (!config) return '未配置'
  const name = String(config.name || '')
  if (/老李/.test(name)) return '老李站点'
  if (/银子媒体/.test(name)) return '银子媒体站'
  if (/YinziAPI|银子 API/i.test(name)) return 'YinziAPI'
  return String(config.provider || '当前配置')
})
const projectVideoModelLabel = computed(() => projectVideoModelDisplay({
  settingsVisible: settingsVisible.value,
  draft: settingsDraft.value,
  activePolicy: activeRun.value?.policy || {},
  currentModel: currentRoute.value.model,
  catalogConfigId: videoCatalogConfigId.value,
  catalog: videoCatalog.value,
  catalogError: catalogLoadError.value,
}))
const projectVideoGroups = computed(() => {
  const groups = videoGroupsFromCatalog(videoCatalog.value)
  const current = String(settingsDraft.value?.video_group || '').trim()
  return current && !groups.includes(current) ? [current, ...groups] : groups
})
const projectVideoModelOptions = computed(() => {
  const group = String(settingsDraft.value?.video_group || '').trim()
  const options = (videoCatalog.value || [])
    .map((item) => catalogModelOption(videoCatalog.value, item.model, group))
    .filter(Boolean)
    .sort((left, right) => {
      return String(left.name || left.model).localeCompare(String(right.name || right.model), 'zh-CN')
    })
  const currentModel = String(settingsDraft.value?.video_model || '').trim()
  if (currentModel && !options.some((item) => item.model === currentModel)) options.unshift(catalogModelOption(videoCatalog.value, currentModel, group))
  return options
})
const projectSelectedVideoOption = computed(() => {
  const model = String(settingsDraft.value?.video_model || '').trim()
  return model ? catalogModelOption(videoCatalog.value, model, String(settingsDraft.value?.video_group || '').trim()) : null
})
const settingsSaveDisabled = computed(() => {
  if (!settingsDraft.value || settingsSaving.value) return true
  if (settingsDraft.value.video_routing_mode !== 'fixed') return false
  if (!String(settingsDraft.value.video_model || '').trim()) return true
  return projectSelectedVideoOption.value.requires_explicit_confirmation === true && !projectExpensiveConfirmed.value
})
const shotStrip = computed(() => (runSummary.value?.artifacts || [])
  .filter((item) => item.stage === 'storyboard_plan')
  .sort((a, b) => Number(a.content?.number || a.scope_id || 0) - Number(b.content?.number || b.scope_id || 0)))
const manualTargetOptions = computed(() => {
  if (!activeRun.value || !currentStage.value?.source_stage || isViewingHistory.value) return []
  if (activeRun.value.current_stage === 'final_edit') {
    const shots = (runSummary.value?.artifacts || []).filter((item) => item.stage === 'shot_video' && item.status === 'approved' && item.content?.included !== false)
    return shots.length ? [{ key: 'final-edit', label: `上传已剪辑成片（包含 ${shots.length} 个镜头）`, source: null }] : []
  }
  const existing = new Set(activeArtifacts.value.map((item) => `${item.scope_type}:${item.scope_id}`))
  return (runSummary.value?.artifacts || [])
    .filter((item) => item.stage === currentStage.value.source_stage && item.status === 'approved' && item.content?.included !== false)
    .sort((a, b) => Number(a.scope_id || 0) - Number(b.scope_id || 0))
    .map((source) => ({
      key: `${source.scope_type}:${source.scope_id}:${source.id}`,
      label: `${source.scope_type === 'shot' ? `镜头 #${source.scope_id}` : scopeLabel(source.scope_type)} · ${source.title || source.scope_id}${existing.has(`${source.scope_type}:${source.scope_id}`) ? '（替换当前项）' : ''}`,
      source,
    }))
})
const shortRunId = computed(() => activeRun.value?.id?.slice(0, 8) || '')
const approvedShotCount = computed(() => (runSummary.value?.artifacts || []).filter((item) => item.stage === 'storyboard_plan' && item.status === 'approved' && item.content?.included !== false).length)
const startButtonLabel = computed(() => ({
  human: '生成剧本并逐步确认',
  ai: '开始 AI 审批托管',
  auto_accept: '开始全自动制作',
})[newRun.reviewOwner])
const previousStage = computed(() => {
  if (!activeRun.value) return null
  const index = stageIndex(displayStageKey.value)
  return index > 0 ? graph.stages[index - 1] : null
})
const filteredReusableMedia = computed(() => {
  const type = mediaPickerTarget.value?.bucket === 'images'
    ? 'image'
    : mediaPickerTarget.value?.bucket === 'videos' ? 'video' : 'audio'
  return (reusableMedia.value || []).filter((item) => item.media_type === type)
})

const FIELD_SCHEMAS = {
  script: [
    { key: 'text', label: '完整剧本', required: true, rows: 18, constraints: '影视剧本格式，包含人物、场景、动作、对白和必要旁白' },
  ],
  character: [
    { key: 'name', label: '角色名', required: true, rows: 1, multiline: false },
    { key: 'role', label: '角色定位', rows: 2 },
    { key: 'description', label: '角色设定', required: true, rows: 4 },
    { key: 'appearance', label: '固定外观', rows: 4 },
    { key: 'identity_anchors', label: '辨识锚点（每行一个）', rows: 4, array: true },
    { key: 'continuity_rules', label: '连续性规则', rows: 3 },
    { key: 'visual_prompt', label: '资源图提示词', required: true, rows: 5 },
    { key: 'negative_prompt', label: '排除内容', rows: 2 },
  ],
  scene: [
    { key: 'name', label: '场景名', required: true, rows: 1, multiline: false },
    { key: 'location', label: '地点', rows: 1, multiline: false },
    { key: 'time', label: '时间与天气', rows: 1, multiline: false },
    { key: 'description', label: '场景设定', required: true, rows: 4 },
    { key: 'spatial_anchors', label: '空间锚点（每行一个）', rows: 4, array: true },
    { key: 'visual_prompt', label: '资源图提示词', required: true, rows: 5 },
    { key: 'negative_prompt', label: '排除内容', rows: 2 },
  ],
  prop: [
    { key: 'name', label: '道具名', required: true, rows: 1, multiline: false },
    { key: 'category', label: '类别', rows: 1, multiline: false },
    { key: 'description', label: '外观与材质', required: true, rows: 4 },
    { key: 'continuity_rules', label: '状态连续性', rows: 3 },
    { key: 'visual_prompt', label: '资源图提示词', required: true, rows: 5 },
    { key: 'negative_prompt', label: '排除内容', rows: 2 },
  ],
  shot: [
    { key: 'title', label: '镜头标题', required: true, rows: 1, multiline: false },
    { key: 'duration', label: '创作目标时长（秒）', type: 'number', min: 1, step: 1,
      help: '这是最终希望保留的镜头时长，可自由编辑。实际提交给模型的执行时长会按当前模型能力单独显示并处理（例如即梦 2.5 固定执行 30 秒）。' },
    { key: 'previs_mode', label: '3D 导演台', type: 'select', options: [
      { label: '自动判断（推荐）', value: 'auto' },
      { label: '跳过，不添加参考视频', value: 'skip' },
      { label: '强制生成本地预演', value: 'force' },
    ] },
    { key: 'transition_mode', label: '与上一段的剪辑方式', type: 'select', options: [
      { label: '成片开场', value: 'opening' },
      { label: '独立切镜（不携带尾帧）', value: 'hard_cut' },
      { label: '尾帧参考续接（普通参考图）', value: 'reference_continuation' },
      { label: '严格首帧续拍（仅兼容模型）', value: 'strict_continuation' },
    ] },
    { key: 'cut_motivation', label: '切镜依据', rows: 3 },
    { key: 'cut_in', label: '切入画面状态', required: true, rows: 3 },
    { key: 'cut_out', label: '切出画面状态', required: true, rows: 3 },
    { key: 'continuous_take_id', label: '连续镜头编号（仅严格续拍）', rows: 1, multiline: false },
    { key: 'boundary_prompt', label: '视频边界提示词', required: true, rows: 4 },
    { key: 'action', label: '人物与物体动作', required: true, rows: 4 },
    { key: 'visual', label: '画面构图', required: true, rows: 4 },
    { key: 'dialogue', label: '对白', rows: 3 },
    { key: 'narration', label: '旁白', rows: 3 },
    { key: 'shot_type', label: '景别', rows: 1, multiline: false },
    { key: 'camera_angle', label: '机位角度', rows: 1, multiline: false },
    { key: 'camera_movement', label: '镜头运动', rows: 2 },
    { key: 'lighting', label: '灯光与色调', rows: 2 },
    { key: 'continuity_in', label: '入镜连续性', rows: 3 },
    { key: 'continuity_out', label: '出镜连续性', rows: 3 },
    { key: 'character_names', label: '角色名（每行一个）', rows: 3, array: true },
    { key: 'scene_name', label: '场景名', rows: 1, multiline: false },
    { key: 'prop_names', label: '道具名（每行一个）', rows: 3, array: true },
    { key: 'image_prompt', label: '分镜图提示词', rows: 5 },
    { key: 'video_prompt', label: '视频提示词', required: true, rows: 6 },
  ],
  director: [
    { key: 'scene_summary', label: '预演说明', rows: 3 },
    { key: 'document_json', label: '导演台 JSON', required: true, rows: 18, constraints: '只填写合法 JSON，包含 objects、active_camera_id 和 timeline' },
  ],
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}))
}

function initializeDraft(artifact, run = activeRun.value || {}) {
  const content = mergeShotDraftPolicy(
    deepClone(artifact.content),
    artifact,
    run,
  )
  for (const field of artifactFields(artifact, run)) {
    if (field.key === 'document_json') content.document_json = JSON.stringify(content.document || {}, null, 2)
    else if (field.array) content[field.key] = Array.isArray(content[field.key]) ? content[field.key].join('\n') : String(content[field.key] || '')
    else if (content[field.key] == null) content[field.key] = field.type === 'number' ? (field.min || 0) : ''
  }
  drafts[artifact.id] = content
  if (reviewReasons[artifact.id] == null) reviewReasons[artifact.id] = ''
}

async function loadRun(runId, { loadEvidence = true, viewportSnapshot = null } = {}) {
  const normalizedRunId = String(runId)
  const preserveViewport = selectedRunId.value === normalizedRunId && Boolean(runSummary.value?.run)
  const preservedViewport = viewportSnapshot || (preserveViewport ? captureWorkflowViewport() : null)
  const viewportToken = ++loadRunViewportToken
  const previousRun = runSummary.value?.run || null
  const nextSummary = await productionAPI.getRun(runId)
  // A slower response for an older selection must never overwrite the run
  // currently shown in the URL and header.
  if (viewportToken !== loadRunViewportToken) return
  const validShotIds = (nextSummary.artifacts || [])
    .filter((item) => item.stage === 'storyboard_plan' && item.current !== false)
    .map((item) => String(item.scope_id || ''))
    .filter(Boolean)
  const focus = resolveWorkflowFocus({
    runId: selectedRunId.value,
    activeScopeId: previousRun?.current_scope_id,
    selectedShotId: selectedShotId.value,
    pinned: selectedShotPinned.value,
  }, {
    runId: normalizedRunId,
    activeScopeId: nextSummary.run?.current_scope_id,
    validShotIds,
  })
  for (const artifact of nextSummary.artifacts || []) {
    if (!drafts[artifact.id]) initializeDraft(artifact, nextSummary.run || {})
  }
  runSummary.value = nextSummary
  const requestedViewStage = String(route.query.view_stage || '').trim()
  if (requestedViewStage && stageIndex(requestedViewStage) >= 0 && stageIndex(requestedViewStage) <= stageIndex(nextSummary.run?.current_stage)) {
    viewedStageKey.value = requestedViewStage === nextSummary.run?.current_stage ? null : requestedViewStage
  } else if (viewedStageKey.value && stageIndex(viewedStageKey.value) > stageIndex(nextSummary.run?.current_stage)) {
    viewedStageKey.value = null
  }
  notifyRunState(nextSummary.run)
  await loadRunCosts(normalizedRunId).catch(() => {})
  if (viewportToken !== loadRunViewportToken) return
  imageConcurrencyDraft.value = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number(runSummary.value.run?.policy?.image_concurrency) || 4))
  selectedRunId.value = normalizedRunId
  selectedShotId.value = focus.selectedShotId
  selectedShotPinned.value = focus.pinned
  if (loadEvidence) {
    try {
      const [reviewResult, eventResult] = await Promise.all([
        productionAPI.reviews(runId, { page_size: 100 }),
        productionAPI.events(runId, { limit: 80 }),
      ])
      if (viewportToken !== loadRunViewportToken || selectedRunId.value !== normalizedRunId) return
      reviews.value = reviewResult.items || []
      events.value = (eventResult.items || []).sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
    } catch (_) {}
    if (runSummary.value.run?.current_stage === 'reference_bundle') await loadReusableMedia().catch(() => {})
  }
  if (String(route.query.run || '') !== normalizedRunId) {
    if (viewportToken !== loadRunViewportToken || selectedRunId.value !== normalizedRunId) return
    await router.replace({ query: { ...route.query, run: runId } })
  }
  if (focus.shouldScroll && focus.selectedShotId) {
    await nextTick()
    requestAnimationFrame(() => {
      if (viewportToken !== loadRunViewportToken || selectedRunId.value !== normalizedRunId) return
      document.getElementById(`workflow-shot-${focus.selectedShotId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  } else if (preservedViewport && focus.preserveViewport) {
    await nextTick()
    requestAnimationFrame(() => {
      if (viewportToken === loadRunViewportToken && selectedRunId.value === normalizedRunId) {
        restoreWorkflowViewport(preservedViewport)
      }
    })
  }
}

function notifyRunState(run) {
  const event = productionNotificationEvent(run, notificationPreferences)
  if (!event) {
    if (run?.id) notificationBootstrappedRuns.add(String(run.id))
    return
  }
  const storage = typeof window !== 'undefined' ? window.localStorage : undefined
  const firstObservation = !notificationBootstrappedRuns.has(String(run.id))
  notificationBootstrappedRuns.add(String(run.id))
  if (hasSeenProductionNotification(event.key, storage)) return
  rememberProductionNotification(event.key, storage)
  if (firstObservation) return
  ElNotification({
    title: event.title,
    message: event.message,
    type: event.kind === 'intervention' ? 'warning' : 'success',
    duration: event.duration,
    position: 'top-right',
    showClose: true,
  })
  if (notificationPreferences.notification_sound_enabled) {
    playProductionNotificationTone(event.kind).catch(() => {})
  }
}

async function loadRunCosts(runId) {
  if (!runId) {
    costsItems.value = []
    Object.assign(costsSummary, { settled_usd: 0, reserved_usd: 0, uncertain_usd: 0, unpriced_count: 0, limit_usd: null, remaining_usd: null })
    return
  }
  costsLoading.value = true
  try {
    const result = await productionAPI.costs(runId, { limit: 200 })
    if (String(activeRun.value?.id || runId) !== String(runId)) return
    costsItems.value = result?.items || []
    Object.assign(costsSummary, {
      settled_usd: Number(result?.summary?.settled_usd || 0),
      reserved_usd: Number(result?.summary?.reserved_usd || 0),
      uncertain_usd: Number(result?.summary?.uncertain_usd || 0),
      unpriced_count: Number(result?.summary?.unpriced_count || 0),
      limit_usd: result?.summary?.limit_usd == null ? null : Number(result.summary.limit_usd),
      remaining_usd: result?.summary?.remaining_usd == null ? null : Number(result.summary.remaining_usd),
    })
  } finally { costsLoading.value = false }
}

function openCosts() { costsVisible.value = true; loadRunCosts(activeRun.value?.id).catch(() => {}) }
function formatUsd(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(6)} USD` }
function costStatusLabel(status) { return ({ reserved: '已预留', settled: '已结算', released: '已释放', uncertain: '待对账', unpriced: '未定价' }[status] || status || '未知') }
function costStatusType(status) { return ({ reserved: 'warning', settled: 'success', released: 'info', uncertain: 'danger', unpriced: 'info' }[status] || 'info') }
function costUnitLabel(unit) { return ({ per_request: '次', per_image: '张', per_second: '秒', per_character: '字符', per_1k_tokens: '1K token' }[unit] || '') }

function selectShot(shot) {
  const scopeId = shot?.scope_id == null ? '' : String(shot.scope_id)
  if (!scopeId) return
  selectedShotId.value = scopeId
  selectedShotPinned.value = true
  requestAnimationFrame(() => {
    document.getElementById(`workflow-shot-${scopeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function shotStateLabel(shot) {
  if (!shot) return '未创建'
  if (shot.content?.included === false) return '已跳过，可恢复'
  const scopeId = String(shot.scope_id || '')
  const artifacts = runSummary.value?.artifacts || []
  const video = artifacts.find((item) => item.stage === 'shot_video'
    && String(item.scope_id || '') === scopeId
    && item.status === 'approved'
    && item.content?.included !== false)
  if (video) return '镜头视频已通过'
  if (String(activeRun.value?.current_scope_id || '') === scopeId) {
    if (activeRun.value?.status === 'waiting_provider') return '云端生成或取回中'
    return `${currentStage.value?.label || activeRun.value?.current_stage || '制作中'} · ${artifactStatusLabel(shot)}`
  }
  return shot.status === 'approved' ? '分镜脚本已确认' : artifactStatusLabel(shot)
}

function shotOperationErrorCode(error) {
  return error?.response?.data?.error?.code || error?.code || ''
}

function waitMs(duration) {
  return new Promise((resolve) => window.setTimeout(resolve, duration))
}

async function executeShotOperation({ runId, shotId, request, successMessage }) {
  if (!runId || shotOperationBusy.value) return null
  clearPoll()
  shotOperationBusy.value = true
  let result = null
  let resumeAutonomy = false
  try {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        const version = String(activeRun.value?.id || '') === String(runId) ? activeRun.value?.version : undefined
        result = await request(version)
        break
      } catch (error) {
        const code = shotOperationErrorCode(error)
        if (code === 'VERSION_CONFLICT') {
          await loadRun(runId, { loadEvidence: false })
          continue
        }
        if (code === 'SHOT_OPERATION_BUSY' && attempt < 23) {
          await waitMs(250)
          continue
        }
        throw error
      }
    }
    if (!result) throw new Error('当前镜头仍在收束另一个操作，请稍后再试')
    const focusId = result.focus_shot_id ?? result.summary?.run?.current_scope_id ?? shotId ?? null
    selectedShotId.value = focusId == null ? null : String(focusId)
    selectedShotPinned.value = false
    await loadRun(runId, { loadEvidence: true })
    if (successMessage) ElMessage.success(successMessage)
    resumeAutonomy = isUnattendedOwner(activeRun.value?.review_owner)
      && !autonomyIntervention.value
      && !['paused', 'cancelled', 'completed'].includes(activeRun.value?.status)
    return result
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '镜头操作失败')
    return null
  } finally {
    shotOperationBusy.value = false
    if (resumeAutonomy) driveRun().catch(() => {})
  }
}

async function loadVideoRouting(shotId = videoRoutingShotId.value) {
  if (!activeRun.value || shotId == null || shotId === '') return
  videoRoutingShotId.value = String(shotId)
  videoRoutingLoading.value = true
  videoRoutingError.value = ''
  try {
    videoRouting.value = await productionAPI.getVideoRouting(activeRun.value.id, { shot_id: String(shotId) })
  } catch (error) {
    videoRoutingError.value = error.message || '读取视频模型目录失败'
  } finally {
    videoRoutingLoading.value = false
  }
}

async function openVideoModelPicker(artifact = null) {
  const shotId = artifact?.scope_id ?? currentViewScopeId.value
  if (!activeRun.value || shotId == null || shotId === '') {
    ElMessage.warning('请先选择一个已经生成分镜脚本的镜头')
    return
  }
  videoRoutingShotId.value = String(shotId)
  videoRouting.value = null
  videoRoutingError.value = ''
  videoModelPickerVisible.value = true
  await loadVideoRouting(shotId)
}

function openVideoCapabilityManager(modelOverride = '') {
  const configId = Number(videoRouting.value?.project?.config_id || settingsDraft.value?.video_config_id || 0)
  const model = String(
    modelOverride
      || videoRouting.value?.effective_route?.model
      || videoRouting.value?.shot?.model
      || videoRouting.value?.project?.model
      || '',
  ).trim()
  if (!Number.isSafeInteger(configId) || configId <= 0) {
    ElMessage.warning('请先在项目设置中选择已保存的视频 URL / Key 配置')
    router.push({ name: 'ai-config' })
    return
  }
  const action = `capability:${configId}:${model}`
  videoModelPickerVisible.value = false
  router.push({ name: 'ai-config', query: { action } })
}

async function saveVideoRouting(payload) {
  if (!activeRun.value || videoRoutingSaving.value) return
  const runId = activeRun.value.id
  videoRoutingSaving.value = true
  clearPoll()
  try {
    const result = await productionAPI.updateVideoRouting(runId, payload)
    videoModelPickerVisible.value = false
    videoRouting.value = null
    videoRoutingError.value = ''
    selectedShotId.value = String(payload.shot_id)
    selectedShotPinned.value = true
    await loadRun(runId)
    syncShotPrevisDraft(payload.shot_id, payload.previs_mode)
    const refreshed = result.effects?.reference_bundle_refreshed
    const retry = result.effects?.retry_authorized
    const deferred = result.effects?.route_edit_deferred
    const directorNotice = payload.previs_mode === 'skip'
      ? '，已跳过 3D 导演台与参考视频'
      : payload.previs_mode === 'force' ? '，已要求生成并审核 3D 预演' : ''
    ElMessage.success(deferred
      ? `镜头 #${payload.shot_id} 的规则已保存${directorNotice}；当前分镜仍在修改中，确认新修订后才会重建参考包`
      : refreshed
      ? `镜头 #${payload.shot_id} 的路由已更新${directorNotice}，并生成新的参考包草稿${retry ? '，已准备一次替代重试' : ''}；尚未提交视频`
      : `镜头 #${payload.shot_id} 的模型与导演台规则已保存${directorNotice}；尚未提交视频`)
  } catch (error) {
    videoRoutingError.value = error.message || '切换视频模型失败'
    ElMessage.error(videoRoutingError.value)
    await loadRun(runId, { loadEvidence: false }).catch(() => {})
  } finally {
    videoRoutingSaving.value = false
  }
}

function syncShotPrevisDraft(scopeId, requestedMode) {
  const effectiveMode = configuredShotPrevisMode(activeRun.value || {}, scopeId) || requestedMode
  if (!['auto', 'force', 'skip'].includes(effectiveMode)) return
  for (const artifact of runSummary.value?.artifacts || []) {
    if (artifact.stage !== 'storyboard_plan' || String(artifact.scope_id) !== String(scopeId)) continue
    if (!drafts[artifact.id]) initializeDraft(artifact)
    drafts[artifact.id].previs_mode = effectiveMode
  }
}

async function loadRuns() {
  const result = await productionAPI.listRuns({ drama_id: dramaId, page_size: 50 })
  runs.value = result.items || []
}

async function loadTemplates() {
  templatesLoading.value = true
  try {
    const result = await templatesAPI.list(); templates.value = result?.items || []
    if (newRun.templateId && !templates.value.some((item) => String(item.id) === String(newRun.templateId))) newRun.templateId = ''
    const templateStyle = selectedTemplate.value?.defaults?.style
    const resolvedStyle = resolveTemplateStyle({ currentStyle: newRun.style, targetStyle: templateStyle, templates: templates.value, baseStyle: baseCreationStyle })
    if (resolvedStyle !== newRun.style) newRun.style = resolvedStyle
    newRun.targetShots = resolveTemplateTargetShots({ currentValue: newRun.targetShots, templateDefault: selectedTemplate.value?.defaults?.target_shots || 1, userEdited: targetShotsUserEdited.value })
    if (templateStyle) lastTemplateStyle.value = templateStyle
  }
  catch (_) { templates.value = [] }
  finally { templatesLoading.value = false }
}

async function loadReusableMedia() {
  if (!activeRun.value) return
  mediaPickerLoading.value = true
  try {
    const mediaType = mediaPickerTarget.value?.bucket === 'images'
      ? 'image'
      : mediaPickerTarget.value?.bucket === 'videos' ? 'video' : 'audio'
    const params = {
      media_type: mediaType,
      q: mediaPickerKeyword.value.trim() || undefined,
      page_size: 100,
      limit: 100,
    }
    const result = mediaPickerScope.value === 'global'
      ? await productionAPI.productionMedia(params)
      : await productionAPI.reusableMedia(activeRun.value.id, params)
    reusableMedia.value = result.items || []
  } catch (error) {
    reusableMedia.value = []
    ElMessage.error(error.message || '素材库加载失败')
  } finally {
    mediaPickerLoading.value = false
  }
}

async function loadCatalogs() {
  videoCatalogLoading.value = true
  videoConfigsLoading.value = true
  catalogLoadError.value = ''
  try {
    const results = await Promise.allSettled([
      aiAPI.getYinziCatalog(),
      aiAPI.list('image'),
      aiAPI.list('storyboard_image'),
      aiAPI.list('video'),
    ])
    const [catalogResult, imageResult, storyboardResult, videoResult] = results
    if (catalogResult.status === 'fulfilled') {
      videoCatalog.value = catalogResult.value?.video || []
      imageCatalog.value = catalogResult.value?.image || []
      textCatalog.value = catalogResult.value?.text || []
    }
    if (imageResult.status === 'fulfilled') imageConfigs.image = Array.isArray(imageResult.value) ? imageResult.value : []
    if (storyboardResult.status === 'fulfilled') imageConfigs.storyboard_image = Array.isArray(storyboardResult.value) ? storyboardResult.value : []
    if (videoResult.status === 'fulfilled') videoConfigs.value = Array.isArray(videoResult.value) ? videoResult.value : []
    const failures = results.filter((item) => item.status === 'rejected')
    if (failures.length) catalogLoadError.value = `有 ${failures.length} 项配置或目录暂时无法刷新；已加载内容仍保留，可稍后重试。`
    const selectedConfigId = settingsDraft.value?.video_config_id ?? activeRun.value?.policy?.video_config_id
    if (selectedConfigId) {
      await discoverVideoCatalog(selectedConfigId, {
        group: settingsDraft.value?.video_group || activeRun.value?.policy?.video_group || '',
        preserveLoading: true,
      })
    }
  } finally {
    videoCatalogLoading.value = false
    videoConfigsLoading.value = false
  }
}

async function discoverVideoCatalog(configId, options = {}) {
  const normalizedId = Number(configId)
  if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
    videoCatalog.value = []
    videoCatalogConfigId.value = null
    catalogLoadError.value = '请先选择一个已保存的视频 URL / Key 配置。'
    return false
  }
  if (!options.preserveLoading) videoCatalogLoading.value = true
  catalogLoadError.value = ''
  try {
    const result = await aiAPI.discoverModels({
      config_id: normalizedId,
      service_type: 'video',
      group: String(options.group || '').trim(),
    }, { suppressGlobalError: true })
    const catalog = Array.isArray(result?.catalog?.video) ? result.catalog.video : []
    // The backend may return a partial manual-only catalog when the upstream
    // directory is unavailable. Keep the last usable list if no explicit
    // fallback model exists, and surface the evidence boundary to the user.
    if (catalog.length || !videoCatalog.value.length) videoCatalog.value = catalog
    videoCatalogConfigId.value = normalizedId
    const diagnostic = result?.diagnostic || result?.discovery_diagnostic || null
    if (diagnostic) {
      const code = String(diagnostic.code || '')
      const message = code === 'MODEL_DISCOVERY_AUTH_FAILED'
        ? '当前视频 Key 鉴权失败，请检查 Key 是否完整、是否已过期。已保留你手动配置的模型。'
        : code === 'MODEL_DISCOVERY_ENDPOINT_NOT_FOUND'
          ? '当前服务没有提供模型目录接口。已保留你手动配置的模型，固定模型仍可保存并交给上游校验。'
          : code === 'MODEL_DISCOVERY_TIMEOUT' || code === 'MODEL_DISCOVERY_NETWORK_ERROR' || code === 'MODEL_DISCOVERY_UPSTREAM_ERROR'
            ? '模型目录网络请求暂时失败。已保留你手动配置的模型，稍后可重试，不会自动替换模型。'
            : '模型目录暂时无法读取。已保留你手动配置的模型，能力和权限将在提交时由上游确认。'
      catalogLoadError.value = message
    } else if (!catalog.length) catalogLoadError.value = '这个 Key 的模型目录为空，请确认分组权限或上游 /models 返回内容。'
    return catalog.length > 0
  } catch (error) {
    // Preserve the last catalog and the persisted/current selection after a
    // transport failure; clearing it made a transient outage look like loss
    // of model permissions.
    videoCatalogConfigId.value = normalizedId
    const code = String(error?.code || '')
    catalogLoadError.value = code === 'MODEL_DISCOVERY_AUTH_FAILED'
      ? '当前视频 Key 鉴权失败，请检查 Key 是否完整、是否已过期。已保留你手动配置的模型。'
      : code === 'MODEL_DISCOVERY_ENDPOINT_NOT_FOUND'
        ? '当前服务没有提供模型目录接口。已保留你手动配置的模型，固定模型仍可保存并交给上游校验。'
        : `模型目录暂时无法读取：${error.message || '网络或上游服务异常'}。已保留你手动配置的模型。`
    return false
  } finally {
    if (!options.preserveLoading) videoCatalogLoading.value = false
  }
}

async function refreshSelectedVideoCatalog() {
  const configId = settingsDraft.value?.video_config_id ?? activeRun.value?.policy?.video_config_id
  await discoverVideoCatalog(configId, {
    group: settingsDraft.value?.video_group || activeRun.value?.policy?.video_group || '',
  })
}

async function onVideoConfigChange(configId) {
  if (!settingsDraft.value) return
  projectExpensiveConfirmed.value = false
  settingsDraft.value.video_model = ''
  const loaded = await discoverVideoCatalog(configId, { group: settingsDraft.value.video_group })
  if (!loaded) return
  const groups = videoGroupsFromCatalog(videoCatalog.value)
  if (settingsDraft.value.video_group && !groups.includes(settingsDraft.value.video_group)) {
    settingsDraft.value.video_group = groups[0] || ''
  }
  if (settingsDraft.value.video_routing_mode === 'fixed') {
    settingsDraft.value.video_model = projectVideoModelOptions.value.find((item) => item.selectable)?.model || ''
  }
}

function imageConfigDraft(serviceType, config = null, fallbackModel = '') {
  const models = Array.isArray(config?.model) ? config.model : []
  return {
    id: config?.id || null,
    name: config?.name || '',
    provider: config?.provider || '',
    api_protocol: config?.api_protocol || '',
    base_url: config?.base_url || '',
    api_key: '',
    has_api_key: Boolean(config?.has_api_key),
    model: config?.default_model || models[0] || fallbackModel || 'gpt-image-2',
    models,
    service_type: serviceType,
  }
}

function selectImageConfig(serviceType) {
  const draft = settingsDraft.value?.image_configs?.[serviceType]
  if (!draft) return
  if (String(draft.id || '').startsWith('new:')) {
    Object.assign(draft, imageConfigDraft(serviceType, null, draft.model), {
      id: `new:${serviceType}`,
      name: serviceType === 'storyboard_image' ? '分镜图配置' : '资源图配置',
      provider: 'openai',
      api_protocol: 'openai',
      api_key: '',
      has_api_key: false,
    })
    return
  }
  const config = (imageConfigs[serviceType] || []).find((item) => Number(item.id) === Number(draft.id))
  if (!config) return
  Object.assign(draft, imageConfigDraft(serviceType, config, draft.model))
}

function isNewImageConfig(serviceType) {
  return String(settingsDraft.value?.image_configs?.[serviceType]?.id || '').startsWith('new:')
}

async function saveImageConfig(serviceType) {
  const draft = settingsDraft.value?.image_configs?.[serviceType]
  if (!draft?.id) return
  imageConfigSaving.value = serviceType
  try {
    const model = String(draft.model || '').trim()
    if (!model) throw new Error('请先选择或填写模型')
    const body = {
      base_url: String(draft.base_url || '').trim(),
      model: [model],
      default_model: model,
      is_default: true,
      is_active: true,
    }
    if (!body.base_url) throw new Error('Base URL 不能为空')
    const apiKey = String(draft.api_key || '').trim()
    if (apiKey) body.api_key = apiKey
    const creating = isNewImageConfig(serviceType)
    if (creating && !apiKey) throw new Error('新建配置时必须填写 API Key')
    const updated = creating
      ? await aiAPI.create({
        ...body,
        service_type: serviceType,
        name: String(draft.name || '').trim() || (serviceType === 'storyboard_image' ? '分镜图配置' : '资源图配置'),
        provider: draft.provider || 'openai',
        api_protocol: draft.api_protocol || 'openai',
        endpoint: '/images/generations',
      })
      : await aiAPI.update(draft.id, body)
    const index = (imageConfigs[serviceType] || []).findIndex((item) => Number(item.id) === Number(updated?.id || draft.id))
    if (index >= 0) imageConfigs[serviceType].splice(index, 1, { ...imageConfigs[serviceType][index], ...updated, has_api_key: updated?.has_api_key ?? Boolean(apiKey || draft.has_api_key) })
    else imageConfigs[serviceType].unshift({ ...updated, has_api_key: updated?.has_api_key ?? Boolean(apiKey) })
    draft.id = updated?.id || draft.id
    draft.name = updated?.name || draft.name
    draft.provider = updated?.provider || draft.provider
    draft.base_url = updated?.base_url || body.base_url
    draft.model = updated?.default_model || model
    draft.models = updated?.model || [model]
    draft.has_api_key = updated?.has_api_key ?? Boolean(apiKey || draft.has_api_key)
    draft.api_key = ''
    const policyKey = serviceType === 'storyboard_image' ? 'storyboard_image_model' : 'asset_image_model'
    const configPolicyKey = serviceType === 'storyboard_image' ? 'storyboard_image_config_id' : 'asset_image_config_id'
    await productionAPI.updateRun(activeRun.value.id, {
      policy: { ...activeRun.value.policy, [policyKey]: model, [configPolicyKey]: Number(updated.id), image_model: activeRun.value.policy?.image_model || model },
      expected_version: activeRun.value.version,
    })
    await loadRun(activeRun.value.id, { loadEvidence: false })
    ElMessage.success(`${serviceType === 'storyboard_image' ? '分镜图' : '资源图'}配置已保存并设为默认`)
  } catch (error) {
    ElMessage.error(error.message || '图片配置保存失败')
  } finally {
    imageConfigSaving.value = ''
  }
}

async function testImageConfig(serviceType) {
  const draft = settingsDraft.value?.image_configs?.[serviceType]
  if (!draft) return
  imageConfigTesting.value = serviceType
  try {
    await aiAPI.testConnection({
      ...(Number.isSafeInteger(Number(draft.id)) && Number(draft.id) > 0 ? { config_id: Number(draft.id) } : {}),
      draft: {
        base_url: String(draft.base_url || '').trim(),
        ...(String(draft.api_key || '').trim() ? { api_key: draft.api_key.trim() } : {}),
        model: [draft.model],
        default_model: draft.model,
         provider: draft.provider || 'openai',
        api_protocol: draft.api_protocol || 'openai',
        service_type: serviceType,
        endpoint: '/images/generations',
      },
    }, { suppressGlobalError: true })
    ElMessage.success('图片配置连接测试通过（未调用生图）')
  } catch (error) {
    ElMessage.error(error.message || '图片配置连接测试失败')
  } finally {
    imageConfigTesting.value = ''
  }
}

async function initialize() {
  loading.value = true
  let resumeActiveRun = false
  try {
    const [graphResult, dramaResult] = await Promise.all([productionAPI.graph(), dramaAPI.get(dramaId)])
    graph.stages = graphResult.stages || []
    graph.macros = graphResult.macros || []
    drama.value = dramaResult
    newRun.aspectRatio = normalizeProductionAspectRatio(dramaResult?.metadata?.aspect_ratio)
    const automationResult = await advancedSettingsAPI.getAutomationPreferences().catch(() => null)
    Object.assign(notificationPreferences, normalizeProductionNotificationPreferences(automationResult || {}))
    await Promise.all([loadRuns(), loadCatalogs(), loadSeriesGroups(), loadTemplates()])
    if (newRun.seriesGroupId) await loadSeriesAssets()
    // A deep-link is an explicit request for this run. Do not gate it on the
    // current project's list: imported/legacy runs can legitimately belong to
    // another project (and the list is paginated), while the run endpoint is
    // the authoritative source for the page. The previous membership check
    // silently fell back to the empty create form, making a valid test/share
    // link look broken and hiding the saved story/input state.
    const requestedRun = String(route.query.run || '').trim()
    if (requestedRun) {
      try {
        await loadRun(requestedRun)
        resumeActiveRun = !['draft', 'paused', 'completed', 'cancelled'].includes(activeRun.value?.status)
          && (activeRun.value?.status !== 'failed' || isUnattendedOwner(activeRun.value?.review_owner))
      } catch (error) {
        // Keep the create form usable when a stale/deleted deep-link is opened,
        // but make the reason visible instead of failing silently.
        ElMessage.error(error?.message || '制作任务不存在或暂时无法读取，请从历史任务中重新选择')
        const query = { ...route.query }
        delete query.run
        delete query.view_stage
        await router.replace({ query }).catch(() => {})
      }
    }
  } finally {
    loading.value = false
  }
  if (resumeActiveRun) await driveRun()
}

async function loadSeriesGroups() {
  try {
    const result = await seriesGroupsAPI.list({ page_size: 100 })
    seriesGroups.value = result?.items || []
  } catch (_) {
    seriesGroups.value = []
  }
}

async function loadSeriesAssets() {
  if (!newRun.seriesGroupId) { seriesAssets.value = []; return }
  seriesAssetsLoading.value = true
  try {
    const result = await seriesGroupsAPI.assets(newRun.seriesGroupId)
    seriesAssets.value = result?.items || []
  } catch (_) {
    seriesAssets.value = []
  } finally {
    seriesAssetsLoading.value = false
  }
}

function browserCapabilities() {
  let webgl = false
  try {
    const canvas = document.createElement('canvas')
    webgl = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch (_) {}
  return { webgl, media_recorder: typeof window.MediaRecorder !== 'undefined' }
}

async function createAndStartRun() {
  if (!sourceDraft.value.trim()) return
  if (inlineAssetImport.value?.hasPlannedSession?.() && inlineAssetImport.value?.isContextStale?.()) {
    inlineAssetImport.value?.revealPlan?.()
    ElMessage.warning('故事、模板或镜头数已在素材分析后修改。请先点击“按当前内容重新整理”，已上传文件不会重复上传。')
    return
  }
  starting.value = true
  try {
    const selectedVideoConfig = videoConfigs.value.find((item) => item.is_active !== false && item.is_default)
      || videoConfigs.value.find((item) => item.is_active !== false)
      || null
    const selectedVideoModels = Array.isArray(selectedVideoConfig?.model)
      ? selectedVideoConfig.model
      : selectedVideoConfig?.model ? [selectedVideoConfig.model] : []
    const initialVideoModel = String(newRun.videoModel || selectedVideoConfig?.default_model || selectedVideoModels[0] || '').trim()
    const episodeId = Number(route.query.episode) || drama.value?.episodes?.[0]?.id || null
    const selectedSeriesGroup = seriesGroups.value.find((group) => Number(group.id) === Number(newRun.seriesGroupId))
    const seriesAssetRefs = (seriesAssets.value || []).filter((item) => item.selected).map((item) => ({
      series_asset_id: item.id,
      series_asset_version_id: item.current_version_id,
    }))
    const created = await productionAPI.createRun({
      drama_id: dramaId,
      episode_id: episodeId,
      idempotency_key: `workflow-${dramaId}-${Date.now()}`,
      review_owner: newRun.reviewOwner,
      next_stage_strategy: 'auto_generate',
      input: {
        source_type: newRun.sourceType,
        template_id: newRun.templateId || null,
        story: sourceDraft.value.trim(),
        file_name: novelFileName.value || undefined,
        chapter_indexes: selectedChapterIndexes.value,
      },
      policy: {
        template_id: newRun.templateId || null,
        style: newRun.style,
        visual_style: newRun.style,
        target_shots: newRun.targetShots,
        aspect_ratio: normalizeProductionAspectRatio(newRun.aspectRatio),
        image_model: newRun.imageModel,
        asset_image_model: newRun.imageModel,
        storyboard_image_model: newRun.imageModel,
        asset_image_config_id: imageConfigs.image.find((item) => item.is_default)?.id || imageConfigs.image[0]?.id || null,
        storyboard_image_config_id: imageConfigs.storyboard_image.find((item) => item.is_default)?.id || imageConfigs.storyboard_image[0]?.id || null,
        image_concurrency: newRun.imageConcurrency,
        video_config_id: selectedVideoConfig?.id || null,
        // Keep the default model visible in the persisted creation snapshot.
        // Auto routing may choose a better eligible candidate per shot, but it
        // must start from the same configured default rather than a legacy
        // hard-coded 720mini value.
        video_model: initialVideoModel,
        video_routing_mode: 'auto',
        video_duration_min: 1,
        video_duration_max: Math.max(1, Number(newRun.maxSeconds) || 60),
        director_mode: newRun.directorMode,
        video_group: String(selectedVideoConfig?.group || selectedVideoConfig?.settings?.group || '').trim(),
        video_provider: String(selectedVideoConfig?.provider || '').trim(),
        video_quality: newRun.videoQuality,
        keep_provider_audio: true,
        subtitles: false,
        series_group_id: selectedSeriesGroup?.id || null,
        series_group_name: selectedSeriesGroup?.name || null,
        series_asset_refs: seriesAssetRefs,
      },
      budget: {
        max_video_attempts: newRun.maxAttempts,
        max_video_seconds: newRun.maxSeconds,
        max_shots: Math.max(newRun.targetShots, 1),
      },
    })
    if (inlineImportSession.value?.status === 'planned') {
      try {
        await inlineAssetImport.value?.applyToRun(created.run.id)
        ElMessage.success('已把本页确认的素材纳入制作任务')
      } catch (importError) {
        // Keep the newly created run usable. The staged plan remains available
        // for retry and the production runner can still fill missing assets.
        ElMessage.warning(`素材计划暂未纳入任务：${importError.message || '请稍后重试'}；故事和任务已保存`)
      }
    }
    clearCreationDraft()
    await loadRun(created.run.id)
    preflightResult.value = await productionAPI.preflight(created.run.id, { browser: browserCapabilities() })
    if (!preflightResult.value.ok) {
      if (isUnattendedOwner(newRun.reviewOwner)) {
        ElMessage.warning('无人值守制作需要先补齐下方未就绪项目；任务草稿已经保存，不会产生模型费用。')
        await openSettings()
        return
      }
      await ElMessageBox.confirm(
        '部分后续能力尚未就绪。可以先完成剧本和资源审批，系统会在对应阶段停止，不会盲目消费额度。',
        '后续能力待配置',
        { confirmButtonText: '先开始前期制作', cancelButtonText: '返回配置', type: 'warning' },
      )
    }
    await productionAPI.start(created.run.id, { next_stage_strategy: 'auto_generate' })
    await loadRun(created.run.id)
    await driveRun()
    await loadRuns()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '创建制作任务失败')
  } finally {
    starting.value = false
  }
}

async function driveRun() {
  if (!activeRun.value || driving.value) return
  clearPoll()
  driving.value = true
  let loopExhausted = true
  try {
    for (let index = 0; index < 60; index += 1) {
      const beforeSignature = productionSemanticProgressSignature(runSummary.value || { run: activeRun.value })
      const outcome = await productionAPI.advance(activeRun.value.id, { lease_owner: `browser-${activeRun.value.id}` })
      lastOutcome.value = outcome
      const autonomyOutcome = String(outcome.reason || '').startsWith('automatic')
      await loadRun(activeRun.value.id, {
        loadEvidence: autonomyOutcome || outcome.state === 'waiting_review' || outcome.state === 'completed',
      })
      const semanticChanged = beforeSignature !== productionSemanticProgressSignature(runSummary.value || { run: activeRun.value })
      if (semanticChanged) semanticIdleCount.value = 0
      else if (['progressed', 'approved'].includes(outcome.state)) {
        semanticIdleCount.value += 1
        loopExhausted = false
        schedulePoll(productionIdleBackoffDelay(semanticIdleCount.value))
        break
      }
      if (outcome.state === 'client_action') { loopExhausted = false; break }
      if (['waiting_task', 'waiting_provider'].includes(outcome.state)) {
        loopExhausted = false
        schedulePoll()
        break
      }
      if (['waiting_review', 'failed'].includes(outcome.state)) {
        loopExhausted = false
        if (isUnattendedMode.value && !autonomyIntervention.value) schedulePoll()
        break
      }
      if (['paused', 'cancelled', 'completed'].includes(outcome.state)) { loopExhausted = false; break }
      if (activeRun.value.review_owner === 'human' && outcome.state === 'approved') { loopExhausted = false; break }
    }
  } catch (error) {
    loopExhausted = false
    if (!isUnattendedMode.value) ElMessage.error(error.message || '推进制作失败')
    if (activeRun.value) await loadRun(activeRun.value.id).catch(() => {})
    if (isUnattendedMode.value && !autonomyIntervention.value) schedulePoll()
  } finally {
    driving.value = false
    if (loopExhausted && activeRun.value && !['paused', 'cancelled', 'completed', 'failed'].includes(activeRun.value.status)) schedulePoll()
  }
}

function schedulePoll(delayMs = 3500) {
  clearPoll()
  pollTimer = window.setTimeout(() => driveRun(), Math.max(250, Number(delayMs) || 3500))
}

function clearPoll() {
  if (pollTimer) window.clearTimeout(pollTimer)
  pollTimer = null
}

async function refreshAndAdvance() {
  await loadRun(activeRun.value.id)
  if (isViewingHistory.value) return
  await driveRun()
}

async function detachView() {
  clearPoll()
  if (!activeRun.value) return
  try {
    const result = await productionAPI.detach(activeRun.value.id, { reason: '用户停止当前页面查看' })
    ElMessage.success(result?.background_continues === false
      ? '已停止查看'
      : '已停止当前页面等待，任务会在后台继续')
    // Do not navigate or reload the run here: the user can inspect history or
    // another page without changing the active production state.
  } catch (error) {
    ElMessage.error(error.message || '停止当前页面等待失败')
  }
}

async function cancelCurrentAction() {
  if (!activeRun.value || !activeProviderAction.value || actionCancelling.value) return
  actionCancelling.value = true
  try {
    const result = await productionAPI.cancelProvider(activeRun.value.id, {
      action_id: activeProviderAction.value.id,
      reason: '用户请求停止当前供应商任务',
    })
    if (result?.status === 'cancelled_local') ElMessage.success(result.message || '已在本地取消')
    else if (result?.status === 'cancel_requested_provider_unknown') ElMessage.warning(result.message || '已停止本地等待，供应商任务可能继续')
    else ElMessage.info(result?.message || '取消请求已处理')
    await loadRun(activeRun.value.id, { loadEvidence: false })
    clearPoll()
  } catch (error) {
    ElMessage.error(error.message || '停止当前请求失败')
  } finally {
    actionCancelling.value = false
  }
}

async function rebuildFinalEdit() {
  if (!activeRun.value || !finalEditState.value.canRebuild) return
  if (finalEditPlanDirty.value) {
    ElMessage.warning('请先保存并确认最新旁白修订，再重新剪辑合成')
    return
  }
  try {
    const result = await productionAPI.rebuildFinalEdit(activeRun.value.id, {
      reason: '用户请求重新剪辑合成',
      lease_owner: `browser-final-edit-${activeRun.value.id}`,
    })
    lastOutcome.value = result
    await loadRun(activeRun.value.id)
    await driveRun()
  } catch (error) {
    ElMessage.error(error.message || '重新剪辑合成失败')
    await loadRun(activeRun.value.id).catch(() => {})
  }
}

async function pauseRun() {
  clearPoll()
  await productionAPI.pause(activeRun.value.id, { expected_version: activeRun.value.version })
  await loadRun(activeRun.value.id)
}

async function resumeRun() {
  await productionAPI.resume(activeRun.value.id, { expected_version: activeRun.value.version })
  await loadRun(activeRun.value.id)
  await driveRun()
}

async function retryFailedGeneration() {
  const reason = retryReason.value.trim() || '用户请求重试当前失败任务'
  if (!latestFailedAction.value || driving.value) return
  try {
    const action = latestFailedAction.value
    // A fixed-duration child may already be cancelled with an explicit retry
    // grant from an earlier click. In that state the runner only needs to be
    // resumed; authorizing the same terminal action again would be rejected.
    if (!(action.status === 'cancelled' && action.result?.retry_authorized === true)) {
      await productionAPI.retry(activeRun.value.id, { action_id: action.id, reason })
    }
    retryReason.value = ''
    await loadRun(activeRun.value.id)
    await driveRun()
  } catch (error) {
    ElMessage.error(error.message || '重试失败')
  }
}

async function retryDirectorFailure() {
  const action = latestFailedAction.value
  if (!activeRun.value || !action || directorRecoveryBusy.value) return
  directorRecoveryBusy.value = true
  try {
    await productionAPI.retry(activeRun.value.id, {
      action_id: action.id,
      reason: '修复导演台素材引用并重新生成本镜头预演方案',
    })
    await loadRun(activeRun.value.id)
    await driveRun()
  } catch (error) {
    ElMessage.error(error.message || '导演台重试失败；仍可选择跳过导演台继续')
    await loadRun(activeRun.value.id, { loadEvidence: false }).catch(() => {})
  } finally {
    directorRecoveryBusy.value = false
  }
}

async function skipDirectorForCurrentShot() {
  if (!activeRun.value || directorRecoveryBusy.value) return
  const shotId = currentShotArtifact.value?.scope_id || activeRun.value.current_scope_id
  if (!shotId) return ElMessage.error('找不到当前镜头')
  directorRecoveryBusy.value = true
  try {
    await ElMessageBox.confirm(
      '当前镜头和上传参考图片会完整保留，只是不再生成或携带 3D 预演视频。接下来会进入参考包检查，不会提交视频或产生视频费用。',
      '只跳过本镜头导演台',
      { confirmButtonText: '保留镜头并继续', cancelButtonText: '取消', type: 'warning' },
    )
    const result = await productionAPI.skipDirector(activeRun.value.id, shotId, {
      reason: '用户选择保留镜头并跳过本镜头导演台',
      expected_version: activeRun.value.version,
    })
    if (result.summary) runSummary.value = result.summary
    await loadRun(activeRun.value.id)
    ElMessage.success('已保留镜头并跳过导演台，请检查参考包后继续')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '跳过导演台失败')
  } finally {
    directorRecoveryBusy.value = false
  }
}

async function disableDirectorForRun() {
  if (!activeRun.value || directorRecoveryBusy.value) return
  directorRecoveryBusy.value = true
  try {
    await ElMessageBox.confirm(
      '本项目后续镜头也会跳过 3D 导演台，但分镜、上传素材、参考包和视频生成仍保留。你之后仍可在设置中重新开启。此操作不会提交视频或产生视频费用。',
      '关闭本项目导演台并继续',
      { confirmButtonText: '关闭并继续', cancelButtonText: '取消', type: 'warning' },
    )
    const result = await productionAPI.disableDirector(activeRun.value.id, {
      reason: '用户在导演台失败后关闭本项目导演台',
      expected_version: activeRun.value.version,
    })
    if (result.summary) runSummary.value = result.summary
    await loadRun(activeRun.value.id)
    ElMessage.success('本项目导演台已关闭，当前镜头已进入参考包检查')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '关闭导演台失败')
  } finally {
    directorRecoveryBusy.value = false
  }
}

async function reconcileAmbiguousAction(mode, body = {}) {
  const action = ambiguousProviderAction.value
  if (!activeRun.value || !action || ambiguousRecoveryBusy.value) return null
  ambiguousRecoveryBusy.value = true
  try {
    const result = await productionAPI.reconcileAction(activeRun.value.id, action.id, { mode, ...body })
    ambiguousRecoveryResult.value = result
    await loadRun(activeRun.value.id, { loadEvidence: true })
    if (result?.status === 'processing') schedulePoll()
    if (result?.status === 'recovered') await driveRun()
    return result
  } catch (error) {
    ElMessage.error(error.message || '核对原任务失败')
    return null
  } finally {
    ambiguousRecoveryBusy.value = false
  }
}

async function attachAmbiguousProviderTask() {
  try {
    const { value } = await ElMessageBox.prompt(
      '从上游“我的任务/资产”复制任务 ID。系统会先查询这个任务，不会创建新视频。',
      '恢复原视频任务',
      { inputPlaceholder: '粘贴上游任务 ID', confirmButtonText: '查询并绑定', cancelButtonText: '取消', inputValidator: (value) => String(value || '').trim() ? true : '请填写任务 ID' },
    )
    await reconcileAmbiguousAction('attach_provider_task', { provider_task_id: String(value).trim(), reason: '用户从上游任务记录提供' })
  } catch (_) {}
}

async function confirmAmbiguousNotCreated() {
  try {
    await ElMessageBox.confirm(
      '如果你已确认上游没有对应任务，点击后将只开放一次新的重试。旧费用仍显示“待对账”，不代表已退款。',
      '确认上游没有创建任务',
      { type: 'warning', confirmButtonText: '确认并开放一次重试', cancelButtonText: '返回继续核对' },
    )
    await reconcileAmbiguousAction('confirm_not_created', { confirmed: true, reason: '用户确认上游无任务并请求重试' })
  } catch (_) {}
}

function retryConfirmationValue(value, fallback = '待实时读取') {
  return value == null || value === '' ? fallback : String(value)
}

async function startAmbiguousRetry() {
  const action = ambiguousProviderAction.value
  if (!activeRun.value || !action || ambiguousRecoveryBusy.value) return
  ambiguousRecoveryBusy.value = true
  try {
    const routing = await productionAPI.getVideoRouting(activeRun.value.id, {
      shot_id: String(action.scope_id || activeRun.value.current_scope_id || ''),
    })
    const latestRoute = routing?.effective_route || {}
    const model = latestRoute.model || currentRoute.value.model || '提交前自动选择'
    const plannedDuration = latestRoute.planned_duration ?? currentRoute.value.planned_duration
      ?? currentShotArtifact.value?.content?.duration
    const providerDuration = latestRoute.provider_duration ?? latestRoute.duration
      ?? currentRoute.value.provider_duration ?? currentRoute.value.duration
    const units = Math.max(1, Number(latestRoute.execution_unit_count ?? currentRoute.value.execution_unit_count) || 1)
    const currency = String(latestRoute.currency || '').toUpperCase()
    const currencyPrefix = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency ? `${currency} ` : ''
    const estimatedValue = latestRoute.estimated_price
    const estimated = estimatedValue == null || estimatedValue === '' ? Number.NaN : Number(estimatedValue)
    const priceText = Number.isFinite(estimated) ? `${currencyPrefix}${estimated.toFixed(4)}` : '价格待实时目录确认'
    await ElMessageBox.confirm(
      h('div', { class: 'retry-confirm-details' }, [
        h('p', `即将为镜头 ${action.scope_id || '当前镜头'} 创建一次新的付费尝试。旧任务 #${action.id} 的费用仍为“待对账”，不会伪装成退款。`),
        h('ul', [
          h('li', `最新模型：${retryConfirmationValue(model)}`),
          h('li', `创作目标时长：${retryConfirmationValue(plannedDuration, '未知')} 秒`),
          h('li', `供应商单次执行时长：${retryConfirmationValue(providerDuration, '未知')} 秒`),
          h('li', `执行单元数：${units}`),
          h('li', `本次预计费用：${priceText}`),
        ]),
        h('p', '确认后，系统才会实时读取最新模型、Key、能力和参考包并继续。'),
      ]),
      '确认创建一次新尝试',
      { confirmButtonText: '确认并重试', cancelButtonText: '先不创建', type: 'warning' },
    )
    const result = await productionAPI.reconcileAction(activeRun.value.id, action.id, {
      mode: 'start_retry',
      reason: '用户查看最新模型、时长、执行单元和费用后明确确认',
    })
    ambiguousRecoveryResult.value = result
    await loadRun(activeRun.value.id, { loadEvidence: true })
    ElMessage.success(result?.message || '已开始一次新尝试')
    await driveRun()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '创建新尝试失败')
  } finally {
    ambiguousRecoveryBusy.value = false
  }
}

function returnToReferenceBundle() {
  const stage = graph.stages.find((item) => item.key === 'reference_bundle')
  if (stage) returnToStage(stage)
}

async function recoverStoryboard() {
  if (!canRecoverStoryboard.value || !latestFailedAction.value || driving.value) return
  driving.value = true
  try {
    const result = await productionAPI.recoverStoryboard(activeRun.value.id, {
      action_id: latestFailedAction.value.id,
    })
    lastOutcome.value = result
    await loadRun(activeRun.value.id, { loadEvidence: true })
    ElMessage.success(result.reused
      ? '已恢复到现有的本地修订，请检查后确认'
      : '已从确认过的粗分镜恢复；未调用模型，也未使用上一视频尾帧')
  } catch (error) {
    ElMessage.error(error.message || '本地恢复失败')
  } finally {
    driving.value = false
  }
}

async function changeReviewOwner(value, options = {}) {
  const resolveCurrentIntervention = options.resolveIntervention === true
  if (value === activeRun.value.review_owner && !resolveCurrentIntervention) return
  if (value !== 'human' && stageIndex(activeRun.value.current_stage) >= stageIndex('shot_video')) {
    try {
      await ElMessageBox.confirm('切换后 AI 将重新获得剩余额度内的自动提交权限。已完成的内容不会重做。', '确认自动权限', { type: 'warning' })
    } catch (_) { return }
  }
  await productionAPI.updateRun(activeRun.value.id, {
    review_owner: value,
    resolve_intervention: resolveCurrentIntervention,
    expected_version: activeRun.value.version,
  })
  await loadRun(activeRun.value.id)
  if (value !== 'human') await driveRun()
}

async function resolveIntervention(owner) {
  if (!autonomyIntervention.value || resolvingIntervention.value) return
  resolvingIntervention.value = true
  try {
    await changeReviewOwner(owner, { resolveIntervention: true })
    ElMessage.success('人工处理已记录，自动流程已恢复')
  } catch (error) {
    ElMessage.error(error.message || '恢复自动流程失败')
  } finally {
    resolvingIntervention.value = false
  }
}

function artifactFields(artifact, run = activeRun.value) {
  if (artifact.stage === 'script') return FIELD_SCHEMAS.script
  if (artifact.stage === 'asset_text') return FIELD_SCHEMAS[artifact.scope_type] || []
  if (artifact.stage === 'storyboard_plan') {
    const hidden = new Set(['transition_mode'])
    if (run?.policy?.director_mode === 'off') hidden.add('previs_mode')
    return FIELD_SCHEMAS.shot.filter((field) => !hidden.has(field.key))
  }
  if (artifact.stage === 'director_plan') return FIELD_SCHEMAS.director
  return []
}

function markDirty(id) {
  dirtyArtifacts.add(id)
}

function setContinuityMode(artifact, mode) {
  if (!artifact || !drafts[artifact.id]) return
  const number = Number(drafts[artifact.id].number ?? artifact.scope_id)
  if (number === 1) return
  if (!['hard_cut', 'reference_continuation', 'strict_continuation'].includes(mode)) return
  drafts[artifact.id].transition_mode = mode
  if (mode === 'strict_continuation' && !String(drafts[artifact.id].continuous_take_id || '').trim()) {
    drafts[artifact.id].continuous_take_id = `take-${Math.max(1, number - 1)}-${number}`
  }
  if (mode !== 'strict_continuation') drafts[artifact.id].continuous_take_id = ''
  markDirty(artifact.id)
}

function isDirty(id) {
  return dirtyArtifacts.has(id)
}

function serializeDraft(artifact) {
  const content = deepClone(drafts[artifact.id])
  for (const field of artifactFields(artifact)) {
    if (field.array) content[field.key] = String(content[field.key] || '').split(/\n|,/).map((item) => item.trim()).filter(Boolean)
    if (field.key === 'document_json') {
      try { content.document = JSON.parse(content.document_json) } catch (_) { throw new Error('导演台 JSON 格式不正确') }
      delete content.document_json
    }
  }
  return content
}

async function saveArtifact(artifact) {
  savingId.value = artifact.id
  try {
    const content = serializeDraft(artifact)
    const body = { content }
    if (artifact.stage === 'reference_bundle') {
      const manualOrigin = artifact.content?.bundle_origin === 'manual'
      const selectedAutoLinkDependencies = selectedAutoLinkDependencyIds(content)
      content.bundle_origin = manualOrigin ? 'manual' : 'manual_revision'
      content.revision_source = {
        type: 'user_edit',
        source_artifact_id: artifact.id,
        source_revision: artifact.revision,
      }
      body.depends_on = [...new Set([
        content.source_artifact_id,
        content.continuity_in_artifact_id,
        content.strict_first_frame_artifact_id,
        ...['images', 'videos', 'audios'].flatMap((key) => (content[key] || []).map((item) => item.artifact_id)),
        ...selectedAutoLinkDependencies,
      ].map(Number).filter(Number.isInteger))]
    }
    const created = await productionAPI.updateArtifact(artifact.id, body)
    dirtyArtifacts.delete(artifact.id)
    await loadRun(activeRun.value.id)
    ElMessage.success(`已保存为修订 ${created.revision}，请重新确认`)
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  } finally {
    savingId.value = null
  }
}

async function approveArtifact(artifact) {
  if (isDirty(artifact.id)) {
    await saveArtifact(artifact)
    return ElMessage.warning('已先保存新修订，请检查后再确认')
  }
  try {
    await productionAPI.reviewArtifact(artifact.id, { decision: 'approved', reason: '用户确认' })
    reviewReasons[artifact.id] = ''
    await loadRun(activeRun.value.id)
    if (artifact.stage === 'asset_images'
      || (artifact.stage === 'final_edit' && artifact.content?.kind === 'narration_plan')) await driveRun()
  } catch (error) {
    ElMessage.error(error.message || '确认失败')
  }
}

async function rejectArtifact(artifact) {
  const reason = reviewReasons[artifact.id]?.trim()
  if (!reason) return
  try {
    await productionAPI.reviewArtifact(artifact.id, { decision: 'rejected', reason })
    await loadRun(activeRun.value.id)
    if (['asset_images', 'storyboard_images', 'director_plan', 'director_preview', 'shot_video'].includes(artifact.stage)) await driveRun()
  } catch (error) {
    ElMessage.error(error.message || '打回失败')
  }
}

async function reopenArtifact(artifact) {
  try {
    const { value } = await ElMessageBox.prompt(
      '这会撤销当前确认，并只让真正依赖此项的后续内容失效。请写明需要修改什么。',
      '撤销确认并打回',
      { inputPlaceholder: '例如：角色发色不一致，需要保留银白短发', confirmButtonText: '确认打回', inputValidator: (text) => !!String(text || '').trim() || '必须填写打回原因' },
    )
    await productionAPI.reviewArtifact(artifact.id, { decision: 'rejected', reason: String(value).trim() })
    reviewReasons[artifact.id] = ''
    await loadRun(activeRun.value.id)
    if (['asset_images', 'storyboard_images', 'director_plan', 'director_preview', 'shot_video'].includes(artifact.stage)) await driveRun()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '撤销确认失败')
  }
}

async function skipShotOperation(artifact) {
  try {
    const { value } = await ElMessageBox.prompt(
      '镜头会退出主序列并立即让出后续制作。已经外发的视频不会重复提交，完成后只保留到素材库。',
      `跳过镜头 #${artifact.content?.number || artifact.scope_id}`,
      { inputPlaceholder: '可填写跳过原因', confirmButtonText: '跳过并继续', cancelButtonText: '取消' },
    )
    return executeShotOperation({
      runId: activeRun.value.id,
      shotId: artifact.scope_id,
      request: (version) => productionAPI.skipShot(activeRun.value.id, artifact.scope_id, {
        reason: String(value || '用户跳过此镜头').trim(),
        expected_version: version,
      }),
      successMessage: '已跳过当前镜头并继续后续序列',
    })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '跳过镜头失败')
    return null
  }
}

async function restoreShotOperation(artifact) {
  try {
    await ElMessageBox.confirm(
      '将创建一个新的分镜草稿重新进入审批，旧的分镜图、参考包和视频不会被自动复活。',
      `恢复镜头 #${artifact.content?.number || artifact.scope_id}`,
      { confirmButtonText: '恢复为新草稿', cancelButtonText: '取消' },
    )
    return executeShotOperation({
      runId: activeRun.value.id,
      shotId: artifact.scope_id,
      request: (version) => productionAPI.restoreShot(activeRun.value.id, artifact.scope_id, {
        reason: '用户恢复已跳过镜头', expected_version: version,
      }),
      successMessage: '镜头已恢复为新草稿',
    })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '恢复镜头失败')
    return null
  }
}

async function reviseShotOperation(artifact) {
  try {
    const { value } = await ElMessageBox.prompt(
      '写清需要保留和改变的内容，系统会重写这一镜并让其后代按新版本重建。',
      `修改镜头 #${artifact.content?.number || artifact.scope_id}`,
      {
        inputPlaceholder: '例如：保留角色和场景，只把动作改成先回头再拔剑',
        confirmButtonText: '生成新修订',
        inputValidator: (text) => Boolean(String(text || '').trim()) || '请输入修改要求',
      },
    )
    return executeShotOperation({
      runId: activeRun.value.id,
      shotId: artifact.scope_id,
      request: (version) => productionAPI.reviseShot(activeRun.value.id, artifact.scope_id, {
        instruction: String(value).trim(), expected_version: version,
      }),
      successMessage: '镜头新修订已生成',
    })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '修改镜头失败')
    return null
  }
}

async function splitShotOperation(artifact) {
  try {
    const { value } = await ElMessageBox.prompt(
      '说明当前镜头中没有展示完的动作或信息，系统会在真实剪辑点拆成两镜。',
      `拆分镜头 #${artifact.content?.number || artifact.scope_id}`,
      {
        inputPlaceholder: '例如：把角色看到符箓后的反应拆成下一镜头特写',
        confirmButtonText: '拆成两镜',
        inputValidator: (text) => Boolean(String(text || '').trim()) || '请输入拆分要求',
      },
    )
    return executeShotOperation({
      runId: activeRun.value.id,
      shotId: artifact.scope_id,
      request: (version) => productionAPI.splitShot(activeRun.value.id, artifact.scope_id, {
        instruction: String(value).trim(), expected_version: version,
      }),
      successMessage: '已创建两个可独立制作的镜头草稿',
    })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '拆分镜头失败')
    return null
  }
}

async function pickupShotOperation(artifact) {
  try {
    const { value } = await ElMessageBox.prompt(
      '补拍镜头会插入当前镜头之后，不会覆盖现有素材。',
      `在镜头 #${artifact.content?.number || artifact.scope_id} 后补拍`,
      {
        inputPlaceholder: '例如：补一个桃木剑落地后符纹熄灭的道具特写',
        confirmButtonText: '添加补拍镜头',
        inputValidator: (text) => Boolean(String(text || '').trim()) || '请输入补拍内容',
      },
    )
    return executeShotOperation({
      runId: activeRun.value.id,
      shotId: artifact.scope_id,
      request: (version) => productionAPI.pickupShot(activeRun.value.id, {
        after_shot_id: artifact.scope_id,
        instruction: String(value).trim(),
        expected_version: version,
      }),
      successMessage: '补拍镜头已插入序列',
    })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '添加补拍镜头失败')
    return null
  }
}

async function excludeArtifact(artifact) {
  if (artifact.stage === 'storyboard_plan' && artifact.scope_type === 'shot') {
    return skipShotOperation(artifact)
  }
  const { value } = await ElMessageBox.prompt('可以说明为什么不再使用，后续也可恢复。', '不使用此项', { inputPlaceholder: '例如：剧情已删除这个道具', confirmButtonText: '确认不使用' })
  await productionAPI.excludeArtifact(artifact.id, { reason: value || '用户选择不使用' })
  await loadRun(activeRun.value.id)
}

async function restoreArtifact(artifact) {
  if (artifact.stage === 'storyboard_plan' && artifact.scope_type === 'shot') {
    return restoreShotOperation(artifact)
  }
  await productionAPI.restoreArtifact(artifact.id, { reason: '用户恢复使用' })
  await loadRun(activeRun.value.id)
}

async function confirmDirectClip(artifact) {
  await productionAPI.confirmDirectClip(artifact.id, { reason: '用户确认作为直接视频片段使用' })
  await loadRun(activeRun.value.id)
  ElMessage.success('已确认，片段会进入后续成片编排')
}

async function derivePrivacyImage(artifact) {
  privacyBusyId.value = artifact.id
  try {
    const result = await privacyAPI.derive({ source_media_path: artifact.media_path, mode: privacyMode.value, density: privacyDensity.value })
    ElMessage.success(result.mode === 'face_grid' ? '已生成九宫格面部细节派生图，原图未改动' : `已生成可逆隐私派生图（密度 ${Math.round((result.density || privacyDensity.value) * 100)}%），原图未改动`)
  } catch (error) { ElMessage.error(error.message || '隐私派生失败') }
  finally { privacyBusyId.value = null }
}

async function suggestWholeArtifact(artifact) {
  suggestingId.value = artifact.id
  try {
    const instruction = reviewReasons[artifact.id]?.trim() || '提升清晰度、一致性和可执行性'
    const result = await productionAPI.suggestArtifact(artifact.id, { instruction })
    drafts[artifact.id] = normalizeCandidateDraft(artifact, result.candidate)
    markDirty(artifact.id)
    ElMessage.success('AI 建议已填入草稿，尚未保存或确认')
  } finally {
    suggestingId.value = null
  }
}

function normalizeCandidateDraft(artifact, candidate) {
  const value = deepClone(candidate)
  for (const field of artifactFields(artifact)) {
    if (field.array) value[field.key] = Array.isArray(value[field.key]) ? value[field.key].join('\n') : String(value[field.key] || '')
    if (field.key === 'document_json') value.document_json = JSON.stringify(value.document || {}, null, 2)
  }
  return value
}

async function confirmStage(strategy) {
  try {
    const result = await productionAPI.transition(activeRun.value.id, {
      next_stage_strategy: strategy,
      expected_version: activeRun.value.version,
    })
    await loadRun(result.run.id)
    if (strategy === 'auto_generate') await driveRun()
  } catch (error) {
    ElMessage.error(error.message || '无法进入下一步')
  }
}

function supportsAdd(stage) {
  return ['script', 'asset_text', 'storyboard_plan'].includes(stage)
}

function addOptions(stage) {
  if (stage === 'script') return [{ label: '手动填写剧本', value: 'run' }]
  if (stage === 'asset_text') return [{ label: '新增角色', value: 'character' }, { label: '新增场景', value: 'scene' }, { label: '新增道具', value: 'prop' }]
  return [{ label: '新增分镜', value: 'shot' }]
}

function nextScopeId(scopeType) {
  if (scopeType === 'run') return ''
  const numbers = activeArtifacts.value
    .filter((item) => item.scope_type === scopeType)
    .map((item) => Number(String(item.scope_id || '').match(/(\d+)$/)?.[1] || 0))
  const next = Math.max(0, ...numbers) + 1
  return scopeType === 'shot' ? String(next) : `${scopeType}-${next}`
}

async function addManualArtifact(scopeType) {
  const stage = activeRun.value.current_stage
  let content = { included: true }
  let title = '新内容'
  if (stage === 'script') {
    title = '手动剧本'
    content = { text: '', included: true, required_fields: ['text'] }
  } else if (stage === 'asset_text') {
    title = scopeType === 'character' ? '新角色' : scopeType === 'scene' ? '新场景' : '新道具'
    content = { type: scopeType, name: title, description: '', visual_prompt: '', included: true, required_fields: ['name', 'description', 'visual_prompt'] }
  } else if (stage === 'storyboard_plan') {
    const number = Number(nextScopeId('shot'))
    title = `镜头 ${number}`
    const opening = number === 1
    content = {
      number, title, duration: 5, previs_mode: 'auto', action: '', visual: '', video_prompt: '',
      transition_mode: opening ? 'opening' : 'hard_cut',
      cut_motivation: opening ? '' : '上一镜头动作完整结束后切换到新的独立机位',
      cut_in: opening ? '建立本片开场状态' : '从新的独立机位建立本镜头状态',
      cut_out: '本镜头动作完整结束并形成可剪辑的稳定状态',
      continuous_take_id: '',
      boundary_prompt: opening
        ? '这是成片的开场镜头，从独立完整的开场构图开始。'
        : '这是一次明确硬切后的新摄影镜头，不得延续上一段尚未完成的运镜或动作。',
      character_names: [], prop_names: [], included: true,
      required_fields: ['title', 'action', 'visual', 'video_prompt', 'transition_mode', 'cut_in', 'cut_out', 'boundary_prompt'],
    }
  }
  manualAdding.value = true
  try {
    await productionAPI.addArtifact(activeRun.value.id, { stage, scope_type: scopeType, scope_id: nextScopeId(scopeType), title, content })
    await loadRun(activeRun.value.id)
  } catch (error) {
    ElMessage.error(error.message || '手动新增失败')
  } finally {
    manualAdding.value = false
  }
}

function supportsMediaUpload(stage) {
  return ['asset_images', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit'].includes(stage)
}

function handleManualTarget(target) {
  if (supportsMediaUpload(activeRun.value.current_stage)) uploadManualMedia(target)
  else addManualDerivedArtifact(target)
}

async function addManualDerivedArtifact(target) {
  const source = target?.source
  if (!source) return
  const stage = activeRun.value.current_stage
  const manualRoute = normalizeRoute({
    director_mode: activeRun.value?.policy?.director_mode || 'auto',
  }, source)
  const content = stage === 'reference_bundle'
    ? {
      images: [], videos: [], audios: [], limits: null,
      soft_limits: true,
      media_constraints: { contract_status: 'unknown' },
      route_profile: manualRoute.profile,
      uses_reference_video: manualRoute.usesReferenceVideo,
      requires_director_preview: manualRoute.requiresDirectorPreview,
      bundle_origin: 'manual',
      included: true, source_artifact_id: source.id,
    }
    : { scene_summary: '', included: true, source_artifact_id: source.id }
  manualAdding.value = true
  try {
    await productionAPI.addArtifact(activeRun.value.id, {
      stage,
      source_artifact_id: source.id,
      scope_type: source.scope_type,
      scope_id: source.scope_id,
      title: stage === 'director_plan' ? `${source.title} 导演台方案` : `${source.title} 参考包`,
      content,
    })
    await loadRun(activeRun.value.id)
  } catch (error) {
    ElMessage.error(error.message || '手动创建失败')
  } finally {
    manualAdding.value = false
  }
}

function uploadManualMedia(target) {
  const stage = activeRun.value.current_stage
  const imageStage = ['asset_images', 'storyboard_images'].includes(stage)
  const targets = manualTargetOptions.value.map((item) => ({ ...item }))
  uploadDialogContext.value = {
    mode: 'stage',
    stage,
    title: imageStage ? '批量上传阶段图片' : stage === 'final_edit' ? '上传已剪辑成片' : '批量上传阶段视频',
    description: targets.length > 1 ? '每个文件会明确分配到一个目标，不会静默覆盖其它角色、场景或镜头。' : '',
    expectedMediaType: imageStage ? 'image' : 'video',
    endpoint: imageStage ? 'image' : 'reference',
    accept: imageStage ? 'image/*' : 'video/*',
    targets,
    initialTargetKey: target?.key || targets[0]?.key || '',
    maxFiles: targets.length || 1,
    currentItems: [],
    capability: {
      media_constraints: {
        contract_status: 'known',
        ...(imageStage ? { max_image_bytes: 16 * 1024 * 1024 } : { max_video_bytes: 50 * 1024 * 1024 }),
      },
    },
  }
  uploadDialogVisible.value = true
}

function referenceBuckets(artifact) {
  const content = drafts[artifact.id] || artifact.content || {}
  const limits = content.limits || artifact.content?.limits || {}
  const contractStatus = String(content.media_constraints?.contract_status || content.contract_status || '')
  const softLimits = content.soft_limits === true || contractStatus !== 'known'
  const resolvedLimit = (key) => {
    if (softLimits) return null
    const value = Number(limits[key])
    return Number.isFinite(value) ? value : null
  }
  return [
    { key: 'images', label: '参考图', limit: resolvedLimit('images'), items: content.images || [] },
    { key: 'videos', label: '参考视频', limit: resolvedLimit('videos'), items: content.videos || [] },
    { key: 'audios', label: '参考音频', limit: resolvedLimit('audios'), items: content.audios || [] },
  ]
}

function referenceAutoLinkView(artifact) {
  return buildReferenceAutoLinkView(drafts[artifact.id] || artifact.content || {}, {
    dirty: isDirty(artifact.id),
  })
}

function referenceSourceText(item) {
  return referenceSourceLabel(item)
}

function uploadBundleReference(artifact, type) {
  const content = drafts[artifact.id] || artifact.content || {}
  const bucket = referenceBuckets(artifact).find((item) => item.key === type)
  const allItems = ['images', 'videos', 'audios'].flatMap((key) => (content[key] || []).map((item) => ({
    ...item,
    mime_type: item.mime_type || (key === 'images' ? 'image/*' : key === 'videos' ? 'video/*' : 'audio/*'),
  })))
  const mediaType = type === 'images' ? 'image' : type === 'videos' ? 'video' : 'audio'
  const remainingText = bucket?.limit == null
    ? '当前模型未登记硬上限，可继续添加；提交时由上游校验'
    : `当前为建议上限 ${bucket.limit} 个，可继续添加，提交时由上游校验`
  uploadDialogContext.value = {
    mode: 'reference',
    artifactId: artifact.id,
    bucket: type,
    title: `为 ${artifact.title} 添加${bucket?.label || '参考媒体'}`,
    description: remainingText,
    expectedMediaType: mediaType,
    endpoint: 'reference',
    accept: `${mediaType}/*`,
    targets: [],
    initialTargetKey: '',
    maxFiles: null,
    enforceContractLimits: false,
    currentItems: allItems,
    capability: {
      limits: content.limits || {},
      media_constraints: content.media_constraints || { contract_status: 'unknown' },
    },
  }
  uploadDialogVisible.value = true
}

async function commitWorkflowUpload({ file, descriptor, targetKey, uploaded }) {
  const context = uploadDialogContext.value
  if (!context || !activeRun.value) throw new Error('上传目标已经失效，请重新打开上传窗口')
  const mediaPath = uploaded.local_path || uploaded.path
  if (!mediaPath) throw new Error('上传成功，但服务端没有返回可用文件路径')
  if (context.mode === 'stage') {
    const target = context.targets.find((item) => item.key === targetKey)
    if (!target) throw new Error('请选择此文件对应的角色、场景或镜头')
    const source = target.source || null
    await productionAPI.addArtifact(activeRun.value.id, {
      stage: context.stage,
      source_artifact_id: source?.id,
      scope_type: source?.scope_type || 'run',
      scope_id: source?.scope_id || '',
      title: source ? `${source.title} · ${file.name}` : file.name,
      content: {
        included: true,
        uploaded_by_user: true,
        source_artifact_id: source?.id,
        upload_receipt: {
          sha256: uploaded.sha256 || descriptor.sha256 || null,
          size: Number(file.size || 0),
          deduplicated: uploaded.deduplicated === true,
        },
      },
      media_path: mediaPath,
      mime_type: file.type,
      content_hash: uploaded.sha256 || descriptor.sha256 || null,
    })
    return
  }
  if (context.mode === 'reference') {
    const artifact = (runSummary.value?.artifacts || []).find((item) => Number(item.id) === Number(context.artifactId))
    if (!artifact || !drafts[artifact.id]) throw new Error('参考包已经变化，请重新打开上传窗口')
    const content = deepClone(drafts[artifact.id])
    const current = content[context.bucket] || []
    const sha256 = uploaded.sha256 || descriptor.sha256 || null
    if (current.some((item) => item.path === mediaPath || (sha256 && (item.sha256 || item.content_hash) === sha256))) {
      const error = new Error('相同内容已经在当前参考包中，无需重复添加')
      error.code = 'DUPLICATE_REFERENCE'
      throw error
    }
    content[context.bucket] = [...current, {
      path: mediaPath,
      label: file.name,
      source: 'upload',
      sha256,
      content_hash: sha256,
      size: Number(file.size || 0),
      mime_type: file.type,
      media_type: descriptor.mediaType,
      duration_seconds: descriptor.durationSeconds,
      deduplicated: uploaded.deduplicated === true,
    }]
    drafts[artifact.id] = content
    markDirty(artifact.id)
  }
}

async function onWorkflowUploadFinished(summary) {
  if (uploadDialogContext.value?.mode === 'stage' && summary.uploaded > 0) {
    await loadRun(activeRun.value.id)
  }
  if (summary.uploaded > 0) ElMessage.success(`已完成 ${summary.uploaded} 个文件`)
  if (summary.failed > 0) ElMessage.warning(`${summary.failed} 个文件需要调整或重试`)
}

async function openMediaPicker(artifact, bucket) {
  mediaPickerTarget.value = {
    artifact,
    bucket,
    label: bucket === 'images' ? '参考图' : bucket === 'videos' ? '参考视频' : '参考音频',
  }
  mediaPickerScope.value = 'project'
  mediaPickerKeyword.value = ''
  await loadReusableMedia()
  mediaPickerVisible.value = true
}

async function selectReusableMedia(item) {
  const target = mediaPickerTarget.value
  if (!target?.artifact || !target.bucket) return
  const content = deepClone(drafts[target.artifact.id])
  const current = content[target.bucket] || []
  if (current.some((entry) => entry.path === item.media_path
    || Number(entry.artifact_id) === Number(item.artifact_id)
    || (entry.original_path && entry.original_path === item.original_media_path))) {
    mediaPickerVisible.value = false
    return ElMessage.info('这个媒体已经在参考包中')
  }
  if (item.available === false) return ElMessage.error('源文件不可用，无法加入参考包')

  let selected = item
  const crossProject = isCrossProjectMedia(item, dramaId)
  if (!item.ready || crossProject) {
    materializingMediaId.value = item.artifact_id
    try {
      const prepared = await productionAPI.materializeReusableMedia(
        activeRun.value.id,
        item.artifact_id,
        reusableMaterializeBody(item, dramaId),
      )
      selected = { ...item, ...prepared }
      const stored = reusableMedia.value.find((entry) => Number(entry.artifact_id) === Number(item.artifact_id))
      if (stored) Object.assign(stored, prepared)
    } catch (error) {
      return ElMessage.error(error.message || '历史媒体准备失败')
    } finally {
      materializingMediaId.value = null
    }
  }

  content[target.bucket] = [...current, {
    path: selected.media_path,
    original_path: selected.original_media_path || item.original_media_path || item.media_path,
    artifact_id: selected.artifact_id,
    label: selected.title || fileName(selected.media_path),
    source: 'reused',
    provenance: {
      drama_id: selected.drama_id,
      drama_title: selected.drama_title,
      run_id: selected.run_id,
      stage: selected.stage,
      scope_type: selected.scope_type,
      scope_id: selected.scope_id,
      cross_project: crossProject,
    },
  }]
  drafts[target.artifact.id] = content
  markDirty(target.artifact.id)
  mediaPickerVisible.value = false
  ElMessage.success(crossProject ? '已从其他项目加入参考包草稿，并保留来源记录' : '已加入参考包草稿，保存并确认后生效')
}

function removeReference(artifact, type, mediaPath) {
  const content = deepClone(drafts[artifact.id])
  content[type] = (content[type] || []).filter((item) => item.path !== mediaPath)
  drafts[artifact.id] = content
  markDirty(artifact.id)
}

async function onClientCaptureSubmitted() {
  lastOutcome.value = null
  await loadRun(activeRun.value.id)
  await driveRun()
}

function openDirectorEditor(action) {
  router.push({ path: `/director/${dramaId}`, query: { workflow_run: activeRun.value.id, shot: action.shot_id } })
}

async function openRevisionHistory(artifact) {
  revisionTarget.value = artifact
  const result = await productionAPI.listArtifacts(activeRun.value.id, {
    stage: artifact.stage,
    scope_type: artifact.scope_type,
    scope_id: artifact.scope_id,
    page_size: 100,
  })
  revisions.value = result.items || []
  revisionsVisible.value = true
}

async function selectRun(runId) {
  const normalizedRunId = String(runId)
  const selection = {
    runId: normalizedRunId,
    viewportSnapshot: selectedRunId.value === normalizedRunId && runSummary.value?.run
      ? captureWorkflowViewport()
      : null,
  }
  if (historyVisible.value) {
    pendingRunSelection.value = selection
    historyVisible.value = false
    return
  }
  await applyRunSelection(selection)
}

async function applyPendingRunSelection() {
  const selection = pendingRunSelection.value
  pendingRunSelection.value = null
  if (selection) await applyRunSelection(selection)
}

async function applyRunSelection({ runId, viewportSnapshot = null }) {
  clearPoll()
  lastOutcome.value = null
  viewedStageKey.value = String(route.query.view_stage || '').trim() || null
  await loadRun(runId, { viewportSnapshot })
  if (!['draft', 'paused', 'completed', 'cancelled'].includes(activeRun.value.status)
    && (activeRun.value.status !== 'failed' || isUnattendedOwner(activeRun.value.review_owner))) await driveRun()
}

async function startNewRunWithProjectAspect() {
  clearPoll()
  loadRunViewportToken += 1
  runSummary.value = null
  viewedStageKey.value = null
  inputReviewVisible.value = false
  selectedRunId.value = null
  selectedShotId.value = null
  selectedShotPinned.value = false
  lastOutcome.value = null
  preflightResult.value = null
  newRun.aspectRatio = projectAspect.value.value
  const query = { ...route.query }
  delete query.run
  await router.replace({ query })
  await nextTick()
  window.scrollTo({ top: 0, behavior: 'auto' })
}

async function openSettings() {
  if (!activeRun.value) return
  if ((!imageConfigs.image.length && !imageConfigs.storyboard_image.length) || !videoCatalog.value.length || !videoConfigs.value.length) await loadCatalogs()
  const assetConfig = imageConfigs.image.find((item) => Number(item.id) === Number(activeRun.value.policy?.asset_image_config_id))
    || imageConfigs.image.find((item) => item.is_default)
    || imageConfigs.image[0]
    || null
  const storyboardConfig = imageConfigs.storyboard_image.find((item) => Number(item.id) === Number(activeRun.value.policy?.storyboard_image_config_id))
    || imageConfigs.storyboard_image.find((item) => item.is_default)
    || imageConfigs.storyboard_image[0]
    || null
  const videoConfig = videoConfigs.value.find((item) => Number(item.id) === Number(activeRun.value.policy?.video_config_id) && item.is_active !== false)
    || videoConfigs.value.find((item) => item.is_active !== false && item.is_default)
    || videoConfigs.value.find((item) => item.is_active !== false)
    || null
  settingsDraft.value = {
    review_owner: activeRun.value.review_owner,
    style: activeRun.value.policy?.style || '',
    image_model: activeRun.value.policy?.image_model || '',
    image_configs: {
      image: imageConfigDraft('image', assetConfig, activeRun.value.policy?.asset_image_model || activeRun.value.policy?.image_model),
      storyboard_image: imageConfigDraft('storyboard_image', storyboardConfig, activeRun.value.policy?.storyboard_image_model || activeRun.value.policy?.image_model),
    },
    image_concurrency: Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number(activeRun.value.policy?.image_concurrency) || 4)),
    video_config_id: videoConfig?.id || null,
    video_model: activeRun.value.policy?.video_model || '',
    video_routing_mode: activeRun.value.policy?.video_routing_mode || 'auto',
    video_group: activeRun.value.policy?.video_group || '特价视频分组(即梦)',
    video_provider: activeRun.value.policy?.video_provider || 'yinzi',
    video_quality: activeRun.value.policy?.video_quality || 'balanced',
    director_mode: activeRun.value.policy?.director_mode || 'auto',
    target_shots: activeRun.value.policy?.target_shots || 3,
    aspect_ratio: activeRun.value.policy?.aspect_ratio || '16:9',
    max_video_seconds: activeRun.value.budget?.max_video_seconds || 60,
    max_video_attempts: activeRun.value.budget?.max_video_attempts || 10,
    max_video_attempts_per_shot: activeRun.value.budget?.max_video_attempts_per_shot || 2,
    max_text_revisions: activeRun.value.budget?.max_text_revisions || 5,
    max_image_revisions: activeRun.value.budget?.max_image_revisions || 5,
    max_director_revisions: activeRun.value.budget?.max_director_revisions || 5,
    max_auto_recoveries: activeRun.value.budget?.max_auto_recoveries || 5,
    max_cost_usd: activeRun.value.budget?.max_cost_usd ?? null,
    allow_unknown_price: activeRun.value.budget?.allow_unknown_price === true,
    manual_next_default: !!activeRun.value.manual_next_default,
    review_prompt: activeRun.value.review_profile?.prompt || '',
    review_model: activeRun.value.review_profile?.model || '',
    review_skills: Array.isArray(activeRun.value.review_profile?.skills) ? activeRun.value.review_profile.skills.join('\n') : (activeRun.value.review_profile?.skills || ''),
  }
  projectExpensiveConfirmed.value = false
  settingsVisible.value = true
  if (settingsDraft.value.video_config_id) {
    await discoverVideoCatalog(settingsDraft.value.video_config_id, { group: settingsDraft.value.video_group })
  }
}

async function saveSettings() {
  const value = settingsDraft.value
  if (!value || !activeRun.value || settingsSaving.value) return
  const runId = activeRun.value.id
  const stageBefore = activeRun.value.current_stage
  const directorWasEnabled = activeRun.value.policy?.director_mode !== 'off'
  const directorWillBeDisabled = value.director_mode === 'off'
  const routeChanged = projectVideoRoutingChanged(activeRun.value.policy, value)
  let routeApplied = false
  settingsSaving.value = true
  try {
    const videoConfigId = Number(value.video_config_id)
    if (!Number.isSafeInteger(videoConfigId) || videoConfigId <= 0) {
      throw new Error('请先选择一个已保存的视频 URL / Key 配置')
    }
    if (videoCatalogConfigId.value !== videoConfigId || !videoCatalog.value.length) {
      await discoverVideoCatalog(videoConfigId, { group: value.video_group })
    }
    if (value.video_routing_mode === 'fixed') {
      if (!String(value.video_model || '').trim()) throw new Error('请先选择或手动输入一个视频模型名')
      if (projectSelectedVideoOption.value.requires_explicit_confirmation && !projectExpensiveConfirmed.value) {
        throw new Error('高价破甲模型需要先确认目录价格')
      }
    }

    let baseRun = activeRun.value
    if (routeChanged) {
      clearPoll()
      const routeResult = await productionAPI.updateVideoRouting(runId, buildProjectVideoRoutingPayload(value, {
        shotId: activeRun.value.current_scope_id,
        expectedVersion: activeRun.value.version,
        confirmExpensive: projectExpensiveConfirmed.value,
      }))
      routeApplied = true
      if (routeResult.summary) runSummary.value = routeResult.summary
      baseRun = routeResult.summary?.run || baseRun
    }

    const updated = await productionAPI.updateRun(runId, {
      review_owner: value.review_owner,
      manual_next_default: value.manual_next_default,
      policy: {
        ...baseRun.policy,
        style: value.style,
        visual_style: value.style,
        image_model: value.image_model,
        asset_image_model: value.image_configs?.image?.model || value.asset_image_model || value.image_model,
        storyboard_image_model: value.image_configs?.storyboard_image?.model || value.storyboard_image_model || value.image_model,
        asset_image_config_id: Number(value.image_configs?.image?.id) || baseRun.policy?.asset_image_config_id || null,
        storyboard_image_config_id: Number(value.image_configs?.storyboard_image?.id) || baseRun.policy?.storyboard_image_config_id || null,
        image_concurrency: Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number(value.image_concurrency) || 4)),
        video_duration_min: 1,
        director_mode: value.director_mode === 'off' ? 'off' : 'auto',
        target_shots: value.target_shots,
        aspect_ratio: normalizeProductionAspectRatio(baseRun.policy?.aspect_ratio),
      },
      budget: {
        ...baseRun.budget,
        max_video_seconds: value.max_video_seconds,
        max_video_attempts: value.max_video_attempts,
        max_video_attempts_per_shot: value.max_video_attempts_per_shot,
        max_text_revisions: value.max_text_revisions,
        max_image_revisions: value.max_image_revisions,
        max_director_revisions: value.max_director_revisions,
        max_auto_recoveries: value.max_auto_recoveries,
        max_cost_usd: value.max_cost_usd == null || value.max_cost_usd === '' ? null : Number(value.max_cost_usd),
        allow_unknown_price: value.allow_unknown_price === true,
      },
      review_profile: {
        ...baseRun.review_profile,
        prompt: value.review_prompt,
        model: value.review_model || '',
        skills: String(value.review_skills || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      },
      expected_version: baseRun.version,
    })
    if (updated) runSummary.value = updated
    settingsVisible.value = false
    lastOutcome.value = null
    await loadRun(runId)
    ElMessage.success(routeChanged ? '设置已保存，视频路由已更新；尚未提交任何视频任务' : '设置已保存')
    if (directorWasEnabled && directorWillBeDisabled && !routeChanged
      && ['director_plan', 'director_preview'].includes(stageBefore)) {
      await driveRun()
    }
  } catch (error) {
    ElMessage.error(routeApplied
      ? `视频路由已保存，但其它设置未完整保存：${error.message || '请刷新后重试'}`
      : (error.message || '保存设置失败'))
    await loadRun(runId, { loadEvidence: false }).catch(() => {})
  } finally {
    settingsSaving.value = false
  }
}

async function saveImageConcurrency(value) {
  if (!activeRun.value) return
  const concurrency = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Number(value) || 4))
  try {
    await productionAPI.updateRun(activeRun.value.id, {
      policy: { ...activeRun.value.policy, image_concurrency: concurrency },
      expected_version: activeRun.value.version,
    })
    await loadRun(activeRun.value.id, { loadEvidence: false })
    if (activeRun.value.current_stage === 'asset_images') await driveRun()
  } catch (error) {
    imageConcurrencyDraft.value = Number(activeRun.value.policy?.image_concurrency) || 4
    ElMessage.error(error.message || '保存并发数失败')
  }
}

async function exportRun() {
  exportResult.value = await productionAPI.exportRun(activeRun.value.id)
  exportVisible.value = true
}

async function zipRun() {
  exportResult.value = await productionAPI.zipRun(activeRun.value.id)
  exportVisible.value = true
}

async function importNovel(event) {
  const file = event.target.files?.[0]
  if (!file) return
  if (file.size > 8 * 1024 * 1024) return ElMessage.error('小说文件不能超过 8 MB')
  novelFileName.value = file.name
  novelChapters.value = splitNovelChapters(await file.text())
  selectedChapterIndexes.value = novelChapters.value.slice(0, Math.min(5, novelChapters.value.length)).map((chapter) => chapter.index)
  syncSelectedChapters()
}

function syncSelectedChapters() {
  sourceDraft.value = joinSelectedChapters(novelChapters.value, selectedChapterIndexes.value)
}

function stageIndex(key) {
  return graph.stages.findIndex((stage) => stage.key === key)
}

function stageLabel(key) {
  return graph.stages.find((stage) => stage.key === key)?.label || key
}

function macroState(macro) {
  const stages = graph.stages.filter((stage) => stage.macro === macro.key)
  const current = stageIndex(activeRun.value.current_stage)
  const start = stageIndex(stages[0]?.key)
  const end = stageIndex(stages[stages.length - 1]?.key)
  return { active: current >= start && current <= end, done: current > end || stages.every(stageIsEffectivelyComplete) }
}

function macroProgress(macro) {
  const stages = graph.stages.filter((stage) => stage.macro === macro.key)
  const completed = stages.filter(stageIsEffectivelyComplete).length
  return `${completed}/${stages.length}`
}

function isDirectorStageDisabled(stage) {
  return activeRun.value?.policy?.director_mode === 'off'
    && ['director_plan', 'director_preview'].includes(stage?.key || stage)
}

function stageIsEffectivelyComplete(stage) {
  if (isDirectorStageDisabled(stage)) return true
  return !!runSummary.value.stages.find((item) => item.key === stage.key)?.complete
}

function canOpenMacro(macro) {
  const stages = graph.stages.filter((stage) => stage.macro === macro.key)
  return stageIndex(stages[0]?.key) <= stageIndex(activeRun.value.current_stage)
}

function setViewedStage(stageKey) {
  const key = typeof stageKey === 'string' ? stageKey : stageKey?.key
  if (!key || !activeRun.value || stageIndex(key) < 0 || stageIndex(key) > stageIndex(activeRun.value.current_stage)) return
  viewedStageKey.value = key === activeRun.value.current_stage ? null : key
  const query = { ...route.query }
  if (viewedStageKey.value) query.view_stage = viewedStageKey.value
  else delete query.view_stage
  router.replace({ query }).catch(() => {})
}

function returnToExecutionStage() {
  viewedStageKey.value = null
  const query = { ...route.query }
  delete query.view_stage
  router.replace({ query }).catch(() => {})
  inputReviewVisible.value = false
}

function reopenStoryForRevision() {
  inputReviewVisible.value = false
  const storyStage = graph.stages.find((stage) => stage.key === 'story_input')
  if (storyStage) returnToStage(storyStage, { revise: true })
}

function openMacro(macro) {
  const macroStages = graph.stages.filter((stage) => stage.macro === macro.key)
  const target = macro.key === 'story' ? macroStages[0] : macroStages.at(-1)
  if (!target || stageIndex(target.key) >= stageIndex(activeRun.value.current_stage)) return
  setViewedStage(target.key)
}

async function returnToStage(stage, options = {}) {
  if (!stage || stageIndex(stage.key) >= stageIndex(activeRun.value.current_stage)) return
  if (!options.revise) {
    setViewedStage(stage.key)
    return
  }
  try {
    await ElMessageBox.confirm(
      `返回“${stage.label}”后可继续修改；新修订确认时只会使依赖它的下游内容失效。`,
      '返回这个步骤',
      { type: 'warning', confirmButtonText: '确认返回' }
    )
    await productionAPI.returnToStage(activeRun.value.id, {
      stage: stage.key,
      reason: '用户从子阶段导航返回修改',
      expected_version: activeRun.value.version,
    })
    lastOutcome.value = null
    viewedStageKey.value = null
    await loadRun(activeRun.value.id)
  } catch (_) {}
}

function substageClass(stage) {
  const summary = runSummary.value.stages.find((item) => item.key === stage.key)
  return { active: stage.key === activeRun.value.current_stage, done: stageIsEffectivelyComplete(stage), invalid: summary?.counts?.invalidated }
}

function substageIcon(stage) {
  const summary = runSummary.value.stages.find((item) => item.key === stage.key)
  if (stageIsEffectivelyComplete(stage)) return CircleCheck
  if (stage.key === activeRun.value.current_stage && driving.value) return Loading
  if (summary?.counts?.rejected || summary?.counts?.failed) return Warning
  return Clock
}

function statusIcon(status) {
  if (status === 'completed') return CircleCheck
  if (['failed', 'cancelled'].includes(status)) return Warning
  if (['running', 'waiting_provider'].includes(status)) return Loading
  if (status === 'paused') return VideoPause
  return Clock
}

function statusLabel(status, fixture = false) {
  if (fixture && status === 'waiting_provider') return '本地验收模拟'
  return ({ draft: '待开始', running: '制作中', waiting_review: '等待确认', waiting_client: '等待本地预演', waiting_provider: '云端生成中', paused: '已暂停', completed: '已完成', failed: '需要处理', cancelled: '已取消' })[status] || status
}

function waitingReasonLabel(reason) {
  return ({
    narration_confirmation: '请确认逐镜旁白、Xiaoyi 音色、字幕与原声混音设置，确认后将自动开始本地合成。',
    final_merge: '正在本地合成旁白、字幕、原声和最终视频。',
    storyboard_local_recovery: '顺序分镜已从确认过的粗分镜恢复，请检查当前修订。',
    revision_required: '当前内容已打回，设置会保留；请修改并保存为新修订，确认后再继续。',
    stage_transition: '本阶段已确认完毕，可以进入下一步。',
    unresolved_items: '仍有内容需要确认或生成。',
    automation_limit_reached: '同一对象已达到连续自动处理上限，系统已安全停止。',
    ambiguous_external_task: '外部任务结果不明确，为避免重复扣费已停止重提。',
    budget_exhausted: '当前授权预算已经用完。',
    resource_unavailable: '缺少可继续执行的模型、配置或素材。',
    automation_diagnosis_stopped: 'AI 判断继续尝试只会重复失败。',
    automation_recovery_failed: '自动恢复未能完成。',
  })[reason] || ''
}

function artifactStatusIcon(status) {
  if (status === 'approved') return CircleCheck
  if (['rejected', 'failed', 'invalidated'].includes(status)) return Warning
  if (status === 'reviewing') return Loading
  return Edit
}

function artifactStatusLabel(artifact) {
  if (artifact.content?.included === false && artifact.status === 'approved') return '不使用'
  return ({ draft: '待确认', reviewing: '审批中', approved: '已确认', rejected: '已打回', superseded: '历史版本', invalidated: '上游已变更', failed: '生成失败' })[artifact.status] || artifact.status
}

function modeDescription(mode) {
  return ({
    human: 'AI 生成每一步，你逐项确认或填写打回意见。',
    ai: '多模态 AI 逐项审核；不通过会自己修改并复审，只有同一对象达到上限才找你。',
    auto_accept: '从故事一路生成到成片，不要求中间确认；失败会先由 AI 自愈，确定性校验始终保留。',
  })[mode] || ''
}

function stageDescription(stage) {
  const directorDisabled = activeRun.value?.policy?.director_mode === 'off'
  return ({
    story_input: '确认创作源内容。', script: '阅读完整剧本，编辑或打回后再提取资源。', asset_text: '逐项确认角色、场景和道具设定。', asset_images: '审核每个资源的视觉参考图。', storyboard_plan: '确认创作时长、当前模型执行时长、动作、构图，以及是否携带上一镜尾帧；2.5 可按 30 秒执行单元生成后本地裁剪。', storyboard_images: '逐镜审核静态分镜参考图。', director_plan: directorDisabled ? '本任务已关闭 3D 导演台，此阶段会自动跳过。' : '用 JSON 控制摄像机、物体、走位和关键帧。', director_preview: directorDisabled ? '本任务已关闭 3D 导演台，不会录制或携带预演视频。' : '只有需要连续动作的长镜头才录制真实 WebM 预演；其余镜头会明确跳过。', reference_bundle: directorDisabled ? '检查参考图与音频；本任务不会添加 3D 参考视频。' : '检查本镜头自动路由后的参考图、可选预演视频和音频上限。', shot_video: '逐镜检查生成视频，可打回重做；普通镜头直接切换，只有明确选择时才携带上一镜尾帧。', final_edit: '先确认逐镜旁白、字幕与原声混音，再在本地严格合并全部镜头并整理交付文件。',
  })[stage] || ''
}

function unresolvedLabel(reason) {
  return ({ empty_stage: '还没有内容', draft: '尚未确认', reviewing: '正在审批', rejected: '已打回，等待新修订', failed: '生成失败', invalidated: '上游内容已变更', media_missing: '缺少真实媒体文件', missing_final_video: '最终成片尚未生成', required_field_empty: '必填字段为空', missing_derived_artifact: '派生内容尚未生成', missing_scoped_artifact: '当前镜头内容尚未生成', shot_plan_not_refined: '需要根据前一镜正式视频修订' })[reason] || reason
}

function scopeLabel(scope) {
  return ({ run: '整项', character: '角色', scene: '场景', prop: '道具', shot: '镜头', resource: '资源' })[scope] || scope
}

function fieldContext(artifact, field) {
  return { stage: artifact.stage, scope: artifact.scope_type, title: artifact.title, field: field.key, artifact: artifact.content }
}

function canExclude(artifact) {
  return ['asset_text', 'asset_images', 'storyboard_plan', 'storyboard_images', 'director_plan', 'director_preview', 'shot_video'].includes(artifact.stage)
}

function isImageArtifact(artifact) {
  return artifact.mime_type?.startsWith('image/') || ['asset_images', 'storyboard_images'].includes(artifact.stage)
}

function mediaUrl(value) {
  if (!value) return ''
  if (/^(https?:|data:|blob:)/i.test(value)) return value
  return `/static/${String(value).replace(/^\/?static\//, '').replace(/^\//, '')}`
}

function fileName(value) {
  return String(value || '').split(/[\\/]/).pop() || '参考文件'
}

function latestReview(artifact) {
  return reviews.value.filter((item) => Number(item.artifact_id) === Number(artifact.id)).sort((a, b) => b.id - a.id)[0] || null
}

function reviewerLabel(type) {
  return ({ human: '人工审批', ai: 'AI 审批', deterministic: '技术校验' })[type] || type
}

function reviewDecisionLabel(decision) {
  return ({ approved: '通过', rejected: '打回', needs_human: '转人工' })[decision] || decision
}

function scoreLabel(key) {
  return ({ clarity: '清晰度', continuity: '连续性', production_ready: '可制作性' })[key] || key
}

function revisionPreview(item) {
  if (item.content?.text) return item.content.text.slice(0, 800)
  return JSON.stringify(item.content, null, 2).slice(0, 1600)
}

function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

onMounted(initialize)
onBeforeUnmount(clearPoll)
</script>

<style scoped>
.workflow-page { min-height: 100vh; overflow-x: clip; background: #f3f5f6; color: #1e2930; --accent: #16766b; --accent-soft: #e9f4f1; --line: #dbe2e5; --muted: #6f7d85; --el-color-primary: #16766b; --el-color-primary-light-3: #5b9f97; --el-color-primary-light-5: #86bab3; --el-color-primary-light-7: #b8d8d4; --el-color-primary-light-8: #d5e8e5; --el-color-primary-light-9: #ecf5f3; --el-color-primary-dark-2: #125f56; }
.start-template { margin: 18px 0; padding: 16px; border: 1px solid var(--line); background: #fff; }
.start-template .section-heading { margin-bottom: 10px; }
.start-template h2 { margin: 3px 0 0; font-size: 18px; }
.start-template > .el-select { width: min(100%, 520px); }
.template-hint, .start-template p { color: var(--muted); font-size: 11px; }
.start-template p { margin: 9px 0 0; line-height: 1.5; }
.start-assets { margin: 18px 0; padding: 16px; border: 1px solid #cfe1dd; background: #f7fbfa; }
.history-view-banner { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 9px 11px; border: 1px solid #c8deda; background: #f3faf8; color: #356c63; font-size: 11px; line-height: 1.5; }
.history-view-banner > .el-icon { color: var(--accent); }
.history-view-banner span { flex: 1; min-width: 220px; }
.run-input-access { margin: -8px 0 20px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid #d3e3e0; background: #fbfefd; }
.run-input-access > div { min-width: 0; display: grid; gap: 3px; }
.run-input-access strong { color: #2e5f57; font-size: 12px; }
.run-input-access span { color: #738481; font-size: 11px; line-height: 1.5; }
.input-review-notice { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid #cfe1dd; background: #f5fbf9; color: #42665f; font-size: 12px; line-height: 1.55; }
.input-review-notice > .el-icon { flex: 0 0 auto; margin-top: 2px; color: var(--accent); }
.input-review-notice span { flex: 1; }
.input-review-notice :deep(.el-button) { flex: 0 0 auto; margin-left: 6px; }
.input-review-grid { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 16px; }
.input-review-story, .input-review-assets { min-width: 0; padding: 12px; border: 1px solid #dfe8e6; background: #fff; }
.input-review-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 9px; color: #355651; font-size: 13px; }
.input-review-heading small { color: #82908d; font-size: 10px; }
.input-review-facts { display: grid; gap: 8px; margin-top: 11px; }
.input-review-facts span { display: grid; gap: 3px; padding: 7px 9px; border: 1px solid #e4ecea; background: #f8fbfa; }
.input-review-facts small { color: #7e8d8b; font-size: 10px; }
.input-review-facts strong { color: #3e5955; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.input-review-assets :deep(.inline-import) { margin-top: 0; border: 0; padding: 0; background: transparent; }
.input-review-assets :deep(.inline-import-head h3) { font-size: 15px; }
.input-review-assets :deep(.inline-import-head p) { font-size: 11px; }
.story-input-view { margin: -8px 0 20px; padding: 14px 16px; border: 1px solid #d5e4e1; background: #fff; }
.story-input-view > p { margin: 0; white-space: pre-wrap; color: #495d61; font-size: 13px; line-height: 1.7; }
.story-input-view .input-review-facts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.story-input-view-actions { display: flex; align-items: center; gap: 9px; margin-top: 12px; }
.start-assets .section-heading { margin-bottom: 10px; }
.start-assets h2 { margin: 3px 0 0; font-size: 18px; }
.start-assets-copy { margin: 0 0 12px; color: #64777a; font-size: 12px; line-height: 1.6; }
.start-assets-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.start-assets-actions :deep(.el-button) { margin-left: 0; }
.start-progress { width: min(520px, 100%); padding: 10px 12px; border: 1px solid #c7ddda; background: #f4fbfa; }
.start-progress > div { display: flex; align-items: center; gap: 7px; color: #28645e; font-size: 13px; }
.start-progress > span { color: #6a7d7f; font-size: 11px; line-height: 1.5; }
.template-slot-hints { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.template-slot-hints span { min-width: 0; padding: 7px 9px; border: 1px solid #d7e7e3; background: #fff; color: #71817f; font-size: 10px; line-height: 1.45; }
.template-slot-hints strong { margin-right: 5px; color: #3a6e65; }
.template-option { display: grid; gap: 2px; }
.template-option small { color: #7b8a8e; font-size: 10px; }
.provider-cancel-strip { margin: 0 0 18px; }
.provider-cancel-strip :deep(.el-alert__content) { width: 100%; }
.provider-cancel-strip :deep(.el-alert__description) { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ambiguous-recovery-card { margin: 0 0 18px; padding: 18px; border: 1px solid #e3b77d; background: #fffaf2; box-shadow: 0 8px 24px rgba(109, 73, 28, .08); }
.ambiguous-recovery-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.ambiguous-recovery-heading h2 { margin: 4px 0 6px; color: #734c1f; font-size: 18px; }
.ambiguous-recovery-heading p { max-width: 780px; margin: 0; color: #765f45; font-size: 12px; line-height: 1.65; }
.ambiguous-recovery-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 14px 0; border: 1px solid #ead8bd; background: #ead8bd; }
.ambiguous-recovery-facts span { min-width: 0; padding: 10px; display: grid; gap: 3px; background: #fff; }
.ambiguous-recovery-facts small { color: #967b59; font-size: 9px; }
.ambiguous-recovery-facts strong { overflow-wrap: anywhere; color: #664c2e; font-size: 11px; }
.ambiguous-primary-action { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.ambiguous-primary-action span { color: #79664e; font-size: 11px; }
.retry-confirm-details { color: #5f5142; line-height: 1.65; }
.retry-confirm-details p { margin: 0 0 10px; }
.retry-confirm-details ul { margin: 0 0 10px; padding-left: 20px; }
.ambiguous-other-actions { margin-top: 12px; }
.ambiguous-other-actions summary, .ambiguous-recovery-card .failure-details summary { color: #735b3d; font-size: 11px; cursor: pointer; }
.ambiguous-other-actions > div { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.ambiguous-other-actions :deep(.el-button) { margin-left: 0; }
.ambiguous-recovery-card .failure-details { margin-top: 12px; }
.ambiguous-recovery-card .failure-details code { display: block; margin-top: 7px; padding: 8px; overflow-wrap: anywhere; background: rgba(255,255,255,.7); color: #765c3d; font-size: 10px; }
.workflow-page :deep(.el-button--primary:not(.is-link):not(.is-plain):not(.is-disabled)) { background: var(--accent) !important; border-color: var(--accent) !important; box-shadow: 0 2px 7px rgba(22, 118, 107, .2) !important; }
.workflow-page :deep(.el-button--primary:not(.is-link):not(.is-plain):not(.is-disabled):hover) { background: #125f56 !important; border-color: #125f56 !important; box-shadow: 0 3px 9px rgba(22, 118, 107, .26) !important; }
.autonomy-strip { min-height: 84px; margin: 0 0 20px; padding: 14px 0; display: grid; grid-template-columns: 28px minmax(220px, 1fr) minmax(420px, 1.4fr); align-items: center; gap: 14px; border-top: 1px solid #bdd8d2; border-bottom: 1px solid #bdd8d2; color: #28564f; background: #eef7f5; }.autonomy-strip > .el-icon { font-size: 20px; }.autonomy-strip.needs-attention { border-color: #dfbaa9; color: #914b3d; background: #fff5f1; }.autonomy-copy { min-width: 0; display: grid; gap: 4px; }.autonomy-copy strong { font-size: 14px; }.autonomy-copy span { color: #607b76; font-size: 11px; line-height: 1.55; }.needs-attention .autonomy-copy span { color: #8a665c; }.autonomy-facts { margin: 0; display: grid; grid-template-columns: .9fr .65fr 1.45fr; gap: 12px; }.autonomy-facts div { min-width: 0; display: grid; gap: 3px; }.autonomy-facts dt { color: #79908b; font-size: 9px; }.autonomy-facts dd { margin: 0; overflow-wrap: anywhere; color: #365e58; font-size: 11px; font-weight: 650; }.needs-attention .autonomy-facts dd { color: #81584e; }
.cost-summary { min-height: 58px; margin: -8px 0 20px; padding: 10px 12px; display: grid; grid-template-columns: minmax(200px, 1fr) auto auto; align-items: center; gap: 16px; border-top: 1px solid #d5e1df; border-bottom: 1px solid #d5e1df; background: #f8fbfa; }.cost-summary-main { min-width: 0; display: flex; align-items: center; gap: 9px; }.cost-summary-main > .el-icon { flex: 0 0 auto; color: var(--accent); font-size: 19px; }.cost-summary-main > div { min-width: 0; display: grid; gap: 3px; }.cost-summary-main strong { font-size: 12px; }.cost-summary-main span { overflow-wrap: anywhere; color: #71817e; font-size: 10px; }.cost-summary-metrics { display: flex; align-items: center; gap: 16px; }.cost-summary-metrics > span, .cost-dialog-summary > span { display: grid; gap: 2px; }.cost-summary-metrics small, .cost-dialog-summary small { color: #85938f; font-size: 9px; }.cost-summary-metrics b { color: #3d5b55; font-size: 11px; white-space: nowrap; }.is-warning { color: #a05e2a !important; }.cost-dialog-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-bottom: 14px; border: 1px solid var(--line); background: var(--line); }.cost-dialog-summary > span { min-height: 64px; padding: 11px; align-content: center; background: #f8faf9; }.cost-dialog-summary strong { color: #365b54; font-size: 14px; overflow-wrap: anywhere; }.cost-table { margin-top: 14px; border: 1px solid var(--line); }.cost-model { min-width: 0; display: grid; gap: 2px; }.cost-model strong { font-size: 11px; }.cost-model small { overflow-wrap: anywhere; color: #78888d; font-size: 10px; }.empty-costs { margin: 18px 0; color: var(--muted); font-size: 12px; text-align: center; }
.autonomy-intervention { margin: 0 0 22px; padding: 18px 0 18px 18px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; border-left: 4px solid #b95747; border-top: 1px solid #e4c4b9; border-bottom: 1px solid #e4c4b9; background: #fff8f5; }.intervention-main { min-width: 0; }.intervention-main h2 { margin: 3px 0 7px; font-size: 18px; letter-spacing: 0; }.intervention-main p { margin: 0; color: #755b53; font-size: 12px; line-height: 1.65; }.intervention-main > small { display: block; margin-top: 7px; color: #916d61; font-size: 11px; }.intervention-main details { margin-top: 10px; color: #80665e; font-size: 11px; }.intervention-main summary { cursor: pointer; }.intervention-main ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 5px; }.intervention-actions { display: flex; align-items: center; gap: 8px; padding-right: 18px; }
.autonomy-artifact-note { min-height: 34px; display: inline-flex; align-items: center; gap: 7px; color: #53716b; font-size: 11px; }.autonomy-artifact-note.is-paused { color: #80613f; }.unattended-empty-note { max-width: 560px; color: #6a7d80; font-size: 12px; line-height: 1.6; text-align: center; }.unattended-next-state { align-items: center; color: #52736d; font-size: 12px; }.unattended-next-state.is-paused { color: #80613f; }
.workflow-page :deep(.el-button--primary.is-disabled:not(.is-link):not(.is-plain)) { background: #b9c9c7 !important; border-color: #b9c9c7 !important; box-shadow: none !important; color: #f7fafa !important; }
.director-failure-recovery { display: grid; gap: 10px; margin-top: 10px; padding: 12px; border: 1px solid #efc3b8; background: #fffaf8; }
.director-failure-recovery p, .director-failure-recovery small { margin: 0; color: #795b52; font-size: 11px; line-height: 1.6; }
.director-failure-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.director-failure-actions :deep(.el-button) { margin-left: 0; }
 .field-help { color: #71817f; font-size: 10px; line-height: 1.5; }
 .workflow-page :deep(.el-input__wrapper), .workflow-page :deep(.el-textarea__wrapper) { box-shadow: 0 0 0 1px #cfd9dc !important; }
.workflow-page :deep(.el-input__wrapper:hover), .workflow-page :deep(.el-textarea__wrapper:hover) { box-shadow: 0 0 0 1px #7faea8 !important; }
.image-config-panel { display: grid; gap: 12px; padding: 14px; border: 1px solid #cfe1dd; background: #f7fbfa; }
.image-config-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.image-config-heading > div, .image-config-block { display: grid; gap: 8px; min-width: 0; }
.image-config-heading strong { color: #2e625a; font-size: 13px; }
.image-config-heading span, .image-config-actions small { color: #718984; font-size: 11px; line-height: 1.5; }
.image-config-block { padding: 12px; border: 1px solid #dce8e5; background: #fff; }
.image-config-block-title, .image-config-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.image-config-block-title label, .image-config-grid label, .image-config-block > label { color: #51616a; font-size: 12px; font-weight: 650; }
.image-config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.image-config-grid > div { display: grid; gap: 5px; min-width: 0; }
.image-config-actions { align-items: flex-end; flex-wrap: wrap; }
.image-config-actions > span { display: flex; gap: 6px; }
.video-config-panel { display: grid; gap: 13px; padding: 14px; border: 1px solid #cddadf; background: #f8fafb; }
.video-config-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.video-config-heading > div:first-child { min-width: 0; display: grid; gap: 4px; }
.video-config-heading strong { color: #334f55; font-size: 13px; }
.video-config-heading span { color: #708187; font-size: 11px; line-height: 1.5; }
.video-config-heading-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; flex: 0 0 auto; }
.video-provider-receipt { display: grid; grid-template-columns: .7fr 1.25fr 1.25fr auto; align-items: center; gap: 10px; padding: 11px 12px; border: 1px solid #dce4e6; background: #fff; }
.video-provider-receipt > span { min-width: 0; display: grid; gap: 2px; }
.video-provider-receipt small { color: #87959a; font-size: 9px; }
.video-provider-receipt strong { overflow-wrap: anywhere; color: #40565c; font-size: 11px; }
.video-config-select { min-width: 0; }
.video-config-option { min-width: 0; display: grid; gap: 1px; line-height: 1.25; }
.video-config-option strong, .video-config-option small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-config-option small, .field-hint { color: #7b898e; font-size: 10px; line-height: 1.45; }
.project-routing-mode, .fixed-video-model { display: grid; gap: 8px; }
.project-routing-mode > label, .fixed-video-model > label { color: #51616a; font-size: 12px; font-weight: 650; }
.project-routing-mode p { margin: 0; color: #718187; font-size: 11px; line-height: 1.55; }
.project-model-receipt { min-width: 0; padding: 9px 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid #dce4e6; background: #fff; }
.project-model-receipt > span { min-width: 0; display: grid; gap: 3px; }
.project-model-receipt strong, .project-model-receipt small { overflow-wrap: anywhere; }
.project-model-receipt strong { color: #40565c; font-size: 11px; }.project-model-receipt small { color: #79898e; font-size: 9px; line-height: 1.45; }
.workflow-page :deep(.el-input__wrapper.is-focus), .workflow-page :deep(.el-textarea__wrapper.is-focus) { box-shadow: 0 0 0 2px rgba(22, 118, 107, .48) !important; }
.workflow-header { min-height: 68px; padding: 10px 28px; display: flex; align-items: center; justify-content: space-between; gap: 18px; position: sticky; top: 0; z-index: 30; background: #fff; border-bottom: 1px solid var(--line); }
.header-main, .header-actions, .project-identity, .artifact-title, .artifact-state-actions, .stage-toolbar, .stage-toolbar-actions, .run-status, .artifact-status, .approved-note, .preflight-title { display: flex; align-items: center; }
.header-main, .header-actions { gap: 10px; }.header-main { min-width: 0; }.header-actions { flex: 0 0 auto; }.project-identity { align-items: flex-start; flex-direction: column; min-width: 0; }.project-identity strong { max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; }.project-identity span { color: var(--muted); font-size: 12px; }
.run-status { min-height: 32px; gap: 6px; padding: 0 10px; border: 1px solid #cfd9dc; color: #566770; font-size: 12px; }.run-status.is-running, .run-status.is-waiting_provider { color: #176c62; border-color: #afd3cc; background: #eff8f6; }.run-status.is-failed { color: #a3483c; border-color: #e5bcb5; background: #fff5f3; }.run-status.is-completed { color: #2f7250; border-color: #b8d8c5; background: #f1f8f3; }
.run-aspect-notice { margin: 0 0 20px; padding: 12px 14px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 11px; color: #765327; border: 1px solid #e1c99e; background: #fffaf0; }.run-aspect-notice > .el-icon { color: #a66b20; }.run-aspect-notice > div { min-width: 0; display: grid; gap: 3px; }.run-aspect-notice strong { font-size: 12px; }.run-aspect-notice span { color: #866f50; font-size: 11px; line-height: 1.5; }
.macro-rail { max-width: 1180px; margin: 22px auto 0; padding: 0 24px; display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); }.macro-step { min-height: 62px; display: grid; grid-template-columns: 28px minmax(0,1fr) auto; align-items: center; gap: 9px; padding: 0 14px; border: 0; border-bottom: 2px solid #cbd4d8; background: transparent; color: #75828a; text-align: left; cursor: pointer; }.macro-step:disabled { cursor: default; }.macro-step > span { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 50%; background: #e2e7e9; font-size: 12px; }.macro-step strong { font-size: 14px; }.macro-step small { font-size: 11px; }.macro-step.active { color: #155f57; border-color: var(--accent); }.macro-step.active > span, .macro-step.done > span { color: #fff; background: var(--accent); }.macro-step.done { color: #397168; }.start-rail { margin-top: 20px; }
  .start-main { max-width: 1000px; margin: 0 auto; padding: 30px 24px 70px; }.start-source, .start-options, .preflight-result { padding: 26px 0; border-bottom: 1px solid var(--line); }.resume-card { min-height: 74px; margin-bottom: 12px; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 18px; border: 1px solid #b9d7d1; background: #f4faf8; }.resume-card > div { display: grid; gap: 4px; min-width: 0; }.resume-card strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }.resume-card small { color: var(--muted); font-size: 11px; }.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }.section-heading h1, .section-heading h2 { margin: 4px 0 0; letter-spacing: 0; }.section-heading h1 { font-size: 25px; }.section-heading h2 { font-size: 18px; }.section-kicker { color: var(--accent); font-size: 11px; font-weight: 800; }.novel-import-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; color: var(--muted); font-size: 13px; }.chapter-picker { display: grid; grid-template-columns: 100px minmax(0, 1fr); align-items: center; gap: 12px; margin-bottom: 18px; }.chapter-picker label, .option-block > label, .numeric-option label, .mode-control label, .settings-form > label, .settings-grid label { color: #51616a; font-size: 12px; font-weight: 650; }.option-block { display: grid; gap: 10px; }.option-block p { margin: 0; color: var(--muted); font-size: 13px; }.mode-selector { justify-self: start; }.option-grid { display: grid; grid-template-columns: minmax(0, 2fr) 140px 150px 170px; align-items: start; gap: 14px; margin-top: 24px; }.numeric-option { display: grid; gap: 8px; }.numeric-option :deep(.el-input-number) { width: 100%; }.aspect-choice, .director-mode-choice { margin-top: 22px; }.aspect-selector { justify-self: start; }.aspect-selector :deep(.el-radio-button__inner) { min-width: 118px; }
.preflight-result { display: grid; gap: 12px; color: #2d6f55; }.preflight-result.failed { color: #9b553f; }.preflight-title { gap: 8px; }.preflight-checks { display: flex; flex-wrap: wrap; gap: 7px; }.preflight-checks span { min-height: 28px; padding: 5px 8px; display: inline-flex; align-items: center; gap: 5px; background: #edf7f2; border: 1px solid #cce1d6; font-size: 12px; }.preflight-checks span.failed { background: #fff5ef; border-color: #e5c8b8; color: #9b553f; }.start-footer { padding-top: 26px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }.start-footer > div { display: grid; gap: 5px; }.start-footer span { color: var(--muted); font-size: 12px; }
.workflow-main { max-width: 1180px; margin: 0 auto; padding: 26px 24px 80px; }.run-overview { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 34px; padding: 4px 0 22px; }.current-stage-copy h1 { margin: 3px 0 6px; font-size: 25px; letter-spacing: 0; }.current-stage-copy p { margin: 0; color: var(--muted); font-size: 13px; }.run-metrics { display: grid; grid-template-columns: repeat(3, minmax(72px, auto)); gap: 18px; }.run-metrics div { display: grid; gap: 3px; }.run-metrics span { color: var(--muted); font-size: 11px; }.run-metrics strong { font-size: 16px; }.mode-control { display: grid; gap: 7px; }.substage-row { min-height: 44px; padding: 8px 0 18px; display: flex; align-items: center; gap: 8px; overflow-x: auto; scrollbar-width: none; }.substage-row::-webkit-scrollbar { display: none; }.substage-row button { min-height: 28px; padding: 4px 9px; display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; border: 1px solid #d5dde0; color: #718088; background: #fff; font: inherit; font-size: 11px; cursor: pointer; }.substage-row button:disabled { cursor: default; opacity: 1; }.substage-row button:not(:disabled):hover { border-color: #80bbb2; color: #14655c; }.substage-row button.active { border-color: #80bbb2; color: #14655c; background: var(--accent-soft); }.substage-row button.done { color: #347355; border-color: #b9d6c6; }.run-alert { margin-bottom: 18px; }.client-action-section { padding: 22px 0 28px; border-top: 1px solid var(--line); }.compact-heading { margin-bottom: 14px; }
  .stage-surface { padding: 24px 0 0; border-top: 1px solid var(--line); }.stage-toolbar { justify-content: space-between; gap: 18px; margin-bottom: 16px; }.stage-toolbar > div:first-child { display: flex; align-items: baseline; gap: 10px; }.stage-toolbar > div:first-child span { color: var(--muted); font-size: 12px; }.stage-toolbar-actions { gap: 8px; flex-wrap: wrap; justify-content: flex-end; }.concurrency-control { min-height: 32px; display: flex; align-items: center; gap: 7px; padding-left: 8px; border-left: 1px solid var(--line); }.concurrency-control label { color: var(--muted); font-size: 11px; white-space: nowrap; }.concurrency-control :deep(.el-input-number) { width: 92px; }.empty-stage { min-height: 280px; display: grid; place-items: center; align-content: center; gap: 12px; color: #77858d; border: 1px dashed #bdc9ce; background: #fafbfb; }.empty-stage > .el-icon { font-size: 38px; }.artifact-list { display: grid; gap: 14px; }.artifact-item { padding: 18px; scroll-margin-top: 84px; background: #fff; border: 1px solid var(--line); border-radius: 6px; }.artifact-item.is-focused { border-color: #76b7ad; box-shadow: 0 0 0 2px rgba(22, 118, 107, .08); }.artifact-item.excluded { background: #f7f8f8; opacity: .82; }.artifact-header { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }.artifact-title, .artifact-state-actions { gap: 9px; min-width: 0; }.artifact-title > span { color: var(--accent); font-weight: 800; }.artifact-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.artifact-title small { color: #8a959b; font-size: 11px; }.artifact-status { min-height: 26px; padding: 3px 7px; gap: 4px; border: 1px solid #d3dcdf; color: #6d7b83; font-size: 11px; }.artifact-status.is-approved { color: #2e7454; border-color: #b9d7c5; background: #f1f8f3; }.artifact-status.is-rejected, .artifact-status.is-failed, .artifact-status.is-invalidated { color: #a04c3e; border-color: #e4c1ba; background: #fff5f3; }.artifact-status.is-reviewing { color: #8c6a2f; border-color: #dfcca6; background: #fffaf0; }.artifact-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 16px; padding: 14px 0; border-top: 1px solid #edf0f1; }.artifact-form > :deep(.assist-field):last-child:nth-child(odd), .stage-script .artifact-form > :deep(.assist-field), .artifact-form > :deep(.assist-field:has(textarea[rows="18"])) { grid-column: 1 / -1; }.numeric-field { display: grid; align-content: start; gap: 8px; }.numeric-field label { color: #34434e; font-size: 13px; font-weight: 650; }.artifact-media { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px; padding: 10px 0 16px; }.artifact-media img, .artifact-media video { width: 100%; max-height: 480px; object-fit: contain; background: #111; }.artifact-media img { background: #eef1f2; }.artifact-media a, .export-result a { color: var(--accent); display: inline-flex; align-items: center; gap: 5px; text-decoration: none; white-space: nowrap; }.excluded-message { min-height: 76px; display: flex; align-items: center; gap: 9px; color: #65747c; }.reference-editor { display: grid; grid-template-columns: 1.2fr 1fr .8fr; gap: 12px; padding: 14px 0; }.autolink-panel { grid-column: 1 / -1; display: grid; gap: 9px; padding: 12px 13px; color: #355f58; border: 1px solid #c9ded9; background: #f5faf9; }.autolink-panel.has-warning { color: #76563a; border-color: #e2cfb8; background: #fffaf3; }.autolink-heading, .autolink-heading > div { display: flex; align-items: center; gap: 8px; }.autolink-heading { justify-content: space-between; }.autolink-heading > div > span { display: grid; gap: 2px; }.autolink-heading strong { font-size: 12px; }.autolink-heading small, .autolink-panel p { color: #708680; font-size: 10px; line-height: 1.5; }.autolink-panel.has-warning .autolink-heading small, .autolink-panel.has-warning p { color: #8b735d; }.autolink-panel p { margin: 0; }.autolink-items { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }.autolink-item { min-width: 0; padding: 7px 8px; display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 6px; align-items: flex-start; border: 1px solid #d9e7e3; background: #fff; }.autolink-item.is-warning { border-color: #eadcca; background: #fffdf9; }.autolink-item > span { min-width: 0; display: grid; gap: 2px; }.autolink-item strong { font-size: 10px; }.autolink-item small { color: #788b86; font-size: 9px; line-height: 1.45; overflow-wrap: anywhere; }.autolink-item.is-warning > .el-icon { color: #a16a32; }.autolink-item.is-success > .el-icon { color: #2f7a60; }.reference-bucket { min-width: 0; padding: 12px; border: 1px solid #dfe5e7; background: #fafbfb; }.bucket-title { display: flex; justify-content: space-between; margin-bottom: 10px; color: #52636b; font-size: 12px; }.reference-list { display: grid; gap: 6px; margin-bottom: 9px; }.reference-row { min-height: 42px; display: grid; grid-template-columns: 26px minmax(0,1fr) 28px 28px; align-items: center; gap: 6px; padding: 4px 5px; background: #eef3f2; }.reference-row > span { min-width: 0; display: grid; }.reference-row strong, .reference-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.reference-row strong { font-size: 11px; }.reference-row small { color: #849198; font-size: 9px; }.reference-row a { color: var(--accent); display: grid; place-items: center; }.bucket-empty { color: #919ba0; font-size: 11px; }.reference-add-actions { display: flex; flex-wrap: wrap; gap: 6px; }.reference-add-actions :deep(.el-button) { margin-left: 0; }.review-evidence { margin-top: 14px; padding: 10px 12px; border-top: 1px solid #e6ebed; background: #f8faf9; }.review-evidence summary { cursor: pointer; display: flex; align-items: center; gap: 6px; color: #4f626a; font-size: 12px; }.review-evidence p { margin: 10px 0 0; color: #56666e; font-size: 12px; line-height: 1.6; }.score-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }.score-row span { padding: 3px 6px; border: 1px solid #d7dfdc; font-size: 10px; }.artifact-actions { min-height: 50px; margin-top: 14px; padding-top: 14px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-top: 1px solid #e7ebed; }.edit-actions, .review-actions { display: flex; align-items: center; gap: 8px; }.review-actions { min-width: min(100%, 510px); }.review-actions :deep(.el-input) { flex: 1; }.approved-note { gap: 5px; color: #347556; font-size: 12px; }.approved-note :deep(.el-button) { margin-left: 6px; }.unresolved-panel { margin-top: 16px; padding: 13px 15px; display: flex; flex-wrap: wrap; gap: 8px 14px; border: 1px solid #e1c5b8; background: #fff8f4; color: #98513d; }.unresolved-panel div { flex-basis: 100%; display: flex; align-items: center; gap: 6px; }.unresolved-panel span { font-size: 11px; }.stage-footer { margin-top: 22px; padding: 20px 0 0; display: flex; align-items: center; justify-content: space-between; gap: 20px; border-top: 1px solid var(--line); }.stage-footer-copy { display: grid; gap: 4px; }.stage-footer-copy span { color: var(--muted); font-size: 12px; }.stage-next-actions { display: flex; gap: 9px; }
.reference-lock { color: #52736a; }
.retry-controls { width: min(100%, 780px); display: grid; grid-template-columns: minmax(180px, 1fr) auto auto; gap: 8px; margin-top: 8px; }
.failure-details { margin: 5px 0 9px; color: #7f5149; font-size: 11px; }.failure-details summary { cursor: pointer; }.failure-details code { display: block; margin-top: 6px; overflow-wrap: anywhere; line-height: 1.5; }
.local-recovery-note { min-height: 44px; margin-bottom: 14px; padding: 9px 12px; display: flex; align-items: flex-start; gap: 8px; color: #356c5c; border: 1px solid #c8ded4; background: #f3faf6; font-size: 11px; line-height: 1.55; }.local-recovery-note > .el-icon { margin-top: 2px; flex: 0 0 auto; }.local-recovery-note span { display: grid; gap: 2px; }
  .settings-form { display: grid; gap: 14px; }.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }.settings-grid > div { display: grid; gap: 6px; }.settings-grid :deep(.el-input-number), .settings-grid :deep(.el-select) { width: 100%; }.run-budget-setting small, .run-aspect-lock small { color: #78888d; font-size: 10px; line-height: 1.45; }.run-aspect-lock > span { min-height: 32px; padding: 5px 9px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid #d8e1e3; background: #f7f9f9; }.run-aspect-lock strong { color: #40555c; font-size: 12px; }.drawer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }.run-history-list, .revision-list { display: grid; gap: 8px; max-height: 62vh; overflow: auto; }.run-history-list > button { min-height: 60px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid #dfe5e7; background: #fff; cursor: pointer; text-align: left; }.run-history-list > button:hover { border-color: #76b7ad; }.run-history-list span { display: grid; gap: 4px; }.run-history-list span:last-child { display: flex; gap: 6px; }.run-history-list small, .run-history-list em { color: #78868d; font-size: 11px; font-style: normal; }.run-history-list em { padding: 3px 6px; background: #eef3f2; }.revision-list article { padding: 12px; border: 1px solid #dfe5e7; }.revision-list article > span, .revision-list article > strong, .revision-list article > small { margin-right: 10px; font-size: 12px; }.revision-list pre { max-height: 260px; overflow: auto; white-space: pre-wrap; color: #526169; background: #f5f7f7; padding: 10px; }.export-result { display: grid; justify-items: center; gap: 10px; text-align: center; }.export-result > .el-icon { font-size: 40px; color: var(--accent); }.export-result p { color: var(--muted); line-height: 1.6; }
  .media-picker-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; color: #586970; font-size: 12px; }.media-picker-toolbar > div { display: flex; align-items: center; gap: 8px; }.media-picker-toolbar > div:last-child { justify-content: flex-end; }.media-picker-toolbar :deep(.el-input) { width: 210px; }.media-picker-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: 64vh; overflow: auto; }.media-picker-item { min-width: 0; min-height: 80px; padding: 8px; display: grid; grid-template-columns: 96px minmax(0, 1fr) 24px; align-items: center; gap: 10px; border: 1px solid #dce4e6; background: #fff; color: #31424a; text-align: left; cursor: pointer; }.media-picker-item:not(:disabled):hover, .media-picker-item:not(:disabled):focus-visible { border-color: #69aaa0; outline: 2px solid rgba(22, 118, 107, .16); }.media-picker-item:disabled { cursor: wait; }.media-picker-item.is-unavailable { color: #7d898e; border-color: #e1e5e6; background: #f5f6f6; cursor: not-allowed; }.media-picker-item.is-unavailable .media-picker-thumb { opacity: .55; }.media-picker-thumb { width: 96px; aspect-ratio: 16 / 9; display: grid; place-items: center; overflow: hidden; background: #e9edef; }.media-picker-thumb img, .media-picker-thumb video { width: 100%; height: 100%; object-fit: cover; }.media-picker-copy { min-width: 0; display: grid; gap: 5px; }.media-picker-copy strong, .media-picker-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.media-picker-copy strong { font-size: 12px; }.media-picker-copy small { color: #7c8a91; font-size: 10px; }.media-picker-cross-project { color: #9a5c25 !important; }.media-picker-status { color: #2f7063 !important; }.media-picker-item.is-unavailable .media-picker-status { color: #a05548 !important; }
.routing-promise { margin-top: 22px; padding: 13px 15px; display: flex; align-items: flex-start; gap: 10px; border: 1px solid #cfe1dd; background: #f7fbfa; color: #315b55; }.routing-promise > .el-icon { flex: 0 0 auto; margin-top: 2px; color: var(--accent); }.routing-promise > div { display: grid; gap: 3px; }.routing-promise strong { font-size: 12px; }.routing-promise span { color: #68817d; font-size: 11px; line-height: 1.55; }
.shot-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin: 0 0 16px; }.shot-chip { min-width: 0; padding: 10px 11px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 7px; text-align: left; border: 1px solid #d9e2e3; background: #fff; color: #687980; }.shot-chip.active { border-color: #75b7ad; background: #f3faf8; }.shot-chip.approved { color: #376f59; }.shot-chip span { color: var(--accent); font-size: 10px; font-weight: 800; }.shot-chip strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }.shot-chip small { grid-column: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #87969a; font-size: 10px; }.provider-status-spacing { margin: 0 0 16px; }.artifact-route-card { margin: 0 0 14px; }.skipped-previs { min-height: 42px; padding: 9px 12px; display: flex; align-items: center; gap: 8px; color: #3b7460; border: 1px solid #c8dfd1; background: #f4faf6; font-size: 11px; }.skipped-previs strong { margin-right: 5px; }.workflow-activity { margin-top: 24px; }.auto-routing-setting { min-height: 44px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid #cfe1dd; background: #f7fbfa; }.auto-routing-setting > div { display: grid; gap: 3px; }.auto-routing-setting strong { color: #2e625a; font-size: 12px; }.auto-routing-setting span { color: #718984; font-size: 11px; }.expert-settings { padding: 10px 12px; border: 1px solid #dfe6e7; background: #fafcfc; }.expert-settings summary { cursor: pointer; color: #53706c; font-size: 12px; }.expert-settings p { margin: 8px 0 12px; color: #7b898e; font-size: 11px; line-height: 1.55; }.expert-settings > label { display: block; margin: 9px 0 6px; }
.shot-chip { grid-template-rows: auto auto auto; }
.shot-chip.skipped { color: #7d8589; border-style: dashed; background: #f6f7f7; }
.shot-chip em { grid-column: 1 / -1; color: #71847f; font-size: 9px; font-style: normal; }
.shot-chip.skipped em { color: #9a5b4f; }
.shot-operations { margin: -4px 0 16px; padding: 12px 14px; display: grid; grid-template-columns: minmax(220px, 1fr) auto; align-items: center; gap: 14px; border: 1px solid #d8e2e1; background: #fafcfc; }
.shot-operation-copy { min-width: 0; display: grid; gap: 3px; }
.shot-operation-copy strong { color: #294c48; font-size: 12px; }
.shot-operation-copy small { color: #71817f; font-size: 10px; line-height: 1.5; }
.shot-operation-actions { display: flex; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
.shot-operation-actions :deep(.el-button) { margin-left: 0; }
@media (max-width: 840px) {
  .workflow-header { padding: 10px 14px; }.project-identity strong { max-width: 35vw; }.run-status { display: none; }.macro-rail { overflow-x: auto; grid-template-columns: repeat(5, 150px); padding: 0 12px; scrollbar-width: none; }.macro-rail::-webkit-scrollbar { display: none; }.start-main, .workflow-main { padding-left: 14px; padding-right: 14px; }.run-aspect-notice { grid-template-columns: auto minmax(0, 1fr); align-items: flex-start; }.run-aspect-notice :deep(.el-button) { grid-column: 1 / -1; width: 100%; margin-left: 0; }.option-grid, .run-overview, .input-review-grid { grid-template-columns: 1fr; }.run-overview { gap: 18px; }.run-metrics { grid-template-columns: repeat(3, 1fr); }.mode-control { justify-self: start; }.artifact-form, .reference-editor { grid-template-columns: 1fr; }.artifact-form > :deep(.assist-field) { grid-column: 1; }.artifact-actions, .stage-footer { align-items: flex-start; flex-direction: column; }.review-actions, .stage-next-actions { width: 100%; }.stage-next-actions :deep(.el-button) { flex: 1; }.artifact-media { grid-template-columns: 1fr; }.shot-operations { grid-template-columns: minmax(0, 1fr); align-items: flex-start; }.shot-operation-actions { width: 100%; justify-content: flex-start; }
}
@media (max-width: 560px) {
  .macro-rail { grid-template-columns: repeat(5, minmax(0, 1fr)); overflow: visible; padding: 0 8px; }
  .macro-step { min-width: 0; min-height: 72px; grid-template-columns: 1fr; grid-template-rows: 22px auto auto; justify-items: center; align-content: center; gap: 2px; padding: 6px 2px; text-align: center; }
  .macro-step > span { width: 22px; height: 22px; font-size: 10px; }
  .macro-step strong { max-width: 100%; font-size: 10px; line-height: 1.25; overflow-wrap: anywhere; }
  .macro-step small { font-size: 9px; line-height: 1.2; }
  .workflow-header { gap: 8px; }.header-actions { gap: 6px; }.header-actions > :deep(.el-button:not(.is-circle)) { width: 32px; min-width: 32px; padding: 0; }.header-actions > :deep(.el-button:not(.is-circle)) span { display: none; }.resume-card, .section-heading, .start-footer, .stage-toolbar { align-items: flex-start; flex-direction: column; }.resume-card :deep(.el-button) { width: 100%; }.section-heading h1 { font-size: 21px; }.mode-selector { display: grid; grid-template-columns: 1fr; width: 100%; }.mode-selector :deep(.el-radio-button__inner) { width: 100%; }.start-footer :deep(.el-button) { width: 100%; }.stage-toolbar-actions { width: 100%; flex-wrap: wrap; justify-content: flex-start; }.concurrency-control { width: 100%; padding: 7px 0 0; border-left: 0; border-top: 1px solid var(--line); }.artifact-list, .artifact-item, .artifact-actions, .edit-actions, .review-actions { min-width: 0; }.artifact-item { padding: 13px; }.artifact-header { align-items: flex-start; }.artifact-title { align-items: flex-start; flex-wrap: wrap; }.artifact-title strong { flex-basis: calc(100% - 38px); white-space: normal; }.edit-actions, .review-actions { width: 100%; align-items: stretch; flex-wrap: wrap; }.edit-actions :deep(.el-button) { flex: 1 1 100%; width: 100%; min-width: 0; margin-left: 0; }.review-actions :deep(.el-input) { flex-basis: 100%; }.review-actions :deep(.el-button) { flex: 1; min-width: 0; margin-left: 0; }.approved-note { width: 100%; flex-wrap: wrap; }.approved-note :deep(.el-button) { margin-left: 0; }.stage-next-actions { flex-direction: column; }.settings-grid, .retry-controls, .media-picker-list, .image-config-grid, .autolink-items { grid-template-columns: 1fr; }.autolink-heading { align-items: flex-start; flex-direction: column; }.image-config-heading, .image-config-actions, .video-config-heading { align-items: flex-start; flex-direction: column; }.image-config-actions > span { width: 100%; }.image-config-actions > span :deep(.el-button) { flex: 1; }.video-config-heading-actions { width: 100%; justify-content: flex-start; }.video-provider-receipt { grid-template-columns: 1fr; }.video-provider-receipt :deep(.el-button) { width: 100%; margin-left: 0; }.project-routing-mode :deep(.el-radio-group) { width: 100%; display: grid; grid-template-columns: 1fr; }.project-routing-mode :deep(.el-radio-button__inner) { width: 100%; }.project-model-receipt { align-items: flex-start; flex-direction: column; }.media-picker-item { grid-template-columns: 80px minmax(0, 1fr) 20px; }.media-picker-thumb { width: 80px; }.routing-promise { padding: 11px 12px; }.shot-strip { grid-template-columns: 1fr; }.shot-chip small { white-space: normal; }.auto-routing-setting { align-items: flex-start; }.shot-operation-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }.shot-operation-actions :deep(.el-button) { width: 100%; min-width: 0; }.run-input-access { align-items: flex-start; flex-direction: column; }.run-input-access :deep(.el-button) { width: 100%; margin-left: 0; }.history-view-banner { align-items: flex-start; }.history-view-banner :deep(.el-button) { margin-left: 0; }.input-review-notice { align-items: flex-start; flex-direction: column; }.input-review-notice :deep(.el-button) { margin-left: 0; }
}
  .final-edit-status { margin: 0 0 16px; padding: 13px 15px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border: 1px solid #dfe6e7; background: #fafcfc; }.final-edit-status.is-actionable { border-color: #c9ded9; background: #f5fbf9; }.final-edit-status-copy { min-width: 0; display: grid; gap: 4px; }.final-edit-status-copy > div { display: flex; align-items: center; gap: 7px; color: #355d58; }.final-edit-status-copy > div small { color: #768982; font-size: 10px; }.final-edit-status-copy > span, .final-edit-status-copy > small { color: #687a7e; font-size: 11px; line-height: 1.5; }.final-history-note { min-width: 0; display: flex; align-items: center; gap: 7px; color: #7a6a62; font-size: 12px; }.final-sidecars { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 0 0 14px; }.final-sidecars a { color: var(--accent); display: inline-flex; align-items: center; gap: 5px; text-decoration: none; font-size: 12px; }
.narration-editor { display: grid; gap: 16px; padding: 14px 0; border-top: 1px solid #edf0f1; }.narration-banner { display: flex; align-items: flex-start; gap: 9px; padding: 11px 12px; border: 1px solid #cfe1dd; background: #f5fbf9; color: #356b61; }.narration-banner > .el-icon { margin-top: 2px; color: var(--accent); }.narration-banner > div { display: grid; gap: 3px; }.narration-banner span { color: #6d817e; font-size: 11px; line-height: 1.5; }.narration-settings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }.narration-expert-settings { padding: 10px 12px; border: 1px solid #dfe6e7; background: #fafcfc; }.narration-expert-settings summary { cursor: pointer; color: #53706c; font-size: 12px; }.narration-expert-settings .narration-settings-grid { margin-top: 12px; }.narration-segments { display: grid; gap: 10px; }.narration-segments-heading { display: flex; align-items: baseline; gap: 9px; }.narration-segments-heading small { color: var(--muted); font-size: 11px; }.narration-segment { padding: 11px 12px; border: 1px solid #dfe6e7; background: #fff; }.narration-segment-heading { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 8px; color: #40545b; font-size: 12px; }.narration-segment-heading small { color: #87959a; font-size: 10px; }
@media (max-width: 840px) { .autonomy-strip { grid-template-columns: 24px minmax(0, 1fr); }.autonomy-facts { grid-column: 1 / -1; grid-template-columns: 1fr 1fr; }.autonomy-facts div:last-child { grid-column: 1 / -1; }.autonomy-intervention { grid-template-columns: 1fr; padding-right: 14px; }.intervention-actions { padding-right: 0; flex-wrap: wrap; }.intervention-actions :deep(.el-button) { flex: 1; margin-left: 0; }.cost-summary { grid-template-columns: 1fr auto; }.cost-summary-metrics { grid-column: 1 / -1; flex-wrap: wrap; }.cost-dialog-summary { grid-template-columns: 1fr 1fr; }.final-edit-status { align-items: flex-start; flex-direction: column; } .final-edit-status :deep(.el-button) { width: 100%; margin-left: 0; } .narration-settings-grid { grid-template-columns: 1fr; } .narration-segments-heading { align-items: flex-start; flex-direction: column; gap: 3px; } .final-sidecars { align-items: flex-start; flex-direction: column; } }
@media (max-width: 700px) { .media-picker-toolbar, .media-picker-toolbar > div { align-items: stretch; flex-direction: column; }.media-picker-toolbar > div:last-child { justify-content: stretch; }.media-picker-toolbar :deep(.el-input) { width: 100%; }.media-picker-toolbar > div:last-child :deep(.el-button) { width: 100%; margin-left: 0; } }
@media (max-width: 560px) { .cost-summary { grid-template-columns: 1fr; }.cost-summary > :deep(.el-button) { justify-self: start; margin-left: 0; }.cost-summary-metrics { grid-column: 1; display: grid; grid-template-columns: 1fr 1fr; width: 100%; }.cost-dialog-summary { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .start-assets { padding: 13px; }.start-assets-actions { display: grid; grid-template-columns: 1fr; }.start-assets-actions :deep(.el-button) { width: 100%; }.template-slot-hints { display: grid; grid-template-columns: 1fr; } }
</style>

<style scoped>
.user-guidance-card { display:grid; grid-template-columns:34px minmax(0,1fr) minmax(190px,.55fr); align-items:center; gap:12px; margin:0 0 16px; padding:13px 15px; border:1px solid #cfdfe1; background:#f7fbfb; color:#40565c; }
.user-guidance-card.is-warning { border-color:#e4cfb5; background:#fffaf3; color:#76583b; }.user-guidance-card.is-success { border-color:#bedcca; background:#f3faf5; color:#397253; }
.user-guidance-icon { width:30px; height:30px; display:grid; place-items:center; border-radius:50%; background:rgba(72,142,133,.12); color:var(--accent); }.user-guidance-copy { min-width:0; display:grid; gap:3px; }.user-guidance-copy strong { font-size:13px; }.user-guidance-copy p { margin:0; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }.user-guidance-copy small { color:#7b898e; font-size:10px; }.user-guidance-next { min-width:0; padding-left:14px; border-left:1px solid rgba(120,140,145,.25); display:grid; gap:3px; }.user-guidance-next span { color:#869398; font-size:10px; }.user-guidance-next b { font-size:12px; overflow-wrap:anywhere; }
@media (max-width:840px) { .user-guidance-card { grid-template-columns:34px minmax(0,1fr); }.user-guidance-next { grid-column:2; padding-left:0; border-left:0; border-top:1px solid rgba(120,140,145,.25); padding-top:8px; } }
</style>
