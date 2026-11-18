'use strict';
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateProjectPreset, validateProjectPresetSaveInput, validateProjectPresetSaveResponse,
  validateProjectPresetPreviewInput, validateProjectPresetCreateInput, validateProjectPresetCreation } = require('./project-presets-protocol');

const MAX_PRESETS = 1000, MAX_RECEIPTS = 10000, MAX_CREATIONS = 10000, MAX_BYTES = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const id = value => typeof value === 'string' && ID.test(value);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === fields.slice().sort().join('|');
const fail = code => Object.assign(new Error(code), { code });
const clone = value => structuredClone(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const PRESET_FIELDS = ['id', 'teamId', 'name', 'branches', 'syncClasses', 'version', 'createdAt', 'updatedAt'];
const publicPreset = value => Object.fromEntries(PRESET_FIELDS.map(key => [key, clone(value[key])]));
const publicCreation = value => Object.fromEntries(['projectId', 'teamId', 'presetId', 'presetVersion', 'projectName',
  'branches', 'syncClasses', 'createdAt'].map(key => [key, clone(value[key])]));
const saveIntent = value => Object.fromEntries(['presetId', 'expectedVersion', 'name', 'branches', 'syncClasses'].map(key => [key, clone(value[key])]));
const createIntent = value => Object.fromEntries(['presetId', 'expectedVersion', 'projectName', 'planId'].map(key => [key, clone(value[key])]));
const requestHash = (operation, actorId, teamId, input) => fingerprint({ domain: 'project-presets-v1', operation, actorId, teamId, input });
const receiptKey = (operation, actorId, teamId, key) => fingerprint({ domain: 'project-preset-receipt-v1', operation, actorId, teamId, key });
function planHash(actorId, preset, projectName) {
  return fingerprint({ domain: 'new-project-from-preset-v1', actorId, teamId: preset.teamId, presetId: preset.id,
    presetVersion: preset.version, projectName, branches: ['main', ...preset.branches], syncClasses: preset.syncClasses });
}

function validateServiceProjectPresetsState(value) {
  const bad = () => { throw fail('preset-state-invalid'); };
  try {
    if (!exact(value, ['version', 'presets', 'saveReceipts', 'creations']) || value.version !== 1
      || !Array.isArray(value.presets) || value.presets.length > MAX_PRESETS
      || !Array.isArray(value.saveReceipts) || value.saveReceipts.length > MAX_RECEIPTS
      || !Array.isArray(value.creations) || value.creations.length > MAX_CREATIONS) bad();
    const presets = new Map(), keys = new Set(), projects = new Set(), versions = new Map(), transitions = new Map();
    for (const item of value.presets) {
      if (!exact(item, [...PRESET_FIELDS, 'createdBy', 'updatedBy']) || !id(item.createdBy)
        || !id(item.updatedBy) || presets.has(item.id) || item.version > MAX_RECEIPTS) bad();
      validateProjectPreset(publicPreset(item)); presets.set(item.id, item);
    }
    for (const item of value.saveReceipts) {
      if (!exact(item, ['actorId', 'teamId', 'keyHash', 'requestHash', 'input', 'result'])
        || !id(item.actorId) || !id(item.teamId) || !SHA.test(item.keyHash || '')
        || !SHA.test(item.requestHash || '') || keys.has(item.keyHash)
        || !exact(item.input, ['presetId', 'expectedVersion', 'name', 'branches', 'syncClasses'])) bad();
      validateProjectPresetSaveInput({ teamId: item.teamId, ...item.input, idempotencyKey: 'saved-receipt' });
      const result = validateProjectPresetSaveResponse(item.result, { teamId: item.teamId, ...item.input });
      const current = presets.get(result.id);
      if (!current || current.teamId !== item.teamId || current.createdAt !== result.createdAt || current.version < result.version
        || item.input.presetId === null && current.createdBy !== item.actorId
        || item.requestHash !== requestHash('save', item.actorId, item.teamId, item.input)) bad();
      keys.add(item.keyHash);
      const versionKey = `${result.id}:${result.version}`, prior = versions.get(versionKey);
      if (prior && fingerprint(prior) !== fingerprint(result)) bad();
      versions.set(versionKey, result);
      if (item.input.expectedVersion === result.version - 1) {
        if (transitions.has(versionKey)) bad();
        transitions.set(versionKey, item);
      }
    }
    for (const preset of presets.values()) {
      let previous = null;
      for (let version = 1; version <= preset.version; version++) {
        const versionKey = `${preset.id}:${version}`, result = versions.get(versionKey), transition = transitions.get(versionKey);
        if (!result || !transition || version === 1 && (transition.input.presetId !== null
          || transition.actorId !== preset.createdBy || result.updatedAt !== result.createdAt)
          || version > 1 && (transition.input.presetId !== preset.id || result.updatedAt < previous.updatedAt
            || ['name', 'branches', 'syncClasses'].every(key => fingerprint(result[key]) === fingerprint(previous[key])))) bad();
        previous = result;
      }
      if (fingerprint(previous) !== fingerprint(publicPreset(preset))
        || transitions.get(`${preset.id}:${preset.version}`).actorId !== preset.updatedBy) bad();
    }
    for (const item of value.creations) {
      if (!exact(item, ['projectId', 'teamId', 'presetId', 'presetVersion', 'projectName', 'branches', 'syncClasses', 'createdAt',
        'actorId', 'planId', 'keyHash', 'requestHash', 'template']) || !id(item.actorId)
        || !SHA.test(item.keyHash || '') || keys.has(item.keyHash) || !SHA.test(item.requestHash || '') || projects.has(item.projectId)) bad();
      const template = validateProjectPreset(item.template, { teamId: item.teamId, presetId: item.presetId });
      const input = { presetId: item.presetId, expectedVersion: item.presetVersion, projectName: item.projectName, planId: item.planId };
      validateProjectPresetCreateInput({ teamId: item.teamId, ...input, idempotencyKey: 'saved-creation' });
      validateProjectPresetCreation(publicCreation(item), { teamId: item.teamId, ...input });
      const current = presets.get(item.presetId);
      if (!current || current.teamId !== item.teamId || current.version < template.version || current.createdAt !== template.createdAt
        || fingerprint(versions.get(`${template.id}:${template.version}`)) !== fingerprint(template)
        || template.version !== item.presetVersion || item.createdAt < template.updatedAt
        || fingerprint(item.branches) !== fingerprint(['main', ...template.branches])
        || fingerprint(item.syncClasses) !== fingerprint(template.syncClasses)
        || item.planId !== planHash(item.actorId, template, item.projectName)
        || item.requestHash !== requestHash('create', item.actorId, item.teamId, input)) bad();
      keys.add(item.keyHash); projects.add(item.projectId);
    }
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) bad();
    return clone(value);
  } catch { throw fail('preset-state-invalid'); }
}

