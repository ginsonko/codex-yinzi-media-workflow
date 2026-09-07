export function normalizeTargetShots(value, fallback = 1) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) return Math.max(1, Number(fallback) || 1)
  return Math.min(999, number)
}

export function resolveTemplateTargetShots({ currentValue, templateDefault, userEdited = false } = {}) {
  if (userEdited) return normalizeTargetShots(currentValue)
  return normalizeTargetShots(templateDefault, currentValue)
}

export function resolvedPlanTargetShots(plan, fallback = 1) {
  return normalizeTargetShots(plan?.recommended_settings?.target_shots?.value, fallback)
}
