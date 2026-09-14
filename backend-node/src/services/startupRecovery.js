'use strict';

// Maintenance must not silently resume a provider outage or unattended run.
// Persist in the runtime config; an environment override is useful for recovery.
function startupRecoveryMode(config = {}, env = process.env) {
  const mode = env.YINZI_WORKFLOW_STARTUP_RECOVERY
    ?? config.runtime?.startup_recovery
    ?? 'auto';
  if (mode !== 'auto' && mode !== 'manual') {
    const error = new Error('runtime.startup_recovery must be auto or manual');
    error.code = 'INVALID_STARTUP_RECOVERY';
    throw error;
  }
  return mode;
}

module.exports = { startupRecoveryMode };