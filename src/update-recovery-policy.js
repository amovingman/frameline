const { compareVersions } = require('./release-policy');
function fail(code) { const error = new Error(code); error.code = code; return error; }

// Pure recovery policy. A future installer must persist these phases and perform
// artifact verification, activation, and rollback before reporting success.
function beginUpdate({ currentVersion, targetVersion, currentDataSchema, targetCanOpenCurrentData } = {}) {
  if (compareVersions(targetVersion, currentVersion) <= 0) throw fail('update-downgrade-blocked');
  if (!Number.isSafeInteger(currentDataSchema) || currentDataSchema < 1
    || targetCanOpenCurrentData !== true) throw fail('update-data-incompatible');
  return { phase: 'staging', currentVersion, targetVersion, currentDataSchema, previousVersionRetained: true };
}

function advanceUpdate(state, event) {
  if (!state || state.previousVersionRetained !== true) throw fail('update-state-invalid');
  const transitions = {
    staging: { 'artifact-verified': 'ready', interrupt: 'discard-staging' },
    ready: { activate: 'health-check', interrupt: 'discard-staging' },
    'health-check': { healthy: 'complete', failed: 'rollback-required', interrupt: 'rollback-required' },
    'rollback-required': { restored: 'rolled-back' }
  };
  const next = transitions[state.phase]?.[event];
  if (!next) throw fail('update-transition-invalid');
  return { ...state, phase: next };
}

module.exports = { beginUpdate, advanceUpdate };
