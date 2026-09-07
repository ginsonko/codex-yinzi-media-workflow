import * as THREE from 'three'

function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max, fallback) {
  return Math.min(max, Math.max(min, finite(value, fallback)))
}

function safeColor(value, fallback) {
  try {
    return new THREE.Color(value || fallback)
  } catch (_) {
    return new THREE.Color(fallback)
  }
}

export function createDirectorMaterial(props = {}, fallbackColor = '#d8794f', defaults = {}) {
  const opacity = clamp(props.opacity, 0.02, 1, defaults.opacity ?? 1)
  const wireframe = props.wireframe === true
  const transparent = opacity < 0.999 || defaults.transparent === true
  const requestedSide = String(props.side || '').toLowerCase()
  const side = requestedSide === 'back'
    ? THREE.BackSide
    : requestedSide === 'double' || transparent
      ? THREE.DoubleSide
      : (defaults.side ?? THREE.FrontSide)
  return new THREE.MeshStandardMaterial({
    ...defaults,
    color: safeColor(props.color, fallbackColor),
    roughness: clamp(props.roughness, 0, 1, defaults.roughness ?? 0.65),
    metalness: clamp(
      props.metalness,
      0,
      1,
      props.reflective === true ? 0.38 : (defaults.metalness ?? 0.12)
    ),
    emissive: safeColor(props.emissive, defaults.emissive || '#000000'),
    emissiveIntensity: clamp(
      props.emissive_intensity ?? props.emissiveIntensity,
      0,
      20,
      defaults.emissiveIntensity ?? 0
    ),
    opacity,
    transparent,
    wireframe,
    side,
    depthWrite: defaults.depthWrite ?? (!transparent && !wireframe),
  })
}

export function resolveDirectorCameraTarget(cameraRecord, objectMap) {
  if (!cameraRecord || cameraRecord.props?.aim_mode === 'rotation') return null
  const targetId = String(cameraRecord.props?.target_id || '')
  const target = objectMap.get(targetId)
  if (!target) return null
  target.updateMatrixWorld(true)
  const point = new THREE.Vector3()
  target.getWorldPosition(point)
  const offset = Array.isArray(cameraRecord.props?.target_offset)
    ? cameraRecord.props.target_offset
    : [0, finite(target.userData?.directorFocusHeight, 0), 0]
  point.add(new THREE.Vector3(
    finite(offset[0], 0),
    finite(offset[1], 0),
    finite(offset[2], 0)
  ))
  return point
}

export function applyDirectorCameraAim(camera, cameraRecord, objectMap) {
  if (!camera?.isPerspectiveCamera) return null
  const target = resolveDirectorCameraTarget(cameraRecord, objectMap)
  if (!target) return null
  camera.lookAt(target)
  camera.updateMatrixWorld(true)
  return target
}

export function inspectDirectorCameraFraming(camera, target, margin = 0.96) {
  if (!camera?.isPerspectiveCamera || !target) {
    return { ok: false, reason: 'missing_camera_target' }
  }
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const projected = target.clone().project(camera)
  const finiteProjection = [projected.x, projected.y, projected.z].every(Number.isFinite)
  const ok = finiteProjection
    && Math.abs(projected.x) <= margin
    && Math.abs(projected.y) <= margin
    && projected.z >= -1
    && projected.z <= 1
  return {
    ok,
    reason: ok ? null : 'target_out_of_frame',
    ndc: [projected.x, projected.y, projected.z],
  }
}
