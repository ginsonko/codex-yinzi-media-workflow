<template>
  <div class="film-list">
    <header class="header">
      <div class="header-inner">
        <button class="brand" type="button" aria-label="返回项目工作台" @click="router.push('/')">
          <span class="brand-mark"><el-icon><VideoCamera /></el-icon></span>
          <span class="brand-copy">
            <strong>银子AI视频工作流</strong>
            <small>Yinzi AI Video Studio</small>
          </span>
        </button>

        <nav class="primary-nav" aria-label="主导航">
          <button type="button" class="nav-link is-active" @click="scrollToProjects">项目</button>
          <button type="button" class="nav-link" @click="router.push('/media-library')">素材库</button>
          <button type="button" class="nav-link" @click="router.push('/director')">3D 导演台</button>
          <button type="button" class="nav-link" @click="router.push('/help')">使用指南</button>
          <button type="button" class="nav-link" @click="router.push('/advanced-settings')">高级设置</button>
          <button type="button" class="nav-link" @click="router.push('/codex-console')">Codex 编排台</button>
          <el-dropdown trigger="click" @command="openResourceCenter">
            <button type="button" class="nav-link resource-trigger">
              资源中心<el-icon><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="characters" :icon="User">角色素材</el-dropdown-item>
                <el-dropdown-item command="scenes" :icon="PictureFilled">场景素材</el-dropdown-item>
                <el-dropdown-item command="props" :icon="Box">道具素材</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </nav>

        <div class="header-actions">
          <a v-if="distributionProfile?.smart_routing_entry" class="yinzi-link" href="https://www.yinziapi.top" target="_blank" rel="noopener noreferrer">
            银子API<el-icon><TopRight /></el-icon>
          </a>
          <el-tooltip :content="isDark ? '切换到浅色模式' : '切换到暗色模式'">
            <el-button class="icon-action" circle :aria-label="isDark ? '切换到浅色模式' : '切换到暗色模式'" @click="toggleTheme">
              <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
            </el-button>
          </el-tooltip>
          <el-button :class="['config-status-button', { ready: configReadiness.isReady }]" @click="openConfigDialog()">
            <el-icon><CircleCheckFilled v-if="configReadiness.isReady" /><WarningFilled v-else /></el-icon>
            {{ configLoading ? '检查配置' : configReadiness.isReady ? '配置完整' : `缺 ${configReadiness.missing.length} 项配置` }}
          </el-button>
          <el-button type="primary" class="btn-new" @click="goNewProject">
            <el-icon><Plus /></el-icon>新建项目
          </el-button>
        </div>
        <input ref="importFileInput" type="file" accept=".zip" hidden @change="onImportFile" />
      </div>
    </header>

    <main class="main">
      <section class="start-panel" aria-labelledby="workspace-title">
        <div class="start-copy">
          <p class="section-kicker">从故事到成片</p>
          <h1 id="workspace-title">制作工作台</h1>
          <p class="start-description">人工模式可逐项打磨；AI 审批会自己打回、修改和复审；全自动模式从故事一路运行到旁白、字幕与最终成片。</p>
          <div class="primary-actions">
            <el-button type="primary" size="large" @click="goNewProject">
              <el-icon><Plus /></el-icon>开始真实制作
            </el-button>
            <el-button size="large" @click="router.push('/guided-demo')">
              <el-icon><VideoPlay /></el-icon>零成本模拟
            </el-button>
            <el-button size="large" :loading="importing" @click="triggerImport">
              <el-icon><Upload /></el-icon>导入项目
            </el-button>
          </div>
          <div class="template-launcher" aria-label="开始制作时选择模板">
            <div class="template-launcher-copy"><strong>制作模板</strong><span>先选方向，进入制作页后再补素材</span></div>
            <el-select v-model="homeTemplateId" class="template-launcher-select" :loading="templatesLoading" aria-label="选择制作模板" @change="persistTemplateChoice" @clear="resetTemplateChoice">
              <el-option :value="'free'" label="自由创作"><span class="template-option"><strong>自由创作</strong><small>不套固定模板，AI 根据你的故事规划</small></span></el-option>
              <el-option v-for="item in templates" :key="item.id" :value="item.id" :label="item.name"><span class="template-option"><strong>{{ item.name }}</strong><small>{{ templateInputSummary(item) }}</small></span></el-option>
            </el-select>
            <small v-if="selectedHomeTemplate" class="template-launcher-hint">{{ selectedHomeTemplate.description || selectedHomeTemplate.guardrails?.[0] || '进入后可继续添加文件、图片或视频素材。' }}</small>
            <small v-else class="template-launcher-hint">自由创作会根据你的故事自动安排剧本、资产和镜头。</small>
          </div>
          <div class="mode-summary" aria-label="三种制作模式">
            <article v-for="mode in modeHighlights" :key="mode.key">
              <strong>{{ mode.label }}</strong>
              <small>{{ mode.description }}</small>
            </article>
          </div>
          <ol class="workflow-strip" aria-label="制作流程">
            <li v-for="(stage, index) in workflowStages" :key="stage">
              <span>{{ index + 1 }}</span>{{ stage }}
            </li>
          </ol>
        </div>

        <aside class="readiness-panel" aria-label="模型配置准备度">
          <div class="readiness-heading">
            <div>
              <span>真实制作准备度</span>
              <strong>{{ configReadiness.readyCount }}/{{ configReadiness.total }}</strong>
            </div>
            <el-progress
              type="circle"
              :percentage="configProgress"
              :width="54"
              :stroke-width="6"
              :show-text="false"
              :status="configReadiness.isReady ? 'success' : undefined"
            />
          </div>
          <div v-if="configError" class="config-load-error" role="status">
            <span>暂时无法读取配置，真实新建会保持锁定。</span>
            <el-button link type="primary" @click="loadConfigReadiness">重试</el-button>
          </div>
          <div v-else v-loading="configLoading" class="readiness-list">
            <button
              v-for="item in configReadiness.required"
              :key="item.type"
              type="button"
              :class="['readiness-item', { ready: item.ready }]"
              @click="openConfigDialog(item.type)"
            >
              <el-icon><CircleCheckFilled v-if="item.ready" /><WarningFilled v-else /></el-icon>
              <span><strong>{{ item.label }}</strong><small>{{ item.reason }}</small></span>
              <el-icon class="readiness-arrow"><ArrowRight /></el-icon>
            </button>
          </div>
          <p class="readiness-note">“已配置”仅检查已保存的默认配置，不会自动测试 Key，也不会产生模型费用。</p>
          <div class="readiness-actions">
            <el-button type="primary" plain @click="openConfigDialog(distributionProfile?.smart_routing_entry ? 'yinzi' : 'laoli')">{{ distributionProfile?.smart_routing_entry ? '一键配置银子API' : '配置文本、图片和视频' }}</el-button>
            <el-button text @click="router.push('/help#configuration')">查看配置方法</el-button>
          </div>
        </aside>
      </section>

      <section id="projects" class="projects-section" aria-labelledby="projects-title">
        <div class="section-toolbar">
          <div>
            <p class="section-kicker">本地项目</p>
            <h2 id="projects-title">{{ archiveState === 'archived' ? '已归档项目' : '正在制作' }}</h2>
          </div>
          <div class="project-filters">
            <el-radio-group v-model="archiveState" size="large" @change="changeArchiveState">
              <el-radio-button value="active">进行中</el-radio-button>
              <el-radio-button value="archived">已归档</el-radio-button>
            </el-radio-group>
            <el-input v-model="projectKeyword" class="project-search" clearable placeholder="搜索项目名称或描述" @input="onProjectSearch">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-tooltip content="刷新项目">
              <el-button circle :icon="Refresh" aria-label="刷新项目" :loading="loading" @click="loadList" />
            </el-tooltip>
          </div>
        </div>

        <div v-if="listError" class="list-error" role="status">
          <span>{{ listError }}</span>
          <el-button link type="primary" @click="loadList">重新加载</el-button>
        </div>

        <div v-loading="loading" class="projects-wrap" aria-live="polite">
          <div v-if="dramas.length" class="project-grid">
            <article
              v-for="d in dramas"
              :key="d.id"
              :class="['project-card', { 'has-final': projectFinal(d) }]"
              @click="openProject(d.id)"
            >
              <div class="project-card-menu" @click.stop>
                <el-dropdown trigger="click" @command="(command) => handleProjectCommand(command, d)">
                  <el-button circle :icon="MoreFilled" aria-label="项目更多操作" />
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="director" :icon="Camera">打开 3D 导演台</el-dropdown-item>
                      <el-dropdown-item command="media" :icon="Files">查看项目素材</el-dropdown-item>
                      <el-dropdown-item command="export" :icon="Download">导出项目</el-dropdown-item>
                      <el-dropdown-item command="edit" :icon="EditPen">编辑资料</el-dropdown-item>
                      <el-dropdown-item divided :command="archiveState === 'archived' ? 'restore' : 'archive'" :icon="archiveState === 'archived' ? RefreshLeft : Folder">
                        {{ archiveState === 'archived' ? '恢复项目' : '归档项目' }}
                      </el-dropdown-item>
                      <el-dropdown-item command="delete" :icon="Delete">删除项目</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>

              <button
                v-if="projectFinal(d)"
                type="button"
                class="project-final-preview"
                :class="{ 'is-unavailable': projectFinal(d).available === false }"
                :aria-label="projectFinal(d).available === false ? '成片文件暂不可用' : `播放${d.title || '项目'}成片`"
                @click.stop="openFinalPreview(d)"
              >
                <video v-if="projectFinalUrl(d)" :src="`${projectFinalUrl(d)}#t=0.1`" muted playsinline preload="metadata" />
                <span v-else class="project-final-placeholder"><VideoPlay /></span>
                <span class="project-final-shade"></span>
                <span class="project-final-state">
                  <el-icon><CircleCheckFilled /></el-icon>
                  {{ projectFinal(d).available === false ? '成片已批准 · 文件待恢复' : '成片已完成' }}
                </span>
                <span v-if="projectFinal(d).available !== false" class="project-final-play"><VideoPlay /></span>
                <span class="project-final-meta">{{ formatDuration(projectFinal(d).duration_seconds) || formatDate(projectFinal(d).approved_at || projectFinal(d).updated_at) }}</span>
              </button>
              <div v-else class="project-progress-cover">
                <el-icon><MagicStick /></el-icon>
                <span>{{ formatStatus(d.status) }}</span>
              </div>

              <div class="project-card-body">
                <h3 class="project-title">{{ d.title || '未命名项目' }}</h3>
                <p class="project-desc">{{ d.description || '还没有故事简介' }}</p>
                <div class="project-badges">
                  <span v-if="d.archived_at" class="badge badge-archived"><el-icon><Folder /></el-icon>已归档</span>
                  <span v-if="projectFinal(d)" class="badge badge-final"><el-icon><CircleCheckFilled /></el-icon>成片已完成</span>
                  <span v-else class="badge badge-status" :class="'badge-status--' + (d.status || 'draft')">{{ formatStatus(d.status) }}</span>
                  <span v-if="d.episodes?.length" class="badge badge-episodes">{{ d.episodes.length }} 集</span>
                  <span v-if="totalStoryboards(d) > 0" class="badge badge-storyboards">{{ totalStoryboards(d) }} 分镜</span>
                  <span v-if="d.metadata?.aspect_ratio" class="badge badge-ratio">{{ d.metadata.aspect_ratio }}</span>
                </div>
                <div class="project-card-footer">
                  <span>更新于 {{ formatDate(d.updated_at) }}</span>
                  <el-button type="primary" link @click.stop="openProject(d.id)">{{ d.archived_at ? '查看项目' : '继续制作' }}<el-icon><ArrowRight /></el-icon></el-button>
                </div>
              </div>
            </article>
          </div>

          <div v-else-if="!loading" class="project-empty">
            <el-icon><FolderOpened /></el-icon>
            <h3>{{ projectKeyword ? '没有匹配的项目' : archiveState === 'archived' ? '还没有归档项目' : '开始第一个视频项目' }}</h3>
            <p>{{ projectKeyword ? '换一个关键词，或清空搜索条件。' : archiveState === 'archived' ? '暂时不处理的项目可以从项目菜单归档到这里。' : '可以先运行零成本模拟，理解流程后再开始真实制作。' }}</p>
            <div>
              <el-button v-if="projectKeyword" @click="clearProjectSearch">清空搜索</el-button>
              <el-button v-else-if="archiveState === 'active'" type="primary" @click="goNewProject">新建项目</el-button>
              <el-button v-if="archiveState === 'active'" @click="router.push('/guided-demo')">零成本模拟</el-button>
            </div>
          </div>
        </div>

        <div v-if="total > 0" class="project-pagination">
          <span>共 {{ total }} 个项目</span>
          <el-pagination
            v-model:current-page="projectPage"
            v-model:page-size="projectPageSize"
            :total="total"
            :page-sizes="[12, 24, 48]"
            layout="sizes, prev, pager, next"
            @current-change="changeProjectPage"
            @size-change="changeProjectPageSize"
          />
        </div>
      </section>

      <footer class="home-footer">
        <div><strong>银子AI视频工作流</strong><span>作者：银子 · QQ：474764004</span></div>
        <div>
          <a href="https://github.com/ginsonko" target="_blank" rel="noopener noreferrer">GitHub · ginsonko</a>
          <a v-if="distributionProfile?.smart_routing_entry" href="https://www.yinziapi.top" target="_blank" rel="noopener noreferrer">银子API</a>
          <button type="button" @click="router.push('/help')">说明书</button>
        </div>
      </footer>
    </main>

    <!-- 新建项目：先填标题和描述 -->
    <el-dialog
      v-model="showNewDialog"
      title="新建真实制作"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetNewForm"
    >
      <el-form :model="newForm" label-width="80px" label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="newForm.title" placeholder="输入项目标题" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="newForm.description" type="textarea" :rows="3" placeholder="输入项目描述（选填）" />
        </el-form-item>
        <el-form-item label="画面比例">
          <el-select v-model="newForm.aspect_ratio" style="width: 100%">
            <el-option label="16:9 横屏（默认）" value="16:9" />
            <el-option label="9:16 竖屏（短视频）" value="9:16" />
            <el-option label="3:4 竖版" value="3:4" />
            <el-option label="1:1 方形" value="1:1" />
            <el-option label="4:3 传统横屏" value="4:3" />
            <el-option label="21:9 宽银幕" value="21:9" />
          </el-select>
          <p style="margin: 4px 0 0; font-size: 12px; color: #71717a;">影响分镜图和视频的生成比例，短视频选 9:16</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showNewDialog = false">取消</el-button>
        <el-button type="primary" :loading="newSaving" :disabled="!newForm.title?.trim()" @click="submitNew">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showConfigGuide" title="完成核心配置后开始制作" width="min(520px, 92vw)" :close-on-click-modal="false">
      <p class="config-guide-intro">真实制作需要文本、资源生图、分镜生图和视频四项默认配置。这里仅检查是否已保存，不会主动测试或产生费用。</p>
      <div v-if="configError" class="config-guide-error">
        <el-icon><WarningFilled /></el-icon>
        <span>当前无法读取配置，请先重试；零成本模拟和历史项目仍可使用。</span>
      </div>
      <div v-else class="config-guide-list">
        <div v-for="item in configReadiness.required" :key="item.type" :class="['config-guide-item', { ready: item.ready }]">
          <el-icon><CircleCheckFilled v-if="item.ready" /><WarningFilled v-else /></el-icon>
          <span><strong>{{ item.label }}</strong><small>{{ item.reason }} · {{ item.purpose }}</small></span>
        </div>
      </div>
      <template #footer>
        <el-button @click="router.push('/guided-demo'); showConfigGuide = false">先体验零成本模拟</el-button>
        <el-button @click="router.push('/help#configuration'); showConfigGuide = false">查看配置方法</el-button>
        <el-button type="primary" @click="showConfigGuide = false; openConfigDialog('yinzi')">一键去配置</el-button>
      </template>
    </el-dialog>

    <!-- AI 配置弹窗 -->
    <el-dialog v-model="showAiConfigDialog" title="模型与 Key" width="min(1120px, 94vw)" destroy-on-close @closed="loadConfigReadiness">
      <AIConfigContent v-if="showAiConfigDialog" :initial-action="configInitialAction" />
    </el-dialog>

    <!-- 公共角色库 -->
    <el-dialog v-model="showCharLibrary" title="素材库 · 角色" width="720px" destroy-on-close class="library-dialog" @open="loadCharLibraryList">
      <div class="library-toolbar">
        <el-input v-model="charLibraryKeyword" placeholder="搜索名称或描述" clearable style="width: 200px" @input="debouncedLoadCharLibrary()" />
      </div>
      <div v-loading="charLibraryLoading" class="library-list">
        <div v-for="item in charLibraryList" :key="item.id" class="library-item">
          <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
            <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
            <span v-else class="library-item-placeholder">暂无图</span>
          </div>
          <div class="library-item-info">
            <div class="library-item-name">{{ item.name || '未命名' }}</div>
            <div class="library-item-desc">{{ (item.description || '').slice(0, 60) }}{{ (item.description || '').length > 60 ? '…' : '' }}</div>
            <div class="library-item-actions">
              <el-button size="small" @click="openEditCharLibrary(item)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="onDeleteCharLibrary(item)">删除</el-button>
            </div>
          </div>
        </div>
        <div v-if="!charLibraryLoading && charLibraryList.length === 0" class="library-empty">素材库暂无角色，可在项目中将角色「加入素材库」后在此查看</div>
      </div>
      <div class="library-pagination">
        <el-pagination v-model:current-page="charLibraryPage" v-model:page-size="charLibraryPageSize" :total="charLibraryTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @current-change="loadCharLibraryList" @size-change="loadCharLibraryList" />
      </div>
      <template #footer><el-button @click="showCharLibrary = false">关闭</el-button></template>
    </el-dialog>
    <!-- 编辑公共角色 -->
    <el-dialog v-model="showEditCharLibrary" title="编辑素材角色" width="480px" @close="editCharLibraryForm = null">
      <el-form v-if="editCharLibraryForm" label-width="80px">
        <el-form-item label="图片">
          <div class="lib-img-editor">
            <div class="lib-img-thumb" @click="openImagePreview(assetImageUrl(editCharLibraryForm))">
              <img v-if="editCharLibraryForm.image_url || editCharLibraryForm.local_path" :src="assetImageUrl(editCharLibraryForm)" />
              <div v-else class="lib-img-empty"><el-icon><PictureFilled /></el-icon></div>
            </div>
            <div class="lib-img-btns">
              <el-button size="small" :loading="editCharLibraryForm.imgUploading" @click="charLibFileRef.click()">上传图片</el-button>
              <el-button size="small" type="primary" :loading="editCharLibraryForm.imgGenerating" @click="doGenerateLibImg(editCharLibraryForm, (editCharLibraryForm.name + (editCharLibraryForm.description ? ', ' + editCharLibraryForm.description : '')), characterLibraryAPI, loadCharLibraryList)">AI 生成</el-button>
            </div>
          </div>
          <input ref="charLibFileRef" type="file" accept="image/*" style="display:none" @change="e => doUploadLibImg(e, editCharLibraryForm, characterLibraryAPI, loadCharLibraryList)" />
        </el-form-item>
        <el-form-item label="名称"><el-input v-model="editCharLibraryForm.name" placeholder="角色名称" /></el-form-item>
        <el-form-item label="分类"><el-input v-model="editCharLibraryForm.category" placeholder="可选" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="editCharLibraryForm.description" type="textarea" :rows="3" placeholder="可选" /></el-form-item>
        <el-form-item label="标签"><el-input v-model="editCharLibraryForm.tags" placeholder="可选，逗号分隔" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditCharLibrary = false">取消</el-button>
        <el-button type="primary" :loading="editCharLibrarySaving" @click="submitEditCharLibrary">保存</el-button>
      </template>
    </el-dialog>

    <!-- 公共场景库 -->
    <el-dialog v-model="showSceneLibrary" title="素材库 · 场景" width="720px" destroy-on-close class="library-dialog" @open="loadSceneLibraryList">
      <div class="library-toolbar">
        <el-input v-model="sceneLibraryKeyword" placeholder="搜索地点或描述" clearable style="width: 200px" @input="debouncedLoadSceneLibrary()" />
      </div>
      <div v-loading="sceneLibraryLoading" class="library-list">
        <div v-for="item in sceneLibraryList" :key="item.id" class="library-item">
          <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
            <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
            <span v-else class="library-item-placeholder">暂无图</span>
          </div>
          <div class="library-item-info">
            <div class="library-item-name">{{ item.location || item.time || '未命名' }}</div>
            <div class="library-item-desc">{{ (item.description || item.prompt || '').slice(0, 60) }}{{ (item.description || item.prompt || '').length > 60 ? '…' : '' }}</div>
            <div class="library-item-actions">
              <el-button size="small" @click="openEditSceneLibrary(item)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="onDeleteSceneLibrary(item)">删除</el-button>
            </div>
          </div>
        </div>
        <div v-if="!sceneLibraryLoading && sceneLibraryList.length === 0" class="library-empty">素材库暂无场景，可在项目中将场景「加入素材库」后在此查看</div>
      </div>
      <div class="library-pagination">
        <el-pagination v-model:current-page="sceneLibraryPage" v-model:page-size="sceneLibraryPageSize" :total="sceneLibraryTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @current-change="loadSceneLibraryList" @size-change="loadSceneLibraryList" />
      </div>
      <template #footer><el-button @click="showSceneLibrary = false">关闭</el-button></template>
    </el-dialog>
    <!-- 编辑公共场景 -->
    <el-dialog v-model="showEditSceneLibrary" title="编辑素材场景" width="480px" @close="editSceneLibraryForm = null">
      <el-form v-if="editSceneLibraryForm" label-width="80px">
        <el-form-item label="图片">
          <div class="lib-img-editor">
            <div class="lib-img-thumb" @click="openImagePreview(assetImageUrl(editSceneLibraryForm))">
              <img v-if="editSceneLibraryForm.image_url || editSceneLibraryForm.local_path" :src="assetImageUrl(editSceneLibraryForm)" />
              <div v-else class="lib-img-empty"><el-icon><PictureFilled /></el-icon></div>
            </div>
            <div class="lib-img-btns">
              <el-button size="small" :loading="editSceneLibraryForm.imgUploading" @click="sceneLibFileRef.click()">上传图片</el-button>
              <el-button size="small" type="primary" :loading="editSceneLibraryForm.imgGenerating" @click="doGenerateLibImg(editSceneLibraryForm, ([editSceneLibraryForm.location, editSceneLibraryForm.time, editSceneLibraryForm.description].filter(Boolean).join(', ')), sceneLibraryAPI, loadSceneLibraryList)">AI 生成</el-button>
            </div>
          </div>
          <input ref="sceneLibFileRef" type="file" accept="image/*" style="display:none" @change="e => doUploadLibImg(e, editSceneLibraryForm, sceneLibraryAPI, loadSceneLibraryList)" />
        </el-form-item>
        <el-form-item label="地点"><el-input v-model="editSceneLibraryForm.location" placeholder="场景地点" /></el-form-item>
        <el-form-item label="时间"><el-input v-model="editSceneLibraryForm.time" placeholder="如：浅色/夜晚" /></el-form-item>
        <el-form-item label="分类"><el-input v-model="editSceneLibraryForm.category" placeholder="可选" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="editSceneLibraryForm.description" type="textarea" :rows="3" placeholder="可选" /></el-form-item>
        <el-form-item label="标签"><el-input v-model="editSceneLibraryForm.tags" placeholder="可选，逗号分隔" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditSceneLibrary = false">取消</el-button>
        <el-button type="primary" :loading="editSceneLibrarySaving" @click="submitEditSceneLibrary">保存</el-button>
      </template>
    </el-dialog>

    <!-- 公共道具库 -->
    <el-dialog v-model="showPropLibrary" title="素材库 · 道具" width="720px" destroy-on-close class="library-dialog" @open="loadPropLibraryList">
      <div class="library-toolbar">
        <el-input v-model="propLibraryKeyword" placeholder="搜索名称或描述" clearable style="width: 200px" @input="debouncedLoadPropLibrary()" />
      </div>
      <div v-loading="propLibraryLoading" class="library-list">
        <div v-for="item in propLibraryList" :key="item.id" class="library-item">
          <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
            <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
            <span v-else class="library-item-placeholder">暂无图</span>
          </div>
          <div class="library-item-info">
            <div class="library-item-name">{{ item.name || '未命名' }}</div>
            <div class="library-item-desc">{{ (item.description || item.prompt || '').slice(0, 60) }}{{ (item.description || item.prompt || '').length > 60 ? '…' : '' }}</div>
            <div class="library-item-actions">
              <el-button size="small" @click="openEditPropLibrary(item)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="onDeletePropLibrary(item)">删除</el-button>
            </div>
          </div>
        </div>
        <div v-if="!propLibraryLoading && propLibraryList.length === 0" class="library-empty">素材库暂无道具，可在项目中将道具「加入素材库」后在此查看</div>
      </div>
      <div class="library-pagination">
        <el-pagination v-model:current-page="propLibraryPage" v-model:page-size="propLibraryPageSize" :total="propLibraryTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @current-change="loadPropLibraryList" @size-change="loadPropLibraryList" />
      </div>
      <template #footer><el-button @click="showPropLibrary = false">关闭</el-button></template>
    </el-dialog>
    <!-- 编辑公共道具 -->
    <el-dialog v-model="showEditPropLibrary" title="编辑素材道具" width="480px" @close="editPropLibraryForm = null">
      <el-form v-if="editPropLibraryForm" label-width="80px">
        <el-form-item label="图片">
          <div class="lib-img-editor">
            <div class="lib-img-thumb" @click="openImagePreview(assetImageUrl(editPropLibraryForm))">
              <img v-if="editPropLibraryForm.image_url || editPropLibraryForm.local_path" :src="assetImageUrl(editPropLibraryForm)" />
              <div v-else class="lib-img-empty"><el-icon><PictureFilled /></el-icon></div>
            </div>
            <div class="lib-img-btns">
              <el-button size="small" :loading="editPropLibraryForm.imgUploading" @click="propLibFileRef.click()">上传图片</el-button>
              <el-button size="small" type="primary" :loading="editPropLibraryForm.imgGenerating" @click="doGenerateLibImg(editPropLibraryForm, (editPropLibraryForm.name + (editPropLibraryForm.description ? ', ' + editPropLibraryForm.description : '')), propLibraryAPI, loadPropLibraryList)">AI 生成</el-button>
            </div>
          </div>
          <input ref="propLibFileRef" type="file" accept="image/*" style="display:none" @change="e => doUploadLibImg(e, editPropLibraryForm, propLibraryAPI, loadPropLibraryList)" />
        </el-form-item>
        <el-form-item label="名称"><el-input v-model="editPropLibraryForm.name" placeholder="道具名称" /></el-form-item>
        <el-form-item label="分类"><el-input v-model="editPropLibraryForm.category" placeholder="可选" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="editPropLibraryForm.description" type="textarea" :rows="3" placeholder="可选" /></el-form-item>
        <el-form-item label="标签"><el-input v-model="editPropLibraryForm.tags" placeholder="可选，逗号分隔" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditPropLibrary = false">取消</el-button>
        <el-button type="primary" :loading="editPropLibrarySaving" @click="submitEditPropLibrary">保存</el-button>
      </template>
    </el-dialog>

    <!-- 图片放大预览 -->
    <Teleport to="body">
      <div v-if="previewImageUrl" class="image-preview-overlay" @click="previewImageUrl = null">
        <img :src="previewImageUrl" alt="" class="image-preview-img" @click.stop="previewImageUrl = null" />
      </div>
    </Teleport>

    <el-dialog
      v-model="showFinalPreview"
      :title="previewFinal?.drama_title ? `${previewFinal.drama_title} · 最终成片` : '最终成片'"
      width="min(960px, 94vw)"
      destroy-on-close
      @closed="previewFinal = null"
    >
      <div class="final-player-shell">
        <video
          v-if="previewFinalUrl"
          :src="previewFinalUrl"
          controls
          autoplay
          playsinline
          preload="metadata"
          class="final-player"
        />
        <div v-else class="final-player-unavailable">
          <el-icon><VideoPlay /></el-icon>
          <strong>成片记录已批准，但源文件当前不可用</strong>
          <span>可进入制作向导查看产物来源和恢复状态。</span>
        </div>
      </div>
      <div v-if="previewFinal" class="final-player-info">
        <span>{{ previewFinal.title || '最终成片' }}</span>
        <span>{{ formatDuration(previewFinal.duration_seconds) || '时长由播放器读取' }}</span>
        <span>批准于 {{ formatDate(previewFinal.approved_at || previewFinal.updated_at) }}</span>
      </div>
      <template #footer>
        <el-button @click="router.push({ path: `/workflow/${previewFinal?.drama_id}`, query: { run: previewFinal?.run_id } })">查看制作流程</el-button>
        <el-button type="primary" :icon="Download" :disabled="!previewFinalUrl" @click="downloadFinal(previewFinal)">下载成片</el-button>
      </template>
    </el-dialog>

    <!-- 编辑项目：修改标题和故事 -->
    <el-dialog
      v-model="showEditDialog"
      title="编辑项目"
      width="480px"
      :close-on-click-modal="false"
      @closed="resetEditForm"
    >
      <el-form :model="editForm" label-width="80px" label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="editForm.title" placeholder="输入项目标题" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item label="故事">
          <el-input v-model="editForm.description" type="textarea" :rows="3" placeholder="输入故事梗概（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" :disabled="!editForm.title?.trim()" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  ArrowRight,
  Box,
  Camera,
  CircleCheckFilled,
  Delete,
  Download,
  EditPen,
  Files,
  Folder,
  FolderOpened,
  MagicStick,
  Moon,
  MoreFilled,
  PictureFilled,
  Plus,
  Refresh,
  RefreshLeft,
  Search,
  Sunny,
  TopRight,
  Upload,
  User,
  VideoCamera,
  VideoPlay,
  WarningFilled,
} from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import { dramaAPI } from '@/api/drama'
import { characterLibraryAPI } from '@/api/characterLibrary'
import { sceneLibraryAPI } from '@/api/sceneLibrary'
import { propLibraryAPI } from '@/api/propLibrary'
import AIConfigContent from '@/components/AIConfigContent.vue'
import { uploadAPI } from '@/api/upload'
import { aiAPI } from '@/api/ai'
import { imagesAPI } from '@/api/images'
import { taskAPI } from '@/api/task'
import { productionAPI } from '@/api/production'
import { mapLatestFinalsByDrama, productionMediaUrl } from '@/utils/productionMedia'
import { getConfigReadiness } from '@/utils/configReadiness'
import { templatesAPI } from '@/api/templates'

