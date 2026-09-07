<template>
  <section class="experience-panel delivery-panel" aria-labelledby="delivery-title">
    <header class="experience-heading"><div><small>最后一步</small><h3 id="delivery-title">交付给你</h3></div><span :class="['delivery-status', deliveryTone(delivery.status)]">{{ deliveryLabel(delivery.status) }}</span></header>
    <p class="delivery-summary">{{ delivery.summary || (['delivered','validated','completed'].includes(String(delivery.status || '').toLowerCase()) ? '成果已完成核验，可以直接观看或下载。' : '成果完成检查后，会在这里列出可观看和可下载的成品。') }}</p>
    <div v-if="delivery.items?.length" class="delivery-list"><article v-for="item in delivery.items" :key="item.artifact_id || item.id"><span :class="['delivery-dot', isVerified(item) ? 'verified' : '']"></span><div><strong>{{ item.title || '未命名成果' }}</strong><small>{{ isVerified(item) ? '已核验，可交付' : item.required ? '还需要检查' : '可选成果' }}</small></div><a v-if="item.download_url || item.url" :href="item.download_url || item.url" target="_blank" rel="noreferrer">下载</a></article></div>
    <p v-else class="delivery-empty">交付清单会随着成果检查实时更新。</p>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { deliveryLabel, deliveryTone } from '@/utils/orchestrationExperience'
const props = defineProps({ delivery: { type: Object, default: () => ({}) } })
const delivery = computed(() => props.delivery || {})
function isVerified(item) { return item?.verified === true || ['validated','verified','delivered','completed','succeeded'].includes(String(item?.status || '').toLowerCase()) }
</script>

<style scoped>
.experience-panel{border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);padding:18px 20px}.experience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.experience-heading small{display:block;margin-bottom:4px;color:var(--ui-accent);font-size:11px;font-weight:800;letter-spacing:.12em}.experience-heading h3{margin:0;color:var(--text-primary);font-size:15px}.delivery-status{padding:4px 8px;border-radius:999px;background:var(--bg-inner);color:var(--text-muted);font-size:11px}.delivery-status.success{color:var(--ui-accent);background:var(--bg-inner)}.delivery-status.warning{color:var(--ui-warning);background:var(--bg-inner)}.delivery-status.danger{color:var(--ui-danger);background:var(--bg-inner)}.delivery-summary,.delivery-empty{margin:11px 0;color:var(--text-muted);font-size:12px;line-height:1.6}.delivery-list{display:grid;gap:6px}.delivery-list article{display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-card)}.delivery-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--bg-card)}.delivery-dot.verified{background:var(--ui-accent)}.delivery-list article div{min-width:0;display:grid;gap:3px;flex:1}.delivery-list strong{overflow:hidden;color:var(--text-primary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.delivery-list small{color:var(--text-muted);font-size:11px}.delivery-list a{color:var(--ui-accent);font-size:11px;text-decoration:none}
</style>
