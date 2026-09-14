/**
 * JSON Schemas and structural validators for Model-Neutral Shot IR and Target Profiles.
 * Pure deterministic JavaScript - no network, no external dependencies.
 */

export const SHOT_IR_SCHEMA_VERSION = 'shot-ir/v1';

export const VALID_REFERENCE_TYPES = Object.freeze([
  'image',
  'video',
  'audio'
]);

export const VALID_REFERENCE_ROLES = Object.freeze([
  'character',
  'face',
  'subject',
  'style',
  'background',
  'video',
  'audio',
  'pose',
  'motion_guide'
]);

export const VALID_CAMERA_MOVEMENTS = Object.freeze([
  'static',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'zoom_in',
  'zoom_out',
  'tracking',
  'pedestal',
  'dolly',
  'arc',
  'crane',
  'handheld',
  'whip_pan'
]);

export const VALID_SHOT_TYPES = Object.freeze([
  'extreme_close_up',
  'close_up',
  'medium_close_up',
  'medium_shot',
  'cowboy_shot',
  'full_shot',
  'long_shot',
  'extreme_long_shot',
  'aerial_shot',
  'over_the_shoulder',
  'point_of_view'
]);

export const LOSS_SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  DEGRADED: 'degraded',
  DROPPED: 'dropped'
});