const router = useRouter()
const route = useRoute()
const { isDark, toggle: toggleTheme } = useTheme()
const workflowStages = ['故事', '资产', '分镜与预演', '视频生成', '剪辑交付']
const modeHighlights = [
  { key: 'human', label: '人工审批', description: '逐项阅读、编辑、确认或打回，适合精细控制。' },
  { key: 'ai', label: 'AI 审批', description: '自动打回、修改并复审；同一对象连续耗尽上限才找你。' },
  { key: 'auto', label: '全自动', description: '从故事运行到成片，中间无人确认，仍保留技术与媒体校验。' },
]

// 库编辑图片 – 文件输入 refs
const charLibFileRef  = ref(null)
const sceneLibFileRef = ref(null)
const propLibFileRef  = ref(null)

// 共享：上传图片
async function doUploadLibImg(event, form, api, reloadFn) {
  const file = event.target?.files?.[0]
  if (event.target) event.target.value = ''
  if (!file || !form?.id) return
  form.imgUploading = true
  try {
    const res = await uploadAPI.uploadImage(file)
    const data = res?.data ?? res
    const url = data?.url || data?.path || data?.local_path
    if (!url) { ElMessage.error('上传未返回地址'); return }
    form.image_url = url
    form.local_path = data?.local_path ?? null
    await api.update(form.id, { image_url: url, local_path: null })
    reloadFn()
    ElMessage.success('图片已更新')
  } catch (e) { ElMessage.error(e.message || '上传失败') }
  finally { form.imgUploading = false }
}

