import { onMounted, onBeforeUnmount } from 'vue'
// One in-flight read per surface. Hidden pages back off; returning is immediate.
export function useLiveRefresh(read, { active = () => true, failed = () => false, interval = 1000, idle = 5000 } = {}) {
  let timer, pending = false, disposed = false, failures = 0
  async function refresh() {
    clearTimeout(timer)
    if (pending || disposed) return
    pending = true
    try { await read(); failures = failed() ? failures + 1 : 0 } catch { failures += 1 }
    finally {
      pending = false
      if (!disposed) timer = setTimeout(refresh, document.hidden ? 30000 : failures ? Math.min(30000,1000 * 2 ** Math.min(failures,5)) : active() ? interval : idle)
    }
  }
  function visible() { if (!document.hidden) refresh() }
  onMounted(() => { document.addEventListener('visibilitychange',visible); window.addEventListener('online',visible); refresh() })
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange',visible); window.removeEventListener('online',visible) })
  return { refresh }
}
