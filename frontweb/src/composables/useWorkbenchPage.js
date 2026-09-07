import { shallowRef, onMounted, onBeforeUnmount } from 'vue'

export const workbenchPage = shallowRef(null)

// Page controls belong to the persistent application frame, while each page
// owns its data. Never remount navigation when a task deep link changes.
export function useWorkbenchPage(controls) {
  onMounted(() => { workbenchPage.value = controls })
  onBeforeUnmount(() => { if (workbenchPage.value === controls) workbenchPage.value = null })
}
