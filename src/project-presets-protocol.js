'use strict';
const PRESET_ERROR_CODES = Object.freeze(['preset-invalid', 'preset-forbidden', 'preset-not-found',
  'preset-version-conflict', 'preset-idempotency-conflict', 'preset-capacity', 'preset-plan-stale',
  'preset-media-unavailable', 'preset-unavailable']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const BRANCH = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const CLASSES = new Set(['audio', 'graphics', 'original', 'other', 'proxy']);
const id = value => typeof value === 'string' && ID.test(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const version = value => Number.isSafeInteger(value) && value >= 1;
const name = (value, max) => typeof value === 'string' && value === value.trim() && value.length >= 1
  && value.length <= max && !/[\\/\x00-\x1f\x7f]/.test(value);
const fail = (code = 'sync-response-invalid') => Object.assign(new Error(code), { code });
function sorted(values, check, max) {
  return Array.isArray(values) && values.length <= max && values.every(check)
    && values.every((value, index) => index === 0 || values[index - 1] < value);
}
const branches = values => sorted(values, value => typeof value === 'string' && BRANCH.test(value) && value !== 'main', 20);
const classes = values => sorted(values, value => CLASSES.has(value), 5);
const projectBranches = values => Array.isArray(values) && values[0] === 'main' && branches(values.slice(1));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function validatePresetTeamCatalog(value) {
  if (!exact(value, ['teams', 'mediaAvailable']) || typeof value.mediaAvailable !== 'boolean'
    || !Array.isArray(value.teams) || value.teams.length > 10000) throw fail();
  const seen = new Set(), teams = value.teams.map(team => {
    if (!exact(team, ['id', 'name', 'role']) || !id(team.id) || typeof team.name !== 'string' || team.name !== team.name.trim()
      || team.name.length < 1 || team.name.length > 120 || /[\x00-\x1f\x7f]/.test(team.name)
      || !['owner', 'editor', 'viewer'].includes(team.role) || seen.has(team.id)) throw fail();
    seen.add(team.id); return { id: team.id, name: team.name, role: team.role };
  });
  return { teams, mediaAvailable: value.mediaAvailable };
}
function validateProjectPreset(value, { teamId, presetId } = {}) {
  if (!exact(value, ['id', 'teamId', 'name', 'branches', 'syncClasses', 'version', 'createdAt', 'updatedAt'])
    || !id(value.id) || !id(value.teamId) || teamId !== undefined && value.teamId !== teamId
    || presetId !== undefined && value.id !== presetId || !name(value.name, 80) || !branches(value.branches)
    || !classes(value.syncClasses) || !version(value.version) || !time(value.createdAt) || !time(value.updatedAt)
    || value.updatedAt < value.createdAt) throw fail();
  return { id: value.id, teamId: value.teamId, name: value.name, branches: value.branches.slice(),
    syncClasses: value.syncClasses.slice(), version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function validateProjectPresetCatalog(value, teamId) {
  if (!id(teamId) || !exact(value, ['teamId', 'items']) || value.teamId !== teamId
    || !Array.isArray(value.items) || value.items.length > 1000) throw fail();
  const seen = new Set(), items = value.items.map(item => {
    const checked = validateProjectPreset(item, { teamId }); if (seen.has(checked.id)) throw fail(); seen.add(checked.id); return checked;
  });
  return { teamId, items };
}
function bound(value, context) {
  return context && id(context.teamId) && id(context.presetId) && version(context.expectedVersion)
    && name(context.projectName, 120) && value.teamId === context.teamId && value.presetId === context.presetId
    && value.presetVersion === context.expectedVersion && value.projectName === context.projectName;
}
function validateProjectPresetPlan(value, context) {
  if (!exact(value, ['planId', 'teamId', 'presetId', 'presetVersion', 'projectName', 'branches', 'syncClasses', 'mediaAvailable'])
    || !bound(value, context) || typeof value.planId !== 'string' || !/^[a-f0-9]{64}$/.test(value.planId)
    || !projectBranches(value.branches) || !classes(value.syncClasses) || typeof value.mediaAvailable !== 'boolean') throw fail();
  return structuredClone(value);
}
function validateProjectPresetCreation(value, context) {
  if (!exact(value, ['projectId', 'teamId', 'presetId', 'presetVersion', 'projectName', 'branches', 'syncClasses', 'createdAt'])
    || !bound(value, context) || !id(value.projectId) || !projectBranches(value.branches)
    || !classes(value.syncClasses) || !time(value.createdAt)) throw fail();
  return structuredClone(value);
}
function validateProjectPresetSaveInput(value) {
  if (!exact(value, ['teamId', 'presetId', 'expectedVersion', 'name', 'branches', 'syncClasses', 'idempotencyKey'])
    || !id(value.teamId) || !id(value.idempotencyKey) || !name(value.name, 80)
    || !branches(value.branches) || !classes(value.syncClasses)
    || !(value.presetId === null ? value.expectedVersion === 0 : id(value.presetId) && version(value.expectedVersion))) throw fail('preset-invalid');
  return structuredClone(value);
}
function validateProjectPresetPreviewInput(value) {
  if (!exact(value, ['teamId', 'presetId', 'expectedVersion', 'projectName']) || !id(value.teamId)
    || !id(value.presetId) || !version(value.expectedVersion) || !name(value.projectName, 120)) throw fail('preset-invalid');
  return structuredClone(value);
}
function validateProjectPresetCreateInput(value) {
  if (!exact(value, ['teamId', 'presetId', 'expectedVersion', 'projectName', 'planId', 'idempotencyKey'])
    || !id(value.idempotencyKey) || typeof value.planId !== 'string' || !/^[a-f0-9]{64}$/.test(value.planId)) throw fail('preset-invalid');
  validateProjectPresetPreviewInput(Object.fromEntries(['teamId', 'presetId', 'expectedVersion', 'projectName'].map(key => [key, value[key]])));
  return structuredClone(value);
}
function validateProjectPresetSaveResponse(value, input) {
  const checked = validateProjectPreset(value, { teamId: input.teamId, ...(input.presetId === null ? {} : { presetId: input.presetId }) });
  if (checked.name !== input.name || !equal(checked.branches, input.branches) || !equal(checked.syncClasses, input.syncClasses)
    || !(input.presetId === null ? checked.version === 1 : [input.expectedVersion, input.expectedVersion + 1].includes(checked.version))) throw fail();
  return checked;
}
// Preset request objects contain only scalar fields and string arrays. Reject
// duplicate top-level keys before JSON.parse can erase ambiguous intent.
function parseProjectPresetBody(text) {
  let value; try { value = JSON.parse(text); } catch { throw fail('body-invalid'); }
  let depth = 0; const seen = new Set();
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      const start = index; for (index++; index < text.length; index++) { if (text[index] === '\\') index++; else if (text[index] === '"') break; }
      let next = index + 1; while (/\s/.test(text[next] || '') && next < text.length) next++;
      if (depth === 1 && text[next] === ':') { const key = JSON.parse(text.slice(start, index + 1)); if (seen.has(key)) throw fail('body-invalid'); seen.add(key); }
    } else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
  return value;
}
module.exports = { PRESET_ERROR_CODES, validatePresetTeamCatalog, validateProjectPreset, validateProjectPresetCatalog,
  validateProjectPresetPlan, validateProjectPresetCreation, validateProjectPresetSaveInput, validateProjectPresetPreviewInput,
  validateProjectPresetCreateInput, validateProjectPresetSaveResponse, parseProjectPresetBody };