// 共享：AI 生成图片
async function doGenerateLibImg(form, prompt, api, reloadFn) {
  if (!prompt?.trim()) { ElMessage.warning('请先填写名称或描述'); return }
  form.imgGenerating = true
  try {
    const res = await imagesAPI.create({ prompt: prompt.trim(), drama_id: null })
    const imgData = res?.data ?? res
    const taskId = imgData?.task_id
    if (!taskId) throw new Error('未返回任务ID')
    let task = null
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 1500))
      const tr = await taskAPI.get(taskId)
      task = tr?.data ?? tr
      if (task.status === 'completed') break
      if (task.status === 'failed') throw new Error(task.error || '生成失败')
    }
    if (!task || task.status !== 'completed') throw new Error('生成超时')
    const result = task.result
    const imageUrl = result?.image_url
    const localPath = result?.local_path ?? null
    if (!imageUrl && !localPath) throw new Error('未获取到图片地址')
    form.image_url = imageUrl || ''
    form.local_path = localPath
    await api.update(form.id, { image_url: imageUrl || null, local_path: localPath })
    reloadFn()
    ElMessage.success('AI 图片已生成')
  } catch (e) { ElMessage.error(e.message || '生成失败') }
  finally { form.imgGenerating = false }
}

const loading = ref(false)
const dramas = ref([])
const total = ref(0)
const finalMediaByDrama = ref(new Map())
const showFinalPreview = ref(false)
const previewFinal = ref(null)
const previewFinalUrl = computed(() => productionMediaUrl(previewFinal.value))

