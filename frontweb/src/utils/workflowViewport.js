export function selectViewportAnchor(candidates, viewportHeight) {
  const height = Math.max(1, Number(viewportHeight) || 1)
  const visible = (Array.isArray(candidates) ? candidates : [])
    .map((item) => ({
      id: String(item?.id || ''),
      top: Number(item?.top),
      bottom: Number(item?.bottom),
    }))
    .filter((item) => item.id && Number.isFinite(item.top) && Number.isFinite(item.bottom)
      && item.bottom > 0 && item.top < height)
  const crossingViewportTop = visible
    .filter((item) => item.top <= 0 && item.bottom > 0)
    .sort((a, b) => b.top - a.top)
  if (crossingViewportTop.length) return crossingViewportTop[0]
  const withVisibleTop = visible.filter((item) => item.top >= 0).sort((a, b) => a.top - b.top)
  if (withVisibleTop.length) return withVisibleTop[0]
  return visible.sort((a, b) => b.top - a.top)[0] || null
}

export function restoredScrollTop(snapshot, currentAnchorTop, currentScrollY = snapshot?.scrollY) {
  if (!snapshot || !Number.isFinite(Number(currentAnchorTop))) return Math.max(0, Number(snapshot?.scrollY) || 0)
  return Math.max(0, (Number(currentScrollY) || 0) + Number(currentAnchorTop) - (Number(snapshot.top) || 0))
}

export function captureWorkflowViewport(doc = document, view = window) {
  const elements = [...doc.querySelectorAll('[data-workflow-anchor]')]
  const candidates = elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { id: element.dataset.workflowAnchor, top: rect.top, bottom: rect.bottom }
  })
  const anchor = selectViewportAnchor(candidates, view.innerHeight)
  return {
    id: anchor?.id || '',
    top: anchor?.top ?? 0,
    scrollY: Number(view.scrollY) || 0,
  }
}

export function restoreWorkflowViewport(snapshot, doc = document, view = window) {
  if (!snapshot) return
  const element = [...doc.querySelectorAll('[data-workflow-anchor]')]
    .find((item) => item.dataset.workflowAnchor === snapshot.id)
  const top = element?.getBoundingClientRect().top
  view.scrollTo({ top: restoredScrollTop(snapshot, top, view.scrollY), behavior: 'auto' })
}
