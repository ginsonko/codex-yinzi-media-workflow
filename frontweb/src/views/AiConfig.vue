<template>
  <section class="model-workspace">
    <div class="workspace-intro"><span class="workspace-kicker">创作引擎</span><h2>一次配置，贯穿每一次创作</h2><p>把你使用的模型服务接入工作台。Codex 会根据任务选择已保存的配置，图片、分镜、视频与声音在同一流程中协作。</p></div>
    <div class="capability-cards"><article v-for="item in roles" :key="item.name"><el-icon><component :is="item.icon" /></el-icon><strong>{{ item.name }}</strong><p>{{ item.text }}</p></article></div>
    <AIConfigContent :initial-action="String(route.query.action || '')" />
  </section>
</template>
<script setup>
import { useRoute } from 'vue-router'
import AIConfigContent from '@/components/AIConfigContent.vue'
const route = useRoute()
const roles = [
  {name:'文字与策划',icon:'EditPen',text:'脚本、研究、镜头设计与内容复核'},
  {name:'图片与一致性',icon:'Picture',text:'商品图、角色设定、场景与分镜参考'},
  {name:'视频与运镜',icon:'VideoCamera',text:'文生视频、参考图视频与镜头生成'},
  {name:'声音与表达',icon:'Microphone',text:'旁白、角色配音与字幕时间轴'},
]
</script>