/**
 * Validate neutral Shot IR structure safely without throwing TypeErrors.
 * @param {any} ir
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateShotIR(ir) {
  const errors = [];
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) {
    return { valid: false, errors: ['Shot IR must be a non-null object'] };
  }

  if (ir.version !== SHOT_IR_SCHEMA_VERSION) {
    errors.push(`Invalid or missing version, expected "${SHOT_IR_SCHEMA_VERSION}"`);
  }

  if (!Array.isArray(ir.shots) || ir.shots.length === 0) {
    errors.push('Shot IR must contain a non-empty "shots" array');
  } else {
    ir.shots.forEach((shot, idx) => {
      const shotPrefix = `Shot[${idx}] (id: ${shot?.shot_id ?? idx})`;
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
        errors.push(`${shotPrefix}: must be an object`);
        return;
      }

      if (shot.shot_id === undefined || shot.shot_id === null) {
        errors.push(`${shotPrefix}: missing required "shot_id"`);
      }
      for (const field of ['subject', 'action', 'style', 'negative', 'raw_text']) {
        if (shot[field] != null && typeof shot[field] !== 'string') errors.push(`${shotPrefix}.${field}: must be a string or null`);
      }
      for (const field of ['audio', 'custom_extensions']) {
        if (shot[field] != null && (typeof shot[field] !== 'object' || Array.isArray(shot[field]))) errors.push(`${shotPrefix}.${field}: must be an object or null`);
      }
      if (shot.audio?.description != null && typeof shot.audio.description !== 'string') errors.push(`${shotPrefix}.audio.description: must be a string`);
      if (shot.unsupported != null && (!Array.isArray(shot.unsupported) || !shot.unsupported.every(s => typeof s === 'string'))) errors.push(`${shotPrefix}.unsupported: must be an array of strings`);

      const hasSubject = shot.subject !== undefined && shot.subject !== null && String(shot.subject).trim() !== '';
      const hasRawText = shot.raw_text !== undefined && shot.raw_text !== null && String(shot.raw_text).trim() !== '';
      if (!hasSubject && !hasRawText) {
        errors.push(`${shotPrefix}: must provide at least non-empty "subject" or "raw_text"`);
      }

      // Safe check for references
      if (shot.references !== undefined && shot.references !== null) {
        if (!Array.isArray(shot.references)) {
          errors.push(`${shotPrefix}: "references" must be an array`);
        } else {
          shot.references.forEach((ref, refIdx) => {
            if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
              errors.push(`${shotPrefix}.references[${refIdx}]: must be an object`);
            } else {
              if (ref.index === undefined || typeof ref.index !== 'number' || !Number.isInteger(ref.index) || ref.index <= 0) {
                errors.push(`${shotPrefix}.references[${refIdx}]: "index" must be a positive integer`);
              }
              if (ref.type !== undefined && ref.type !== null && typeof ref.type !== 'string') {
                errors.push(`${shotPrefix}.references[${refIdx}]: "type" must be a string`);
              }
              if (ref.role && typeof ref.role !== 'string') {
                errors.push(`${shotPrefix}.references[${refIdx}]: "role" must be a string`);
              }
              for (const field of ['label', 'asset_id', 'path', 'url', 'sha256']) {
                if (ref[field] != null && typeof ref[field] !== 'string') errors.push(`${shotPrefix}.references[${refIdx}].${field}: must be a string`);
              }
            }
          });
        }
      }

      // Safe check for time: nullable optional field
      if (shot.time !== undefined && shot.time !== null) {
        if (typeof shot.time !== 'object' || Array.isArray(shot.time)) {
          errors.push(`${shotPrefix}: "time" must be an object or null`);
        } else if (shot.time.duration !== undefined && shot.time.duration !== null) {
          if (typeof shot.time.duration !== 'number' || !Number.isFinite(shot.time.duration) || shot.time.duration <= 0) {
            errors.push(`${shotPrefix}: time.duration must be a positive finite number`);
          }
        }
        if (shot.time.start != null && (typeof shot.time.start !== 'number' || !Number.isFinite(shot.time.start) || shot.time.start < 0)) errors.push(`${shotPrefix}.time.start: must be nonnegative finite seconds`);
      }

      // Safe check for camera: nullable optional field
      if (shot.camera !== undefined && shot.camera !== null) {
        if (typeof shot.camera !== 'object' || Array.isArray(shot.camera)) {
          errors.push(`${shotPrefix}: "camera" must be an object or null`);
        }
        for (const field of ['shot_type', 'movement', 'description']) {
          if (shot.camera[field] != null && typeof shot.camera[field] !== 'string') errors.push(`${shotPrefix}.camera.${field}: must be a string`);
        }
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate target profile definition safely
 * @param {any} profile
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { valid: false, errors: ['Profile must be a non-null object'] };
  }

  if (typeof profile.profile_id !== 'string' || !profile.profile_id.trim()) {
    errors.push('Profile missing required string "profile_id"');
  }

  if (!profile.model_name || typeof profile.model_name !== 'string') {
    errors.push('Profile missing required string "model_name"');
  }

  if (!['supported', 'unknown', 'unsupported'].includes(profile.availability)) {
    errors.push('Profile availability must be "supported", "unknown", or "unsupported"');
  }

  if (profile.duration_mode && !['range', 'fixed', 'enumerated', 'unknown'].includes(profile.duration_mode)) {
    errors.push('Profile duration_mode must be one of "range", "fixed", "enumerated", "unknown"');
  }

  if (profile.duration_mode === 'fixed') {
    if (typeof profile.fixed_duration_seconds !== 'number' || !Number.isFinite(profile.fixed_duration_seconds) || profile.fixed_duration_seconds <= 0) {
      errors.push('Fixed duration profile requires positive finite number "fixed_duration_seconds"');
    }
  }

  if (profile.duration_mode === 'range') {
    if (typeof profile.duration_min !== 'number' || !Number.isFinite(profile.duration_min) || profile.duration_min <= 0 ||
        typeof profile.duration_max !== 'number' || !Number.isFinite(profile.duration_max) || profile.duration_max < profile.duration_min) {
      errors.push('Range duration profile requires positive finite numbers "duration_min" <= "duration_max"');
    }
  }

  if (profile.duration_mode === 'enumerated') {
    if (!Array.isArray(profile.allowed_durations) || profile.allowed_durations.length === 0 || !profile.allowed_durations.every(d => typeof d === 'number' && Number.isFinite(d) && d > 0)) {
      errors.push('Enumerated duration profile requires non-empty array of positive finite numbers "allowed_durations"');
    }
  }

  for (const field of ['max_images', 'max_videos', 'max_audios', 'max_total_references', 'max_prompt_length']) {
    if (profile[field] != null && (!Number.isSafeInteger(profile[field]) || profile[field] < 0)) errors.push(`${field} must be a nonnegative integer or null`);
  }
  for (const field of ['first_last_frame_supported', 'negative_prompt_supported', 'each_reference_must_be_mentioned']) {
    if (profile[field] != null && typeof profile[field] !== 'boolean') errors.push(`${field} must be boolean or null`);
  }
  if (profile.supported_resolutions != null && (!Array.isArray(profile.supported_resolutions) || !profile.supported_resolutions.every(r => typeof r === 'string'))) errors.push('supported_resolutions must be an array of strings');
  if (profile.reference_template != null && (typeof profile.reference_template !== 'string' || !profile.reference_template.includes('{type}') || !profile.reference_template.includes('{index}'))) errors.push('reference_template must contain {type} and {index}');
  if (profile.shot_separator != null && typeof profile.shot_separator !== 'string') errors.push('shot_separator must be a string');
  return { valid: errors.length === 0, errors };
}