const showAiConfigDialog = ref(false)
const showConfigGuide = ref(false)
const configInitialAction = ref('')
const configLoading = ref(true)
const configError = ref('')
const aiConfigs = ref([])
const configReadiness = computed(() => getConfigReadiness(aiConfigs.value))
const configProgress = computed(() => Math.round((configReadiness.value.readyCount / configReadiness.value.total) * 100))
const distributionProfile = ref(null)
const templates = ref([])
const templatesLoading = ref(false)
const homeTemplateId = ref('free')
const selectedHomeTemplate = computed(() => templates.value.find((item) => String(item.id) === String(homeTemplateId.value)) || null)
function templateInputSummary(item) {
  const inputs = Array.isArray(item?.inputs) ? item.inputs : []
  return inputs.length ? inputs.slice(0, 3).join('、') : '可添加参考文件，由 AI 自动整理'
}
function persistTemplateChoice() {
  try { window.localStorage.setItem('yinzi-ai-video:last-template-id', homeTemplateId.value || 'free') } catch (_) {}
}
function resetTemplateChoice() { homeTemplateId.value = 'free'; persistTemplateChoice() }
function loadTemplateChoice() {
  try {
    const saved = window.localStorage.getItem('yinzi-ai-video:last-template-id')
    if (saved === 'free' || templates.value.some((item) => String(item.id) === String(saved))) homeTemplateId.value = saved || 'free'
  } catch (_) {}
}
async function loadTemplates() {
  templatesLoading.value = true
  try { const result = await templatesAPI.list(); templates.value = result?.items || []; loadTemplateChoice() }
  catch (_) { templates.value = []; loadTemplateChoice() }
  finally { templatesLoading.value = false }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const archiveState = ref(route.query.archive_state === 'archived' ? 'archived' : 'active')
const projectKeyword = ref(typeof route.query.keyword === 'string' ? route.query.keyword : '')
const projectPage = ref(positiveInt(route.query.page, 1))
const projectPageSize = ref([12, 24, 48].includes(positiveInt(route.query.page_size, 12)) ? positiveInt(route.query.page_size, 12) : 12)
const listError = ref('')
let listRequestId = 0
let projectSearchTimer = null

async function loadConfigReadiness() {
  configLoading.value = true
  configError.value = ''
  try {
    aiConfigs.value = await aiAPI.list()
  } catch (error) {
    configError.value = error?.message || '配置读取失败'
  } finally {
    configLoading.value = false
  }
}

async function loadDistributionProfile() {
  try {
    distributionProfile.value = await aiAPI.getDistributionProfile()
  } catch (_) {
    // Fail closed for the edition-specific Yinzi entry: a profile that cannot
    // be read must never expose a provider-specific shortcut.
    distributionProfile.value = { id: 'universal', smart_routing_entry: false }
  }
}

function openConfigDialog(action = '') {
  configInitialAction.value = action === 'yinzi' ? 'yinzi' : action === 'laoli' ? 'laoli' : (action ? `service:${action}` : '')
  showAiConfigDialog.value = true
}

function openResourceCenter(command) {
  if (command === 'characters') showCharLibrary.value = true
  if (command === 'scenes') showSceneLibrary.value = true
  if (command === 'props') showPropLibrary.value = true
}

function scrollToProjects() {
  document.getElementById('projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 图片预览
const previewImageUrl = ref(null)
function assetImageUrl(item) {
  if (!item) return ''
  if (typeof item === 'string') return item.startsWith('http') ? item : item
  const localPath = item.local_path && String(item.local_path).trim()
  if (localPath) return '/static/' + localPath.replace(/^\//, '')
  return item.image_url || ''
}
function openImagePreview(url) {
  if (url) previewImageUrl.value = url
}

// 公共角色库
const showCharLibrary = ref(false)
const charLibraryList = ref([])
const charLibraryLoading = ref(false)
const charLibraryPage = ref(1)
const charLibraryPageSize = ref(20)
const charLibraryTotal = ref(0)
const charLibraryKeyword = ref('')
const showEditCharLibrary = ref(false)
const editCharLibraryForm = ref(null)
const editCharLibrarySaving = ref(false)
let charLibraryKeywordTimer = null

async function loadCharLibraryList() {
  charLibraryLoading.value = true
  try {
    const res = await characterLibraryAPI.list({ page: charLibraryPage.value, page_size: charLibraryPageSize.value, keyword: charLibraryKeyword.value || undefined, global: 1 })
    charLibraryList.value = res?.items ?? []
    const p = res?.pagination ?? {}
    charLibraryTotal.value = p.total ?? 0
    if (p.page != null) charLibraryPage.value = p.page
    if (p.page_size != null) charLibraryPageSize.value = p.page_size
  } catch { charLibraryList.value = [] } finally { charLibraryLoading.value = false }
}
function debouncedLoadCharLibrary() {
  if (charLibraryKeywordTimer) clearTimeout(charLibraryKeywordTimer)
  charLibraryKeywordTimer = setTimeout(() => { charLibraryPage.value = 1; loadCharLibraryList() }, 300)
}
function openEditCharLibrary(item) {
  editCharLibraryForm.value = { id: item.id, name: item.name ?? '', category: item.category ?? '', description: item.description ?? '', tags: item.tags ?? '', image_url: item.image_url ?? '', local_path: item.local_path ?? null, imgUploading: false, imgGenerating: false }
  showEditCharLibrary.value = true
}
async function submitEditCharLibrary() {
  if (!editCharLibraryForm.value?.id) return
  editCharLibrarySaving.value = true
  try {
    await characterLibraryAPI.update(editCharLibraryForm.value.id, { name: editCharLibraryForm.value.name, category: editCharLibraryForm.value.category || null, description: editCharLibraryForm.value.description || null, tags: editCharLibraryForm.value.tags || null, image_url: editCharLibraryForm.value.image_url || null, local_path: editCharLibraryForm.value.local_path ?? null })
    ElMessage.success('已保存')
    showEditCharLibrary.value = false
    loadCharLibraryList()
  } catch (e) { ElMessage.error(e.message || '保存失败') } finally { editCharLibrarySaving.value = false }
}
async function onDeleteCharLibrary(item) {
  try { await ElMessageBox.confirm(`确定删除公共角色「${(item.name || '未命名').slice(0, 20)}」吗？`, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }) } catch { return }
  try { await characterLibraryAPI.delete(item.id); ElMessage.success('已删除'); loadCharLibraryList() } catch (e) { ElMessage.error(e.message || '删除失败') }
}

// 公共场景库
const showSceneLibrary = ref(false)
const sceneLibraryList = ref([])
const sceneLibraryLoading = ref(false)
const sceneLibraryPage = ref(1)
const sceneLibraryPageSize = ref(20)
const sceneLibraryTotal = ref(0)
const sceneLibraryKeyword = ref('')
const showEditSceneLibrary = ref(false)
const editSceneLibraryForm = ref(null)
const editSceneLibrarySaving = ref(false)
let sceneLibraryKeywordTimer = null

async function loadSceneLibraryList() {
  sceneLibraryLoading.value = true
  try {
    const res = await sceneLibraryAPI.list({ page: sceneLibraryPage.value, page_size: sceneLibraryPageSize.value, keyword: sceneLibraryKeyword.value || undefined, global: 1 })
    sceneLibraryList.value = res?.items ?? []
    const p = res?.pagination ?? {}
    sceneLibraryTotal.value = p.total ?? 0
    if (p.page != null) sceneLibraryPage.value = p.page
    if (p.page_size != null) sceneLibraryPageSize.value = p.page_size
  } catch { sceneLibraryList.value = [] } finally { sceneLibraryLoading.value = false }
}
function debouncedLoadSceneLibrary() {
  if (sceneLibraryKeywordTimer) clearTimeout(sceneLibraryKeywordTimer)
  sceneLibraryKeywordTimer = setTimeout(() => { sceneLibraryPage.value = 1; loadSceneLibraryList() }, 300)
}
function openEditSceneLibrary(item) {
  editSceneLibraryForm.value = { id: item.id, location: item.location ?? '', time: item.time ?? '', category: item.category ?? '', description: item.description ?? '', tags: item.tags ?? '', image_url: item.image_url ?? '', local_path: item.local_path ?? null, imgUploading: false, imgGenerating: false }
  showEditSceneLibrary.value = true
}
async function submitEditSceneLibrary() {
  if (!editSceneLibraryForm.value?.id) return
  editSceneLibrarySaving.value = true
  try {
    await sceneLibraryAPI.update(editSceneLibraryForm.value.id, { location: editSceneLibraryForm.value.location, time: editSceneLibraryForm.value.time || null, category: editSceneLibraryForm.value.category || null, description: editSceneLibraryForm.value.description || null, tags: editSceneLibraryForm.value.tags || null, image_url: editSceneLibraryForm.value.image_url || null, local_path: editSceneLibraryForm.value.local_path ?? null })
    ElMessage.success('已保存')
    showEditSceneLibrary.value = false
    loadSceneLibraryList()
  } catch (e) { ElMessage.error(e.message || '保存失败') } finally { editSceneLibrarySaving.value = false }
}
async function onDeleteSceneLibrary(item) {
  const name = (item.location || item.time || '未命名').slice(0, 20)
  try { await ElMessageBox.confirm(`确定删除公共场景「${name}」吗？`, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }) } catch { return }
  try { await sceneLibraryAPI.delete(item.id); ElMessage.success('已删除'); loadSceneLibraryList() } catch (e) { ElMessage.error(e.message || '删除失败') }
}

// 公共道具库
const showPropLibrary = ref(false)
const propLibraryList = ref([])
const propLibraryLoading = ref(false)
const propLibraryPage = ref(1)
const propLibraryPageSize = ref(20)
const propLibraryTotal = ref(0)
const propLibraryKeyword = ref('')
const showEditPropLibrary = ref(false)
const editPropLibraryForm = ref(null)
const editPropLibrarySaving = ref(false)
let propLibraryKeywordTimer = null

async function loadPropLibraryList() {
  propLibraryLoading.value = true
  try {
    const res = await propLibraryAPI.list({ page: propLibraryPage.value, page_size: propLibraryPageSize.value, keyword: propLibraryKeyword.value || undefined, global: 1 })
    propLibraryList.value = res?.items ?? []
    const p = res?.pagination ?? {}
    propLibraryTotal.value = p.total ?? 0
    if (p.page != null) propLibraryPage.value = p.page
    if (p.page_size != null) propLibraryPageSize.value = p.page_size
  } catch { propLibraryList.value = [] } finally { propLibraryLoading.value = false }
}
function debouncedLoadPropLibrary() {
  if (propLibraryKeywordTimer) clearTimeout(propLibraryKeywordTimer)
  propLibraryKeywordTimer = setTimeout(() => { propLibraryPage.value = 1; loadPropLibraryList() }, 300)
}
function openEditPropLibrary(item) {
  editPropLibraryForm.value = { id: item.id, name: item.name ?? '', category: item.category ?? '', description: item.description ?? '', tags: item.tags ?? '', image_url: item.image_url ?? '', local_path: item.local_path ?? null, imgUploading: false, imgGenerating: false }
  showEditPropLibrary.value = true
}
async function submitEditPropLibrary() {
  if (!editPropLibraryForm.value?.id) return
  editPropLibrarySaving.value = true
  try {
    await propLibraryAPI.update(editPropLibraryForm.value.id, { name: editPropLibraryForm.value.name, category: editPropLibraryForm.value.category || null, description: editPropLibraryForm.value.description || null, tags: editPropLibraryForm.value.tags || null, image_url: editPropLibraryForm.value.image_url || null, local_path: editPropLibraryForm.value.local_path ?? null })
    ElMessage.success('已保存')
    showEditPropLibrary.value = false
    loadPropLibraryList()
  } catch (e) { ElMessage.error(e.message || '保存失败') } finally { editPropLibrarySaving.value = false }
}
async function onDeletePropLibrary(item) {
  try { await ElMessageBox.confirm(`确定删除公共道具「${(item.name || '未命名').slice(0, 20)}」吗？`, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }) } catch { return }
  try { await propLibraryAPI.delete(item.id); ElMessage.success('已删除'); loadPropLibraryList() } catch (e) { ElMessage.error(e.message || '删除失败') }
}

const showNewDialog = ref(false)
const newForm = ref({ title: '', description: '', aspect_ratio: '16:9' })
const newSaving = ref(false)
const exportingId = ref(null)
const importing = ref(false)
const importFileInput = ref(null)

const showEditDialog = ref(false)
const editForm = ref({ id: null, title: '', description: '' })
const editSaving = ref(false)

function syncProjectQuery() {
  const query = {}
  if (archiveState.value === 'archived') query.archive_state = 'archived'
  if (projectKeyword.value.trim()) query.keyword = projectKeyword.value.trim()
  if (projectPage.value > 1) query.page = String(projectPage.value)
  if (projectPageSize.value !== 12) query.page_size = String(projectPageSize.value)
  router.replace({ path: '/', query })
}

async function loadList(options = {}) {
  const requestId = ++listRequestId
  loading.value = true
  listError.value = ''
  try {
    const res = await dramaAPI.list({
      page: projectPage.value,
      page_size: projectPageSize.value,
      keyword: projectKeyword.value.trim() || undefined,
      archive_state: archiveState.value,
    })
    if (requestId !== listRequestId) return
    const items = res?.items ?? []
    const nextTotal = res?.pagination?.total ?? 0
    if (!items.length && nextTotal > 0 && projectPage.value > 1 && options.allowPageFallback !== false) {
      projectPage.value = Math.max(1, projectPage.value - 1)
      syncProjectQuery()
      return loadList({ allowPageFallback: false })
    }
    dramas.value = items
    total.value = nextTotal
  } catch (error) {
    if (requestId !== listRequestId) return
    listError.value = error?.message || '项目列表加载失败'
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

function onProjectSearch() {
  if (projectSearchTimer) clearTimeout(projectSearchTimer)
  projectSearchTimer = setTimeout(() => {
    projectPage.value = 1
    syncProjectQuery()
    loadList()
  }, 300)
}

function clearProjectSearch() {
  projectKeyword.value = ''
  projectPage.value = 1
  syncProjectQuery()
  loadList()
}

function changeArchiveState() {
  projectPage.value = 1
  syncProjectQuery()
  loadList()
}

function changeProjectPage() {
  syncProjectQuery()
  loadList()
  scrollToProjects()
}

function changeProjectPageSize() {
  projectPage.value = 1
  syncProjectQuery()
  loadList()
}

async function loadFinalMedia() {
  try {
    const result = await productionAPI.productionMedia({
      stage: 'final_edit',
      kind: 'final_video',
      media_type: 'video',
      latest_per_drama: true,
      page_size: 100,
    })
    finalMediaByDrama.value = mapLatestFinalsByDrama(result?.items || [])
  } catch (_) {
    finalMediaByDrama.value = new Map()
  }
}

function projectFinal(drama) {
  return finalMediaByDrama.value.get(Number(drama?.id)) || null
}

function projectFinalUrl(drama) {
  return productionMediaUrl(projectFinal(drama))
}

function openFinalPreview(drama) {
  const item = projectFinal(drama)
  if (!item) return
  previewFinal.value = item
  showFinalPreview.value = true
}

function formatDuration(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return minutes ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder} 秒`
}

function downloadFinal(item) {
  const url = productionMediaUrl(item)
  if (!url) return ElMessage.warning('成片文件当前不可下载')
  const extension = String(item.media_path || '').match(/\.[a-z0-9]+$/i)?.[0] || '.mp4'
  const name = String(item.drama_title || '最终成片').replace(/[\\/:*?"<>|]/g, '_')
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${name}-成片${extension}`
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function formatDate(val) {
  if (!val) return ''
  const d = new Date(val)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatStatus(status) {
  const map = { draft: '草稿', published: '已发布', archived: '已归档', generating: '生成中' }
  return map[status] || status || '草稿'
}

function formatStyle(style) {
  const map = {
    // 写实 / 影视
    realistic: '写实',
    cinematic: '电影感',
    documentary: '纪录片',
    noir: '黑色电影',
    'retro film': '复古胶片',
    horror: '恐怖',
    // 动漫 / 卡通
    'anime style': '日本动漫',
    anime: '日本动漫',
    'comic style': '欧美漫画',
    cartoon: '卡通',
    // 中国风格
    'ink wash': '国画水墨',
    'chinese style': '中国风',
    historical: '古装',
    wuxia: '武侠',
    // 绘画艺术
    watercolor: '水彩',
    'oil painting': '油画',
    sketch: '素描',
    'woodblock print': '版画',
    impressionist: '印象派',
    // 幻想 / 科幻
    fantasy: '奇幻',
    'dark fantasy': '暗黑奇幻',
    'sci-fi': '科幻',
    sci_fi: '科幻',
    cyberpunk: '赛博朋克',
    steampunk: '蒸汽朋克',
    'post-apocalyptic': '末世废土',
    // 数字 / 现代
    '3d render': '3D渲染',
    'pixel art': '像素风',
    'low poly': '低多边形',
    minimalist: '极简',
    dreamy: '唯美梦幻',
  }
  return map[style] || style
}

function formatGenre(genre) {
  const map = { drama: '剧情', comedy: '喜剧', adventure: '冒险', romance: '爱情', thriller: '悬疑', action: '动作', horror: '恐怖' }
  return map[genre] || genre
}

function totalStoryboards(d) {
  return (d.episodes || []).reduce((sum, ep) => sum + (ep.storyboards?.length || 0), 0)
}

async function goNewProject() {
  if (configLoading.value) await loadConfigReadiness()
  if (configError.value || !configReadiness.value.isReady) {
    showConfigGuide.value = true
    return
  }
  showNewDialog.value = true
}

function resetNewForm() {
  newForm.value = { title: '', description: '', aspect_ratio: '16:9' }
}

async function submitNew() {
  const title = newForm.value.title?.trim()
  if (!title) return
  await loadConfigReadiness()
  if (configError.value || !configReadiness.value.isReady) {
    showNewDialog.value = false
    showConfigGuide.value = true
    return
  }
  newSaving.value = true
  try {
    const drama = await dramaAPI.create({ title, description: newForm.value.description?.trim() || undefined, metadata: { aspect_ratio: newForm.value.aspect_ratio || '16:9' } })
    showNewDialog.value = false
    ElMessage.success('项目已创建')
    const query = homeTemplateId.value && homeTemplateId.value !== 'free' ? { template_id: homeTemplateId.value } : {}
    router.push({ path: '/workflow/' + drama.id, query })
  } catch (e) {
    ElMessage.error(e.message || '创建失败')
  } finally {
    newSaving.value = false
  }
}

function openEditDialog(d) {
  editForm.value = { id: d.id, title: d.title || '', description: d.description || '' }
  showEditDialog.value = true
}

function resetEditForm() {
  editForm.value = { id: null, title: '', description: '' }
}

async function submitEdit() {
  const title = editForm.value.title?.trim()
  if (!title || editForm.value.id == null) return
  editSaving.value = true
  try {
    await dramaAPI.update(editForm.value.id, { title, description: editForm.value.description?.trim() || undefined })
    showEditDialog.value = false
    ElMessage.success('已保存')
    loadList()
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    editSaving.value = false
  }
}

function openProject(id) {
  router.push('/workflow/' + id)
}

async function setProjectArchived(drama, archived) {
  try {
    await dramaAPI.update(drama.id, { archived })
    ElMessage.success(archived ? '项目已归档，可在“已归档”中恢复' : '项目已恢复到进行中')
    await loadList()
  } catch (error) {
    ElMessage.error(error?.message || (archived ? '归档失败' : '恢复失败'))
  }
}

function handleProjectCommand(command, drama) {
  if (command === 'director') router.push(`/director/${drama.id}`)
  if (command === 'media') router.push({ path: '/media-library', query: { drama_id: String(drama.id) } })
  if (command === 'export') onExport(drama)
  if (command === 'edit') openEditDialog(drama)
  if (command === 'archive') setProjectArchived(drama, true)
  if (command === 'restore') setProjectArchived(drama, false)
  if (command === 'delete') onDelete(drama)
}

function onExport(d) {
  if (exportingId.value) return
  exportingId.value = d.id
  try {
    // 大 ZIP 用浏览器原生下载，避免 axios blob 经 dev proxy 整包缓冲导致 ERR_FAILED
    const a = document.createElement('a')
    a.href = `/api/v1/dramas/${d.id}/export`
    a.download = `${d.title || 'drama'}.zip`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    ElMessage.success('开始下载')
  } catch (e) {
    ElMessage.error(e.message || '导出失败')
  } finally {
    exportingId.value = null
  }
}

function triggerImport() {
  importFileInput.value?.click()
}

async function onImportFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  e.target.value = ''
  if (!file.name.endsWith('.zip')) {
    ElMessage.error('请选择 .zip 格式的文件')
    return
  }
  importing.value = true
  try {
    const data = await dramaAPI.importDrama(file)
    ElMessage.success(`导入成功：${data?.title || '项目'}`) 
    archiveState.value = 'active'
    projectKeyword.value = ''
    projectPage.value = 1
    syncProjectQuery()
    await loadList()
  } catch (e) {
    const msg = e.response?.data?.message || e.message || '导入失败'
    ElMessage.error(msg)
  } finally {
    importing.value = false
  }
}

async function onDelete(d) {
  try {
    await ElMessageBox.confirm(
      `确定要删除项目「${(d.title || '未命名').slice(0, 20)}${(d.title && d.title.length > 20) ? '…' : ''}」吗？此操作不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await dramaAPI.delete(d.id)
    ElMessage.success('已删除')
    loadList()
  } catch (e) {
    ElMessage.error(e.message || '删除失败')
  }
}

onMounted(async () => {
  await Promise.all([
    loadConfigReadiness(),
    loadList(),
    loadFinalMedia(),
    loadDistributionProfile(),
    loadTemplates(),
  ])
  if (route.query.config === 'yinzi') {
    openConfigDialog(distributionProfile.value?.smart_routing_entry ? 'yinzi' : 'laoli')
    router.replace({ path: '/' })
  } else if (route.query.start === '1') {
    await goNewProject()
    router.replace({ path: '/' })
  }
})
</script>

<style scoped>
.film-list {
  min-height: 100vh;
  background: #08080d;
  color: #e4e4e7;
  background-image:
    radial-gradient(ellipse 70% 45% at 50% -10%, rgba(99, 102, 241, 0.18) 0%, transparent 70%),
    radial-gradient(ellipse 50% 35% at 85% 55%, rgba(139, 92, 246, 0.1) 0%, transparent 60%),
    radial-gradient(ellipse 40% 30% at 10% 80%, rgba(79, 70, 229, 0.08) 0%, transparent 60%);
}
.header {
  background: rgba(12, 12, 18, 0.82);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(99, 102, 241, 0.18);
  padding: 12px 24px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: 0 1px 0 rgba(99, 102, 241, 0.08), 0 4px 24px rgba(0, 0, 0, 0.3);
}
.header-inner {
  max-width: min(1400px, 96vw);
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.logo {
  margin: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1;
}
.logo-main {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, #a5b4fc 0%, #c084fc 50%, #f0abfc 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 10px rgba(168, 85, 247, 0.35));
}
.logo-sub {
  font-size: 0.68rem;
  font-weight: 400;
  letter-spacing: 0.02em;
  color: #6d6d7a;
  -webkit-text-fill-color: #6d6d7a;
  filter: none;
}
.page-title {
  color: #a1a1aa;
  font-size: 0.95rem;
}
.header-library {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 20px;
}
.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 资源库按钮 —— 靛紫调 */
.btn-library {
  --el-button-bg-color: rgba(99, 102, 241, 0.12);
  --el-button-border-color: rgba(99, 102, 241, 0.35);
  --el-button-text-color: #a5b4fc;
  --el-button-hover-bg-color: rgba(99, 102, 241, 0.22);
  --el-button-hover-border-color: rgba(99, 102, 241, 0.55);
  --el-button-hover-text-color: #c7d2fe;
  --el-button-active-bg-color: rgba(99, 102, 241, 0.3);
  --el-button-active-border-color: rgba(99, 102, 241, 0.7);
}
html.light .btn-library {
  --el-button-bg-color: rgba(79, 70, 229, 0.08);
  --el-button-border-color: rgba(79, 70, 229, 0.3);
  --el-button-text-color: #3730a3;
  --el-button-hover-bg-color: rgba(79, 70, 229, 0.14);
  --el-button-hover-border-color: rgba(79, 70, 229, 0.5);
  --el-button-hover-text-color: #312e81;
  --el-button-active-bg-color: rgba(79, 70, 229, 0.2);
  --el-button-active-border-color: rgba(79, 70, 229, 0.65);
}

/* 主题切换按钮 */
.btn-theme {
  --el-button-bg-color: rgba(148, 163, 184, 0.1);
  --el-button-border-color: rgba(148, 163, 184, 0.3);
  --el-button-text-color: #94a3b8;
  --el-button-hover-bg-color: rgba(148, 163, 184, 0.2);
  --el-button-hover-border-color: rgba(148, 163, 184, 0.5);
  --el-button-hover-text-color: #cbd5e1;
  transition: all 0.2s;
}
html.light .btn-theme {
  --el-button-bg-color: rgba(99, 102, 241, 0.08);
  --el-button-border-color: rgba(99, 102, 241, 0.3);
  --el-button-text-color: #6366f1;
  --el-button-hover-bg-color: rgba(99, 102, 241, 0.15);
  --el-button-hover-border-color: rgba(99, 102, 241, 0.5);
  --el-button-hover-text-color: #4f46e5;
}

/* AI配置按钮 —— 琥珀调 */
.btn-settings {
  --el-button-bg-color: rgba(234, 179, 8, 0.1);
  --el-button-border-color: rgba(234, 179, 8, 0.32);
  --el-button-text-color: #fcd34d;
  --el-button-hover-bg-color: rgba(234, 179, 8, 0.2);
  --el-button-hover-border-color: rgba(234, 179, 8, 0.5);
  --el-button-hover-text-color: #fde68a;
  --el-button-active-bg-color: rgba(234, 179, 8, 0.28);
  --el-button-active-border-color: rgba(234, 179, 8, 0.65);
}
html.light .btn-settings {
  --el-button-bg-color: rgba(180, 83, 9, 0.07);
  --el-button-border-color: rgba(180, 83, 9, 0.28);
  --el-button-text-color: #92400e;
  --el-button-hover-bg-color: rgba(180, 83, 9, 0.12);
  --el-button-hover-border-color: rgba(180, 83, 9, 0.45);
  --el-button-hover-text-color: #78350f;
  --el-button-active-bg-color: rgba(180, 83, 9, 0.18);
  --el-button-active-border-color: rgba(180, 83, 9, 0.6);
}

/* 3D 导演台按钮 —— 青绿色，与摄像机工作区一致 */
.btn-director {
  --el-button-bg-color: rgba(20, 184, 166, 0.1);
  --el-button-border-color: rgba(20, 184, 166, 0.32);
  --el-button-text-color: #5eead4;
  --el-button-hover-bg-color: rgba(20, 184, 166, 0.2);
  --el-button-hover-border-color: rgba(20, 184, 166, 0.52);
  --el-button-hover-text-color: #99f6e4;
}
html.light .btn-director {
  --el-button-bg-color: rgba(13, 148, 136, 0.08);
  --el-button-border-color: rgba(13, 148, 136, 0.3);
  --el-button-text-color: #0f766e;
  --el-button-hover-bg-color: rgba(13, 148, 136, 0.15);
  --el-button-hover-border-color: rgba(13, 148, 136, 0.5);
  --el-button-hover-text-color: #115e59;
}

/* 导入按钮 —— 亮色模式下提升可读性 */
html.light .btn-import {
  --el-button-text-color: #374151;
  --el-button-border-color: #d1d5db;
  --el-button-hover-text-color: #1f2937;
  --el-button-hover-border-color: #9ca3af;
}

.main {
  max-width: min(1400px, 96vw);
  margin: 0 auto;
  padding: 24px 16px 48px;
}
.projects-wrap {
  min-height: 200px;
}
.empty {
  text-align: center;
  padding: 48px 24px;
}
.empty-title {
  font-size: 1.1rem;
  color: #e4e4e7;
  margin: 0 0 8px;
}
.empty-desc {
  color: #71717a;
  font-size: 0.9rem;
  margin: 0 0 20px;
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
  gap: 18px;
}
.project-card {
  position: relative;
  background: rgba(24, 24, 30, 0.75);
  border: 1px solid rgba(63, 63, 70, 0.6);
  border-radius: 14px;
  padding: 20px;
  cursor: pointer;
  transition: border-color 0.25s, background 0.25s, transform 0.25s, box-shadow 0.25s;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  overflow: hidden;
}
.project-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.04) 0%, transparent 60%);
  pointer-events: none;
}
.project-card:hover {
  border-color: rgba(99, 102, 241, 0.55);
  background: rgba(28, 28, 36, 0.9);
  transform: translateY(-3px);
  box-shadow: 0 12px 40px rgba(99, 102, 241, 0.15), 0 0 0 1px rgba(99, 102, 241, 0.1), 0 2px 8px rgba(0, 0, 0, 0.4);
}
.project-card.has-final {
  padding: 0;
}
.project-card.has-final .project-card-body {
  padding: 16px 20px 20px;
}
.project-card.has-final .project-card-actions {
  z-index: 4;
}
.project-final-preview {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  padding: 0;
  border: 0;
  overflow: hidden;
  color: #fff;
  background: #111318;
  cursor: pointer;
  text-align: left;
}
.project-final-preview video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.project-final-preview.is-unavailable {
  cursor: default;
}
.project-final-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #687077;
  background: #14171c;
  font-size: 42px;
}
.project-final-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(8, 10, 12, 0.56), transparent 48%, rgba(8, 10, 12, 0.7));
}
.project-final-state,
.project-final-meta,
.project-final-play {
  position: absolute;
  z-index: 2;
}
.project-final-state {
  top: 14px;
  left: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 190px);
  color: #dcfce7;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}
.project-final-state .el-icon {
  color: #4ade80;
  flex: 0 0 auto;
}
.project-final-play {
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #ecfeff;
  background: rgba(13, 148, 136, 0.88);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  font-size: 24px;
  transform: translate(-50%, -50%);
  transition: transform .2s, background .2s;
}
.project-final-preview:hover .project-final-play {
  background: #0f766e;
  transform: translate(-50%, -50%) scale(1.08);
}
.project-final-meta {
  right: 14px;
  bottom: 12px;
  color: #d4d4d8;
  font-size: 11px;
}

/* 操作卡片 */
.action-card {
  cursor: default;
  border-style: dashed;
  border-color: rgba(99, 102, 241, 0.4);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(139, 92, 246, 0.04) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 40px rgba(99, 102, 241, 0.04);
}
.action-card:hover {
  border-color: rgba(99, 102, 241, 0.65);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.07) 100%);
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(99, 102, 241, 0.12), inset 0 0 40px rgba(99, 102, 241, 0.06);
}
.action-card::before {
  display: none;
}
.action-card-inner {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.action-card-title {
  font-size: 1rem;
  font-weight: 600;
  color: #a5b4fc;
  margin: 0;
}
.action-card-buttons {
  display: flex;
  gap: 12px;
  width: 100%;
  justify-content: center;
}
.action-btn {
  min-width: 150px;
}
.action-btn-new {
  --el-button-bg-color: var(--el-color-primary);
}
.action-btn-import {
  --el-button-bg-color: rgba(99, 102, 241, 0.12);
  --el-button-border-color: rgba(99, 102, 241, 0.35);
  --el-button-text-color: #a5b4fc;
  --el-button-hover-bg-color: rgba(99, 102, 241, 0.22);
  --el-button-hover-border-color: rgba(99, 102, 241, 0.55);
  --el-button-hover-text-color: #c7d2fe;
}
.action-card-example {
  width: 100%;
  padding-top: 8px;
  border-top: 1px solid rgba(99, 102, 241, 0.15);
}
.example-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  margin-bottom: 8px;
}
.example-hint-icon {
  color: #a5b4fc;
  font-size: 15px;
}
.example-hint-text {
  font-size: 0.8rem;
  color: #71717a;
}
.example-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.example-btn {
  --el-button-bg-color: rgba(34, 197, 94, 0.1);
  --el-button-border-color: rgba(34, 197, 94, 0.3);
  --el-button-text-color: #4ade80;
  --el-button-hover-bg-color: rgba(34, 197, 94, 0.2);
  --el-button-hover-border-color: rgba(34, 197, 94, 0.5);
  --el-button-hover-text-color: #22c55e;
}
.project-card-body {
  padding-right: 56px;
}
.project-title {
  font-size: 1.05rem;
  margin: 0 0 8px;
  color: #fafafa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-desc {
  font-size: 0.875rem;
  color: #a1a1aa;
  margin: 0 0 12px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.project-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 10px;
}
.badge {
  display: inline-flex;
  align-items: center;
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 99px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
}
.badge-status--draft {
  background: rgba(113, 113, 122, 0.15);
  color: #a1a1aa;
  border: 1px solid rgba(113, 113, 122, 0.3);
}
.badge-status--published {
  background: rgba(34, 197, 94, 0.12);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.badge-status--generating {
  background: rgba(234, 179, 8, 0.12);
  color: #fcd34d;
  border: 1px solid rgba(234, 179, 8, 0.3);
}
.badge-status--archived {
  background: rgba(99, 102, 241, 0.1);
  color: #a5b4fc;
  border: 1px solid rgba(99, 102, 241, 0.25);
}
.badge-final {
  gap: 4px;
  color: #86efac;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.badge-episodes {
  background: rgba(14, 165, 233, 0.12);
  color: #38bdf8;
  border: 1px solid rgba(14, 165, 233, 0.28);
}
.badge-storyboards {
  background: rgba(20, 184, 166, 0.12);
  color: #2dd4bf;
  border: 1px solid rgba(20, 184, 166, 0.28);
}
.badge-ratio {
  background: rgba(251, 146, 60, 0.1);
  color: #fb923c;
  border: 1px solid rgba(251, 146, 60, 0.25);
  font-family: monospace;
}
.badge-style {
  background: rgba(168, 85, 247, 0.1);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.25);
}
.badge-genre {
  background: rgba(249, 115, 22, 0.1);
  color: #fb923c;
  border: 1px solid rgba(249, 115, 22, 0.25);
}
.project-meta {
  font-size: 0.75rem;
  color: #71717a;
  margin: 0;
}
.project-card-actions {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 6px;
  z-index: 2;
}
.project-card-actions .el-button {
  --el-button-size: 28px;
  padding: 0;
}
.project-card-actions .el-button .el-icon {
  font-size: 14px;
}

.final-player-shell {
  min-height: 320px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #090b0d;
  border: 1px solid #24282d;
  border-radius: 6px;
}
.final-player {
  width: 100%;
  max-height: 68vh;
  display: block;
  background: #000;
}
.final-player-unavailable {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 32px;
  color: #a1a1aa;
  text-align: center;
}
.final-player-unavailable .el-icon {
  color: #5eead4;
  font-size: 44px;
}
.final-player-unavailable strong {
  color: #e4e4e7;
}
.final-player-info {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding-top: 12px;
  color: #71717a;
  font-size: 12px;
}

/* 公共库弹窗 */
:global(.library-dialog .el-dialog__body) { padding-top: 8px; }

/* 编辑弹框内图片区 */
.lib-img-editor { display: flex; align-items: center; gap: 14px; }
.lib-img-thumb { width: 88px; height: 88px; border-radius: 8px; overflow: hidden; cursor: zoom-in; background: var(--bg-inner, #1c1c1e); border: 1px solid var(--border-color, #27272a); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.lib-img-thumb img { width: 100%; height: 100%; object-fit: cover; }
.lib-img-empty { color: var(--text-faint, #52525b); font-size: 26px; }
.lib-img-btns { display: flex; flex-direction: column; gap: 8px; }
.library-toolbar { margin-bottom: 12px; }
.library-list {
  min-height: 200px;
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.library-item {
  display: flex;
  gap: 12px;
  padding: 10px;
  background: #1c1c1e;
  border: 1px solid #27272a;
  border-radius: 8px;
}
.library-item-cover {
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: #27272a;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.library-item-cover img { width: 100%; height: 100%; object-fit: cover; }
.library-item-placeholder { font-size: 0.8rem; color: #71717a; }
.library-item-info { flex: 1; min-width: 0; }
.library-item-name { font-weight: 500; margin-bottom: 4px; color: #fafafa; }
.library-item-desc { font-size: 0.85rem; color: #a1a1aa; margin-bottom: 8px; }
.library-item-actions { display: flex; gap: 8px; }
.library-empty { text-align: center; color: #71717a; padding: 40px 20px; }
.library-pagination { margin-top: 12px; display: flex; justify-content: center; }

/* ===== 亮色模式适配 ===== */
html.light .film-list {
  background: #f5f3ff;
  color: #1e1b4b;
  background-image:
    radial-gradient(ellipse 70% 45% at 50% -10%, rgba(99, 102, 241, 0.1) 0%, transparent 70%),
    radial-gradient(ellipse 50% 35% at 85% 55%, rgba(139, 92, 246, 0.06) 0%, transparent 60%);
}
html.light .header {
  background: rgba(248, 246, 255, 0.88);
  border-bottom-color: rgba(99, 102, 241, 0.2);
  box-shadow: 0 1px 0 rgba(99, 102, 241, 0.1), 0 4px 16px rgba(99, 102, 241, 0.06);
}
html.light .logo-main {
  background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #9333ea 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 8px rgba(99, 102, 241, 0.2));
}
html.light .logo-sub {
  color: #9ca3af;
  -webkit-text-fill-color: #9ca3af;
}
html.light .project-card {
  background: rgba(255, 255, 255, 0.9);
  border-color: rgba(199, 210, 254, 0.8);
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.06), 0 2px 12px rgba(0, 0, 0, 0.04);
  backdrop-filter: none;
}
html.light .project-card::before {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.03) 0%, transparent 60%);
}
html.light .project-card:hover {
  border-color: rgba(99, 102, 241, 0.5);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 12px 36px rgba(99, 102, 241, 0.12), 0 0 0 1px rgba(99, 102, 241, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
}
html.light .action-card {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(139, 92, 246, 0.04) 100%);
  border-color: rgba(99, 102, 241, 0.35);
}
html.light .action-card:hover {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.07) 100%);
  border-color: rgba(99, 102, 241, 0.55);
}
html.light .action-card-title { color: #4f46e5; }
html.light .project-title { color: #1e1b4b; }
html.light .project-desc { color: #4b5563; }
html.light .project-meta { color: #6b7280; }
html.light .example-hint-text { color: #6b7280; }
html.light .library-item {
  background: #faf9ff;
  border-color: #e5e7eb;
}
html.light .library-item-name { color: #1e1b4b; }
html.light .library-item-desc { color: #4b5563; }
html.light .library-empty { color: #6b7280; }
html.light .lib-img-thumb {
  background: #f3f4f6;
  border-color: #e5e7eb;
}
html.light .lib-img-empty { color: #9ca3af; }
html.light .badge-status--draft {
  background: rgba(107, 114, 128, 0.1);
  color: #4b5563;
  border-color: rgba(107, 114, 128, 0.25);
}
html.light .badge-final {
  color: #166534;
  background: rgba(22, 163, 74, 0.1);
  border-color: rgba(22, 163, 74, 0.25);
}
html.light .final-player-info {
  color: #4b5563;
}

/* ===== 图片放大预览 ===== */
.image-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  cursor: zoom-out;
}
.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 8px;
  object-fit: contain;
}

@media (max-width: 760px) {
  .header {
    padding: 10px 12px;
  }
  .header-inner {
    gap: 10px;
  }
  .header-library,
  .header-actions {
    width: 100%;
    margin-left: 0;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .header-library,
  .header-actions {
    flex-wrap: nowrap;
  }
  .header-library :deep(.el-button),
  .header-actions :deep(.el-button) {
    flex: 0 0 auto;
  }
  .main {
    padding: 16px 12px 36px;
  }
  .project-card-actions {
    max-width: calc(100% - 24px);
    overflow-x: auto;
  }
  .project-final-state {
    max-width: calc(100% - 150px);
  }
  .final-player-shell {
    min-height: 210px;
  }
}

/* ===== 银子 AI 视频工作台 ===== */
.film-list {
  min-height: 100vh;
  color: #e7ece9;
  background: #0d1110;
  background-image: none;
}
.header {
  padding: 10px 20px;
  background: rgba(13, 17, 16, 0.96);
  border-bottom: 1px solid #27312d;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(12px);
}
.header-inner {
  max-width: 1480px;
  display: grid;
  grid-template-columns: auto minmax(360px, 1fr) auto;
  gap: 18px;
}
.brand {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.brand-mark {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  color: #f0fdfa;
  background: #0f766e;
  border-radius: 7px;
  font-size: 18px;
}
.brand-copy {
  min-width: 0;
  display: grid;
  line-height: 1.2;
}
.brand-copy strong {
  color: #f4f7f5;
  font-size: 15px;
  white-space: nowrap;
}
.brand-copy small {
  margin-top: 3px;
  color: #85928d;
  font-size: 10px;
}
.primary-nav {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
}
.nav-link {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 11px;
  border: 0;
  border-radius: 6px;
  color: #a7b2ad;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
.nav-link:hover,
.nav-link.is-active {
  color: #f0fdfa;
  background: #1b2421;
}
.resource-trigger {
  font-family: inherit;
}
.header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: 0;
}
.yinzi-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 5px;
  color: #7dd3fc;
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}
.yinzi-link:hover { color: #bae6fd; }
.icon-action { flex: 0 0 auto; }
.config-status-button {
  --el-button-bg-color: rgba(245, 158, 11, 0.08);
  --el-button-border-color: rgba(245, 158, 11, 0.34);
  --el-button-text-color: #fbbf24;
  --el-button-hover-bg-color: rgba(245, 158, 11, 0.15);
  --el-button-hover-border-color: rgba(245, 158, 11, 0.5);
  --el-button-hover-text-color: #fde68a;
}
.config-status-button.ready {
  --el-button-bg-color: rgba(16, 185, 129, 0.08);
  --el-button-border-color: rgba(16, 185, 129, 0.34);
  --el-button-text-color: #6ee7b7;
  --el-button-hover-bg-color: rgba(16, 185, 129, 0.15);
  --el-button-hover-border-color: rgba(16, 185, 129, 0.5);
  --el-button-hover-text-color: #a7f3d0;
}
.main {
  max-width: 1480px;
  padding: 26px 22px 38px;
}
.start-panel {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(330px, 0.75fr);
  gap: 32px;
  padding: 24px 0 28px;
  border-bottom: 1px solid #27312d;
}
.start-copy { min-width: 0; }
.section-kicker {
  margin: 0 0 7px;
  color: #5eead4;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}
.start-copy h1,
.section-toolbar h2 {
  margin: 0;
  color: #f4f7f5;
  letter-spacing: 0;
}
.start-copy h1 { font-size: 28px; }
.start-description {
  max-width: 780px;
  margin: 10px 0 20px;
  color: #a7b2ad;
  font-size: 14px;
  line-height: 1.75;
}
.primary-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.primary-actions :deep(.el-button) { margin-left: 0; }
.template-launcher {
  display: grid;
  grid-template-columns: auto minmax(220px, 300px) minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid #2c3d37;
  border-radius: 8px;
  background: #111a17;
}
.template-launcher-copy { display: grid; gap: 3px; min-width: 150px; }
.template-launcher-copy strong { color: #dce6e2; font-size: 13px; }
.template-launcher-copy span { color: #81908a; font-size: 11px; }
.template-launcher-select { min-width: 0; }
.template-launcher-hint { min-width: 0; color: #8fa09a; font-size: 11px; line-height: 1.5; }
html.light .template-launcher { border-color: #cfe0d8; background: #f7fbf9; }
html.light .template-launcher-copy strong { color: #2e4038; }
html.light .template-launcher-copy span,
html.light .template-launcher-hint { color: #687971; }
.mode-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 20px;
  border-top: 1px solid #2b3732;
  border-bottom: 1px solid #2b3732;
}
.mode-summary article {
  min-width: 0;
  display: grid;
  gap: 4px;
  padding: 11px 14px;
  border-right: 1px solid #2b3732;
}
.mode-summary article:first-child { padding-left: 0; }
.mode-summary article:last-child { border-right: 0; }
.mode-summary strong { color: #dce6e2; font-size: 12px; }
.mode-summary small { color: #84918b; font-size: 10px; line-height: 1.55; }
.workflow-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(100px, 1fr));
  gap: 0;
  margin: 26px 0 0;
  padding: 0;
  list-style: none;
}
.workflow-strip li {
  position: relative;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  color: #9ba6a1;
  font-size: 12px;
  white-space: nowrap;
}
.workflow-strip li:not(:last-child)::after {
  content: '';
  height: 1px;
  flex: 1;
  margin: 0 8px;
  background: #39443f;
}
.workflow-strip span {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid #3a4b45;
  border-radius: 50%;
  color: #99f6e4;
  background: #18221f;
}
.readiness-panel {
  align-self: start;
  padding: 17px;
  border: 1px solid #2c3833;
  border-radius: 8px;
  background: #141b18;
}
.readiness-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #29342f;
}
.readiness-heading > div { display: grid; gap: 4px; }
.readiness-heading span { color: #9da9a4; font-size: 12px; }
.readiness-heading strong { color: #f4f7f5; font-size: 21px; }
.readiness-list { min-height: 174px; padding: 9px 0 2px; }
.readiness-item {
  width: 100%;
  min-height: 42px;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border: 0;
  color: #fbbf24;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.readiness-item:hover { background: #1b2421; }
.readiness-item.ready { color: #34d399; }
.readiness-item > span { min-width: 0; display: grid; gap: 2px; }
.readiness-item strong { color: #dce3df; font-size: 13px; font-weight: 600; }
.readiness-item small { color: #7f8c86; font-size: 11px; }
.readiness-arrow { color: #64706b; }
.readiness-note {
  margin: 9px 0 12px;
  color: #7f8c86;
  font-size: 11px;
  line-height: 1.55;
}
.readiness-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.readiness-actions :deep(.el-button) { margin-left: 0; }
.config-load-error,
.list-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #fca5a5;
  font-size: 12px;
}
.config-load-error { min-height: 174px; padding: 16px 4px; }
.projects-section { padding: 30px 0 10px; scroll-margin-top: 80px; }
.section-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 16px;
}
.section-toolbar h2 { font-size: 20px; }
.project-filters {
  display: flex;
  align-items: center;
  gap: 9px;
}
.project-search { width: 260px; }
.list-error {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(239, 68, 68, 0.28);
  border-radius: 6px;
  background: rgba(127, 29, 29, 0.12);
}
.projects-wrap { min-height: 260px; }
.project-grid {
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  gap: 14px;
}
.project-card {
  padding: 0;
  border: 1px solid #2b3531;
  border-radius: 8px;
  background: #141918;
  box-shadow: none;
  backdrop-filter: none;
  transition: border-color .18s, background .18s, transform .18s;
}
.project-card::before { display: none; }
.project-card:hover {
  border-color: #447269;
  background: #171e1b;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
  transform: translateY(-2px);
}
.project-card-menu {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 5;
}
.project-card-menu :deep(.el-button) {
  --el-button-bg-color: rgba(12, 16, 15, 0.78);
  --el-button-border-color: rgba(255, 255, 255, 0.14);
  --el-button-text-color: #e7ece9;
}
.project-progress-cover {
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: #7dd3fc;
  background: #101817;
  border-bottom: 1px solid #27312d;
}
.project-progress-cover .el-icon { font-size: 31px; }
.project-progress-cover span { color: #8e9b95; font-size: 12px; }
.project-card.has-final .project-card-body,
.project-card-body {
  padding: 15px 16px 14px;
  padding-right: 16px;
}
.project-title { margin-bottom: 6px; color: #f0f4f2; font-size: 15px; }
.project-desc { min-height: 38px; margin-bottom: 11px; color: #94a099; font-size: 12px; line-height: 1.55; }
.project-badges { margin-bottom: 12px; }
.badge { border-radius: 5px; }
.badge-archived {
  gap: 4px;
  color: #c4b5fd;
  background: rgba(139, 92, 246, 0.1);
  border: 1px solid rgba(139, 92, 246, 0.26);
}
.project-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid #27312d;
  color: #74817b;
  font-size: 11px;
}
.project-card-footer :deep(.el-button) { margin-left: auto; }
.project-empty {
  min-height: 300px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  padding: 32px;
  border: 1px dashed #34413c;
  border-radius: 8px;
  color: #7d8a84;
  text-align: center;
}
.project-empty > .el-icon { color: #5eead4; font-size: 38px; }
.project-empty h3 { margin: 4px 0 0; color: #dce3df; font-size: 16px; }
.project-empty p { margin: 0 0 8px; font-size: 12px; }
.project-pagination {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  color: #7d8a84;
  font-size: 12px;
}
.home-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-top: 28px;
  padding: 20px 0 4px;
  border-top: 1px solid #27312d;
  color: #78857f;
  font-size: 11px;
}
.home-footer > div { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.home-footer strong { color: #cbd5d0; }
.home-footer a,
.home-footer button {
  padding: 0;
  border: 0;
  color: #7dd3fc;
  background: transparent;
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}
.config-guide-intro { margin: 0 0 14px; color: #66736d; font-size: 13px; line-height: 1.65; }
.config-guide-list { display: grid; gap: 6px; }
.config-guide-item {
  min-width: 0;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid #f1d6a3;
  border-radius: 6px;
  color: #d97706;
  background: #fffbeb;
}
.config-guide-item.ready { border-color: #bbdfd0; color: #059669; background: #f0fdf8; }
.config-guide-item span { min-width: 0; display: grid; gap: 2px; }
.config-guide-item strong { color: #2e3934; font-size: 13px; }
.config-guide-item small { color: #77827d; font-size: 11px; line-height: 1.5; }
.config-guide-error { display: flex; gap: 8px; color: #b91c1c; }

html.light .film-list {
  color: #24302b;
  background: #f4f7f5;
  background-image: none;
}
html.light .header {
  background: rgba(255, 255, 255, 0.96);
  border-bottom-color: #d9e1dd;
  box-shadow: 0 2px 12px rgba(20, 40, 32, 0.06);
}
html.light .brand-copy strong,
html.light .start-copy h1,
html.light .section-toolbar h2,
html.light .project-title { color: #1d2924; }
html.light .brand-copy small { color: #7c8882; }
html.light .nav-link { color: #59665f; }
html.light .nav-link:hover,
html.light .nav-link.is-active { color: #115e59; background: #edf5f1; }
html.light .start-panel,
html.light .projects-section,
html.light .home-footer { border-color: #d9e1dd; }
html.light .start-description { color: #5d6a64; }
html.light .mode-summary,
html.light .mode-summary article { border-color: #d9e1dd; }
html.light .mode-summary strong { color: #2b3832; }
html.light .mode-summary small { color: #6d7a74; }
html.light .workflow-strip li { color: #64716b; }
html.light .workflow-strip li:not(:last-child)::after { background: #cfd9d4; }
html.light .workflow-strip span { color: #0f766e; border-color: #b6d5c9; background: #effaf6; }
html.light .readiness-panel { border-color: #d5dfda; background: #ffffff; }
html.light .readiness-heading { border-color: #e1e7e4; }
html.light .readiness-heading span,
html.light .readiness-note { color: #6f7c76; }
html.light .readiness-heading strong,
html.light .readiness-item strong { color: #26322d; }
html.light .readiness-item:hover { background: #f1f6f3; }
html.light .readiness-item small { color: #76837d; }
html.light .project-card {
  border-color: #d6dfdb;
  background: #ffffff;
  box-shadow: 0 2px 10px rgba(20, 40, 32, 0.04);
}
html.light .project-card:hover { border-color: #7cb5a6; background: #ffffff; box-shadow: 0 10px 28px rgba(20, 40, 32, 0.09); }
html.light .project-progress-cover { color: #0369a1; background: #eff6f5; border-color: #dbe5e0; }
html.light .project-progress-cover span,
html.light .project-desc { color: #65726c; }
html.light .project-card-footer { border-color: #e1e7e4; color: #78847e; }
html.light .project-empty { border-color: #cbd7d1; color: #6d7973; background: #fafcfb; }
html.light .project-empty h3 { color: #26322d; }
html.light .home-footer { color: #6f7b75; }
html.light .home-footer strong { color: #34413b; }

@media (max-width: 1180px) {
  .header-inner { grid-template-columns: auto 1fr; }
  .primary-nav { order: 3; grid-column: 1 / -1; }
  .start-panel { grid-template-columns: minmax(0, 1fr) 340px; gap: 22px; }
}

@media (max-width: 820px) {
  .header { padding: 9px 12px; }
  .header-inner { display: flex; flex-wrap: wrap; gap: 9px; }
  .brand { flex: 1 1 240px; }
  .header-actions { flex: 1 1 100%; order: 3; justify-content: flex-start; overflow-x: auto; padding-bottom: 2px; }
  .primary-nav { order: 2; width: 100%; overflow-x: auto; }
  .main { padding: 16px 12px 32px; }
  .start-panel { grid-template-columns: minmax(0, 1fr); gap: 20px; padding-top: 14px; }
  .template-launcher { grid-template-columns: minmax(0, 1fr) minmax(180px, 1fr); }
  .template-launcher-hint { grid-column: 1 / -1; }
  .workflow-strip { overflow-x: auto; grid-template-columns: repeat(5, minmax(130px, 1fr)); padding-bottom: 4px; }
  .section-toolbar { align-items: stretch; flex-direction: column; }
  .project-filters { flex-wrap: wrap; }
  .project-search { min-width: 0; flex: 1 1 230px; }
  .project-pagination { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  .home-footer { align-items: flex-start; flex-direction: column; }
}

@media (max-width: 480px) {
  .brand-copy strong { white-space: normal; }
  .yinzi-link { display: none; }
  .primary-nav {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    overflow: visible;
  }
  .primary-nav :deep(.el-dropdown) { min-width: 0; }
  .primary-nav .nav-link {
    width: 100%;
    justify-content: center;
    padding: 0 4px;
    font-size: 12px;
  }
  .config-status-button { flex: 1 1 auto; }
  .start-copy h1 { font-size: 24px; }
  .primary-actions { display: grid; grid-template-columns: 1fr; }
  .primary-actions :deep(.el-button) { width: 100%; }
  .template-launcher { grid-template-columns: 1fr; align-items: stretch; }
  .template-launcher-hint { grid-column: auto; }
  .mode-summary { grid-template-columns: 1fr; }
  .mode-summary article,
  .mode-summary article:first-child { padding: 9px 0; border-right: 0; border-bottom: 1px solid #2b3732; }
  .mode-summary article:last-child { border-bottom: 0; }
  html.light .mode-summary article { border-bottom-color: #d9e1dd; }
  .workflow-strip { grid-template-columns: repeat(5, minmax(0, 1fr)); overflow: visible; }
  .workflow-strip li { display: grid; justify-items: center; gap: 5px; font-size: 10px; line-height: 1.25; text-align: center; white-space: normal; }
  .workflow-strip li:not(:last-child)::after { position: absolute; top: 12px; left: calc(50% + 17px); width: calc(100% - 34px); margin: 0; }
  .readiness-panel { padding: 14px; }
  .project-filters :deep(.el-radio-group) { width: 100%; display: grid; grid-template-columns: 1fr 1fr; }
  .project-filters :deep(.el-radio-button__inner) { width: 100%; }
  .project-search { flex-basis: calc(100% - 44px); }
  .project-grid { grid-template-columns: 1fr; }
  .project-card-footer { align-items: flex-start; flex-direction: column; }
}
</style>
