<template>
  <div class="ai-config-content">
    <el-tabs v-model="activeTab" class="config-tabs">
      <el-tab-pane label="AI 配置" name="configs">
        <div class="tab-content">
          <el-alert
            v-if="distributionProfile"
            class="distribution-profile-alert"
            type="info"
            :closable="false"
            show-icon
          >
            <template #title>{{ distributionProfile.name }}</template>
            <div class="distribution-profile-copy">{{ distributionProfile.description }}</div>
            <div class="distribution-profile-copy">
              {{ distributionProfile.smart_routing_entry
                ? '银子 API：先填一个 Key 就能开始使用文本、生图和视频；需要备用渠道时，再分别添加图片或视频配置。'
                : '银子 API：文本、图片和视频都可以分别保存多个配置；不懂时先填一个常用配置即可。' }}
            </div>
          </el-alert>
          <!-- 普通模式操作栏 -->
          <div v-if="!vendorLock.enabled" class="content-actions">
            <div class="actions-left">
              <el-button type="primary" @click="openAdd">
                <el-icon><Plus /></el-icon>
                添加配置
              </el-button>
              <el-button plain @click="exportConfigs">
                <el-icon><Download /></el-icon>
                导出配置
              </el-button>
              <el-button plain @click="triggerImport">
                <el-icon><Upload /></el-icon>
                导入配置
              </el-button>
              <el-button plain @click="$router.push('/advanced-settings')">
                <el-icon><Setting /></el-icon>
                高级设置
              </el-button>
              <input ref="importFileRef" type="file" accept=".json" style="display:none" @change="importConfigs" />
              <el-button type="primary" plain @click="openOneKeyYinzi">
                <el-icon><MagicStick /></el-icon>
                一键配置银子 API
              </el-button>
              <el-button type="primary" plain @click="openOneKeyImageYinzi">
                <el-icon><MagicStick /></el-icon>
                配置银子媒体站
              </el-button>
              <el-button v-if="distributionProfile?.id === 'universal'" type="primary" plain @click="openOneKeyLaoli">
                <el-icon><MagicStick /></el-icon>
                配置老李站点（三 Key）
              </el-button>
              <el-button type="success" plain @click="openOneKeyVolc">
                <el-icon><MagicStick /></el-icon>
                一键配置火山
              </el-button>
              <el-button type="success" plain @click="openOneKeyAgnes">
                <el-icon><MagicStick /></el-icon>
                一键配置 Agnes
              </el-button>
              <el-button type="info" plain @click="openOneKeyTongyi">
                <el-icon><MagicStick /></el-icon>
                一键配置通义
                <span class="one-key-not-recommended">不推荐</span>
              </el-button>
            </div>
            <div class="actions-right">
              <transition name="fade-slide">
                <el-button
                  v-if="selectedRows.length > 0"
                  type="danger"
                  :loading="batchDeleting"
                  @click="onBatchDelete"
                >
                  <el-icon><Delete /></el-icon>
                  删除选中 ({{ selectedRows.length }})
                </el-button>
              </transition>
            </div>
          </div>
          <!-- 锁定模式提示栏 -->
          <div v-else class="vendor-lock-bar">
            <el-alert
              type="info"
              :closable="false"
              class="vendor-lock-tip"
            >
              <template #title>
                <span>🔒 当前为厂商锁定模式，AI 服务由管理员统一配置。你只能修改 <b>API Key</b> 和 <b>默认模型</b>。</span>
              </template>
            </el-alert>
            <el-button type="primary" size="small" class="vendor-bulk-key-btn" @click="openBulkKey">
              <el-icon><Key /></el-icon>
              一键换Key
            </el-button>
            <el-button size="small" @click="$router.push('/advanced-settings')">
              <el-icon><Setting /></el-icon>高级设置
            </el-button>
          </div>
          <p class="default-tip">每种服务类型仅有一个默认配置：文本用于生成故事；文本生成图片用于角色/场景/道具图；分镜图片生成用于分镜图（支持参考图）；视频用于生成视频；语音合成 TTS 用于分镜配音；即梦2角色认证用于创作页 SD2 认证（网关 Token）；SD2 资产库用于官方 ModelArk 私有资产（在未配置即梦2角色认证时供 SD2 认证使用）。</p>
          <el-table
            v-loading="loading"
            :data="list"
            stripe
            style="width: 100%"
            :row-class-name="configRowClassName"
            @selection-change="onSelectionChange"
          >
            <el-table-column v-if="!vendorLock.enabled" type="selection" width="46" />
            <el-table-column prop="name" label="名称" min-width="130" />
            <el-table-column prop="provider" label="提供商" width="96" />
            <el-table-column prop="base_url" label="Base URL" min-width="170" show-overflow-tooltip />
            <el-table-column prop="default_model" label="默认模型" min-width="130" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.default_model || (Array.isArray(row.model) && row.model[0]) || '—' }}
              </template>
            </el-table-column>
            <el-table-column label="用途 / 状态" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="['config-status', row.is_active === false ? 'is-off' : 'is-on']">{{ row.is_active === false ? '已停用' : '可用候选' }}</span>
                <small v-if="row.metadata?.note" class="config-note">{{ row.metadata.note }}</small>
              </template>
            </el-table-column>
            <el-table-column prop="service_type" label="类型" width="148">
              <template #default="{ row }">
                <span :class="['type-badge', 'type-' + row.service_type]">
                  <el-icon class="type-icon">
                    <ChatDotRound v-if="row.service_type === 'text'" />
                    <Picture v-else-if="row.service_type === 'image'" />
                    <Film v-else-if="row.service_type === 'storyboard_image'" />
                    <VideoCamera v-else-if="row.service_type === 'video'" />
                    <Microphone v-else-if="row.service_type === 'tts'" />
                    <Key v-else-if="row.service_type === 'jimeng2_character_auth'" />
                    <Folder v-else-if="row.service_type === 'model_ark_asset'" />
                  </el-icon>
                  {{ serviceTypeLabel(row.service_type) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="is_default" label="默认" width="60">
              <template #default="{ row }">
                <el-tag v-if="row.is_default" type="success" size="small">✓</el-tag>
                <span v-else class="no-default">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="250" fixed="right">
              <template #default="{ row }">
                <el-button
                  link
                  type="primary"
                  size="small"
                  :loading="testingConfigId === row.id"
                  @click="openTest(row)"
                >测试</el-button>
                <el-button
                  v-if="row.service_type === 'video'"
                  link
                  type="primary"
                  size="small"
                  :loading="discoveringConfigId === row.id"
                  @click="discoverConfigModels(row)"
                >模型与能力</el-button>
                <el-button link type="primary" size="small" @click="onRowEdit(row)">{{ vendorLock.enabled ? '修改Key' : '编辑' }}</el-button>
                <el-button v-if="!vendorLock.enabled" link type="danger" size="small" @click="onDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
      <el-tab-pane label="高级设置（提示词）" name="prompts">
        <div class="tab-content">
          <PromptEditor />
        </div>
      </el-tab-pane>
      <el-tab-pane label="高级设置（业务场景）" name="sceneModelMap">
        <div class="tab-content">
          <SceneModelMap />
        </div>
      </el-tab-pane>
      <el-tab-pane label="生成设置" name="generation">
        <div class="tab-content generation-settings">
          <div class="gs-section-title">⚡ 一键生成并发设置</div>
          <p class="gs-desc">控制「一键生成视频」和「补全并生成」流水线中，各类任务同时并行生成的数量。并发数越高速度越快，但过高可能触发 API 限流（429 错误）。建议根据你的 API 额度选择。</p>

          <div class="gs-row">
            <span class="gs-label">图片并发数</span>
            <el-select
              v-model="genConcurrencyInput"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入并发数"
              style="width: 180px"
              @change="onConcurrencyChange"
            >
              <el-option label="1（串行，最稳定）" :value="1" />
              <el-option label="2" :value="2" />
              <el-option label="3（默认）" :value="3" />
              <el-option label="5" :value="5" />
              <el-option label="8" :value="8" />
              <el-option label="10" :value="10" />
            </el-select>
            <span class="gs-unit">个任务同时生成</span>
          </div>

          <div class="gs-row" style="margin-top: 10px">
            <span class="gs-label">视频并发数</span>
            <el-select
              v-model="genVideoConcurrencyInput"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入并发数"
              style="width: 180px"
              @change="onVideoConcurrencyChange"
            >
              <el-option label="1（串行，最稳定）" :value="1" />
              <el-option label="2" :value="2" />
              <el-option label="3（默认）" :value="3" />
              <el-option label="5" :value="5" />
              <el-option label="8" :value="8" />
              <el-option label="10" :value="10" />
            </el-select>
            <span class="gs-unit">个任务同时生成</span>
          </div>

          <div style="margin-top: 14px">
            <el-button
              type="primary"
              size="small"
              :loading="genSettingSaving"
              @click="saveGenerationSettings"
            >保存</el-button>
          </div>
          <el-alert
            v-if="genSettingSaved"
            type="success"
            title="已保存"
            :closable="false"
            show-icon
            style="margin-top: 12px; width: fit-content"
          />
          <div class="gs-tip-box">
            <div class="gs-tip-title">📌 适用范围</div>
            <ul class="gs-tip-list">
              <li>图片并发：步骤 2 角色图、步骤 4 场景图、步骤 6 分镜图</li>
              <li>视频并发：步骤 7 分镜视频</li>
            </ul>
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane label="SD2 资产管理" name="sd2_assets">
        <div class="tab-content">
          <Sd2AssetManagement :configs="list" @saved="loadList" />
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="modelDiscoveryVisible" title="视频模型与能力提示" width="min(820px, 94vw)">
      <el-alert
        v-if="modelDiscoveryError"
        type="warning"
        :closable="false"
        show-icon
        :title="modelDiscoveryError"
      />
      <div class="model-discovery-body">
        <div class="model-discovery-summary">
          <span><small>配置</small><strong>{{ modelDiscoveryTarget?.name || '视频配置' }}</strong></span>
          <span><small>Base URL</small><strong>{{ modelDiscoveryTarget?.base_url || '未填写' }}</strong></span>
          <span><small>读取结果</small><strong>{{ modelDiscoveryRows.length }} 个模型</strong></span>
        </div>
        <div class="capability-manual-entry">
          <el-input v-model="modelCapabilityManualName" clearable placeholder="目录没有返回时，也可直接输入模型名维护本地能力提示" @keyup.enter="openManualCapabilityEditor" />
          <el-button type="primary" plain :disabled="!modelCapabilityManualName.trim()" @click="openManualCapabilityEditor">编辑此模型提示</el-button>
        </div>
        <el-table :data="modelDiscoveryRows" stripe max-height="56vh">
          <el-table-column prop="model" label="模型" min-width="260" show-overflow-tooltip />
          <el-table-column label="能力状态" width="120">
            <template #default="{ row }">
              <el-tag size="small" effect="plain" :type="row.contract_status === 'known' ? 'success' : row.contract_status === 'local' ? 'primary' : 'warning'">
                {{ row.contract_status === 'known' ? '内置' : row.contract_status === 'local' ? '本地提示' : '待补充' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="自动选模" width="105">
            <template #default="{ row }">{{ row.automatic_eligible ? '可用' : '手动选择' }}</template>
          </el-table-column>
          <el-table-column label="分组 / 价格" min-width="180">
            <template #default="{ row }">
              {{ Array.isArray(row.groups) && row.groups.length ? row.groups.join('、') : '当前 Key 范围' }}
            </template>
          </el-table-column>
          <el-table-column label="本地能力提示" width="180" fixed="right">
            <template #default="{ row }">
              <div class="capability-actions">
                <el-tag size="small" effect="plain" :type="row.local_capability_override ? 'success' : 'info'">
                  {{ row.local_capability_override ? '已配置本地提示' : '使用默认提示' }}
                </el-tag>
                <span>
                  <el-button link type="primary" size="small" @click="openCapabilityEditor(row)">编辑</el-button>
                  <el-button v-if="row.local_capability_override" link type="warning" size="small" @click="resetCapability(row)">恢复默认</el-button>
                </span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer><el-button @click="modelDiscoveryVisible = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="capabilityEditorVisible" title="编辑模型能力提示" width="min(760px, 94vw)" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        :title="`${capabilityEditorTarget?.model || '当前模型'}：这些是本地提示，不会限制手动选择或强制携带参考素材。只有勾选自动选择授权后，自动模式才会使用它。`"
      />
      <el-form label-position="top" class="capability-editor-form">
        <div class="capability-editor-grid">
          <el-form-item label="时长模式">
            <el-select v-model="capabilityEditorForm.duration_mode" clearable>
              <el-option label="自由时长" value="free" />
              <el-option label="范围时长" value="range" />
              <el-option label="固定时长" value="fixed" />
            </el-select>
          </el-form-item>
          <el-form-item label="分辨率提示">
            <el-input v-model="capabilityEditorForm.resolution" clearable placeholder="例如 480p、720p、2k" />
          </el-form-item>
          <el-form-item label="最短秒数">
            <el-input-number v-model="capabilityEditorForm.duration_min" :min="0" :max="3600" :precision="2" controls-position="right" />
          </el-form-item>
          <el-form-item label="最长秒数">
            <el-input-number v-model="capabilityEditorForm.duration_max" :min="0" :max="3600" :precision="2" controls-position="right" />
          </el-form-item>
          <el-form-item label="固定秒数">
            <el-input-number v-model="capabilityEditorForm.fixed_duration_seconds" :min="0" :max="3600" :precision="2" controls-position="right" />
          </el-form-item>
          <el-form-item label="最大参考图片数">
            <el-input-number v-model="capabilityEditorForm.max_images" :min="0" :max="1000" controls-position="right" />
          </el-form-item>
          <el-form-item label="最大参考视频数">
            <el-input-number v-model="capabilityEditorForm.max_videos" :min="0" :max="1000" controls-position="right" />
          </el-form-item>
          <el-form-item label="最大参考音频数">
            <el-input-number v-model="capabilityEditorForm.max_audios" :min="0" :max="1000" controls-position="right" />
          </el-form-item>
          <el-form-item label="最大参考总数">
            <el-input-number v-model="capabilityEditorForm.max_total_references" :min="0" :max="2000" controls-position="right" />
          </el-form-item>
          <el-form-item label="参考视频总秒数上限">
            <el-input-number v-model="capabilityEditorForm.max_reference_video_seconds_total" :min="0" :max="3600" :precision="2" controls-position="right" />
          </el-form-item>
          <el-form-item label="自动选择授权">
            <el-checkbox v-model="capabilityEditorForm.automatic_eligible">允许自动模式把它作为候选</el-checkbox>
          </el-form-item>
          <el-form-item label="昂贵模型标记">
            <el-checkbox v-model="capabilityEditorForm.expensive_bypass">需要单独确认费用</el-checkbox>
          </el-form-item>
        </div>
        <el-form-item label="自动选择适用镜头类型">
          <el-checkbox-group v-model="capabilityEditorForm.route_profiles">
            <el-checkbox label="short_image_guided">短镜头 / 图片引导</el-checkbox>
            <el-checkbox label="long_previs_guided">长镜头 / 连续动作</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="媒体角色（高级，可选 JSON）">
          <el-input v-model="capabilityEditorForm.roles_json" type="textarea" :rows="3" placeholder='例如 {"image":["reference"],"video":["reference"],"audio":["reference"]}' />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="capabilityEditorVisible = false">取消</el-button>
        <el-button type="primary" :loading="capabilityEditorSaving" @click="saveCapabilityEditor">保存本地提示</el-button>
      </template>
    </el-dialog>

    <!-- 添加/编辑 -->
    <el-dialog
      v-model="dialogVisible"
      :title="vendorLock.enabled ? '修改 API Key / 默认模型' : (editingId ? '编辑配置' : '添加配置')"
      width="520px"
      :close-on-click-modal="false"
      @closed="resetForm"
    >
      <!-- 锁定模式：只展示 api_key 和 default_model -->
      <template v-if="vendorLock.enabled">
        <el-descriptions :column="1" border style="margin-bottom: 16px">
          <el-descriptions-item label="名称">{{ form.name }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ serviceTypeLabel(form.service_type) }}</el-descriptions-item>
          <el-descriptions-item label="厂商">{{ form.provider }}</el-descriptions-item>
        </el-descriptions>
        <el-form ref="formRef" :model="form" label-width="100px">
          <el-form-item prop="api_key" :rules="rules.api_key">
            <template #label><span class="form-label-tip">API Key</span></template>
            <el-input
              v-model="form.api_key"
              type="password"
              :placeholder="editingId && list.find((item) => item.id === editingId)?.has_api_key ? '已保存，留空保持不变' : (form.provider === 'jimeng_ai_api' ? '即梦 Session，多个用英文逗号分隔' : '输入你的 API 密钥')"
              show-password
            />
          </el-form-item>
          <el-form-item>
            <template #label><span class="form-label-tip">默认模型</span></template>
            <el-select v-model="form.default_model" clearable style="width: 100%">
              <el-option v-for="m in formModelList" :key="m" :label="m" :value="m" />
            </el-select>
            <p class="field-tip">实际调用时使用的模型，可从预设列表中选择。</p>
          </el-form-item>
          <el-form-item>
            <template #label>
              <span class="form-label-tip">设为默认
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      每种服务类型只有一个「默认」配置。<br>
                      生成时系统会优先使用默认配置，建议每类至少设一个默认。
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-switch v-model="form.is_default" />
          </el-form-item>
        </el-form>
      </template>

      <!-- 普通模式：完整表单 -->
      <el-form v-else ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item prop="service_type">
          <template #label>
            <span class="form-label-tip">服务类型
              <el-tooltip placement="top" :show-arrow="true" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    <b>文本/对话</b>：用于 AI 生成故事剧本<br>
                    <b>文本生成图片</b>：角色、场景、道具的图片生成（不支持参考图）<br>
                    <b>分镜图片生成</b>：生成分镜图片，支持传入角色参考图<br>
                    <b>视频生成</b>：根据分镜图生成视频片段<br>
                    <b>语音合成 TTS</b>：为分镜对白自动合成语音（点分镜配音按钮时使用）<br>
                    <b>即梦2角色认证</b>：将角色主图登记到即梦业务素材库（SD2 认证），仅填网关 URL 与 Token
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select v-model="form.service_type" placeholder="选择类型" style="width: 100%" @change="onServiceTypeChange">
            <el-option label="文本/对话" value="text" />
            <el-option label="文本生成图片" value="image" />
            <el-option label="分镜图片生成" value="storyboard_image" />
            <el-option label="视频生成" value="video" />
            <el-option label="语音合成 TTS" value="tts" />
            <el-option label="即梦2角色认证" value="jimeng2_character_auth" />
          </el-select>
        </el-form-item>
        <el-form-item prop="provider">
          <template #label>
            <span class="form-label-tip">厂商
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    从下拉选择预设厂商，会自动填入 Base URL 和模型列表。<br>
                    也可直接输入自定义厂商名（需手动填写其他字段）。<br>
                    <b>推荐</b>：通义千问 / 火山引擎，国内访问稳定。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select
            v-model="form.provider"
            placeholder="选择预设厂商（自动填充 URL 和模型）"
            clearable
            filterable
            allow-create
            default-first-option
            style="width: 100%"
            @change="onProviderChange"
          >
            <el-option
              v-for="p in availableProviderOptions"
              :key="p.id"
              :label="p.name"
              :value="p.id"
              :class="p.id === '__custom__' ? 'provider-custom-option' : ''"
            />
          </el-select>
        </el-form-item>
        <!-- 接口规范：仅图片/分镜/视频类型显示，预设厂商自动填充；自定义厂商必选 -->
        <el-form-item v-if="form.service_type !== 'text' && form.service_type !== 'tts' && form.service_type !== 'jimeng2_character_auth'">
          <template #label>
            <span class="form-label-tip">接口规范
              <el-icon class="tip-icon" style="cursor:pointer;color:#409eff" @click="showProtocolHelp = true"><QuestionFilled /></el-icon>
            </span>
          </template>
          <el-select v-model="form.api_protocol" style="width: 100%" placeholder="选择接口规范（自定义厂商必选）" clearable>
            <el-option label="OpenAI 兼容（大多数中转站默认）" value="openai" />
            <el-option label="火山引擎（豆包 Seedream / Seedance）" value="volcengine" />
            <el-option label="火山即梦 Seedance 全能（方舟多图参考，Seedance 2.0 等）" value="volcengine_omni" />
            <el-option label="通义万象 DashScope" value="dashscope" />
            <el-option label="Google Gemini（图片 / Veo 视频）" value="gemini" />
            <el-option label="Sora 中转站（multipart/form-data，seconds+size）" value="sora" />
            <el-option label="Veo3 兼容（JSON，images+enhance_prompt，自动翻译英文）" value="veo3" />
            <el-option label="Vidu 视频" value="vidu" />
            <el-option label="可灵 Omni-Video（官方 api-beijing / ffir 中转，O1 全能）" value="kling_omni" />
            <el-option label="xAI Grok Imagine（官方 prompt + aspect_ratio，/v1/videos/generations）" value="xai" />
            <el-option label="NanoBanana" value="nano_banana" />
          </el-select>
        </el-form-item>

        <!-- 接口规范帮助 Dialog -->
        <el-dialog v-model="showProtocolHelp" title="接口规范说明" width="700px" top="5vh">
          <div class="protocol-help">
            <div class="ph-section-title">🖼 图片 / 分镜图 协议</div>
            <el-collapse accordion>
              <el-collapse-item name="openai-img">
                <template #title><span class="ph-tag ph-tag-img">图片</span> OpenAI 兼容 — 绝大多数中转站默认</template>
                <div class="ph-body">
                  <b>适用场景：</b>OpenAI 官方、各类中转/代理站（ChatFire、硅基流动等）<br>
                  <b>Endpoint：</b><code>POST /v1/images/generations</code><br>
                  <pre>{ "model": "dall-e-3", "prompt": "...", "n": 1, "size": "1024x1024" }</pre>
                </div>
              </el-collapse-item>
              <el-collapse-item name="volcengine-img">
                <template #title><span class="ph-tag ph-tag-img">图片</span> 火山引擎 — 豆包 Seedream</template>
                <div class="ph-body">
                  <b>Endpoint：</b><code>POST /api/v3/images/generations</code><br>
                  <b>Base URL：</b><code>https://ark.cn-beijing.volces.com/api/v3</code><br>
                  <pre>{ "model": "doubao-seedream-4-5-251128", "prompt": "...", "size": "1024x1024" }</pre>
                </div>
              </el-collapse-item>
              <el-collapse-item name="dashscope-img">
                <template #title><span class="ph-tag ph-tag-img">图片</span> 通义万象 DashScope</template>
                <div class="ph-body">
                  <b>Base URL：</b><code>https://dashscope.aliyuncs.com</code><br>
                  <b>Endpoint：</b><code>POST /api/v1/services/aigc/text2image/image-synthesis</code>
                </div>
              </el-collapse-item>
              <el-collapse-item name="gemini-img">
                <template #title><span class="ph-tag ph-tag-img">图片</span> Google Gemini</template>
                <div class="ph-body">
                  <b>认证：</b>URL 参数 <code>?key=API_KEY</code><br>
                  <b>Endpoint：</b><code>POST /v1beta/models/{model}:generateContent</code>
                </div>
              </el-collapse-item>
            </el-collapse>

            <div class="ph-section-title" style="margin-top:16px">🎬 视频 协议</div>
            <el-collapse accordion>
              <el-collapse-item name="openai-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> OpenAI 兼容 — content 数组格式</template>
                <div class="ph-body">
                  <b>适用场景：</b>各类中转站视频接口（ChatFire 等）<br>
                  <b>Endpoint：</b>自定义，如 <code>POST /v1/video/create</code><br>
                  <pre>{ "model": "sora-2-pro",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "reference_image" }
  ],
  "ratio": "9:16", "duration": 5, "watermark": false, "resolution": "720p" }</pre>
                </div>
              </el-collapse-item>
              <el-collapse-item name="sora-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> Sora 中转站 — multipart/form-data</template>
                <div class="ph-body">
                  <b>适用场景：</b>Sora API 格式的中转站<br>
                  <b>默认 Endpoint：</b><code>POST /v1/videos</code>（创建），<code>GET /v1/videos/{taskId}</code>（查询）<br>
                  <b>请求格式：</b>multipart/form-data（非 JSON）<br>
                  <pre>model       = "sora-2"
prompt      = "..."
seconds     = "4" | "8" | "12"
size        = "720x1280" | "1280x720" | "1024x1792" | "1792x1024"
watermark   = "false"
private     = "false"
input_reference = (图片文件，可选)</pre>
                  <b>注意：</b>参考图会自动 resize 到与 size 一致后上传。
                </div>
              </el-collapse-item>
              <el-collapse-item name="veo3-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> Veo3 兼容 — images + enhance_prompt</template>
                <div class="ph-body">
                  <b>适用场景：</b>Veo3 系列模型的 JSON 格式接口<br>
                  <b>默认 Endpoint：</b><code>POST /v1/video/create</code>（创建），<code>GET /v1/video/query?id={taskId}</code>（查询）<br>
                  <pre>{ "model": "veo3.1",
  "prompt": "...",
  "enhance_prompt": true,
  "images": ["data:image/jpeg;base64,..."]
}</pre>
                  <b>注意：</b><code>enhance_prompt: true</code> 会让接口自动将提示词翻译为英文。localhost 图片会自动转为 base64 内嵌。
                </div>
              </el-collapse-item>
              <el-collapse-item name="volcengine-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> 火山引擎 — 豆包 Seedance</template>
                <div class="ph-body">
                  <b>Endpoint：</b><code>POST …/contents/generations/tasks</code>（与后端一致）<br>
                  <b>Base URL：</b><code>https://ark.cn-beijing.volces.com/api/v3</code><br>
                  <pre>{ "model": "doubao-seedance-1-5-pro-251215",
  "content": [{ "type": "text", "text": "..." }],
  "ratio": "9:16", "duration": 5,
  "watermark": false, "resolution": "720p" }</pre>
                </div>
              </el-collapse-item>
              <el-collapse-item name="volcengine-omni-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> 火山即梦 Seedance 全能（多图参考）</template>
                <div class="ph-body">
                  <b>适用：</b>方舟 Seedance 2.0 等支持多参考图的全能链路；与「全能模式」分镜、<code>@图片1</code>… 提示词配合使用。<br>
                  <b>Endpoint：</b><code>POST {base}/contents/generations/tasks</code>，轮询 <code>GET {base}/contents/generations/tasks/{taskId}</code><br>
                  <b>厂商：</b>仍选「火山引擎」，<b>接口规范</b>选本项；模型填控制台接入点（如 <code>doubao-seedance-2-0-260128</code>，以控制台为准）。<br>
                  <pre>{ "model": "doubao-seedance-2-0-260128",
  "task_type": "i2v",
  "content": [
    { "type": "text", "text": "… @图片1 … @图片2 …" },
    { "type": "image_url", "image_url": { "url": "https://..." } },
    { "type": "image_url", "image_url": { "url": "https://..." }, "role": "reference_image" }
  ],
  "ratio": "9:16", "duration": 8, "watermark": false }</pre>
                  <b>说明：</b>全能模式下列均为参考图（场景、角色…），每张均 <code>role: reference_image</code>；最多 9 张，时长 Seedance 2.x 按 4–15 秒吸附。
                </div>
              </el-collapse-item>
              <el-collapse-item name="dashscope-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> 通义万象 DashScope</template>
                <div class="ph-body">
                  <b>Base URL：</b><code>https://dashscope.aliyuncs.com</code><br>
                  <b>Endpoint：</b><code>POST /api/v1/services/aigc/video-generation/video-synthesis</code><br>
                  <pre>{ "model": "wan2.2-kf2v-flash",
  "input": { "prompt": "...", "img_url": "https://..." },
  "parameters": { "size": "1280*720", "duration": 5 } }</pre>
                </div>
              </el-collapse-item>
              <el-collapse-item name="gemini-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> Google Gemini — Veo 视频</template>
                <div class="ph-body">
                  <b>认证：</b>URL 参数 <code>?key=API_KEY</code><br>
                  <b>Endpoint：</b><code>POST /v1beta/models/{model}:generateVideo</code>
                </div>
              </el-collapse-item>
              <el-collapse-item name="vidu-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> Vidu</template>
                <div class="ph-body">
                  <b>适用场景：</b>Vidu 官方及兼容接口<br>
                  <b>认证：</b><code>Authorization: Token {api_key}</code>（非 Bearer）<br>
                  <b>默认 Endpoint：</b><code>POST /ent/v2/img2video</code>（创建），<code>GET /ent/v2/tasks/{taskId}/creations</code>（查询）<br>
                  <pre>{ "model": "viduq3-pro",
  "images": ["https://..."],
  "prompt": "...",
  "duration": 5,
  "resolution": "720p",
  "movement_amplitude": "auto",
  "audio": false,
  "watermark": false
}</pre>
                  <b>注意：</b>官方 api.vidu.cn 用 <code>Token</code> 认证，中转站用 <code>Bearer</code>，系统自动识别。localhost 图片自动上传图床。
                </div>
              </el-collapse-item>
              <el-collapse-item name="jimeng-ai-api-vid">
                <template #title><span class="ph-tag ph-tag-vid">视频</span> Jimeng AI API（自建服务）</template>
                <div class="ph-body">
                  <b>说明：</b>需自行部署 <code>jimeng-free-api-all</code> 等即梦 OpenAI 兼容服务并启动（如 <code>http://127.0.0.1:8000</code>）。本系统仅作为客户端转发请求。<br>
                  <b>Base URL：</b>填你的服务根地址，无尾斜杠。<br>
                  <b>API Key：</b>填即梦网页 <b>Session</b>；多个账号用<b>英文逗号</b>分隔，由对方服务轮询使用。<br>
                  <b>默认路径：</b><code>POST /v1/videos/generations</code>（可在「Endpoint」覆盖）。Seedance 多图需分镜参考图；响应为同步 <code>data[0].url</code>。
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
          <template #footer>
            <el-button @click="showProtocolHelp = false">关闭</el-button>
          </template>
        </el-dialog>
        <el-form-item prop="name">
          <template #label>
            <span class="form-label-tip">名称
              <el-tooltip content="配置的显示名，用于在列表中区分不同配置，选择厂商后可自动生成。" placement="top" popper-class="cfg-tip-popper">
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input v-model="form.name" placeholder="如：OpenAI 图文，可自动生成" />
        </el-form-item>
        <el-form-item>
          <template #label><span class="form-label-tip">备注 / 用途</span></template>
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="例如：人文社科与剧本；用于审美复核；可写给自己看的提示" />
          <p class="field-tip">备注只帮助 Codex 选择候选，不会发送给上游模型。</p>
        </el-form-item>
        <el-form-item>
          <template #label><span class="form-label-tip">任务标签</span></template>
          <el-input v-model="form.useCasesText" placeholder="剧本、研究、分镜、字幕（用逗号分隔，可留空）" />
        </el-form-item>
        <el-form-item prop="base_url">
          <template #label>
            <span class="form-label-tip">{{ form.service_type === 'jimeng2_character_auth' ? '网关 URL' : 'Base URL' }}
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    <template v-if="form.service_type === 'jimeng2_character_auth'">
                      即梦业务素材库网关的<b>根地址</b>（不含 <code>/api/business/v1</code> 路径）。须与素材库实际部署一致。
                    </template>
                    <template v-else>
                      API 接口地址，选择预设厂商后自动填入，一般无需修改。<br>
                      示例：https://dashscope.aliyuncs.com
                    </template>
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input
            v-model="form.base_url"
            :placeholder="form.service_type === 'jimeng2_character_auth' ? '如 https://your-gateway.com' : '选择预设厂商后自动填充，可修改'"
          />
        </el-form-item>
        <el-form-item prop="api_key">
          <template #label>
            <span class="form-label-tip">{{ form.service_type === 'jimeng2_character_auth' ? 'Token' : 'API Key' }}
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    <template v-if="form.service_type === 'jimeng2_character_auth'">
                      素材库要求的 <code>Authorization: Bearer …</code> Token，由网关或即梦侧签发。
                    </template>
                    <template v-else>
                      在对应 AI 平台申请的密钥，用于身份验证。<br>
                      通义：<b>dashscope.aliyuncs.com</b><br>
                      火山：<b>console.volcengine.com/ark</b>
                    </template>
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input
            v-model="form.api_key"
            type="password"
            :placeholder="editingId && list.find((item) => item.id === editingId)?.has_api_key ? '已保存，留空保持不变' : (form.service_type === 'jimeng2_character_auth' ? 'Bearer Token' : (form.provider === 'jimeng_ai_api' ? '即梦 Session，多个用英文逗号分隔' : 'API 密钥'))"
            show-password
          />
        </el-form-item>
        <el-form-item v-if="form.service_type === 'jimeng2_character_auth'">
          <template #label><span class="form-label-tip">素材列表</span></template>
          <div class="jimeng2-assets-actions">
            <el-button type="primary" plain :loading="jimeng2AssetsLoading" @click="openJimeng2MaterialAssetsDialog">
              列出素材
            </el-button>
            <span class="field-tip jimeng2-assets-tip">
              调用网关
              <code>GET /api/business/v1/assets</code>
              ，与
              <a href="https://83zi.com/sd2realperson.html" target="_blank" rel="noopener noreferrer">素材管理 API 文档</a>
              一致（使用当前表单中的网关 URL 与 Token，无需先保存）。
            </span>
          </div>
        </el-form-item>
        <el-alert
          v-if="form.service_type === 'jimeng2_character_auth'"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
          title="用于创作页「角色生成 → SD2认证」"
          description="保存后，系统从此处读取网关与 Token 调用 POST /api/business/v1/assets 登记角色图；可用「列出素材」核对素材状态。角色主图需为外网可访问的 http(s) 地址（图床或本服务 storage.base_url）。"
        />
        <template v-if="form.service_type === 'video' && form.api_protocol === 'kling_omni'">
          <el-form-item>
            <template #label><span class="form-label-tip">AccessKey</span></template>
            <el-input
              v-model="form.kling_access_key"
              type="password"
              show-password
              placeholder="可灵开放平台 AccessKey（与 SecretKey 成对，可不填上方 API Key）"
              autocomplete="off"
            />
            <p class="field-tip">
              官方 JWT 规则见
              <a href="https://klingai.com/document-api/apiReference/commonInfo" target="_blank" rel="noopener noreferrer">commonInfo</a>
              （<a href="https://app.klingai.com/cn/dev/document-api/apiReference/commonInfo" target="_blank" rel="noopener noreferrer">中文版</a>）。
              后端使用与官方示例一致的 HS256（<code>iss</code>=AccessKey，<code>exp</code>、<code>nbf</code>）生成 Token。
              若接口返回 <code>1000 Authorization signature is invalid</code>：请确认 AccessKey/SecretKey 未填反、无多余空格；并尝试勾选下方「SecretKey 为 Base64」；
              Base URL 区域（<code>api-beijing.klingai.com</code> / <code>api-singapore.klingai.com</code>）须与密钥所属区域一致。
            </p>
          </el-form-item>
          <el-form-item>
            <template #label><span class="form-label-tip">SecretKey</span></template>
            <el-input
              v-model="form.kling_secret_key"
              type="password"
              show-password
              placeholder="可灵开放平台 SecretKey"
              autocomplete="off"
            />
            <el-checkbox v-model="form.kling_secret_key_base64" style="margin-top: 8px; display: block">
              SecretKey 为 Base64 字符串（解码后的二进制再用于签名；若仍报签名无效可切换此项重试）
            </el-checkbox>
            <p class="field-tip">
              官方域名：<code>POST {base}/v1/videos/omni-video</code>，轮询
              <code>GET {base}/v1/videos/omni-video/{taskId}</code>；飞儿等中转仍为
              <code>/kling/v1/videos/omni-video</code> 与
              <code>/kling/v1/images/omni-image/{taskId}</code>。详见
              <a href="https://klingai.com/document-api/apiReference/model/OmniVideo" target="_blank" rel="noopener noreferrer">OmniVideo</a>。
            </p>
          </el-form-item>
        </template>
        <!-- TTS 专属字段：声音 ID 和 MiniMax Group ID -->
        <template v-if="form.service_type === 'tts'">
          <el-form-item>
            <template #label>
              <span class="form-label-tip">声音 ID
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      TTS 合成使用的音色 ID。<br>
                      <b>MiniMax 常用音色：</b><br>
                      female-shaonv（少女）、female-chengshu（成熟）<br>
                      male-qingxin（清新男）、male-zhicheng（知城男）<br>
                      audiobook_female_2（有声书女）、audiobook_male_1（有声书男）
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-select
              v-model="form.voice_id"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入声音 ID"
              style="width: 100%"
            >
              <el-option-group label="MiniMax 女声">
                <el-option label="female-shaonv（少女）" value="female-shaonv" />
                <el-option label="female-chengshu（成熟）" value="female-chengshu" />
                <el-option label="female-tianmei（甜美）" value="female-tianmei" />
                <el-option label="audiobook_female_2（有声书）" value="audiobook_female_2" />
              </el-option-group>
              <el-option-group label="MiniMax 男声">
                <el-option label="male-qingxin（清新）" value="male-qingxin" />
                <el-option label="male-zhicheng（知城）" value="male-zhicheng" />
                <el-option label="audiobook_male_1（有声书）" value="audiobook_male_1" />
              </el-option-group>
            </el-select>
            <p class="field-tip">MiniMax 必填；不填默认 female-shaonv。</p>
          </el-form-item>
          <el-form-item>
            <template #label>
              <span class="form-label-tip">Group ID
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      MiniMax 账号的 GroupId，调用 T2A v2 接口时附在 URL 参数里。<br>
                      登录 <b>platform.minimaxi.com</b> → 账户设置 → 即可查看 GroupId。
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.group_id" placeholder="MiniMax GroupId，如 1234567890" />
            <p class="field-tip">仅 MiniMax T2A 需要此字段。</p>
          </el-form-item>
        </template>

        <!-- 端点配置：视频必填（自定义厂商）；图片/分镜在使用代理或特殊厂商时填写 -->
        <template v-if="form.service_type !== 'text' && form.service_type !== 'tts' && form.service_type !== 'jimeng2_character_auth'">
          <el-form-item>
            <template #label>
              <span class="form-label-tip">提交端点
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      接口路径，追加在 Base URL 之后。<br>
                      <b>预设厂商</b>（火山 / 通义 / NanoBanana）留空，系统自动推断。<br>
                      <b>视频自定义厂商</b>必须填写，如 /v1/videos/generations<br>
                      <b>NanoBanana 代理</b>填写代理路径，如 /fal-ai/nano-banana
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.endpoint" :placeholder="form.service_type === 'video' ? '自定义视频厂商必填，如 /v1/videos/generations；预设厂商留空' : '代理或特殊厂商时填写，如 /fal-ai/nano-banana；预设厂商留空'" />
          </el-form-item>
          <el-form-item>
            <template #label>
              <span class="form-label-tip">查询端点
                <el-tooltip placement="top" popper-class="cfg-tip-popper">
                  <template #content>
                    <div class="cfg-tip-content">
                      查询任务状态的接口路径，{taskId} 会被替换为实际任务 ID。<br>
                      <b>预设厂商</b>留空即可，由系统自动推断。<br>
                      <b>视频自定义厂商</b>必须填写，如 /v1/video/tasks/{taskId}<br>
                      <b>图片/NanoBanana</b> 代理若不支持轮询可留空
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.query_endpoint" placeholder="自定义视频厂商必填，如 /v1/video/tasks/{taskId}；预设厂商留空" />
          </el-form-item>
        </template>

        <!-- 接口地址预览：选择厂商/协议后自动展示，帮助用户核对 -->
        <div v-if="endpointPreviewInfo" class="endpoint-preview-box" :class="{ 'ep-box-gemini': endpointPreviewInfo.isGemini }">
          <div class="ep-preview-header">
            <span>📌 系统将使用以下接口地址</span>
            <span v-if="endpointPreviewInfo.isGemini" class="ep-auto-badge ep-badge-gemini">Gemini 固定模式</span>
            <span v-else-if="endpointPreviewInfo.isJimeng2Auth" class="ep-auto-badge">即梦2角色认证</span>
            <span v-else-if="endpointPreviewInfo.isAuto && form.service_type !== 'text'" class="ep-auto-badge">自动推断</span>
          </div>
          <div class="ep-row">
            <span class="ep-label">提交地址：</span>
            <code class="ep-url">{{ endpointPreviewInfo.submit }}</code>
          </div>
          <div v-if="endpointPreviewInfo.query" class="ep-row">
            <span class="ep-label">查询地址：</span>
            <code class="ep-url">{{ endpointPreviewInfo.query }}</code>
          </div>
          <p v-if="endpointPreviewInfo.isGemini" class="ep-tip ep-tip-warn">
            ⚠️ Gemini 端点由系统根据模型名固定生成，上方「提交端点」和「查询端点」字段对 Gemini 无效，填了也不生效。
          </p>
          <p v-else-if="endpointPreviewInfo.isJimeng2Auth" class="ep-tip">角色「SD2认证」将调用上述地址注册素材（POST 创建、GET 查询状态）。</p>
          <p v-else class="ep-tip">以上为系统推断的实际调用地址（可手动填写上方端点字段来覆盖）</p>
        </div>

        <template v-if="form.service_type !== 'jimeng2_character_auth'">
        <el-form-item>
          <template #label>
            <span class="form-label-tip">模型列表
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    该厂商下可用的模型，多个用逗号或换行分隔。<br>
                    可从上方「追加预设模型」下拉快速添加，也可手动输入。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <div class="model-row">
            <el-select
              v-model="presetModelPick"
              placeholder="追加预设模型"
              clearable
              filterable
              style="width: 220px; margin-bottom: 8px"
              @change="onPresetModelSelect"
            >
              <el-option v-for="m in availableModels" :key="m" :label="m" :value="m" />
            </el-select>
          </div>
          <el-input v-model="form.modelText" type="textarea" :rows="2" placeholder="选择预设厂商后自动填入，可编辑；多个用逗号或换行分隔" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="form-label-tip">默认模型
              <el-tooltip content="有多个模型时，实际调用哪个进行生成。建议选响应快、效果好的那个。" placement="top" popper-class="cfg-tip-popper">
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-select
            v-model="form.default_model"
            :placeholder="formModelList.length ? '从上面模型列表中选一个作为生成时使用的默认' : '请先填写上方模型列表'"
            clearable
            style="width: 100%"
          >
            <el-option v-for="m in formModelList" :key="m" :label="m" :value="m" />
          </el-select>
          <p class="field-tip">该配置被选为「默认」时，生成故事/图片/视频将使用此处指定的模型。</p>
        </el-form-item>
        <el-form-item v-if="isDeepSeekOfficialForm">
          <template #label>
            <span class="form-label-tip">思考模式
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    DeepSeek V4 官方模型用 thinking 参数控制思考模式。<br>
                    关闭思考对应旧 deepseek-chat；开启思考对应旧 deepseek-reasoner。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <div class="deepseek-settings">
            <el-radio-group v-model="form.deepseek_thinking">
              <el-radio-button label="disabled">关闭思考</el-radio-button>
              <el-radio-button label="enabled">开启思考</el-radio-button>
            </el-radio-group>
            <el-select
              v-if="form.deepseek_thinking === 'enabled'"
              v-model="form.deepseek_reasoning_effort"
              style="width: 140px"
            >
              <el-option label="high" value="high" />
              <el-option label="max" value="max" />
            </el-select>
          </div>
          <p class="field-tip">官方旧模型名将在 2026-07-24 废弃；新配置建议使用 deepseek-v4-flash 或 deepseek-v4-pro。</p>
        </el-form-item>
        </template>
        <el-form-item>
          <template #label>
            <span class="form-label-tip">优先级
              <el-tooltip content="同一服务类型有多个配置时，数字越大越优先被调用。默认 0，一般设为 10 即可。" placement="top" popper-class="cfg-tip-popper">
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input-number v-model="form.priority" :min="0" :max="999" />
        </el-form-item>
        <el-form-item v-if="['image', 'storyboard_image', 'video'].includes(form.service_type)">
          <template #label><span class="form-label-tip">能力 / 费用（可选）</span></template>
          <el-input v-model="form.capabilityJson" type="textarea" :rows="3" placeholder='例如 {"resolution":"4k","supports_reference":true,"price_cny":3.5,"price_unit":"每秒"}' />
          <p class="field-tip">仅作为本地候选提示；未知或留空也能保存，真正付费前仍以当前 Key 的实时目录为准。</p>
        </el-form-item>
        <el-form-item>
          <template #label><span class="form-label-tip">参与候选</span></template>
          <el-switch v-model="form.is_active" active-text="启用" inactive-text="停用" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="form-label-tip">设为默认
              <el-tooltip placement="top" popper-class="cfg-tip-popper">
                <template #content>
                  <div class="cfg-tip-content">
                    每种服务类型只有一个「默认」配置。<br>
                    生成时系统会优先使用默认配置，建议每类至少设一个默认。
                  </div>
                </template>
                <el-icon class="tip-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-switch v-model="form.is_default" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          v-if="form.service_type !== 'jimeng2_character_auth' && form.service_type !== 'model_ark_asset'"
          :loading="testingDraft"
          @click="testCurrentDraft"
        >测试当前填写</el-button>
        <el-button type="primary" :loading="saving" @click="submit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 一键配置通义 -->
    <!-- 银子媒体站（三 Key，兼容老李协议） -->
    <el-dialog
      v-model="oneKeyImageYinziVisible"
      title="配置银子媒体站（image.yinziapi.top）"
      width="620px"
      :close-on-click-modal="false"
      @closed="resetOneKeyImageYinzi"
    >
      <div class="one-key-help">
        <div class="one-key-section">
          <div class="one-key-section-title">📋 分别填写三类服务，自动创建 4 个配置</div>
          <ul class="one-key-list">
            <li><b>文本 / 剧本</b>：老李站点没有文本模型，请填写其它兼容文本站点；默认 gpt-5.6-sol</li>
            <li><b>图片 / 分镜图</b>：默认 gpt-image-2</li>
            <li><b>视频</b>：默认 Seedance 2.5-720（固定 30 秒），Seedance 2.0-720（5 / 10 / 15 秒）作为备用</li>
          </ul>
        </div>
        <div class="one-key-section">
          <div class="one-key-section-title">🔑 配置说明</div>
          <p class="one-key-note">这里需要分别填写文本、图片、视频的地址和 Key。保存后会自动创建配置，也可以在列表里继续修改。</p>
          <p class="one-key-note">站点地址：<a href="https://image.yinziapi.top/" target="_blank" class="one-key-link">image.yinziapi.top</a>。如果站点目录返回了新模型，仍可在对应配置的“发现模型”中刷新；未知能力不会阻止手动提交。</p>
        </div>
      </div>
      <el-form label-position="top" class="yinzi-config-form" style="margin-top: 12px">
        <div class="yinzi-field-grid">
          <el-form-item label="文本 Base URL" required><el-input v-model="oneKeyImageYinziForm.text_base_url" placeholder="https://文本站点/v1" clearable /></el-form-item>
          <el-form-item label="图片 Base URL" required><el-input v-model="oneKeyImageYinziForm.image_base_url" placeholder="https://image.yinziapi.top/v1" clearable /></el-form-item>
          <el-form-item label="视频 Base URL" required><el-input v-model="oneKeyImageYinziForm.video_base_url" placeholder="https://image.yinziapi.top/v1" clearable /></el-form-item>
        </div>
        <div class="yinzi-field-grid">
          <el-form-item label="文本 Key" required><el-input v-model="oneKeyImageYinziForm.text_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="文本分组 Key" /></el-form-item>
          <el-form-item label="文本模型"><el-input v-model="oneKeyImageYinziForm.text_model" /></el-form-item>
          <el-form-item label="图片 Key" required><el-input v-model="oneKeyImageYinziForm.image_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="图片分组 Key" /></el-form-item>
          <el-form-item label="图片模型"><el-input v-model="oneKeyImageYinziForm.image_model" /></el-form-item>
          <el-form-item label="视频 Key" required><el-input v-model="oneKeyImageYinziForm.video_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="视频分组 Key" /></el-form-item>
          <el-form-item label="默认视频模型"><el-select v-model="oneKeyImageYinziForm.video_model" filterable allow-create default-first-option><el-option label="Seedance 2.5-720（30 秒）" value="Seedance 2.5-720" /><el-option label="Seedance 2.0-720（5/10/15 秒）" value="Seedance 2.0-720" /></el-select></el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="oneKeyImageYinziVisible = false">取消</el-button>
        <el-button type="primary" :loading="oneKeyImageYinziSaving" :disabled="!oneKeyImageYinziReady" @click="submitOneKeyImageYinzi">确定，一键创建配置</el-button>
      </template>
    </el-dialog>

    <!-- 老李 NewAPI（三 Key，即梦 2.5/2.0 兼容） -->
    <el-dialog
      v-model="oneKeyLaoliVisible"
      title="配置老李站点（通用三 Key）"
      width="620px"
      :close-on-click-modal="false"
      @closed="resetOneKeyLaoli"
    >
      <div class="one-key-help">
        <div class="one-key-section">
          <div class="one-key-section-title">📋 一次填写三个 Key，自动创建 4 个配置</div>
          <ul class="one-key-list">
            <li><b>文本 / 剧本</b>：默认 gpt-5.6-sol</li>
            <li><b>图片 / 分镜图</b>：默认 gpt-image-2（图片 Key 共用）</li>
            <li><b>视频</b>：默认 3.5（即梦 2.5，固定 30 秒），3.0（即梦 2.0，5/10/15 秒）备用</li>
          </ul>
        </div>
        <div class="one-key-section">
          <div class="one-key-section-title">🔑 老李站点与文本服务</div>
          <p class="one-key-note">这里需要分别填写文本、图片、视频的地址和 Key；如果你还没有这些信息，可以先用上面的银子 API 一键配置。</p>
          <p class="one-key-note">图片 Key 同时用于资源图和分镜图。视频 3.5 固定 30 秒，3.0 支持 5 / 10 / 15 秒。保存后仍可在配置列表中自由修改。</p>
        </div>
      </div>
      <el-form label-position="top" class="yinzi-config-form" style="margin-top: 12px">
        <div class="laoli-service-block">
          <div class="one-key-section-title">文本服务（必填，独立站点）</div>
          <p class="one-key-note">老李没有文本模型；可填写任意兼容 OpenAI Chat Completions 的 NewAPI / sub2 地址。</p>
          <div class="yinzi-field-grid">
            <el-form-item label="文本 Base URL" required><el-input v-model="oneKeyLaoliForm.text_base_url" placeholder="https://你的文本站点/v1" clearable /></el-form-item>
            <el-form-item label="文本 Key" required><el-input v-model="oneKeyLaoliForm.text_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="文本分组 Key" /></el-form-item>
            <el-form-item label="文本模型"><el-input v-model="oneKeyLaoliForm.text_model" placeholder="gpt-5.6-sol" /></el-form-item>
          </div>
        </div>
        <div class="laoli-service-block">
          <div class="one-key-section-title">图片服务（老李）</div>
          <div class="yinzi-field-grid">
            <el-form-item label="图片 Base URL" required><el-input v-model="oneKeyLaoliForm.image_base_url" placeholder="https://video.laoliimage2.win/v1" clearable /></el-form-item>
            <el-form-item label="图片 Key" required><el-input v-model="oneKeyLaoliForm.image_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="图片分组 Key" /></el-form-item>
            <el-form-item label="图片模型"><el-input v-model="oneKeyLaoliForm.image_model" placeholder="gpt-image-2" /></el-form-item>
          </div>
        </div>
        <div class="laoli-service-block">
          <div class="one-key-section-title">视频服务（老李）</div>
          <div class="yinzi-field-grid">
            <el-form-item label="视频 Base URL" required><el-input v-model="oneKeyLaoliForm.video_base_url" placeholder="https://video.laoliimage2.win/v1" clearable /></el-form-item>
            <el-form-item label="视频 Key" required><el-input v-model="oneKeyLaoliForm.video_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="视频分组 Key" /></el-form-item>
            <el-form-item label="默认视频模型"><el-select v-model="oneKeyLaoliForm.video_model" filterable allow-create default-first-option><el-option label="3.5（即梦 2.5，30 秒）" value="3.5" /><el-option label="3.0（即梦 2.0，5/10/15 秒）" value="3.0" /></el-select></el-form-item>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="oneKeyLaoliVisible = false">取消</el-button>
        <el-button type="primary" :loading="oneKeyLaoliSaving" :disabled="!oneKeyLaoliReady" @click="submitOneKeyLaoli">确定，一键创建配置</el-button>
      </template>
    </el-dialog>

    <!-- 一键配置通义 -->
    <el-dialog
      v-model="oneKeyTongyiVisible"
      title="一键配置通义千问 / 万象（不推荐）"
      width="520px"
      :close-on-click-modal="false"
      @closed="oneKeyTongyiKey = ''"
    >
      <div class="one-key-help">
        <div class="one-key-section">
          <div class="one-key-section-title">📋 将自动创建以下配置</div>
          <ul class="one-key-list">
            <li><b>文本/对话</b>：通义千问（qwen-plus）— 生成故事剧本</li>
            <li><b>文本生成图片</b>：通义万象（wan2.6-image）— 角色/场景/道具图</li>
            <li><b>文本生成图片</b>：通义千问图像（qwen-image-max）— 角色/场景图备选</li>
            <li><b>分镜图片生成</b>：通义万象（wan2.6-image）— 支持角色参考图</li>
            <li><b>视频生成</b>：通义万相（wan2.2-kf2v-flash）— 生成视频片段</li>
          </ul>
        </div>
        <div class="one-key-section">
          <div class="one-key-section-title">🔑 如何申请 API Key</div>
          <ol class="one-key-list">
            <li>前往阿里云百炼控制台：<a href="https://bailian.console.aliyun.com/" target="_blank" class="one-key-link">bailian.console.aliyun.com</a></li>
            <li>注册/登录阿里云账号，开通「百炼」服务（新用户有免费额度）</li>
            <li>左侧菜单点击「API Key」→「创建 API Key」</li>
            <li>复制生成的 Key（格式：<code>sk-xxxxxxxx</code>）填入下方</li>
          </ol>
          <p class="one-key-note">💡 通义一个 Key 同时支持文本、图片、视频等所有服务</p>
        </div>
      </div>
      <el-form label-width="0" style="margin-top: 8px">
        <el-form-item>
          <el-input
            v-model="oneKeyTongyiKey"
            type="password"
            placeholder="请输入通义（DashScope）API Key，格式：sk-xxxxxxxx"
            show-password-on="click"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="oneKeyTongyiVisible = false">取消</el-button>
        <el-button type="success" :loading="oneKeyTongyiSaving" :disabled="!oneKeyTongyiKey.trim()" @click="submitOneKeyTongyi">
          确定，一键创建配置
        </el-button>
      </template>
    </el-dialog>

    <!-- 一键配置火山 -->
    <el-dialog
      v-model="oneKeyVolcVisible"
      title="一键配置火山引擎（方舟）"
      width="520px"
      :close-on-click-modal="false"
      @closed="oneKeyVolcKey = ''"
    >
      <div class="one-key-help">
        <div class="one-key-section">
          <div class="one-key-section-title">📋 将自动创建以下配置</div>
          <ul class="one-key-list">
            <li><b>文本/对话</b>：DeepSeek V3（deepseek-v3-2-251201）— 生成故事剧本</li>
            <li><b>文本生成图片</b>：即梦 4.5（doubao-seedream-4-5-251128）— 角色/场景/道具图</li>
            <li><b>分镜图片生成</b>：即梦 4.5（doubao-seedream-4-5-251128）— 支持角色参考图</li>
            <li><b>视频生成</b>：即梦 Seedance 1.5 Pro — 生成视频片段</li>
          </ul>
        </div>
        <div class="one-key-section">
          <div class="one-key-section-title">🔑 如何申请 API Key</div>
          <ol class="one-key-list">
            <li>前往火山引擎方舟控制台：<a href="https://console.volcengine.com/ark" target="_blank" class="one-key-link">console.volcengine.com/ark</a></li>
            <li>注册/登录字节跳动火山引擎账号（新用户有免费 token 额度）</li>
            <li>左侧菜单点击「API Key 管理」→「创建 API Key」</li>
            <li>复制生成的 Key 填入下方</li>
          </ol>
          <p class="one-key-note">💡 方舟平台一个 Key 同时支持豆包文本、即梦图片与视频等所有服务</p>
          <p class="one-key-note">⚠️ 视频生成需在控制台「开通」对应模型（即梦 Seedance）后方可使用</p>
        </div>
      </div>
      <el-form label-width="0" style="margin-top: 8px">
        <el-form-item>
          <el-input
            v-model="oneKeyVolcKey"
            type="password"
            placeholder="请输入火山引擎（方舟）API Key"
            show-password-on="click"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="oneKeyVolcVisible = false">取消</el-button>
        <el-button type="success" :loading="oneKeyVolcSaving" :disabled="!oneKeyVolcKey.trim()" @click="submitOneKeyVolc">
          确定，一键创建配置
        </el-button>
      </template>
    </el-dialog>

    <!-- 一键配置 Agnes -->
    <el-dialog
      v-model="oneKeyAgnesVisible"
      title="一键配置 Agnes AI"
      width="520px"
      :close-on-click-modal="false"
      @closed="oneKeyAgnesKey = ''"
    >
      <div class="one-key-help">
        <div class="one-key-section">
          <div class="one-key-section-title">📋 将自动创建以下配置</div>
          <ul class="one-key-list">
            <li><b>文本/对话</b>：Agnes 2.0 Flash（agnes-2.0-flash）— 生成故事剧本</li>
            <li><b>文本生成图片</b>：Agnes Image 2.1 Flash — 角色/场景/道具图</li>
            <li><b>分镜图片生成</b>：Agnes Image 2.1 Flash — 支持参考图编辑</li>
            <li><b>视频生成</b>：Agnes Video V2.0（agnes-video-v2.0）— 生成视频片段</li>
          </ul>
        </div>
        <div class="one-key-section">
          <div class="one-key-section-title">🔑 如何申请 API Key</div>
          <ol class="one-key-list">
            <li>前往 Agnes 平台：<a href="https://platform.agnes-ai.com/settings/apiKeys" target="_blank" class="one-key-link">platform.agnes-ai.com/settings/apiKeys</a></li>
            <li>注册/登录账号，进入 Settings → API Keys</li>
            <li>点击「Create new secret key」创建密钥</li>
            <li>复制 Key 填入下方</li>
          </ol>
          <p class="one-key-note">💡 一个 Key 同时支持文本、图片、视频；接口文档见 <a href="https://agnes-ai.com/doc/agnes-20-flash" target="_blank" class="one-key-link">agnes-ai.com/doc</a></p>
        </div>
      </div>
      <el-form label-width="0" style="margin-top: 8px">
        <el-form-item>
          <el-input
            v-model="oneKeyAgnesKey"
            type="password"
            placeholder="请输入 Agnes API Key"
            show-password-on="click"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="oneKeyAgnesVisible = false">取消</el-button>
        <el-button type="success" :loading="oneKeyAgnesSaving" :disabled="!oneKeyAgnesKey.trim()" @click="submitOneKeyAgnes">
          确定，一键创建配置
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="oneKeyYinziVisible"
      title="一键配置银子 API"
      width="680px"
      class="yinzi-config-dialog"
      :close-on-click-modal="false"
      @closed="resetOneKeyYinzi"
    >
      <div class="yinzi-catalog-bar">
        <div>
          <strong>{{ yinziCatalogTitle }}</strong>
          <span v-if="yinziCatalog.pricing_version" class="yinzi-catalog-version">{{ yinziCatalog.pricing_version }}</span>
          <p>{{ yinziCatalogMessage }}</p>
        </div>
        <div class="yinzi-catalog-actions">
          <el-button
            v-if="oneKeyYinziReady"
            plain
            :loading="oneKeyYinziCatalogLoading"
            @click="loadCurrentYinziCatalog"
          >读取当前 Key 模型</el-button>
          <el-button :icon="Refresh" circle :loading="oneKeyYinziCatalogLoading" title="刷新公开模型目录" @click="loadYinziCatalog" />
        </div>
      </div>

      <div class="yinzi-onboarding-steps" aria-label="银子 API 配置步骤">
        <article><b>1</b><div><strong>打开银子 API</strong><a href="https://yinziapi.top/" target="_blank" class="one-key-link">yinziapi.top</a></div></article>
        <article><b>2</b><div><strong>创建 API Key</strong><span>登录后进入 API Key / 密钥页面，点击创建。</span></div></article>
        <article><b>3</b><div><strong>复制完整 Key</strong><span>复制完整的 <code>sk-...</code>，粘贴到下面。</span></div></article>
      </div>
      <p class="yinzi-onboarding-note">配置后，Codex 才能按任务调用文本、图片和视频模型；不配置也能做本地整理、剪辑、已有媒体处理和任务规划。你也可以直接把站点、访问端点、Key 和模型名发给 Codex，让它代为填写。</p>

      <el-form label-position="top" class="yinzi-config-form">
        <el-form-item label="API Base URL">
          <el-input v-model="oneKeyYinziForm.base_url" placeholder="https://api.yinziapi.top/v1" clearable />
        </el-form-item>

        <el-form-item label="银子 API Key（推荐先填这个）" required>
          <el-input v-model="oneKeyYinziForm.api_key" type="password" show-password clearable autocomplete="new-password" placeholder="粘贴完整的 sk- 开头 Key" />
          <p class="yinzi-field-help">先填一个 Key 就可以让 Codex尝试文本、生图和视频任务。系统会先读取当前 Key 能用的模型，再把可用配置列出来；需要备用渠道时，可在“高级设置”中分别填写不同 Key。</p>
        </el-form-item>

        <div class="yinzi-auto-summary">
          <span><small>文本</small><strong>{{ oneKeyYinziForm.text_model || 'gpt-5.6-sol' }}</strong></span>
          <span><small>生图</small><strong>{{ oneKeyYinziForm.image_model || 'gpt-image-2' }}</strong></span>
          <span><small>视频</small><strong>{{ oneKeyYinziForm.video_model || '优先 Seedance，再按镜头自动选择' }}</strong></span>
        </div>

        <div v-if="yinziCatalogScope === 'credential'" class="yinzi-video-scope-summary">
          <span><strong>{{ yinziCredentialVideoCount }}</strong> Key 目录直接返回</span>
          <span><strong>{{ yinziPublicVideoCount }}</strong> 站点报价手选</span>
          <span><strong>{{ yinziSelectionReason }}</strong> 默认策略</span>
        </div>

        <el-collapse v-model="oneKeyYinziAdvanced" class="yinzi-advanced">
          <el-collapse-item title="高级设置：分组 Key 与模型覆盖" name="advanced">
            <div class="yinzi-field-grid">
              <el-form-item label="文本 Base URL">
                <el-input v-model="oneKeyYinziForm.text_base_url" placeholder="留空使用上面的地址" clearable />
              </el-form-item>
              <el-form-item label="文本 Key 覆盖">
                <el-input v-model="oneKeyYinziForm.text_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="留空使用通用 Key" />
              </el-form-item>
              <el-form-item label="文本模型">
                <el-select v-model="oneKeyYinziForm.text_model" filterable allow-create default-first-option clearable placeholder="自动选择">
                  <el-option v-for="item in yinziCatalog.text" :key="item.model" :label="catalogOptionLabel(item)" :value="item.model" />
                </el-select>
              </el-form-item>

              <el-form-item label="生图 Key 覆盖">
                <el-input v-model="oneKeyYinziForm.image_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="留空使用通用 Key" />
              </el-form-item>
              <el-form-item label="生图 Base URL">
                <el-input v-model="oneKeyYinziForm.image_base_url" placeholder="留空使用上面的地址" clearable />
              </el-form-item>
              <el-form-item label="生图模型">
                <el-select v-model="oneKeyYinziForm.image_model" filterable allow-create default-first-option clearable placeholder="自动选择">
                  <el-option v-for="item in yinziCatalog.image" :key="item.model" :label="catalogOptionLabel(item)" :value="item.model" />
                </el-select>
              </el-form-item>

              <el-form-item label="视频 Key 覆盖">
                <el-input v-model="oneKeyYinziForm.video_api_key" type="password" show-password clearable autocomplete="new-password" placeholder="留空使用通用 Key" />
              </el-form-item>
              <el-form-item label="视频 Base URL">
                <el-input v-model="oneKeyYinziForm.video_base_url" placeholder="留空使用上面的地址" clearable />
              </el-form-item>
              <el-form-item label="固定视频模型">
                <el-select v-model="oneKeyYinziForm.video_model" filterable allow-create default-first-option clearable placeholder="留空：当前 Key 内优先 Seedance，按镜头自动选择" @change="oneKeyYinziVideoModelManual = true">
                  <el-option v-for="item in yinziCatalog.video" :key="item.model" :label="catalogOptionLabel(item, 'video')" :value="item.model" />
                </el-select>
                <p class="yinzi-field-help">模型可以手动填写；最终能否使用，以当前 Key 的实际响应为准。</p>
              </el-form-item>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-form>

      <div class="yinzi-local-note">
        保存时会只读核对当前 Key 的模型目录；不生成图片或视频。Key 仅保存在本机 SQLite，不写入前端缓存、源码或导出截图。
      </div>

      <template #footer>
        <el-button @click="oneKeyYinziVisible = false">取消</el-button>
        <el-button type="primary" :loading="oneKeyYinziSaving" :disabled="!oneKeyYinziReady" @click="submitOneKeyYinzi">
          检测并自动配置
        </el-button>
      </template>
    </el-dialog>

    <!-- 即梦2角色认证：素材列表 -->
    <el-dialog
      v-model="jimeng2AssetsDialogVisible"
      title="素材库列表（GET /api/business/v1/assets）"
      width="720px"
      class="jimeng2-assets-dialog"
      destroy-on-close
      @closed="onJimeng2AssetsDialogClosed"
    >
      <p class="field-tip" style="margin-top: 0">
        文档：
        <a href="https://83zi.com/sd2realperson.html" target="_blank" rel="noopener noreferrer">SilvaMux 素材管理 API</a>
        ；仅 <code>status=active</code> 的素材可用于 Seedance 2.0 视频引用。
      </p>
      <el-table v-loading="jimeng2AssetsLoading" :data="jimeng2AssetsRows" stripe max-height="420" empty-text="暂无数据或未加载">
        <el-table-column prop="id" label="素材 ID" min-width="120" show-overflow-tooltip />
        <el-table-column prop="name" label="名称" width="100" show-overflow-tooltip />
        <el-table-column prop="asset_type" label="类型" width="88" />
        <el-table-column prop="status" label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : row.status === 'failed' ? 'danger' : 'info'" size="small">
              {{ row.status || '—' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="asset_url" label="asset_url" min-width="160" show-overflow-tooltip />
        <el-table-column prop="url" label="原始 URL" min-width="120" show-overflow-tooltip />
        <el-table-column prop="created_at" label="创建时间" width="160" show-overflow-tooltip />
      </el-table>
      <div v-if="jimeng2AssetsHasMore" style="margin-top: 12px; text-align: center">
        <el-button :loading="jimeng2AssetsLoading" @click="loadMoreJimeng2MaterialAssets">加载更多</el-button>
      </div>
      <template #footer>
        <el-button @click="jimeng2AssetsDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 测试连接 -->
    <el-dialog v-model="testVisible" title="测试连接" width="420px">
      <div v-if="testTargetName" class="connection-test-target">
        <span>正在验证</span>
        <strong>{{ testTargetName }}</strong>
        <small>保存配置会在本机后端读取 Key，浏览器不会取得明文密钥。</small>
      </div>
      <p v-if="testResult === null">正在进行低成本连接探针，不会生成图片、视频或音频…</p>
      <template v-else-if="testResult">
        <el-alert
          type="success"
          :title="testDetails.authenticated ? '连接与凭据验证成功' : '服务地址已连通'"
          :description="testSuccessDescription"
          show-icon
          :closable="false"
        />
        <div class="connection-test-receipt">
          <span>模型：{{ testDetails.model || '由服务端自动选择' }}</span>
          <span>凭据：{{ testDetails.credential_source === 'saved' ? '本机已保存 Key' : '当前临时填写' }}</span>
          <span>{{ testDetails.probe === 'minimal_text_response' ? '测试用量：极少文本' : '媒体生成费用：无' }}</span>
        </div>
      </template>
      <el-alert v-else type="error" :title="testError || '连接失败'" show-icon :closable="false" />
      <template #footer>
        <el-button @click="testVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 一键换Key（锁定模式） -->
    <el-dialog v-model="bulkKeyVisible" title="一键换Key" width="440px" :close-on-click-modal="false">
      <el-alert
        type="warning"
        :closable="false"
        style="margin-bottom: 16px"
        title="此操作将替换所有配置的 API Key，请确认新 Key 可用后再提交。"
        show-icon
      />
      <el-form label-width="80px">
        <el-form-item label="新 API Key">
          <el-input
            v-model="bulkKeyInput"
            type="password"
            show-password
            placeholder="粘贴新的 API Key"
            clearable
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bulkKeyVisible = false">取消</el-button>
        <el-button type="primary" :loading="bulkKeySaving" :disabled="!bulkKeyInput.trim()" @click="submitBulkKey">确认替换</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, MagicStick, QuestionFilled, Download, Upload, Delete, ChatDotRound, Picture, Film, VideoCamera, Key, Microphone, Folder, Refresh, Setting } from '@element-plus/icons-vue'
import { aiAPI } from '@/api/ai'
import {
  buildDraftConfigTestRequest,
  buildSavedConfigTestRequest,
  configTestSuccessCopy,
} from '@/utils/aiConfigTest'
import { generationSettingsAPI } from '@/api/prompts'
import PromptEditor from '@/components/PromptEditor.vue'
import SceneModelMap from '@/components/SceneModelMap.vue'
import Sd2AssetManagement from '@/components/Sd2AssetManagement.vue'

const props = defineProps({
  initialAction: { type: String, default: '' },
})

const distributionProfile = ref(null)

const activeTab = ref('configs')
const importFileRef = ref(null)

// ---- 生成设置 ----
const genConcurrencyInput = ref(3)
const genVideoConcurrencyInput = ref(3)
const genSettingSaving = ref(false)
const genSettingSaved = ref(false)

async function loadGenerationSettings() {
  try {
    const res = await generationSettingsAPI.get()
    genConcurrencyInput.value = res?.concurrency ?? 3
    genVideoConcurrencyInput.value = res?.video_concurrency ?? 3
  } catch (_) {}
}

function onConcurrencyChange(val) {
  const n = Number(val)
  if (!isNaN(n) && n >= 1) genConcurrencyInput.value = Math.min(20, Math.max(1, Math.round(n)))
}

function onVideoConcurrencyChange(val) {
  const n = Number(val)
  if (!isNaN(n) && n >= 1) genVideoConcurrencyInput.value = Math.min(20, Math.max(1, Math.round(n)))
}

async function saveGenerationSettings() {
  const n = Number(genConcurrencyInput.value)
  const nv = Number(genVideoConcurrencyInput.value)
  if (isNaN(n) || n < 1 || n > 20) {
    ElMessage.warning('图片并发数请填写 1-20 之间的整数')
    return
  }
  if (isNaN(nv) || nv < 1 || nv > 20) {
    ElMessage.warning('视频并发数请填写 1-20 之间的整数')
    return
  }
  genSettingSaving.value = true
  genSettingSaved.value = false
  try {
    await generationSettingsAPI.update({ concurrency: Math.round(n), video_concurrency: Math.round(nv) })
    genSettingSaved.value = true
    setTimeout(() => { genSettingSaved.value = false }, 2000)
  } catch (e) {
    ElMessage.error('保存失败：' + (e?.message || ''))
  } finally {
    genSettingSaving.value = false
  }
}
const loading = ref(false)
const list = ref([])
const selectedRows = ref([])
const batchDeleting = ref(false)
const vendorLock = ref({ enabled: false, config_file: '' })
const dialogVisible = ref(false)
const editingId = ref(null)
const saving = ref(false)
const showProtocolHelp = ref(false)
const bulkKeyVisible = ref(false)
const bulkKeyInput = ref('')
const bulkKeySaving = ref(false)
const jimeng2AssetsDialogVisible = ref(false)
const jimeng2AssetsLoading = ref(false)
const jimeng2AssetsRows = ref([])
const jimeng2AssetsHasMore = ref(false)
const jimeng2AssetsNextCursor = ref(null)
const formRef = ref(null)
const form = ref({
  service_type: 'text',
  name: '',
  provider: '',
  api_protocol: '',
  base_url: '',
  api_key: '',
  endpoint: '',
  query_endpoint: '',
  modelText: '',
  default_model: '',
  deepseek_thinking: 'disabled',
  deepseek_reasoning_effort: 'high',
  priority: 0,
  is_default: false,
  // 可灵 Omni 官方 AK/SK（存 settings，后端生成 JWT）
  kling_access_key: '',
  kling_secret_key: '',
  kling_secret_key_base64: false,
  // TTS 专属字段
  voice_id: '',
  group_id: '',
  note: '',
  useCasesText: '',
  capabilityJson: '',
  is_active: true,
})
const presetModelPick = ref('')

const formModelList = computed(() => parseModelText(form.value.modelText))

// 保证「生成时默认使用」下拉有可选且选中值在列表内，否则会不显示或修改无效
watch(
  () => [formModelList.value, form.value.default_model],
  () => {
    const list = formModelList.value
    if (list.length === 0) return
    const current = form.value.default_model
    if (!current || !list.includes(current)) {
      form.value.default_model = list[0] || ''
    }
  },
  { immediate: true }
)

function onServiceTypeChange() {
  const st = form.value.service_type || 'text'
  if (st === 'jimeng2_character_auth') {
    if (!form.value.provider || form.value.provider === CUSTOM_PROVIDER_SENTINEL) {
      form.value.provider = 'jimeng_material_api'
    }
    const p = form.value.provider
    const pcfg = (providerConfigs.jimeng2_character_auth || []).find((x) => x.id === p)
    if (pcfg) {
      if (!form.value.base_url?.trim()) form.value.base_url = getBaseUrlForProvider(p)
      form.value.modelText = '-'
      form.value.default_model = '-'
      form.value.endpoint = ''
      form.value.query_endpoint = ''
      form.value.api_protocol = ''
    }
    if (!editingId.value && !form.value.name?.trim()) {
      form.value.name = '即梦2角色认证'
    }
    return
  }
  const listByType = providerConfigs[st] || []
  const current = form.value.provider
  if (!current || !listByType.some((p) => p.id === current)) {
    form.value.provider = ''
    form.value.base_url = ''
    form.value.modelText = ''
    form.value.default_model = ''
  }
}

function onPresetModelSelect(value) {
  if (!value) return
  const listParsed = parseModelText(form.value.modelText)
  if (listParsed.includes(value)) {
    presetModelPick.value = ''
    return
  }
  const append = listParsed.length ? '\n' + value : value
  form.value.modelText = (form.value.modelText || '').trim() + append
  presetModelPick.value = ''
}
const rules = computed(() => ({
  service_type: [{ required: true, message: '请选择服务类型', trigger: 'change' }],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  provider: [{ required: true, message: '请选择或输入厂商', trigger: 'change' }],
  base_url: [{ required: true, message: '请输入 Base URL', trigger: 'blur' }],
  api_key: [
    {
      validator: (_rule, v, cb) => {
        const st = form.value.service_type
        const existingHasKey = editingId.value
          ? !!list.value.find((item) => item.id === editingId.value)?.has_api_key
          : false
        if (existingHasKey && (v == null || !String(v).trim())) return cb()
        if (st === 'jimeng2_character_auth') {
          if (v != null && String(v).trim()) return cb()
          return cb(new Error('请填写 Token'))
        }
        const proto = form.value.api_protocol
        const ak = (form.value.kling_access_key || '').trim()
        const sk = (form.value.kling_secret_key || '').trim()
        if (st === 'video' && proto === 'kling_omni' && ak && sk) return cb()
        if (v != null && String(v).trim()) return cb()
        cb(new Error('请输入 API Key，或使用官方 AccessKey + SecretKey（可不填 API Key）'))
      },
      trigger: 'blur',
    },
  ],
}))
const testVisible = ref(false)
const testResult = ref(null)
const testError = ref('')
const testDetails = ref({})
const testTargetName = ref('')
const testingConfigId = ref(null)
const testingDraft = ref(false)
const discoveringConfigId = ref(null)
const modelDiscoveryVisible = ref(false)
const modelDiscoveryTarget = ref(null)
const modelDiscoveryRows = ref([])
const modelDiscoveryError = ref('')
const modelCapabilityManualName = ref('')
const capabilityEditorVisible = ref(false)
const capabilityEditorSaving = ref(false)
const capabilityEditorTarget = ref(null)
const capabilityEditorForm = ref({})
const testSuccessDescription = computed(() => configTestSuccessCopy(testDetails.value))
const oneKeyTongyiVisible = ref(false)
const oneKeyTongyiKey = ref('')
const oneKeyTongyiSaving = ref(false)
const oneKeyVolcVisible = ref(false)
const oneKeyVolcKey = ref('')
const oneKeyVolcSaving = ref(false)
const oneKeyAgnesVisible = ref(false)
const oneKeyAgnesKey = ref('')
const oneKeyAgnesSaving = ref(false)
const oneKeyYinziVisible = ref(false)
const oneKeyYinziSaving = ref(false)
const oneKeyYinziCatalogLoading = ref(false)
const oneKeyYinziAdvanced = ref([])
const yinziCatalogError = ref('')
const yinziCatalogScope = ref('public')
const yinziCatalogWarning = ref('')
const yinziCatalogMeta = ref({})
const oneKeyYinziVideoModelManual = ref(false)
const yinziCatalog = ref({ pricing_version: '', text: [], image: [], video: [] })
const oneKeyYinziForm = ref({
  base_url: 'https://api.yinziapi.top/v1',
  text_base_url: '',
  image_base_url: '',
  video_base_url: '',
  api_key: '',
  text_api_key: '',
  image_api_key: '',
  video_api_key: '',
  text_model: 'gpt-5.6-sol',
  image_model: '',
  video_model: '',
})
const oneKeyImageYinziVisible = ref(false)
const oneKeyImageYinziSaving = ref(false)
const oneKeyImageYinziForm = ref({
  base_url: 'https://image.yinziapi.top/v1',
  text_base_url: 'https://api.yinziapi.top/v1',
  image_base_url: 'https://image.yinziapi.top/v1',
  video_base_url: 'https://image.yinziapi.top/v1',
  text_api_key: '',
  image_api_key: '',
  video_api_key: '',
  text_model: 'gpt-5.6-sol',
  image_model: 'gpt-image-2',
  video_model: 'Seedance 2.5-720',
})
const oneKeyImageYinziReady = computed(() => {
  const form = oneKeyImageYinziForm.value
  return Boolean(String(form.text_base_url || '').trim()
    && String(form.image_base_url || '').trim()
    && String(form.video_base_url || '').trim()
    && String(form.text_api_key || '').trim()
    && String(form.image_api_key || '').trim()
    && String(form.video_api_key || '').trim())
})

const oneKeyLaoliVisible = ref(false)
const oneKeyLaoliSaving = ref(false)
const oneKeyLaoliForm = ref({
  text_base_url: '',
  image_base_url: 'https://video.laoliimage2.win/v1',
  video_base_url: 'https://video.laoliimage2.win/v1',
  text_api_key: '',
  image_api_key: '',
  video_api_key: '',
  text_model: 'gpt-5.6-sol',
  image_model: 'gpt-image-2',
  video_model: '3.5',
})
const oneKeyLaoliReady = computed(() => {
  const form = oneKeyLaoliForm.value
  return Boolean(String(form.text_base_url || '').trim()
    && String(form.image_base_url || '').trim()
    && String(form.video_base_url || '').trim()
    && String(form.text_api_key || '').trim()
    && String(form.image_api_key || '').trim()
    && String(form.video_api_key || '').trim())
})

const oneKeyYinziReady = computed(() => {
  const form = oneKeyYinziForm.value
  const universalReady = String(form.api_key || '').trim()
  const separateReady = [form.text_api_key, form.image_api_key, form.video_api_key]
    .every((value) => String(value || '').trim())
  return Boolean(String(form.base_url || '').trim() && (universalReady || separateReady))
})

const yinziCatalogMessage = computed(() => {
  if (oneKeyYinziCatalogLoading.value) return '正在读取图片和视频模型…'
  if (yinziCatalogError.value) return yinziCatalogError.value
  const catalog = yinziCatalog.value
  if (catalog.image.length || catalog.video.length) {
    const count = `${catalog.text.length} 个文本模型，${catalog.image.length} 个生图模型，${catalog.video.length} 个视频模型`
    return yinziCatalogWarning.value ? `${count}；${yinziCatalogWarning.value}` : count
  }
  return '尚未加载'
})
const yinziCatalogTitle = computed(() => yinziCatalogScope.value === 'credential' ? '当前 Key 可用模型' : '银子 API 公开模型目录')
const yinziCredentialVideoCount = computed(() => Number(yinziCatalogMeta.value.credential_video_model_count)
  || yinziCatalog.value.video.filter((item) => item.credential_verified === true).length)
const yinziPublicVideoCount = computed(() => Number(yinziCatalogMeta.value.public_video_model_count)
  || yinziCatalog.value.video.filter((item) => item.public_catalog === true && item.credential_verified !== true).length)
const yinziSelectionReason = computed(() => {
  const reason = yinziCatalogMeta.value.selection_reason
  if (reason === 'user_selected') return '手动指定'
  if (reason === 'current_key_seedance_preferred') return 'Seedance 优先'
  if (reason === 'only_current_key_video_model') return '唯一可用模型'
  return '当前 Key 内自动选择'
})

/** 预设厂商与模型（与参考前端一致） */
const providerConfigs = {
  text: [
    { id: 'yinzi', name: 'YinziAPI', models: ['gpt-5.6-sol', 'gpt-5.4-mini', 'deepseek-v4-flash'] },
    { id: 'openai', name: 'OpenAI', models: ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'] },
    { id: 'volcengine', name: '火山引擎', models: ['deepseek-v3-2-251201', 'doubao-1-5-pro-32k-250115', 'kimi-k2-thinking-251104'] },
    // { id: 'chatfire', name: 'Chatfire', models: ['gemini-3-flash-preview', 'claude-sonnet-4-5-20250929', 'doubao-seed-1-8-251228'] },
    { id: 'gemini', name: 'Google Gemini', models: ['gemini-2.5-pro', 'gemini-3-flash-preview'] },
    { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
    { id: 'qwen', name: '通义千问', models: ['qwen3-max', 'qwen-plus', 'qwen-flash'] },
    { id: 'agnes', name: 'Agnes AI', models: ['agnes-2.0-flash'] }
  ],
  image: [
    { id: 'yinzi', name: 'YinziAPI', models: ['gpt-image-2'] },
    { id: 'volcengine', name: '火山引擎', models: ['doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'] },
    { id: 'kling', name: '可灵 Kling', models: ['kling-image', 'kling-omni-image'] },
    { id: 'nano_banana', name: 'NanoBanana', models: ['nano-banana-2', 'nano-banana-pro', 'nano-banana'] },
    // { id: 'chatfire', name: 'Chatfire', models: ['nano-banana-pro', 'doubao-seedream-4-5-251128', 'qwen-image'] },
    { id: 'gemini', name: 'Google Gemini', models: ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'] },
    { id: 'openai', name: 'OpenAI', models: ['dall-e-3', 'dall-e-2'] },
    { id: 'dashscope', name: '通义万象', models: ['wan2.6-image', 'qwen-image-edit-plus-2026-01-09', 'qwen-image-edit-plus', 'qwen-image-edit-max'] },
    { id: 'qwen_image', name: '通义千问', models: ['qwen-image-max', 'qwen-image-plus', 'qwen-image'] },
    { id: 'agnes', name: 'Agnes AI', models: ['agnes-image-2.1-flash', 'agnes-image-2.0-flash'] }
  ],
  storyboard_image: [
    { id: 'yinzi', name: 'YinziAPI', models: ['gpt-image-2'] },
    { id: 'dashscope', name: '通义万象', models: ['wan2.6-image', 'qwen-image-edit-plus-2026-01-09', 'qwen-image-edit-plus', 'qwen-image-edit-max'] },
    { id: 'volcengine', name: '火山引擎', models: ['doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'] },
    { id: 'kling', name: '可灵 Kling', models: ['kling-image', 'kling-omni-image'] },
    { id: 'nano_banana', name: 'NanoBanana', models: ['nano-banana-2', 'nano-banana-pro', 'nano-banana'] },
    // { id: 'chatfire', name: 'Chatfire', models: ['nano-banana-pro', 'doubao-seedream-4-5-251128', 'qwen-image'] },
    { id: 'gemini', name: 'Google Gemini', models: ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'] },
    { id: 'openai', name: 'OpenAI', models: ['dall-e-3', 'dall-e-2'] },
    { id: 'agnes', name: 'Agnes AI', models: ['agnes-image-2.1-flash', 'agnes-image-2.0-flash'] }
  ],
  video: [
    { id: 'yinzi', name: 'YinziAPI', models: ['mg-seedance2.0 -480p mini'] },
    { id: 'klingai', name: '可灵官方 Omni (api-beijing.klingai.com)', models: ['kling-video-o1', 'kling-v3-omni'] },
    { id: 'ffir', name: '飞儿API / 可灵 Omni-Video (ffir.cn)', models: ['kling-video-o1', 'kling-v3-omni'] },
    { id: 'kling', name: '可灵 Kling', models: ['kling-omni-video', 'kling-video', 'kling-motion-control'] },
    { id: 'vidu', name: 'Vidu', models: ['viduq2', 'viduq2-pro', 'viduq2-turbo', 'viduq3-pro'] },
    { id: 'volces', name: '火山引擎', models: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-1-5-pro-251215', 'doubao-seedance-1-0-lite-i2v-250428', 'doubao-seedance-1-0-lite-t2v-250428', 'doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-pro-fast-251015'] },
    // { id: 'chatfire', name: 'Chatfire', models: ['doubao-seedance-1-5-pro-251215', 'doubao-seedance-1-0-lite-i2v-250428', 'doubao-seedance-1-0-lite-t2v-250428', 'doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-pro-fast-251015', 'sora-2', 'sora-2-pro'] },
    { id: 'minimax', name: 'MiniMax 海螺', models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02'] },
    { id: 'gemini', name: 'Google Gemini (Veo)', models: ['veo-3.1-generate-preview', 'veo-3.0-generate-preview', 'veo-3.0-fast-generate-preview'] },
    { id: 'dashscope', name: '通义万相', models: ['wan2.6-r2v-flash', 'wan2.6-t2v', 'wan2.2-kf2v-flash', 'wan2.6-i2v-flash', 'wanx2.1-vace-plus'] },
    {
      id: 'jimeng_ai_api',
      name: 'Jimeng AI API（自建即梦免费 API）',
      models: [
        'jimeng-video-seedance-2.0',
        'seedance-2.0',
        'jimeng-video-seedance-2.0-fast',
        'jimeng-video-3.0',
        'jimeng-video-3.0-pro',
        'jimeng-video-3.5-pro',
      ],
    },
    { id: 'openai', name: 'OpenAI', models: ['sora-2', 'sora-2-pro'] },
    { id: 'xai', name: 'xAI Grok Imagine', models: ['grok-imagine-video'] },
    { id: 'agnes', name: 'Agnes AI', models: ['agnes-video-v2.0'] },
  ],
  tts: [
    { id: 'minimax', name: 'MiniMax T2A', models: ['speech-02-hd', 'speech-02-turbo'] },
  ],
  jimeng2_character_auth: [
    { id: 'jimeng_material_api', name: '即梦业务素材 API（/api/business/v1）', models: ['-'] },
  ],
}

/** 厂商 id → 默认接口规范（api_protocol） */
const providerProtocolMap = {
  // image / storyboard_image
  volcengine: 'volcengine',
  volces: 'volcengine',
  volc: 'volcengine',
  nano_banana: 'nano_banana',
  dashscope: 'dashscope',
  qwen_image: 'dashscope',
  gemini: 'gemini',
  google: 'gemini',
  kling: 'kling',
  ffir: 'kling_omni',
  klingai: 'kling_omni',
  // video
  vidu: 'vidu',
  xai: 'xai',
  grok: 'xai',
  minimax: 'openai',
  openai: 'openai',
  chatfire: 'openai',
  qwen: 'openai',
  deepseek: 'openai',
  agnes: 'openai',
  yinzi: 'openai',
  jimeng_ai_api: 'jimeng_ai_api',
  jimeng_material_api: '',
}

/** 厂商 id → 默认 Base URL（与参考前端 AIConfigDialog 757-775 一致） */
function getBaseUrlForProvider(provider) {
  if (!provider) return ''
  const p = String(provider).toLowerCase()
  if (p === 'gemini' || p === 'google') return 'https://generativelanguage.googleapis.com'
  if (p === 'minimax') return 'https://api.minimaxi.com/v1'
  if (p === 'volces' || p === 'volcengine') return 'https://ark.cn-beijing.volces.com/api/v3'
  if (p === 'openai') return 'https://api.openai.com/v1'
  if (p === 'deepseek') return 'https://api.deepseek.com'
  if (p === 'dashscope') return 'https://dashscope.aliyuncs.com'
  if (p === 'qwen_image') return 'https://dashscope.aliyuncs.com'
  if (p === 'qwen') return 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  if (p === 'nano_banana') return 'https://api.nanobananaapi.ai'
  if (p === 'vidu') return 'https://api.vidu.cn'
  if (p === 'kling') return 'https://api.klingai.com'
  if (p === 'klingai') return 'https://api-beijing.klingai.com'
  if (p === 'ffir') return 'https://ffir.cn'
  if (p === 'jimeng_ai_api') return 'http://127.0.0.1:8000'
  if (p === 'jimeng_material_api') return 'https://silvamux.tingyutech.com'
  if (p === 'xai' || p === 'grok') return 'https://api.x.ai'
  if (p === 'agnes') return 'https://apihub.agnes-ai.com/v1'
  if (p === 'yinzi') return 'https://api.yinziapi.top/v1'
  return 'https://api.chatfire.site/v1'
}

const CUSTOM_PROVIDER_SENTINEL = '__custom__'

function parseSettings(settings) {
  if (!settings) return {}
  if (typeof settings === 'object') return settings
  try {
    const parsed = JSON.parse(settings)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

function isDeepSeekOfficial(provider, baseUrl) {
  const p = String(provider || '').trim().toLowerCase()
  const base = String(baseUrl || '').trim().toLowerCase()
  return p === 'deepseek' || base.includes('api.deepseek.com')
}

function resolveDeepSeekFormSettings(row) {
  const s = parseSettings(row?.settings)
  const nested = s.deepseek && typeof s.deepseek === 'object' ? s.deepseek : {}
  let thinking = s.deepseek_thinking || s.thinking || nested.thinking || nested.type || ''
  const model = String(row?.default_model || '').toLowerCase()
  if (!thinking && model === 'deepseek-chat') thinking = 'disabled'
  if (!thinking && model === 'deepseek-reasoner') thinking = 'enabled'
  if (thinking !== 'enabled' && thinking !== 'disabled') thinking = 'disabled'

  let effort = s.deepseek_reasoning_effort || s.reasoning_effort || nested.reasoning_effort || nested.effort || 'high'
  effort = String(effort).toLowerCase() === 'max' ? 'max' : 'high'
  return { thinking, effort }
}

const isDeepSeekOfficialForm = computed(() => (
  form.value.service_type === 'text'
  && isDeepSeekOfficial(form.value.provider, form.value.base_url)
))

/** 当前服务类型下的预设厂商列表（编辑时若当前 provider 不在列表则补一项；末尾始终附一项自定义入口） */
const availableProviderOptions = computed(() => {
  const st = form.value.service_type || 'text'
  const listByType = providerConfigs[st] || []
  const current = form.value.provider
  let result = [...listByType]
  if (editingId.value && current && current !== CUSTOM_PROVIDER_SENTINEL && !listByType.some((p) => p.id === current)) {
    result = [{ id: current, name: current + ' (当前)', models: [] }, ...result]
  }
  result.push({ id: CUSTOM_PROVIDER_SENTINEL, name: '✏️ 自定义（直接输入厂商名）', models: [] })
  return result
})

/** 当前厂商的预设模型列表（用于追加预设模型） */
const availableModels = computed(() => {
  const st = form.value.service_type
  const provider = form.value.provider
  if (!st || !provider) return []
  const p = (providerConfigs[st] || []).find((x) => x.id === provider)
  return p?.models || []
})

/** 根据当前厂商/协议/base_url 推算实际将使用的接口地址，供用户核对 */
const endpointPreviewInfo = computed(() => {
  const { provider, api_protocol, base_url, service_type, endpoint, query_endpoint } = form.value
  const p = String(provider || '').toLowerCase()
  const proto = api_protocol || providerProtocolMap[p] || ''
  const base = (base_url || '').replace(/\/$/, '')

  if (service_type === 'jimeng2_character_auth') {
    const root = base || '(请填写网关 URL)'
    const hasReal = !root.startsWith('(')
    return {
      submit: `${root}/api/business/v1/assets`,
      query: hasReal ? `${root}/api/business/v1/assets/{assetId}` : null,
      isAuto: true,
      isJimeng2Auth: true,
    }
  }

  if (!base && !proto && !p) return null

  let submitPath = '', queryPath = ''

  if (service_type === 'text') {
    submitPath = '/chat/completions'
  } else if (service_type === 'tts') {
    if (p === 'minimax') {
      submitPath = '/t2a_v2?GroupId={group_id}'
    } else {
      submitPath = endpoint || '/tts'
    }
  } else if (service_type === 'image' || service_type === 'storyboard_image') {
    if (endpoint) {
      submitPath = endpoint
    } else if (proto === 'volcengine' || p === 'volcengine' || p === 'volces') {
      submitPath = '/images/generations'
    } else if (proto === 'dashscope' || p === 'dashscope' || p === 'qwen_image') {
      submitPath = '/api/v1/services/aigc/multimodal-generation/generation'
    } else if (proto === 'gemini' || p === 'gemini') {
      const m = form.value.default_model || '{模型名}'
      submitPath = `/v1beta/models/${m}:generateContent?key=***`
      return { submit: base + submitPath, query: null, isAuto: true, isGemini: true }
    } else if (proto === 'nano_banana' || p === 'nano_banana') {
      submitPath = '/v1/images/generations'  // nano_banana base_url 无 /v1
    } else if (proto === 'kling' || p === 'kling' || p === 'klingai') {
      submitPath = '/v1/images/generations'
    } else {
      submitPath = '/images/generations'  // openai 兼容：base_url 已含 /v1
    }
    } else if (service_type === 'video') {
    if (endpoint) {
      submitPath = endpoint
    } else if (proto === 'volcengine_omni') {
      submitPath = '/contents/generations/tasks'
    } else if (proto === 'volcengine' || p === 'volces' || p === 'volcengine') {
      submitPath = '/videos/generations'
    } else if (proto === 'dashscope' || p === 'dashscope') {
      submitPath = '/api/v1/services/aigc/video-generation/video-synthesis'
    } else if (proto === 'gemini' || p === 'gemini') {
      const m = form.value.default_model || '{模型名}'
      return {
        submit: `${base}/v1beta/models/${m}:predictLongRunning  （API Key 放 header: x-goog-api-key）`,
        query: `${base}/v1beta/{operationName}  （operationName 由提交响应返回）`,
        isAuto: true,
        isGemini: true
      }
    } else if (proto === 'vidu' || p === 'vidu') {
      submitPath = '/ent/v2/img2video'
    } else if (proto === 'sora') {
      submitPath = '/v1/videos'
    } else if (proto === 'agnes' || p === 'agnes' || proto === 'yinzi' || p === 'yinzi') {
      submitPath = '/videos'
    } else if (proto === 'xai') {
      submitPath = '/v1/videos/generations'
    } else if (proto === 'veo3') {
      submitPath = '/v1/video/create'
    } else if (proto === 'jimeng_ai_api' || p === 'jimeng_ai_api') {
      submitPath = endpoint || '/v1/videos/generations'
      return {
        submit: (base || '(请填 Base URL)') + submitPath + '  （Bearer 为即梦 Session，可多账号英文逗号分隔；同步返回 data[0].url）',
        query: null,
        isAuto: true,
      }
    } else if (proto === 'kling_omni' || p === 'ffir' || p === 'klingai') {
      const omniFfir = p === 'ffir' || /ffir\.cn/i.test(base)
      const omniKlingOfficial = p === 'klingai' || /api(-beijing|-singapore)?\.klingai\.com/i.test(base)
      submitPath = omniFfir ? '/kling/v1/videos/omni-video' : omniKlingOfficial ? '/v1/videos/omni-video' : '/kling/v1/videos/omni-video'
    } else if (proto === 'kling' || p === 'kling' || p === 'klingai') {
      submitPath = '/v1/videos/text2video (T2V) 或 /v1/videos/image2video (I2V)'
    } else if (p === 'minimax') {
      submitPath = '/video_generation'  // minimax base_url 已含 /v1
    } else {
      submitPath = '/v1/video/create'
    }

    if (query_endpoint) {
      queryPath = query_endpoint
    } else if (proto === 'volcengine_omni') {
      queryPath = '/contents/generations/tasks/{taskId}'
    } else if (proto === 'volcengine' || p === 'volces' || p === 'volcengine') {
      queryPath = '/tasks/{taskId}/info'
    } else if (proto === 'dashscope' || p === 'dashscope') {
      queryPath = '/api/v1/tasks/{taskId}/info'
    } else if (proto === 'vidu' || p === 'vidu') {
      queryPath = '/ent/v2/tasks/{taskId}/creations'
    } else if (proto === 'sora') {
      queryPath = '/v1/videos/{taskId}'
    } else if (proto === 'agnes' || p === 'agnes' || proto === 'yinzi' || p === 'yinzi') {
      queryPath = '/videos/{taskId}'
    } else if (proto === 'xai') {
      queryPath = '/v1/videos/{taskId}'
    } else if (proto === 'veo3') {
      queryPath = '/v1/video/query?id={taskId}'
    } else if (proto === 'kling_omni' || p === 'ffir' || p === 'klingai') {
      const omniFfirQ = p === 'ffir' || /ffir\.cn/i.test(base)
      const omniKlingOfficialQ = p === 'klingai' || /api(-beijing|-singapore)?\.klingai\.com/i.test(base)
      queryPath = omniFfirQ
        ? '/kling/v1/images/omni-image/{taskId}'
        : omniKlingOfficialQ
          ? '/v1/videos/omni-video/{taskId}'
          : '/kling/v1/images/omni-image/{taskId}'
    } else if (proto === 'kling' || p === 'kling' || p === 'klingai') {
      queryPath = '/v1/videos/{videoType}/{taskId}（自动按任务类型选择）'
    } else if (p === 'minimax') {
      queryPath = '/query/video_generation?task_id={taskId}'  // minimax base_url 已含 /v1
    } else if (proto !== 'gemini' && p !== 'gemini') {
      queryPath = '/v1/video/query?id={taskId}'
    }
  }

  const submitUrl = base ? (base + submitPath) : ('(未填 Base URL)' + submitPath)
  const queryUrl = queryPath ? (base ? base + queryPath : '(未填 Base URL)' + queryPath) : null

  if (!submitPath) return null
  return {
    submit: submitUrl,
    query: queryUrl,
    isAuto: !endpoint  // 端点是自动推断的（非用户手填）
  }
})

function onProviderChange(providerId) {
  if (providerId === CUSTOM_PROVIDER_SENTINEL) {
    form.value.provider = ''
    form.value.api_protocol = ''
    form.value.base_url = ''
    form.value.modelText = ''
    form.value.default_model = ''
    return
  }
  const st = form.value.service_type || 'text'
  const p = (providerConfigs[st] || []).find((x) => x.id === providerId)
  if (!p) {
    form.value.base_url = ''
    form.value.modelText = ''
    form.value.default_model = ''
    return
  }
  form.value.base_url = getBaseUrlForProvider(providerId)
  form.value.modelText = (p.models || []).join('\n')
  form.value.default_model = (p.models && p.models[0]) || ''
  if (providerId === 'deepseek') {
    form.value.deepseek_thinking = 'disabled'
    form.value.deepseek_reasoning_effort = 'high'
  }
  // 自动填充接口规范
  form.value.api_protocol = providerProtocolMap[providerId] || (st === 'text' ? '' : 'openai')
  if (st === 'video' && providerId === 'jimeng_ai_api') {
    form.value.endpoint = ''
    form.value.query_endpoint = ''
  }
  if (st === 'video' && (providerId === 'ffir' || providerId === 'klingai')) {
    if (providerId === 'ffir') {
      form.value.endpoint = '/kling/v1/videos/omni-video'
      form.value.query_endpoint = '/kling/v1/images/omni-image/{taskId}'
    } else {
      form.value.endpoint = '/v1/videos/omni-video'
      form.value.query_endpoint = '/v1/videos/omni-video/{taskId}'
    }
  }
  if (st === 'video' && providerId === 'agnes') {
    form.value.api_protocol = 'agnes'
    form.value.endpoint = '/videos'
    form.value.query_endpoint = '/videos/{taskId}'
  }
  if (st === 'video' && providerId === 'yinzi') {
    form.value.api_protocol = 'yinzi'
    form.value.endpoint = '/videos'
    form.value.query_endpoint = '/videos/{taskId}'
  }
  if (!editingId.value) {
    form.value.name = (p.name || providerId) + ' ' + serviceTypeLabel(st)
  }
}

/** 通义一键配置用 */
const TONGYI_CONFIGS = [
  { service_type: 'text', name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', provider: 'qwen', model: ['qwen-plus'] },
  { service_type: 'image', name: '通义万象 文本生图', base_url: 'https://dashscope.aliyuncs.com', provider: 'dashscope', model: ['wan2.6-image'] },
  { service_type: 'image', name: '通义千问 文本生图', base_url: 'https://dashscope.aliyuncs.com', provider: 'qwen_image', model: ['qwen-image-max', 'qwen-image-plus', 'qwen-image'] },
  { service_type: 'storyboard_image', name: '通义万象 分镜图', base_url: 'https://dashscope.aliyuncs.com', provider: 'dashscope', model: ['wan2.6-image'] },
  { service_type: 'video', name: '通义万相', base_url: 'https://dashscope.aliyuncs.com', provider: 'dashscope', model: ['wan2.2-kf2v-flash'] }
]

/** 火山引擎一键配置用 */
const VOLCENGINE_CONFIGS = [
  { service_type: 'text', name: '火山引擎 文本', base_url: 'https://ark.cn-beijing.volces.com/api/v3', provider: 'volcengine', model: ['deepseek-v3-2-251201', 'doubao-1-5-pro-32k-250115', 'kimi-k2-thinking-251104'] },
  { service_type: 'image', name: '火山引擎 即梦 文本生图', base_url: 'https://ark.cn-beijing.volces.com/api/v3', provider: 'volcengine', model: ['doubao-seedream-4-5-251128'] },
  { service_type: 'storyboard_image', name: '火山引擎 即梦 分镜图', base_url: 'https://ark.cn-beijing.volces.com/api/v3', provider: 'volcengine', model: ['doubao-seedream-4-5-251128'] },
  { service_type: 'video', name: '火山引擎 即梦 视频', base_url: 'https://ark.cn-beijing.volces.com/api/v3', provider: 'volces', model: ['doubao-seedance-1-5-pro-251215'] }
]

/** Agnes 一键配置用 */
const AGNES_CONFIGS = [
  { service_type: 'text', name: 'Agnes 文本', base_url: 'https://apihub.agnes-ai.com/v1', provider: 'agnes', api_protocol: 'openai', model: ['agnes-2.0-flash'] },
  { service_type: 'image', name: 'Agnes 文本生图', base_url: 'https://apihub.agnes-ai.com/v1', provider: 'agnes', api_protocol: 'openai', model: ['agnes-image-2.1-flash'] },
  { service_type: 'storyboard_image', name: 'Agnes 分镜图', base_url: 'https://apihub.agnes-ai.com/v1', provider: 'agnes', api_protocol: 'openai', model: ['agnes-image-2.1-flash'] },
  { service_type: 'video', name: 'Agnes 视频', base_url: 'https://apihub.agnes-ai.com/v1', provider: 'agnes', api_protocol: 'agnes', endpoint: '/videos', query_endpoint: '/videos/{taskId}', model: ['agnes-video-v2.0'] },
]

function serviceTypeLabel(t) {
  const map = {
    text: '文本',
    image: '文本生成图片',
    storyboard_image: '分镜图片生成',
    video: '视频',
    tts: '语音合成 TTS',
    jimeng2_character_auth: '即梦2角色认证',
    model_ark_asset: 'SD2 资产库',
  }
  return map[t] || t
}

function onRowEdit(row) {
  if (row.service_type === 'model_ark_asset') {
    activeTab.value = 'sd2_assets'
    ElMessage.info('请在「SD2 资产管理」标签页编辑此配置')
    return
  }
  openEdit(row)
}

async function loadList() {
  loading.value = true
  try {
    list.value = await aiAPI.list()
  } catch (_) {
    list.value = []
  } finally {
    loading.value = false
  }
}

function parseModelText(text) {
  if (!text || !String(text).trim()) return []
  return String(text)
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function resetForm() {
  editingId.value = null
  presetModelPick.value = ''
  form.value = {
    service_type: 'text',
    name: '',
    provider: '',
    api_protocol: '',
    base_url: '',
    api_key: '',
    endpoint: '',
    query_endpoint: '',
    modelText: '',
    default_model: '',
    deepseek_thinking: 'disabled',
    deepseek_reasoning_effort: 'high',
    priority: 0,
    is_default: true,  // 新增时默认勾选「设为默认」，便于理解当前会使用哪条配置
    voice_id: '',
    group_id: '',
    kling_access_key: '',
    kling_secret_key: '',
    kling_secret_key_base64: false,
    note: '',
    useCasesText: '',
    capabilityJson: '',
    is_active: true,
  }
  formRef.value?.resetFields?.()
}

function openAdd(serviceType = 'text') {
  resetForm()
  if (typeof serviceType === 'string' && serviceTypeLabel(serviceType) !== serviceType) {
    form.value.service_type = serviceType
  }
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  const model = Array.isArray(row.model) ? row.model : (row.model ? [row.model] : [])
  const modelList = model.map((m) => String(m).trim()).filter(Boolean)
  const defaultInList = row.default_model && modelList.includes(row.default_model)
  // TTS / 可灵 Omni 等从 settings 解析
  let voice_id = row.voice_id || ''
  let group_id = row.group_id || ''
  let kling_access_key = ''
  let kling_secret_key = ''
  let kling_secret_key_base64 = false
  let metadata = row.metadata || {}
  if ((!metadata || typeof metadata !== 'object') && row.metadata_json) {
    try { metadata = JSON.parse(row.metadata_json) } catch (_) { metadata = {} }
  }
  const deepseekSettings = resolveDeepSeekFormSettings(row)
  if (row.settings) {
    try {
      const s = JSON.parse(row.settings)
      if (row.service_type === 'tts') {
        voice_id = s.voice_id || voice_id
        group_id = s.group_id || group_id
      }
      if (row.service_type === 'video' && row.api_protocol === 'kling_omni') {
        kling_access_key = s.kling_access_key || ''
        kling_secret_key = s.kling_secret_key || ''
        kling_secret_key_base64 = !!s.kling_secret_key_base64
      }
    } catch (_) {}
  }
  form.value = {
    service_type: row.service_type,
    name: row.name,
    provider: row.provider,
    api_protocol: row.api_protocol || '',
    base_url: row.base_url,
    api_key: '',
    endpoint: row.endpoint || '',
    query_endpoint: row.query_endpoint || '',
    modelText: modelList.join('\n'),
    default_model: defaultInList ? row.default_model : (modelList[0] || ''),
    deepseek_thinking: deepseekSettings.thinking,
    deepseek_reasoning_effort: deepseekSettings.effort,
    priority: row.priority ?? 0,
    is_default: !!row.is_default,
    voice_id,
    group_id,
    kling_access_key,
    kling_secret_key,
    kling_secret_key_base64,
    note: metadata.note || '',
    useCasesText: Array.isArray(metadata.use_cases) ? metadata.use_cases.join(', ') : '',
    capabilityJson: metadata.capability ? JSON.stringify(metadata.capability, null, 2) : '',
    is_active: row.is_active !== false,
  }
  dialogVisible.value = true
}

async function submit() {
  await formRef.value?.validate?.().catch(() => {})
  saving.value = true
  try {
    let modelList = parseModelText(form.value.modelText)
    if (form.value.service_type === 'jimeng2_character_auth' && modelList.length === 0) {
      modelList = ['-']
    }
    const defaultModel = form.value.default_model && modelList.includes(form.value.default_model)
      ? form.value.default_model
      : modelList[0] || null
    // TTS / 可灵 Omni 官方 AKSK / DeepSeek V4 参数打包进 settings
    let settings = undefined
    if (form.value.service_type === 'tts') {
      const s = {}
      if (form.value.voice_id) s.voice_id = form.value.voice_id
      if (form.value.group_id) s.group_id = form.value.group_id
      settings = Object.keys(s).length ? JSON.stringify(s) : null
    } else if (form.value.service_type === 'video' && form.value.api_protocol === 'kling_omni') {
      let baseS = {}
      if (editingId.value) {
        const prev = list.value.find((r) => r.id === editingId.value)
        if (prev?.settings) {
          try {
            baseS = JSON.parse(prev.settings)
          } catch (_) {}
        }
      }
      if ((form.value.kling_access_key || '').trim()) baseS.kling_access_key = form.value.kling_access_key.trim()
      else delete baseS.kling_access_key
      if ((form.value.kling_secret_key || '').trim()) baseS.kling_secret_key = form.value.kling_secret_key.trim()
      else delete baseS.kling_secret_key
      if (form.value.kling_secret_key_base64) baseS.kling_secret_key_base64 = true
      else delete baseS.kling_secret_key_base64
      settings = Object.keys(baseS).length ? JSON.stringify(baseS) : null
    } else if (isDeepSeekOfficialForm.value) {
      const prev = editingId.value ? list.value.find((r) => r.id === editingId.value) : null
      const baseS = parseSettings(prev?.settings)
      baseS.deepseek_thinking = form.value.deepseek_thinking === 'enabled' ? 'enabled' : 'disabled'
      if (baseS.deepseek_thinking === 'enabled') {
        baseS.deepseek_reasoning_effort = form.value.deepseek_reasoning_effort === 'max' ? 'max' : 'high'
      } else {
        delete baseS.deepseek_reasoning_effort
      }
      settings = Object.keys(baseS).length ? JSON.stringify(baseS) : null
    }
    let metadata = {}
    if (form.value.note?.trim()) metadata.note = form.value.note.trim()
    const useCases = String(form.value.useCasesText || '').split(/[\n,，]/).map((item) => item.trim()).filter(Boolean)
    if (useCases.length) metadata.use_cases = [...new Set(useCases)]
    if (String(form.value.capabilityJson || '').trim()) {
      try {
        const capability = JSON.parse(form.value.capabilityJson)
        if (capability && typeof capability === 'object' && !Array.isArray(capability)) metadata.capability = capability
        else throw new Error('能力提示必须是 JSON 对象')
      } catch (error) {
        ElMessage.warning(`能力 / 费用 JSON 无法保存：${error.message}`)
        saving.value = false
        return
      }
    }
    const payload = {
      service_type: form.value.service_type,
      name: form.value.name,
      provider: form.value.provider,
      api_protocol: form.value.api_protocol || '',
      base_url: form.value.base_url,
      endpoint: form.value.endpoint || '',
      query_endpoint: form.value.query_endpoint || '',
      model: modelList,
      default_model: defaultModel,
      priority: form.value.priority,
      is_default: form.value.is_default,
      is_active: form.value.is_active,
      metadata,
      ...(settings !== undefined ? { settings } : {}),
    }
    if (!editingId.value || String(form.value.api_key || '').trim()) {
      payload.api_key = form.value.api_key
    }
    if (editingId.value) {
      await aiAPI.update(editingId.value, payload)
      ElMessage.success('保存成功')
    } else {
      await aiAPI.create(payload)
      ElMessage.success('添加成功')
    }
    dialogVisible.value = false
    await loadList()
  } catch (e) {
    // request 已统一报错
  } finally {
    saving.value = false
  }
}

function openBulkKey() {
  bulkKeyInput.value = ''
  bulkKeyVisible.value = true
}

async function submitBulkKey() {
  const key = bulkKeyInput.value.trim()
  if (!key) return
  bulkKeySaving.value = true
  try {
    const res = await aiAPI.bulkUpdateKey(key)
    ElMessage.success(res?.message || '所有配置的 API Key 已更新')
    bulkKeyVisible.value = false
    await loadList()
  } catch (_) {
  } finally {
    bulkKeySaving.value = false
  }
}

function onJimeng2AssetsDialogClosed() {
  jimeng2AssetsRows.value = []
  jimeng2AssetsNextCursor.value = null
  jimeng2AssetsHasMore.value = false
}

async function fetchJimeng2MaterialAssets(firstPage) {
  if (!form.value.base_url?.trim() || !form.value.api_key?.trim()) {
    ElMessage.warning('请先填写网关 URL 与 Token')
    return
  }
  if (firstPage) {
    jimeng2AssetsRows.value = []
    jimeng2AssetsNextCursor.value = null
    jimeng2AssetsHasMore.value = false
    jimeng2AssetsDialogVisible.value = true
  }
  jimeng2AssetsLoading.value = true
  try {
    const data = await aiAPI.listJimeng2MaterialAssets({
      base_url: form.value.base_url.trim(),
      api_key: form.value.api_key,
      limit: 20,
      cursor: firstPage ? undefined : jimeng2AssetsNextCursor.value || undefined,
    })
    const items = Array.isArray(data?.items) ? data.items : []
    if (firstPage) {
      jimeng2AssetsRows.value = items
    } else {
      jimeng2AssetsRows.value = [...jimeng2AssetsRows.value, ...items]
    }
    jimeng2AssetsNextCursor.value = data?.next_cursor ?? null
    jimeng2AssetsHasMore.value = !!data?.has_more
  } catch (_) {
    /* request 拦截器已 ElMessage */
  } finally {
    jimeng2AssetsLoading.value = false
  }
}

function openJimeng2MaterialAssetsDialog() {
  fetchJimeng2MaterialAssets(true)
}

function loadMoreJimeng2MaterialAssets() {
  if (!jimeng2AssetsHasMore.value || !jimeng2AssetsNextCursor.value) return
  fetchJimeng2MaterialAssets(false)
}

async function openTest(row) {
  if (row.service_type === 'jimeng2_character_auth') {
    ElMessage.info('即梦2角色认证无需在此联调；保存后请在创作页「角色生成」中点击「SD2认证」验证。')
    return
  }
  if (row.service_type === 'model_ark_asset') {
    ElMessage.info('SD2 资产库请在「SD2 资产管理」标签页使用「刷新列表」验证连接。')
    return
  }
  testingConfigId.value = row.id
  try {
    await runConnectionTest(
      buildSavedConfigTestRequest(row),
      row.name || serviceTypeLabel(row.service_type),
    )
  } finally {
    testingConfigId.value = null
  }
}

function capabilityRowsFromLocalStates(states, row) {
  const source = Array.isArray(states) ? states : []
  const rows = source.map((item) => ({
    model: item.model,
    name: item.model,
    groups: [],
    prices: [],
    capabilities: item.capability || null,
    local_capability_override: item.override || null,
    capability_source: item.source || 'unknown',
    contract_status: item.contract_status || (item.override ? 'local' : 'missing'),
    automatic_eligible: item.automatic_eligible === true,
    availability_scope: 'credential',
    scope_verified: false,
    catalog_verified: false,
  })).filter((item) => String(item.model || '').trim())
  if (rows.length) return rows
  const configured = Array.isArray(row?.model)
    ? row.model
    : [row?.default_model]
  return configured.map((model) => String(model || '').trim()).filter(Boolean).map((model) => ({
    model,
    name: model,
    groups: [],
    prices: [],
    capabilities: null,
    local_capability_override: null,
    capability_source: 'unknown',
    contract_status: 'missing',
    automatic_eligible: false,
    availability_scope: 'credential',
    scope_verified: false,
    catalog_verified: false,
  }))
}

async function discoverConfigModels(row) {
  discoveringConfigId.value = row.id
  modelDiscoveryTarget.value = row
  modelDiscoveryRows.value = []
  modelDiscoveryError.value = ''
  modelCapabilityManualName.value = ''
  modelDiscoveryVisible.value = true
  try {
    const result = await aiAPI.discoverModels({
      config_id: row.id,
      service_type: row.service_type,
    }, { suppressGlobalError: true })
    modelDiscoveryRows.value = Array.isArray(result?.catalog?.video)
      ? result.catalog.video
      : Array.isArray(result?.models) ? result.models : []
    await loadList()
    const refreshed = list.value.find((item) => Number(item.id) === Number(row.id))
    if (refreshed) modelDiscoveryTarget.value = refreshed
  } catch (error) {
    let fallbackRows = []
    try {
      const local = await aiAPI.getModelCapabilities(row.id)
      fallbackRows = capabilityRowsFromLocalStates(local?.models, row)
    } catch (_) {
      fallbackRows = capabilityRowsFromLocalStates([], row)
    }
    modelDiscoveryRows.value = fallbackRows
    modelDiscoveryError.value = fallbackRows.length
      ? '上游模型目录暂时不可用，已加载当前配置中的模型。这里的能力提示只辅助自动模式，不会限制手动选模或参考素材；也可以直接输入任意上游模型名。'
      : '上游模型目录暂时不可用。你仍可直接输入任意上游模型名维护能力提示，手动选模和参考素材不会被本地提示阻止。'
  } finally {
    discoveringConfigId.value = null
  }
}

function capabilityEditorValue(value, fallback = null) {
  return value == null ? fallback : value
}

function openCapabilityEditor(row) {
  const source = row?.local_capability_override || row?.capabilities || {}
  let rolesJson = ''
  if (source.roles && typeof source.roles === 'object') {
    rolesJson = JSON.stringify(source.roles)
  }
  capabilityEditorTarget.value = row
  capabilityEditorForm.value = {
    duration_mode: source.duration_mode || '',
    resolution: source.resolution || '',
    duration_min: capabilityEditorValue(source.duration_min),
    duration_max: capabilityEditorValue(source.duration_max),
    fixed_duration_seconds: capabilityEditorValue(source.fixed_duration_seconds),
    max_images: capabilityEditorValue(source.max_images),
    max_videos: capabilityEditorValue(source.max_videos),
    max_audios: capabilityEditorValue(source.max_audios),
    max_total_references: capabilityEditorValue(source.max_total_references),
    max_reference_video_seconds_total: capabilityEditorValue(source.max_reference_video_seconds_total),
    automatic_eligible: source.automatic_eligible === true,
    expensive_bypass: source.expensive_bypass === true,
    route_profiles: Array.isArray(source.route_profiles) ? [...source.route_profiles] : [],
    roles_json: rolesJson,
  }
  capabilityEditorVisible.value = true
}

function openManualCapabilityEditor() {
  const model = modelCapabilityManualName.value.trim()
  if (!model) return
  const existing = modelDiscoveryRows.value.find((item) => String(item.model || '').toLowerCase() === model.toLowerCase())
  openCapabilityEditor(existing || { model, contract_status: 'missing', capabilities: null, local_capability_override: null })
}

function buildCapabilityEditorPayload() {
  const source = capabilityEditorForm.value || {}
  const payload = {}
  for (const field of [
    'duration_min', 'duration_max', 'fixed_duration_seconds',
    'max_images', 'max_videos', 'max_audios', 'max_total_references',
    'max_reference_video_seconds_total',
  ]) {
    if (source[field] != null && source[field] !== '') payload[field] = Number(source[field])
  }
  for (const field of ['duration_mode', 'resolution']) {
    if (String(source[field] || '').trim()) payload[field] = String(source[field]).trim()
  }
  payload.automatic_eligible = source.automatic_eligible === true
  payload.expensive_bypass = source.expensive_bypass === true
  payload.route_profiles = Array.isArray(source.route_profiles) ? source.route_profiles : []
  if (String(source.roles_json || '').trim()) {
    let roles
    try { roles = JSON.parse(source.roles_json) } catch (_) { throw new Error('媒体角色 JSON 格式不正确') }
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new Error('媒体角色必须是 JSON 对象')
    payload.roles = roles
  }
  return payload
}

function applyCapabilityStateToRow(state) {
  if (!state || !capabilityEditorTarget.value) return
  const model = String(state.model || '').toLowerCase()
  let row = modelDiscoveryRows.value.find((item) => String(item.model || '').toLowerCase() === model)
  if (!row) {
    row = { model: state.model, name: state.model, groups: [], prices: [] }
    modelDiscoveryRows.value.push(row)
  }
  row.local_capability_override = state.override || null
  row.capabilities = state.capability || null
  row.contract_status = state.contract_status || row.contract_status
  row.capability_source = state.source || row.capability_source
  row.automatic_eligible = state.automatic_eligible === true
}

async function saveCapabilityEditor() {
  const configId = Number(modelDiscoveryTarget.value?.id)
  const model = String(capabilityEditorTarget.value?.model || '').trim()
  if (!Number.isSafeInteger(configId) || configId <= 0 || !model) return
  capabilityEditorSaving.value = true
  try {
    const capability = buildCapabilityEditorPayload()
    const result = await aiAPI.updateModelCapabilities(configId, { model, capability })
    applyCapabilityStateToRow(result?.models?.find((item) => String(item.model || '').toLowerCase() === model.toLowerCase()))
    await loadList()
    capabilityEditorVisible.value = false
    ElMessage.success(`已保存 ${model} 的本地能力提示；手动选择仍然不受限制`)
  } catch (error) {
    ElMessage.error(error?.message || '模型能力提示保存失败')
  } finally {
    capabilityEditorSaving.value = false
  }
}

async function resetCapability(row) {
  const configId = Number(modelDiscoveryTarget.value?.id)
  const model = String(row?.model || '').trim()
  if (!Number.isSafeInteger(configId) || configId <= 0 || !model) return
  try {
    await ElMessageBox.confirm(`恢复“${model}”的默认能力提示？本地修改只会被移除，不会影响视频配置。`, '恢复默认提示', { type: 'warning' })
    const result = await aiAPI.updateModelCapabilities(configId, { model, reset: true })
    applyCapabilityStateToRow(result?.models?.find((item) => String(item.model || '').toLowerCase() === model.toLowerCase()))
    await loadList()
    ElMessage.success('已恢复默认提示')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '恢复默认提示失败')
  }
}

async function testCurrentDraft() {
  testingDraft.value = true
  try {
    await runConnectionTest(
      buildDraftConfigTestRequest(form.value, editingId.value),
      `${form.value.name?.trim() || '尚未保存的配置'}（当前填写）`,
    )
  } finally {
    testingDraft.value = false
  }
}

async function runConnectionTest(payload, targetName) {
  testVisible.value = true
  testResult.value = null
  testError.value = ''
  testDetails.value = {}
  testTargetName.value = targetName
  try {
    const result = await aiAPI.testConnection(payload, { suppressGlobalError: true })
    testDetails.value = result || {}
    testResult.value = true
    return true
  } catch (error) {
    testResult.value = false
    testError.value = error?.message || '连接测试失败'
    return false
  }
}

async function onDelete(row) {
  await ElMessageBox.confirm(`确定删除配置「${row.name}」？`, '删除确认', {
    type: 'warning'
  })
  try {
    await aiAPI.delete(row.id)
    ElMessage.success('已删除')
    await loadList()
  } catch (_) {}
}

function onSelectionChange(rows) {
  selectedRows.value = rows
}

// Element Plus does not expose a stable row class for checkbox selection in
// every table mode. Keep the visual state tied to the same rows used by batch
// actions so the main and fixed columns cannot drift apart.
function configRowClassName({ row }) {
  const rowId = String(row?.id ?? '')
  return selectedRows.value.some((item) => String(item?.id ?? '') === rowId)
    ? 'config-selected-row'
    : ''
}

async function onBatchDelete() {
  if (!selectedRows.value.length) return
  await ElMessageBox.confirm(
    `确定删除选中的 ${selectedRows.value.length} 条配置？此操作不可恢复。`,
    '批量删除确认',
    { type: 'warning', confirmButtonText: '确定删除', confirmButtonClass: 'el-button--danger' }
  )
  batchDeleting.value = true
  let success = 0, failed = 0
  for (const row of selectedRows.value) {
    try {
      await aiAPI.delete(row.id)
      success++
    } catch (_) { failed++ }
  }
  batchDeleting.value = false
  selectedRows.value = []
  ElMessage.success(`已删除 ${success} 条${failed ? `，${failed} 条失败` : ''}`)
  await loadList()
}

function catalogOptionLabel(item, serviceType = '') {
  if (!item) return ''
  const scopeLabel = serviceType === 'video'
    ? item.credential_verified === true
      ? '当前 Key 已验证'
      : item.smart_routing_candidate === true
        ? '站点报价 · 手动'
        : item.public_catalog === true ? '站点报价 · 手动' : ''
    : ''
  const value = item.cheapest_effective_price
  if (value == null) return [item.model, scopeLabel].filter(Boolean).join('  ·  ')
  const priced = (item.prices || []).find((price) => price.effective_price === value)
  const unitMap = {
    per_second: '秒',
    per_request: '次',
    fixed_duration: '固定时长',
  }
  const unit = unitMap[priced?.billing_unit] || priced?.billing_unit || '计费单位'
  const currency = String(priced?.currency || '').toUpperCase()
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency ? `${currency} ` : ''
  return [item.model, scopeLabel, `${symbol}${Number(value).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}/${unit}`].filter(Boolean).join('  ·  ')
}

function applyYinziCatalogDefaults() {
  const form = oneKeyYinziForm.value
  const catalog = yinziCatalog.value
  if (!form.text_model) form.text_model = catalog.text.find((item) => item.model === 'gpt-5.6-sol')?.model || catalog.text[0]?.model || 'gpt-5.6-sol'
  if (!form.image_model && catalog.image.length) form.image_model = catalog.image[0].model
}

async function loadYinziCatalog() {
  oneKeyYinziCatalogLoading.value = true
  yinziCatalogError.value = ''
  yinziCatalogWarning.value = ''
  try {
    const catalog = await aiAPI.getYinziCatalog()
    yinziCatalogScope.value = 'public'
    yinziCatalogMeta.value = {}
    yinziCatalog.value = {
      pricing_version: catalog?.pricing_version || '',
      text: Array.isArray(catalog?.text) ? catalog.text : [],
      image: Array.isArray(catalog?.image) ? catalog.image : [],
      video: Array.isArray(catalog?.video) ? catalog.video : [],
    }
    applyYinziCatalogDefaults()
  } catch (error) {
    yinziCatalogError.value = '目录加载失败，可直接输入模型名'
  } finally {
    oneKeyYinziCatalogLoading.value = false
  }
}

function oneKeyYinziPayload() {
  const form = oneKeyYinziForm.value
  return {
    base_url: form.base_url.trim(),
    api_key: form.api_key.trim(),
    text_base_url: String(form.text_base_url || '').trim(),
    image_base_url: String(form.image_base_url || '').trim(),
    video_base_url: String(form.video_base_url || '').trim(),
    routing_mode: 'group',
    smart_routing: false,
    text_api_key: form.text_api_key.trim(),
    image_api_key: form.image_api_key.trim(),
    video_api_key: form.video_api_key.trim(),
    distribution_profile: distributionProfile.value?.id || undefined,
    text_model: form.text_model,
    image_model: form.image_model,
    video_model: oneKeyYinziVideoModelManual.value ? form.video_model : '',
  }
}

async function loadCurrentYinziCatalog() {
  if (!oneKeyYinziReady.value) return
  oneKeyYinziCatalogLoading.value = true
  yinziCatalogError.value = ''
  yinziCatalogWarning.value = ''
  try {
    const preview = await aiAPI.previewYinzi(oneKeyYinziPayload(), { suppressGlobalError: true })
    const warnings = Array.isArray(preview?.catalog?.warnings) ? preview.catalog.warnings : []
    const credentialVideoCount = Number(preview?.catalog?.credential_video_model_count) || 0
    const publicVideoCount = Number(preview?.catalog?.public_video_model_count) || 0
    yinziCatalogScope.value = 'credential'
    yinziCatalogMeta.value = preview?.catalog || {}
    yinziCatalogWarning.value = warnings.length
      ? `当前 Key 有 ${credentialVideoCount} 个自动可用视频模型；另有 ${publicVideoCount} 个站点报价可手动尝试。能力信息稍后自动同步`
      : `当前 Key 的 ${credentialVideoCount} 个视频模型与能力信息已同步`
    yinziCatalog.value = {
      pricing_version: preview?.catalog?.pricing_version || '',
      text: Array.isArray(preview?.text) ? preview.text : [],
      image: Array.isArray(preview?.image) ? preview.image : [],
      video: Array.isArray(preview?.video) ? preview.video : [],
    }
    const form = oneKeyYinziForm.value
    if (!form.text_model) form.text_model = preview?.text_model || ''
    if (!form.image_model) form.image_model = preview?.image_model || ''
    if (!oneKeyYinziVideoModelManual.value && preview?.video_model) form.video_model = preview.video_model
    ElMessage.success(`已读取：${credentialVideoCount} 个当前 Key 自动候选，${publicVideoCount} 个站点报价手动候选`)
  } catch (error) {
    yinziCatalogError.value = error.message || '当前 Key 模型目录读取失败'
    ElMessage.error(yinziCatalogError.value)
  } finally {
    oneKeyYinziCatalogLoading.value = false
  }
}

function openOneKeyYinzi() {
  oneKeyYinziVisible.value = true
  loadYinziCatalog()
}

function resetOneKeyYinzi() {
  oneKeyYinziForm.value.text_base_url = ''
  oneKeyYinziForm.value.image_base_url = ''
  oneKeyYinziForm.value.video_base_url = ''
  oneKeyYinziForm.value.api_key = ''
  oneKeyYinziForm.value.text_api_key = ''
  oneKeyYinziForm.value.image_api_key = ''
  oneKeyYinziForm.value.video_api_key = ''
  oneKeyYinziAdvanced.value = []
  yinziCatalogScope.value = 'public'
  yinziCatalogWarning.value = ''
  yinziCatalogMeta.value = {}
  oneKeyYinziVideoModelManual.value = false
}

async function submitOneKeyYinzi() {
  if (!oneKeyYinziReady.value) return
  oneKeyYinziSaving.value = true
  try {
    const result = await aiAPI.setupYinzi(oneKeyYinziPayload(), { suppressGlobalError: true })
    const selectedVideo = result?.catalog?.selected_video_model
    const videoCount = Number(result?.catalog?.video_model_count) || 0
    const credentialVideoCount = Number(result?.catalog?.credential_video_model_count) || 0
    const publicVideoCount = Number(result?.catalog?.public_video_model_count) || 0
    const warnings = Array.isArray(result?.catalog?.warnings) ? result.catalog.warnings : []
    ElMessage({
      type: warnings.length ? 'warning' : 'success',
      duration: warnings.length ? 6000 : 3500,
      message: selectedVideo
      ? `YinziAPI 已配置 ${videoCount} 个视频选项（${credentialVideoCount} 个当前 Key 自动候选，${publicVideoCount} 个站点报价手动候选）；当前首选 ${selectedVideo}${warnings.length ? '。能力信息稍后自动同步' : ''}`
      : 'YinziAPI 文本、生图、分镜图和视频配置已设为默认',
    })
    oneKeyYinziVisible.value = false
    await loadList()
  } catch (error) {
    ElMessage.error(error.message || 'YinziAPI 一键配置失败')
  } finally {
    oneKeyYinziSaving.value = false
  }
}

function openOneKeyImageYinzi() {
  oneKeyImageYinziVisible.value = true
}

function openOneKeyLaoli() {
  oneKeyLaoliVisible.value = true
}

function resetOneKeyLaoli() {
  oneKeyLaoliForm.value.text_base_url = ''
  oneKeyLaoliForm.value.image_base_url = 'https://video.laoliimage2.win/v1'
  oneKeyLaoliForm.value.video_base_url = 'https://video.laoliimage2.win/v1'
  oneKeyLaoliForm.value.text_api_key = ''
  oneKeyLaoliForm.value.image_api_key = ''
  oneKeyLaoliForm.value.video_api_key = ''
  oneKeyLaoliForm.value.text_model = 'gpt-5.6-sol'
  oneKeyLaoliForm.value.image_model = 'gpt-image-2'
  oneKeyLaoliForm.value.video_model = '3.5'
}

async function submitOneKeyLaoli() {
  if (!oneKeyLaoliReady.value) return
  oneKeyLaoliSaving.value = true
  try {
    const result = await aiAPI.setupLaoli({
      ...oneKeyLaoliForm.value,
      distribution_profile: distributionProfile.value?.id || 'universal',
    }, { suppressGlobalError: true })
    const count = Array.isArray(result?.configured) ? result.configured.length : 4
    ElMessage.success(`已配置 ${count} 个服务；文本、图片、视频使用各自的 URL 与 Key，默认视频为 3.5（即梦 2.5，固定 30 秒）`)
    oneKeyLaoliVisible.value = false
    await loadList()
  } catch (error) {
    ElMessage.error(error.message || '老李站点一键配置失败')
  } finally {
    oneKeyLaoliSaving.value = false
  }
}

function resetOneKeyImageYinzi() {
  oneKeyImageYinziForm.value.base_url = 'https://image.yinziapi.top/v1'
  oneKeyImageYinziForm.value.text_base_url = 'https://api.yinziapi.top/v1'
  oneKeyImageYinziForm.value.image_base_url = 'https://image.yinziapi.top/v1'
  oneKeyImageYinziForm.value.video_base_url = 'https://image.yinziapi.top/v1'
  oneKeyImageYinziForm.value.text_api_key = ''
  oneKeyImageYinziForm.value.image_api_key = ''
  oneKeyImageYinziForm.value.video_api_key = ''
  oneKeyImageYinziForm.value.text_model = 'gpt-5.6-sol'
  oneKeyImageYinziForm.value.image_model = 'gpt-image-2'
  oneKeyImageYinziForm.value.video_model = 'Seedance 2.5-720'
}

async function submitOneKeyImageYinzi() {
  if (!oneKeyImageYinziReady.value) return
  oneKeyImageYinziSaving.value = true
  try {
    const result = await aiAPI.setupImageYinzi({
      ...oneKeyImageYinziForm.value,
      distribution_profile: distributionProfile.value?.id || undefined,
    }, { suppressGlobalError: true })
    const count = Array.isArray(result?.configured) ? result.configured.length : 4
    ElMessage.success(`银子媒体站已配置 ${count} 个服务：文本、图片、分镜图和视频；默认视频为 Seedance 2.5-720`)
    oneKeyImageYinziVisible.value = false
    await loadList()
  } catch (error) {
    ElMessage.error(error.message || '银子媒体站一键配置失败')
  } finally {
    oneKeyImageYinziSaving.value = false
  }
}

function openOneKeyTongyi() {
  oneKeyTongyiKey.value = ''
  oneKeyTongyiVisible.value = true
}

async function submitOneKeyTongyi() {
  const apiKey = oneKeyTongyiKey.value.trim()
  if (!apiKey) return
  oneKeyTongyiSaving.value = true
  try {
    for (const cfg of TONGYI_CONFIGS) {
      const models = cfg.model || []
      await aiAPI.create({
        service_type: cfg.service_type,
        name: cfg.name,
        provider: cfg.provider,
        base_url: cfg.base_url,
        api_key: apiKey,
        model: models,
        default_model: models[0] || null,
        priority: 10,
        is_default: true
      })
    }
    ElMessage.success('已创建通义文本、文本生图、分镜图、视频配置')
    oneKeyTongyiVisible.value = false
    await loadList()
  } catch (_) {
    // 错误已由 request 统一提示
  } finally {
    oneKeyTongyiSaving.value = false
  }
}

function openOneKeyVolc() {
  oneKeyVolcKey.value = ''
  oneKeyVolcVisible.value = true
}

async function submitOneKeyVolc() {
  const apiKey = oneKeyVolcKey.value.trim()
  if (!apiKey) return
  oneKeyVolcSaving.value = true
  try {
    for (const cfg of VOLCENGINE_CONFIGS) {
      const models = cfg.model || []
      await aiAPI.create({
        service_type: cfg.service_type,
        name: cfg.name,
        provider: cfg.provider,
        base_url: cfg.base_url,
        api_key: apiKey,
        model: models,
        default_model: models[0] || null,
        priority: 10,
        is_default: true
      })
    }
    ElMessage.success('已创建火山引擎文本、文本生图、分镜图、视频配置')
    oneKeyVolcVisible.value = false
    await loadList()
  } catch (_) {
    // 错误已由 request 统一提示
  } finally {
    oneKeyVolcSaving.value = false
  }
}

function openOneKeyAgnes() {
  oneKeyAgnesKey.value = ''
  oneKeyAgnesVisible.value = true
}

async function submitOneKeyAgnes() {
  const apiKey = oneKeyAgnesKey.value.trim()
  if (!apiKey) return
  oneKeyAgnesSaving.value = true
  try {
    for (const cfg of AGNES_CONFIGS) {
      const models = cfg.model || []
      await aiAPI.create({
        service_type: cfg.service_type,
        name: cfg.name,
        provider: cfg.provider,
        api_protocol: cfg.api_protocol || '',
        base_url: cfg.base_url,
        api_key: apiKey,
        model: models,
        default_model: models[0] || null,
        endpoint: cfg.endpoint || '',
        query_endpoint: cfg.query_endpoint || '',
        priority: 10,
        is_default: true
      })
    }
    ElMessage.success('已创建 Agnes 文本、文本生图、分镜图、视频配置')
    oneKeyAgnesVisible.value = false
    await loadList()
  } catch (_) {
    // 错误已由 request 统一提示
  } finally {
    oneKeyAgnesSaving.value = false
  }
}

async function exportConfigs() {
  try {
    const configs = await aiAPI.list()
    const exportData = configs.map(({ id, created_at, updated_at, ...rest }) => rest)
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-configs-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success(`已导出 ${exportData.length} 条配置`)
  } catch (e) {
    ElMessage.error('导出失败')
  }
}

function triggerImport() {
  importFileRef.value?.click()
}

async function importConfigs(event) {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const configs = JSON.parse(text)
    if (!Array.isArray(configs)) {
      ElMessage.error('文件格式不正确，需要 JSON 数组')
      return
    }
    let success = 0
    let failed = 0
    for (const cfg of configs) {
      try {
        const models = Array.isArray(cfg.model) ? cfg.model : (cfg.model ? [cfg.model] : [])
        await aiAPI.create({
          service_type: cfg.service_type,
          name: cfg.name,
          provider: cfg.provider,
          api_protocol: cfg.api_protocol || null,
          base_url: cfg.base_url,
          api_key: cfg.api_key || '',
          endpoint: cfg.endpoint || null,
          query_endpoint: cfg.query_endpoint || null,
          model: models,
          default_model: cfg.default_model || null,
          priority: cfg.priority ?? 0,
          is_default: !!cfg.is_default,
          settings: cfg.settings || null
        })
        success++
      } catch (_) {
        failed++
      }
    }
    ElMessage.success(`导入完成：${success} 条成功${failed ? `，${failed} 条失败` : ''}`)
    await loadList()
  } catch (e) {
    ElMessage.error('导入失败：' + (e.message || '文件解析错误'))
  } finally {
    event.target.value = ''
  }
}

async function loadVendorLock() {
  try {
    vendorLock.value = await aiAPI.getVendorLock()
  } catch (_) {
    vendorLock.value = { enabled: false, config_file: '' }
  }
}

async function loadDistributionProfile() {
  try {
    distributionProfile.value = await aiAPI.getDistributionProfile()
  } catch (_) {
    // The profile endpoint is additive; older backends keep the configuration
    // page fully usable with the universal copy fallback.
    distributionProfile.value = {
      id: 'universal',
      name: '通用 NewAPI / sub2 版',
      description: '文本、图片、视频分别填写 Key；站点能力只作提示。',
      smart_routing_entry: false,
    }
  }
}

onMounted(async () => {
  await Promise.all([
    loadVendorLock(),
    loadDistributionProfile(),
    loadList(),
    loadGenerationSettings(),
  ])
  if (props.initialAction === 'yinzi') {
    // The first-run entry is always Yinzi API. Older profile payloads may not
    // expose smart_routing_entry, but that must never send a beginner to the
    // legacy provider dialog.
    openOneKeyYinzi()
  } else if (props.initialAction === 'laoli') {
    openOneKeyLaoli()
  } else if (props.initialAction.startsWith('service:')) {
    openAdd(props.initialAction.slice('service:'.length))
  } else if (props.initialAction.startsWith('capability:')) {
    const [, rawConfigId, ...encodedModel] = props.initialAction.split(':')
    const target = list.value.find((item) => Number(item.id) === Number(rawConfigId) && item.service_type === 'video')
    if (target) {
      await discoverConfigModels(target)
      const modelName = encodedModel.join(':')
      if (modelName) {
        const row = modelDiscoveryRows.value.find((item) => String(item.model || '').toLowerCase() === modelName.toLowerCase())
        openCapabilityEditor(row || { model: modelName, contract_status: 'missing', capabilities: null, local_capability_override: null })
      }
    }
  }
})
</script>

<style>
.provider-custom-option {
  border-top: 1px solid var(--el-border-color-light, #e4e7ed);
  margin-top: 4px;
  padding-top: 4px;
  color: var(--el-color-primary, #409eff) !important;
  font-style: italic;
}
.capability-actions { display: grid; gap: 4px; justify-items: start; }
.capability-actions > span { display: flex; align-items: center; gap: 2px; }
.capability-manual-entry { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
.capability-manual-entry :deep(.el-input) { flex: 1; }
.capability-editor-form { margin-top: 16px; }
.capability-editor-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.capability-editor-grid :deep(.el-input-number), .capability-editor-grid :deep(.el-select) { width: 100%; }
@media (max-width: 720px) { .capability-editor-grid { grid-template-columns: 1fr 1fr; } }
</style>

<style scoped>
.config-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 650; }
.config-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--el-color-success); }
.config-status.is-off { color: var(--text-subtle); }
.config-status.is-off::before { background: var(--text-faint); }
.config-note { display: block; margin-top: 3px; overflow: hidden; color: var(--text-subtle); text-overflow: ellipsis; white-space: nowrap; }
.ai-config-content {
  padding: 0;
}
.config-tabs {
  margin-top: -4px;
}
.tab-content {
  padding-top: 16px;
  max-height: calc(100vh - 320px);
  overflow-y: auto;
}
.content-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;
}
.distribution-profile-alert {
  margin-bottom: 14px;
}
.distribution-profile-copy {
  margin-top: 3px;
  line-height: 1.5;
}
.actions-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.actions-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 过渡动画 */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.2s ease;
}
.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(8px);
}

/* 类型徽章 */
.type-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid transparent;
}
.type-icon {
  font-size: 13px;
  flex-shrink: 0;
}

/* 文本/对话 — 蓝色 */
.type-text {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
  border-color: rgba(59, 130, 246, 0.25);
}
/* 文本生成图片 — 绿色 */
.type-image {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
  border-color: rgba(16, 185, 129, 0.25);
}
/* 分镜图片生成 — 紫色 */
.type-storyboard_image {
  background: rgba(139, 92, 246, 0.12);
  color: #8b5cf6;
  border-color: rgba(139, 92, 246, 0.25);
}
/* 视频 — 橙色 */
.type-video {
  background: rgba(249, 115, 22, 0.12);
  color: #f97316;
  border-color: rgba(249, 115, 22, 0.25);
}
.jimeng2-assets-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  width: 100%;
}
.jimeng2-assets-tip {
  flex: 1;
  min-width: 200px;
  margin: 0;
  line-height: 1.5;
}

.connection-test-target {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  background: var(--el-fill-color-light, #f5f7fa);
}
.connection-test-target span,
.connection-test-target small {
  color: var(--el-text-color-secondary, #909399);
  font-size: 12px;
}
.connection-test-target strong {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
}
.connection-test-target small {
  grid-column: 1 / -1;
  line-height: 1.5;
}
.connection-test-receipt {
  display: grid;
  gap: 5px;
  margin-top: 10px;
  color: var(--el-text-color-regular, #606266);
  font-size: 12px;
}
.model-discovery-summary {
  display: grid;
  grid-template-columns: 1fr 1.5fr .7fr;
  gap: 10px;
  margin-bottom: 14px;
}
.model-discovery-summary > span {
  min-width: 0;
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  background: var(--el-fill-color-light, #f5f7fa);
}
.model-discovery-summary small { color: var(--el-text-color-secondary, #909399); font-size: 11px; }
.model-discovery-summary strong { overflow-wrap: anywhere; font-size: 12px; }
@media (max-width: 680px) {
  .model-discovery-summary { grid-template-columns: 1fr; }
}

.type-jimeng2_character_auth {
  background: rgba(20, 184, 166, 0.14);
  color: #0d9488;
  border-color: rgba(20, 184, 166, 0.28);
}

/* Configuration labels retain readable contrast in both themes. */
.type-text,.type-image,.type-storyboard_image,.type-video,.type-jimeng2_character_auth,.type-model_ark_asset {
  border-color: var(--border-color);
}
:global(html.dark) .type-text { color:#b9d8ff; background:#193453; }
:global(html.dark) .type-image { color:#8ce5c5; background:#173d32; }
:global(html.dark) .type-storyboard_image { color:#d2b8ff; background:#30234d; }
:global(html.dark) .type-video { color:#ffc18c; background:#4a2c1b; }
:global(html.dark) .type-jimeng2_character_auth { color:#8fe9dc; background:#16433f; }
:global(html.dark) .type-model_ark_asset { color:#bfc5ff; background:#252a55; }
:global(html.light) .type-text { color:#155aa8; background:#e8f2ff; }
:global(html.light) .type-image { color:#08744e; background:#e5f7ef; }
:global(html.light) .type-storyboard_image { color:#6941a5; background:#f1eaff; }
:global(html.light) .type-video { color:#a44809; background:#fff0e5; }
:global(html.light) .type-jimeng2_character_auth { color:#08756b; background:#e4f8f5; }
:global(html.light) .type-model_ark_asset { color:#3e45a0; background:#eceeff; }

.type-model_ark_asset {
  background: rgba(99, 102, 241, 0.12);
  color: #6366f1;
  border-color: rgba(99, 102, 241, 0.25);
}

.no-default {
  color: var(--text-muted);
  font-size: 13px;
}
.one-key-tip {
  margin: 0 0 12px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}
.one-key-not-recommended {
  margin-left: 4px;
  padding: 0 5px;
  font-size: 11px;
  line-height: 18px;
  border-radius: 4px;
  color: var(--el-color-warning, #e6a23c);
  background: var(--el-color-warning-light-9, #fdf6ec);
  border: 1px solid var(--el-color-warning-light-7, #f5dab1);
  vertical-align: middle;
}
.one-key-help {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.one-key-section {
  background: var(--el-fill-color-light, #f5f7fa);
  border-radius: 8px;
  padding: 12px 14px;
}
.one-key-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
  margin-bottom: 8px;
}
.one-key-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: var(--el-text-color-regular, #606266);
  line-height: 1.8;
}
.one-key-list li {
  margin-bottom: 2px;
}
.one-key-link {
  color: var(--el-color-primary, #409eff);
  text-decoration: none;
}
.one-key-link:hover {
  text-decoration: underline;
}
.one-key-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
  line-height: 1.5;
}
.one-key-note + .one-key-note {
  margin-top: 4px;
}
code {
  background: var(--el-fill-color, #f0f2f5);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
  font-family: monospace;
}
.cfg-tip-content code {
  background: none;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
  font-family: monospace;
}
.default-tip {
  margin: 0 0 16px;
  padding: 10px 12px;
  background: var(--ui-info-soft);
  border-radius: 6px;
  font-size: 13px;
  color: var(--ui-info);
  line-height: 1.5;
}
.vendor-lock-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.vendor-lock-bar .vendor-lock-tip {
  flex: 1;
  margin-bottom: 0;
}
.vendor-bulk-key-btn {
  white-space: nowrap;
  flex-shrink: 0;
  color: #fff !important;
}
.vendor-lock-tip {
  margin-bottom: 16px;
}
.model-row { margin-bottom: 4px; }
.deepseek-settings {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.field-tip {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}
.form-label-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.ph-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  padding: 4px 0 6px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 4px;
}
.ph-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  margin-right: 6px;
  font-weight: 600;
  vertical-align: middle;
}
.ph-tag-img {
  background: var(--ui-info-soft);
  color: var(--ui-info);
  border: 1px solid var(--border-color);
}
.ph-tag-vid {
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  border: 1px solid var(--border-color);
}
.protocol-help .ph-body {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
}
.protocol-help .ph-body pre {
  background: var(--bg-inner);
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  margin: 6px 0 2px;
  white-space: pre-wrap;
  word-break: break-all;
}
.protocol-help .ph-body code {
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
.tip-icon {
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s;
}
.tip-icon:hover {
  color: var(--ui-info);
}
.endpoint-preview-box {
  background: var(--ui-info-soft);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 10px 14px;
  margin: -4px 0 14px;
  font-size: 12px;
}
.ep-preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--ui-info);
  margin-bottom: 8px;
  font-size: 12px;
}
.ep-auto-badge {
  background: var(--bg-hover);
  color: var(--ui-info);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 0 5px;
  font-size: 11px;
  font-weight: 400;
}
.ep-row {
  display: flex;
  align-items: flex-start;
  margin-bottom: 5px;
  gap: 6px;
  line-height: 1.5;
}
.ep-row:last-of-type {
  margin-bottom: 0;
}
.ep-label {
  flex-shrink: 0;
  color: var(--text-muted);
  min-width: 68px;
}
.ep-url {
  word-break: break-all;
  color: var(--text-primary);
  background: var(--bg-inner);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 1px 6px;
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11.5px;
  line-height: 1.6;
}
.ep-tip {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}
.ep-tip-warn {
  color: var(--ui-warning);
}
.ep-box-gemini {
  background: var(--ui-warning-soft);
  border-color: var(--border-color);
}
.ep-box-gemini .ep-preview-header {
  color: var(--ui-warning);
}
.ep-badge-gemini {
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
  border-color: var(--border-color);
}
.generation-settings {
  max-width: 600px;
}
.gs-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.gs-desc {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: 20px;
}
.gs-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.gs-label {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
}
.gs-unit {
  font-size: 13px;
  color: var(--text-muted);
  white-space: nowrap;
}
.gs-tip-box {
  margin-top: 20px;
  background: var(--bg-inner);
  border-radius: 8px;
  padding: 14px 16px;
  font-size: 13px;
}
.gs-tip-title {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.gs-tip-list {
  margin: 0 0 8px 16px;
  padding: 0;
  color: var(--text-muted);
  line-height: 1.8;
}
.gs-tip-note {
  color: var(--text-muted);
  font-size: 12px;
}
.yinzi-catalog-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: -6px 0 18px;
  padding: 12px 14px;
  border: 1px solid var(--border-color, #dcdfe6);
  border-radius: 6px;
  background: var(--bg-subtle, #f5f7fa);
}
.yinzi-catalog-bar strong {
  font-size: 14px;
  color: var(--text-primary, #303133);
}
.yinzi-catalog-bar p {
  margin: 4px 0 0;
  color: var(--text-secondary, #606266);
  font-size: 12px;
}
.yinzi-catalog-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.yinzi-catalog-version {
  margin-left: 8px;
  color: var(--text-tertiary, #909399);
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11px;
}
.yinzi-field-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 16px;
}
.yinzi-field-grid .el-select {
  width: 100%;
}
.yinzi-onboarding-steps { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:0 0 10px; }
.yinzi-onboarding-steps article { display:flex; gap:9px; align-items:flex-start; min-height:70px; padding:10px; border:1px solid var(--border-color); border-radius:10px; background:var(--bg-inner); }
.yinzi-onboarding-steps b { display:grid; place-items:center; flex:none; width:24px; height:24px; border-radius:50%; background:var(--ui-accent); color:var(--on-accent); font-size:12px; }
.yinzi-onboarding-steps strong,.yinzi-onboarding-steps span,.yinzi-onboarding-steps a { display:block; font-size:12px; line-height:1.55; }
.yinzi-onboarding-steps span { margin-top:2px; color:var(--text-muted); }
.yinzi-onboarding-note { margin:0 0 12px; padding:10px 12px; border:1px solid var(--border-color); border-radius:10px; background:var(--ui-accent-soft); color:var(--text-primary); font-size:12px; line-height:1.65; }
.yinzi-field-help {
  margin: 6px 0 0;
  color: var(--text-tertiary, #737b87);
  font-size: 12px;
  line-height: 1.55;
}
.yinzi-video-scope-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0 0 12px;
}
.yinzi-video-scope-summary span {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--border-color, #dcdfe6);
  background: var(--bg-subtle, #f7f8fa);
  color: var(--text-secondary, #606266);
  font-size: 11px;
}
.yinzi-video-scope-summary strong {
  overflow: hidden;
  color: var(--text-primary, #303133);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yinzi-local-note {
  padding: 10px 12px;
  border-left: 3px solid var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--text-secondary, #606266);
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 720px) {
  .yinzi-onboarding-steps { grid-template-columns:1fr; }
  .yinzi-catalog-bar {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }
  .yinzi-catalog-bar > div:first-child {
    min-width: 0;
  }
  .yinzi-catalog-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
    width: 100%;
  }
  .yinzi-catalog-actions .el-button:first-child {
    flex: 1 1 auto;
    min-width: 0;
  }
  .yinzi-field-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .yinzi-video-scope-summary {
    grid-template-columns: minmax(0, 1fr);
  }
  .yinzi-catalog-version {
    display: block;
    margin: 3px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
  }
}
</style>
