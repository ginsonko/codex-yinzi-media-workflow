const settingsService = require('./settingsService');

const SETTING_KEY = 'production_automation_preferences';
const DEFAULTS = Object.freeze({
  review_concurrency: 3,
  max_consecutive_review_rejections: 5,
  max_consecutive_recovery_failures: 5,
  notifications_enabled: true,
  notification_sound_enabled: true,
  moderation_fallback_enabled: false,
  moderation_fallback_model: 'mg-seedance2.0 -480p fast',
});

function normalize(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const concurrency = Number(source.review_concurrency);
  const reviewLimit = Number(source.max_consecutive_review_rejections);
  const recoveryLimit = Number(source.max_consecutive_recovery_failures);
  return {
    review_concurrency: Number.isFinite(concurrency)
      ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(concurrency)))
      : DEFAULTS.review_concurrency,
    max_consecutive_review_rejections: Number.isFinite(reviewLimit)
      ? Math.min(20, Math.max(1, Math.floor(reviewLimit)))
      : DEFAULTS.max_consecutive_review_rejections,
    max_consecutive_recovery_failures: Number.isFinite(recoveryLimit)
      ? Math.min(20, Math.max(1, Math.floor(recoveryLimit)))
      : DEFAULTS.max_consecutive_recovery_failures,
    notifications_enabled: source.notifications_enabled !== false,
    notification_sound_enabled: source.notification_sound_enabled !== false,
    moderation_fallback_enabled: source.moderation_fallback_enabled === true,
    moderation_fallback_model: String(source.moderation_fallback_model || DEFAULTS.moderation_fallback_model).trim()
      || DEFAULTS.moderation_fallback_model,
  };
}

function get(db) {
  return normalize(settingsService.getGlobalSetting(db, SETTING_KEY, DEFAULTS));
}

function set(db, input) {
  const value = normalize(input);
  settingsService.setGlobalSetting(db, SETTING_KEY, value);
  return value;
}

module.exports = { DEFAULTS, SETTING_KEY, get, normalize, set };
