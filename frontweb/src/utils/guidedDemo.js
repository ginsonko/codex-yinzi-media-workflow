export const DEMO_DIRECTOR_MODE = '携带 3D 预演'

export function demoShotReferenceLabel(index, directorMode, transitionMode = 'hard_cut') {
  const parts = []
  if (Number(index) > 0 && transitionMode === 'strict_first_frame') parts.push('上一镜尾帧')
  parts.push('3 图')
  if (directorMode === DEMO_DIRECTOR_MODE) parts.push('1 预演')
  return parts.join(' + ')
}