// Compose mutations only inside the collaboration transaction. Project access,
// empty branches, immutable initial media policy, and the creation receipt are
// published in its one encrypted generation. No asset-directory write occurs.
function createServiceProjectPresets({ identity, access, history, initialState = null,
  mediaAvailable = false, now = Date.now } = {}) {
  if (!identity || typeof identity.getUser !== 'function' || !access || typeof access.snapshot !== 'function'
    || typeof access.registerProject !== 'function' || !history || typeof history.snapshot !== 'function'
    || typeof history.createProject !== 'function' || typeof history.createBranch !== 'function'
    || typeof mediaAvailable !== 'boolean' || typeof now !== 'function') throw fail('preset-invalid');
  let state = initialState === null ? { version: 1, presets: [], saveReceipts: [], creations: [] }
    : validateServiceProjectPresetsState(initialState);
  function user(actorId) {
    if (!ID.test(actorId || '') || identity.getUser(actorId).status !== 'active') throw fail('preset-forbidden');
  }
  function authorize(actorId, teamId, write = false) {
    user(actorId);
    if (!ID.test(teamId || '')) throw fail('preset-invalid');
    const team = access.snapshot().teams.find(item => item.id === teamId);
    const role = team?.members.find(item => item.userId === actorId)?.role;
    if (!role || write && role !== 'owner') throw fail('preset-forbidden');
    return { team, role };
  }
  function clock() { const at = now(); if (!time(at)) throw fail('preset-invalid'); return at; }
  function commit(next) {
    if (next.presets.length > MAX_PRESETS || next.saveReceipts.length > MAX_RECEIPTS || next.creations.length > MAX_CREATIONS
      || Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw fail('preset-capacity');
    state = next;
  }
  function currentPreset(teamId, presetId, expectedVersion) {
    const value = state.presets.find(item => item.id === presetId && item.teamId === teamId);
    if (!value) throw fail('preset-not-found');
    if (value.version !== expectedVersion) throw fail('preset-version-conflict');
    return value;
  }
  function listTeams(actorId) {
    user(actorId);
    return { teams: access.snapshot().teams.flatMap(team => {
      const role = team.members.find(item => item.userId === actorId)?.role;
      return role ? [{ id: team.id, name: team.name, role }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), mediaAvailable };
  }
  function list(actorId, teamId) {
    authorize(actorId, teamId);
    return { teamId, items: state.presets.filter(item => item.teamId === teamId).map(publicPreset)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  }
  function save(actorId, raw) {
    const input = validateProjectPresetSaveInput(raw); authorize(actorId, input.teamId, true);
    const intent = saveIntent(input), hash = requestHash('save', actorId, input.teamId, intent),
      keyHash = receiptKey('save', actorId, input.teamId, input.idempotencyKey);
    const receipt = state.saveReceipts.find(item => item.keyHash === keyHash);
    if (receipt) {
      if (receipt.requestHash !== hash) throw fail('preset-idempotency-conflict');
      return clone(receipt.result);
    }
    const previous = input.presetId === null ? null : currentPreset(input.teamId, input.presetId, input.expectedVersion);
    const changed = !previous || ['name', 'branches', 'syncClasses'].some(key => fingerprint(previous[key]) !== fingerprint(input[key]));
    if (changed && previous?.version === Number.MAX_SAFE_INTEGER) throw fail('preset-capacity');
    const at = Math.max(clock(), previous?.updatedAt || 0);
    const result = !changed ? previous : { id: previous?.id || randomUUID(), teamId: input.teamId, name: input.name,
      branches: clone(input.branches), syncClasses: clone(input.syncClasses), version: previous ? previous.version + 1 : 1,
      createdAt: previous?.createdAt ?? at, updatedAt: at, createdBy: previous?.createdBy || actorId, updatedBy: actorId };
    const output = publicPreset(result);
    commit({ ...state, presets: changed ? [...state.presets.filter(item => item.id !== result.id), result] : state.presets,
      saveReceipts: [...state.saveReceipts, { actorId, teamId: input.teamId, keyHash, requestHash: hash, input: intent, result: output }] });
    return clone(output);
  }
  function preview(actorId, raw) {
    const input = validateProjectPresetPreviewInput(raw); authorize(actorId, input.teamId, true);
    const template = currentPreset(input.teamId, input.presetId, input.expectedVersion);
    return { planId: planHash(actorId, template, input.projectName), teamId: input.teamId, presetId: template.id,
      presetVersion: template.version, projectName: input.projectName, branches: ['main', ...template.branches],
      syncClasses: clone(template.syncClasses), mediaAvailable };
  }
  function create(actorId, raw) {
    const input = validateProjectPresetCreateInput(raw); authorize(actorId, input.teamId, true);
    const intent = createIntent(input), hash = requestHash('create', actorId, input.teamId, intent),
      keyHash = receiptKey('create', actorId, input.teamId, input.idempotencyKey);
    const receipt = state.creations.find(item => item.keyHash === keyHash);
    // A committed retry returns its historical receipt before current template
    // version checks. It never recreates a deleted project or resets its policy.
    if (receipt) {
      if (receipt.requestHash !== hash) throw fail('preset-idempotency-conflict');
      return publicCreation(receipt);
    }
    const plan = preview(actorId, { teamId: input.teamId, presetId: input.presetId,
      expectedVersion: input.expectedVersion, projectName: input.projectName });
    if (plan.planId !== input.planId) throw fail('preset-plan-stale');
    if (plan.syncClasses.length && !mediaAvailable) throw fail('preset-media-unavailable');
    if (state.creations.length >= MAX_CREATIONS) throw fail('preset-capacity');
    const template = publicPreset(currentPreset(input.teamId, input.presetId, input.expectedVersion));
    const projectId = randomUUID(), at = Math.max(clock(), template.updatedAt);
    history.createProject({ projectId, name: plan.projectName }); access.registerProject(actorId, projectId, input.teamId);
    for (const branch of template.branches) history.createBranch(projectId, branch);
    const value = { projectId, teamId: input.teamId, presetId: template.id, presetVersion: template.version,
      projectName: plan.projectName, branches: clone(plan.branches), syncClasses: clone(plan.syncClasses), createdAt: at,
      actorId, planId: plan.planId, keyHash, requestHash: hash, template };
    commit({ ...state, creations: [...state.creations, value] }); return publicCreation(value);
  }
  function initialPolicy(actorId, projectId) {
    user(actorId); access.authorize(actorId, { projectId, resource: 'project', action: 'read' });
    const creation = state.creations.find(item => item.projectId === projectId);
    return { projectId, version: creation ? 1 : 0, syncClasses: clone(creation?.syncClasses || []) };
  }
  return { listTeams, list, save, preview, create, initialPolicy, snapshot: () => clone(state) };
}
module.exports = { createServiceProjectPresets, validateServiceProjectPresetsState, MAX_PRESETS, MAX_RECEIPTS, MAX_CREATIONS, MAX_BYTES };
