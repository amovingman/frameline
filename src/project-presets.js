const { randomUUID } = require('node:crypto');
const { CLASSES } = require('./media-storage-policy');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const BRANCH = /^[a-z0-9][a-z0-9._-]{0,39}$/;
function fail(code) { const error = new Error(code); error.code = code; return error; }

// Presets produce an explicit plan; applying branch/media changes needs a
// separate authorized transaction once a project has been created.
function createProjectPresets({ authorize } = {}) {
  if (typeof authorize !== 'function') throw fail('preset-store-invalid');
  const presets = new Map();
  function save({ actorId, teamId, name, branches = [], syncClasses = [] }) {
    if (!ID.test(actorId || '') || !ID.test(teamId || '') || authorize(actorId, teamId, 'manage') !== true) throw fail('preset-forbidden');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\\/\x00-\x1f]/.test(name)
      || !Array.isArray(branches) || branches.some(branch => !BRANCH.test(branch) || branch === 'main')
      || new Set(branches).size !== branches.length || branches.length > 20
      || !Array.isArray(syncClasses) || syncClasses.some(value => !CLASSES.includes(value))
      || new Set(syncClasses).size !== syncClasses.length) throw fail('preset-invalid');
    const value = { id: randomUUID(), teamId, name: name.trim(), branches: [...branches].sort(),
      syncClasses: [...syncClasses].sort(), version: 1 };
    presets.set(value.id, value); return structuredClone(value);
  }
  function list(actorId, teamId) {
    if (!ID.test(actorId || '') || !ID.test(teamId || '') || authorize(actorId, teamId, 'read') !== true) throw fail('preset-forbidden');
    return [...presets.values()].filter(value => value.teamId === teamId).map(value => structuredClone(value));
  }
  function plan({ actorId, teamId, presetId, projectId }) {
    if (!ID.test(actorId || '') || !ID.test(teamId || '') || !ID.test(projectId || '')
      || authorize(actorId, teamId, 'read') !== true) throw fail('preset-forbidden');
    const preset = presets.get(presetId);
    if (!preset || preset.teamId !== teamId) throw fail('preset-not-found');
    return { projectId, presetId, branchesToCreate: [...preset.branches],
      syncClassesToSet: [...preset.syncClasses], applied: false };
  }
  return { save, list, plan };
}

module.exports = { createProjectPresets };
