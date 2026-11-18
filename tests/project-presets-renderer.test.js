'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createDesktopProjectPresets } = require('../src/desktop-project-presets');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = source.indexOf('function currentProjectPresetsAccount('), end = source.indexOf('function currentAccountUpdatesAccount(', start);
assert(start >= 0 && end > start);
class Element {
  constructor(text = '') { this.textContent = text; this.value = ''; this.children = []; this.hidden = false; this.disabled = false; this.isConnected = true; this.listeners = {}; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; node.isConnected = true; this.children.push(node); } }
  add(node) { this.append(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; this.isConnected = false; }
  replaceChildren(...nodes) { for (const node of this.children) { node.parent = null; node.isConnected = false; } this.children = []; this.append(...nodes); }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  closest() { for (let node = this; node; node = node.parent) if (node.hidden) return node; return null; }
  focus() { this.owner.activeElement = this; }
}
function preset(patch = {}) { return { id: 'preset-1', teamId: 'team-1', name: 'Post production', branches: ['edit', 'review'], syncClasses: ['audio', 'proxy'], version: 1, createdAt: 1000, updatedAt: 2000, ...patch }; }
function plan(patch = {}) { return { planId: 'a'.repeat(64), teamId: 'team-1', presetId: 'preset-1', presetVersion: 1, projectName: 'New service project', branches: ['main', 'edit', 'review'], syncClasses: ['audio', 'proxy'], mediaAvailable: true, ...patch }; }
function receipt(patch = {}) { const value = plan(); delete value.planId; delete value.mediaAvailable; return { kind: 'project-created', ...value, projectId: 'created-project', createdAt: 3000, ...patch }; }
function pending(kind = 'create', patch = {}) { return { id: 'local-intent-1', kind, teamId: 'prior-team', presetId: 'prior-preset', expectedVersion: 3,
  ...(kind === 'save' ? { name: 'Prior template', branches: ['edit'] } : { projectName: 'Prior project', branches: ['main', 'edit'] }), syncClasses: ['proxy'], createdAt: 1500, ...patch }; }
function fixture() {
  const document = { body: {}, activeElement: null }, nodes = new Map();
  const make = (tag, name, text = '') => { const node = new Element(text); node.owner = document; return node; };
  const element = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); }; document.getElementById = element;
  const state = { version: 1, scopeId: 'preset-scope', available: true, busy: false, error: null, teamsReady: true, teams: [{ id: 'team-1', name: 'Edit team', role: 'owner' }],
    mediaAvailable: true, teamId: 'team-1', role: 'owner', ready: true, items: [preset()], selectedPresetId: 'preset-1', checkedAt: 2500, preview: null, outcome: null, pending: null };
  const context = vm.createContext({ document, make, structuredClone, Option: function(text, value) { const node = make('option', '', text); node.value = value; return node; },
    serviceState: { origin: 'https://service.example', status: 'connected', account: { id: 'member-1' }, projects: [{ id: 'unrelated-project', role: 'viewer' }] },
    projectPresetsState: state, projectPresetsVersion: 1, projectPresetsAccountKey: '', projectPresetsAccessKey: '', projectPresetsEvidenceKey: '', projectPresetsTeamOptionsKey: '', projectPresetsItemOptionsKey: '',
    projectPresetsAction: null, projectPresetsNotice: '', projectPresetDraft: { name: '', branches: '', syncClasses: [] }, projectPresetNameDraft: '', projectPresetPendingKey: '', projectPresetPendingReviewed: false,
    window: { desktop: { getProjectPresetsState() {}, refreshProjectPresets() {}, selectPresetTeam() {}, loadProjectPresets() {}, selectProjectPreset() {}, saveProjectPreset() {}, previewProjectFromPreset() {}, createProjectFromPreset() {}, retryProjectPresetIntent() {}, dismissProjectPresetIntent() {} } },
    setServiceText: (node, value) => { node.textContent = value; }, serviceDate: value => String(value), serviceErrorLabel: () => 'The service action could not finish.' });
  vm.runInContext(source.slice(start, end), context); context.projectPresetsAccountKey = context.currentProjectPresetsAccount(); context.renderProjectPresetsState(state);
  return { context, state, element, render: () => context.renderProjectPresets(), named() { context.projectPresetNameDraft = 'New service project'; context.renderProjectPresets(); } };
}
function handlers(view) {
  const begin = source.indexOf("document.getElementById('project-presets-refresh').addEventListener"), finish = source.indexOf('window.desktop?.onProjectPresetsState', begin);
  vm.runInContext(source.slice(begin, finish), view.context);
}
test('templates are independent of local projects and require explicit team/catalog refresh', () => {
  const view = fixture(); assert.equal(view.context.currentAppState, undefined); assert.equal(view.element('project-presets-save').disabled, false);
  view.state.teamsReady = false; view.state.ready = false; view.render();
  assert.equal(view.element('project-presets-refresh').disabled, false); assert.equal(view.element('project-presets-team').disabled, true); assert.equal(view.element('project-presets-load').disabled, true);
  assert.match(view.element('project-presets-status').textContent, /Refresh available teams/);
});
test('TEAM membership controls read/write authority independently of project owner/editor/viewer roles', () => {
  for (const role of ['editor', 'viewer']) {
    const view = fixture(); view.context.serviceState.projects[0].role = 'owner'; view.state.teams[0].role = role; view.state.role = role; view.named();
    assert.equal(view.element('project-presets-name').value, 'Post production'); assert.equal(view.element('project-presets-select').disabled, false);
    assert.equal(view.element('project-presets-save').disabled, true); assert.equal(view.element('project-presets-new').disabled, true); assert.equal(view.element('project-presets-preview').disabled, true);
  }
  const owner = fixture(); owner.context.serviceState.projects = []; owner.named(); assert.equal(owner.element('project-presets-preview').disabled, false);
  owner.state.teams = []; owner.render(); assert.equal(owner.element('project-presets-name').value, ''); assert.equal(owner.element('project-presets-class-audio').checked, false);
});
test('additional branches are normalized without dropping duplicates, main, invalid names or excessive counts', () => {
  const view = fixture(); view.context.projectPresetDraft.branches = 'review, edit\nexports';
  assert.equal(JSON.stringify(view.context.parsedProjectPresetDraft().branches), JSON.stringify(['edit', 'exports', 'review']));
  for (const branches of ['main', 'edit\nedit', 'BadCase', 'nested/path', '-bad', Array.from({ length: 21 }, (_, i) => `branch-${i}`).join('\n')]) {
    view.context.projectPresetDraft.branches = branches; view.render(); assert.equal(view.context.parsedProjectPresetDraft(), null); assert.equal(view.element('project-presets-save').disabled, true);
  }
  view.context.projectPresetDraft.branches = ''; assert.deepEqual([...view.context.parsedProjectPresetDraft().branches], []);
  view.context.projectPresetDraft.name = 'Bad/path'; assert.equal(view.context.parsedProjectPresetDraft(), null);
});
test('project creation shows exact main-first branches/classes and requires the current saved preview', () => {
  const view = fixture(); view.named(); assert.equal(view.element('project-presets-preview').disabled, false); assert.equal(view.element('project-presets-create').disabled, true);
  view.state.preview = plan(); view.render(); assert.equal(view.element('project-presets-plan').hidden, false); assert.equal(view.element('project-presets-plan-branches').textContent, 'main, edit, review');
  assert.equal(view.element('project-presets-plan-classes').textContent, 'audio, proxy'); assert.equal(view.element('project-presets-create').disabled, false);
  view.context.projectPresetNameDraft = 'Different project'; view.render(); assert.equal(view.element('project-presets-plan').hidden, true); assert.equal(view.element('project-presets-create').disabled, true);
  view.context.projectPresetNameDraft = 'New service project'; view.context.projectPresetDraft.branches += '\nnew-branch'; view.render();
  assert.equal(view.element('project-presets-preview').disabled, true); assert.equal(view.element('project-presets-create').disabled, true); assert.match(view.element('project-presets-status').textContent, /Save template changes/);
});
test('asset service availability blocks only creation with nonempty classes, while saving retains that explicit intent', () => {
  const view = fixture(); view.state.mediaAvailable = false; view.state.preview = plan({ mediaAvailable: false }); view.named();
  assert.equal(view.element('project-presets-save').disabled, false); assert.equal(view.element('project-presets-plan').hidden, false); assert.equal(view.element('project-presets-create').disabled, true);
  assert.match(view.element('project-presets-plan-status').textContent, /asset service is unavailable/);
  view.context.renderProjectPresetsState({ ...view.state, version: 2, scopeId: 'empty-class-scope', items: [preset({ syncClasses: [] })], preview: plan({ mediaAvailable: false, syncClasses: [] }) }); view.named();
  assert.equal(view.element('project-presets-plan-classes').textContent, 'None enabled'); assert.equal(view.element('project-presets-create').disabled, false);
});
test('progress/unrelated catalogs preserve typed drafts and option nodes; selected version/scope changes reset them', () => {
  const view = fixture(); const option = view.element('project-presets-select').children[1];
  view.context.projectPresetDraft.name = 'Unsaved name'; view.context.projectPresetNameDraft = 'Draft project';
  view.context.renderProjectPresetsState({ ...view.state, version: 2, busy: true }); assert.equal(view.element('project-presets-name').value, 'Unsaved name'); assert.equal(view.element('project-presets-project-name').value, 'Draft project');
  assert.equal(view.element('project-presets-select').children[1], option);
  view.context.renderProjectPresetsState({ ...view.state, version: 3, teams: [...view.state.teams, { id: 'another-team', name: 'Other team', role: 'viewer' }] }); assert.equal(view.element('project-presets-name').value, 'Unsaved name');
  view.context.renderProjectPresetsState({ ...view.state, version: 4, scopeId: 'new-version', items: [preset({ version: 2, name: 'Saved new version' })] });
  assert.equal(view.element('project-presets-name').value, 'Saved new version'); assert.equal(view.element('project-presets-project-name').value, '');
});
test('save ACK emitted before RPC survives a rotated scope and failed catalog reload, but cannot acknowledge different settings', async () => {
  const view = fixture(); view.context.projectPresetDraft.name = 'Changed template';
  view.context.window.desktop.saveProjectPreset = async () => {
    const receipt = { ...view.state, version: 2, scopeId: 'saved-scope', busy: true, ready: false, items: [preset({ name: 'Changed template', version: 2 })], outcome: { kind: 'preset-saved', presetId: 'preset-1', version: 2 } };
    view.context.renderProjectPresetsState(receipt); return { ...receipt, version: 3, busy: false, error: 'sync-network-unavailable' };
  };
  await view.context.runProjectPresetsAction('saveProjectPreset', { scopeId: 'preset-scope', ...view.context.parsedProjectPresetDraft() });
  assert.match(view.element('project-presets-status').textContent, /Template saved · version 2.*Refresh available teams/); assert.equal(view.element('project-presets-save').disabled, true);
  const other = fixture(); other.context.projectPresetDraft.name = 'Expected settings';
  other.context.window.desktop.saveProjectPreset = async () => ({ ...other.state, version: 2, scopeId: 'wrong-receipt', items: [preset({ name: 'Other settings', version: 2 })], outcome: { kind: 'preset-saved', presetId: 'preset-1', version: 2 } });
  await other.context.runProjectPresetsAction('saveProjectPreset', { scopeId: 'preset-scope', ...other.context.parsedProjectPresetDraft() }); assert.doesNotMatch(other.element('project-presets-status').textContent, /Template saved/);
});
test('creation ACK retains immutable settings after project refresh failure without linking/uploading or enabling another Create', async () => {
  const view = fixture(); view.state.preview = plan(); view.named(); const button = view.element('project-presets-create'); view.context.document.activeElement = button;
  view.context.window.desktop.createProjectFromPreset = async () => {
    const result = { ...view.state, version: 2, scopeId: 'creation-scope', busy: true, preview: null, outcome: receipt() };
    view.context.renderProjectPresetsState(result); return { ...result, version: 3, busy: false, error: 'sync-network-unavailable' };
  };
  await view.context.runProjectPresetsAction('createProjectFromPreset', { scopeId: 'preset-scope', planId: plan().planId });
  assert.equal(view.element('project-presets-receipt').hidden, false); assert.equal(view.element('project-presets-receipt-project').textContent, 'created-project');
  assert.equal(view.element('project-presets-receipt-branches').textContent, 'main, edit, review'); assert.equal(view.element('project-presets-receipt-classes').textContent, 'audio, proxy');
  assert.match(view.element('project-presets-status').textContent, /created.*Link a local branch explicitly/); assert.equal(view.element('project-presets-create').disabled, true);
  assert.equal(view.context.document.activeElement, view.element('project-presets-status'));
});
test('new template save can bind its first valid ID and no-op updates preserve the selected version', async () => {
  for (const isNew of [true, false]) {
    const view = fixture(); if (isNew) { view.context.renderProjectPresetsState({ ...view.state, version: 2, scopeId: 'new-template-scope', selectedPresetId: null }); view.context.projectPresetDraft = { name: 'New template', branches: '', syncClasses: [] }; }
    const scopeId = view.context.projectPresetsState.scopeId, saved = isNew ? preset({ id: 'new-preset', name: 'New template', branches: [], syncClasses: [] }) : preset();
    view.context.window.desktop.saveProjectPreset = async () => ({ ...view.state, version: 3, scopeId: 'ack-scope', selectedPresetId: saved.id, items: [saved], outcome: { kind: 'preset-saved', presetId: saved.id, version: saved.version } });
    await view.context.runProjectPresetsAction('saveProjectPreset', { scopeId, ...view.context.parsedProjectPresetDraft() }); assert.match(view.element('project-presets-status').textContent, /Template saved · version 1/);
  }
});
test('team/role/account changes discard pending replies and stale scope guards never call a mutator', async t => {
  for (const change of ['team', 'role', 'account']) await t.test(change, async () => {
    const view = fixture(); let finish, calls = 0; view.context.window.desktop.saveProjectPreset = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    await view.context.runProjectPresetsAction('saveProjectPreset', { scopeId: 'stale', ...view.context.parsedProjectPresetDraft() }); assert.equal(calls, 0);
    const pending = view.context.runProjectPresetsAction('saveProjectPreset', { scopeId: 'preset-scope', ...view.context.parsedProjectPresetDraft() });
    if (change === 'account') { view.context.serviceState.account.id = 'new-account'; view.context.syncProjectPresetsAccount(); }
    else view.context.renderProjectPresetsState({ ...view.state, version: 2, scopeId: 'changed-scope', ...(change === 'team' ? { teamId: null, role: null, selectedPresetId: null } : { role: 'viewer', teams: [{ ...view.state.teams[0], role: 'viewer' }] }) });
    finish({ ...view.state, version: 999, outcome: { kind: 'preset-saved', presetId: 'preset-1', version: 1 } }); await pending;
    assert.doesNotMatch(view.element('project-presets-status').textContent, /Template saved/);
  });
});
test('explicit handlers send only validated drafts/opaque preview IDs; user text never selects arbitrary project IDs', () => {
  const view = fixture(), calls = []; view.context.runProjectPresetsAction = (method, input) => { calls.push({ method, input }); }; handlers(view);
  view.element('project-presets-team').listeners.change({ target: { value: 'team-1' } }); assert.equal(calls.at(-1).method, 'selectPresetTeam'); assert.equal(calls.at(-1).input, 'team-1');
  view.element('project-presets-new').listeners.click(); assert.equal(calls.at(-1).method, 'selectProjectPreset'); assert.equal(calls.at(-1).input, null);
  view.element('project-presets-form').listeners.submit({ preventDefault() {} }); assert.deepEqual(Object.keys(calls.at(-1).input).sort(), ['branches', 'name', 'scopeId', 'syncClasses']);
  view.state.preview = plan(); view.named(); view.element('project-presets-project-form').listeners.submit({ preventDefault() {} }); assert.equal(calls.at(-1).input.projectName, 'New service project');
  view.element('project-presets-create').listeners.click(); assert.equal(JSON.stringify(calls.at(-1).input), JSON.stringify({ scopeId: 'preset-scope', planId: 'a'.repeat(64) }));
});
test('a pending creation cannot use a matching old receipt to override a changed selected template version', async () => {
  const view = fixture(); view.state.preview = plan(); view.named(); let finish;
  view.context.window.desktop.createProjectFromPreset = () => new Promise(resolve => { finish = resolve; });
  const pending = view.context.runProjectPresetsAction('createProjectFromPreset', { scopeId: 'preset-scope', planId: plan().planId });
  view.context.renderProjectPresetsState({ ...view.state, version: 2, scopeId: 'changed-version', items: [preset({ version: 2 })], preview: null, outcome: receipt() });
  assert.equal(view.context.projectPresetsAction, null);
  finish({ ...view.state, version: 999, outcome: receipt() }); await pending;
  assert.equal(view.context.projectPresetsState.scopeId, 'changed-version'); assert.doesNotMatch(view.element('project-presets-status').textContent, /Service project.*created/);
});
test('offline/new project name validation disables mutation and uncertain creation never falsely claims no project was created', async () => {
  const view = fixture(); view.named(); view.context.serviceState.status = 'offline'; view.render(); assert.equal(view.element('project-presets-save').disabled, true); assert.equal(view.element('project-presets-preview').disabled, true);
  view.context.serviceState.status = 'connected'; view.context.projectPresetNameDraft = 'Bad/path'; view.render(); assert.equal(view.element('project-presets-preview').disabled, true);
  view.state.preview = plan(); view.named(); view.context.window.desktop.createProjectFromPreset = async () => ({ ...view.state, version: 2, error: 'sync-network-unavailable', outcome: null });
  await view.context.runProjectPresetsAction('createProjectFromPreset', { scopeId: 'preset-scope', planId: plan().planId }); assert.match(view.element('project-presets-status').textContent, /may have completed on the service/);
});

test('unresolved local intent shows the prior request and blocks new Save/Create without requiring its team, version or media service', () => {
  const view = fixture(); view.state.preview = plan(); view.state.pending = pending(); view.named();
  assert.equal(view.element('project-presets-pending').hidden, false); assert.equal(view.element('project-presets-pending-name').textContent, 'Prior project');
  assert.equal(view.element('project-presets-pending-branches').textContent, 'main, edit'); assert.equal(view.element('project-presets-save').disabled, true); assert.equal(view.element('project-presets-create').disabled, true);
  view.context.renderProjectPresetsState({ ...view.state, version: 2, teamId: null, role: null, ready: false, mediaAvailable: false, teams: [], selectedPresetId: null, items: [] });
  assert.equal(view.element('project-presets-pending-retry').disabled, false); assert.equal(view.element('project-presets-pending-dismiss').disabled, true);
  assert.equal(view.element('project-presets-pending-reviewed').checked, false);
});
test('journal verification/storage faults block new mutations even when no readable pending record is available', () => {
  for (const error of ['project-presets-intent-invalid', 'project-presets-storage-unavailable', 'project-presets-storage-uncertain', 'project-presets-retry-required']) {
    const view = fixture(); view.state.preview = plan(); view.state.error = error; view.named();
    assert.equal(view.element('project-presets-save').disabled, true); assert.equal(view.element('project-presets-create').disabled, true);
  }
});
test('dismiss review acknowledgment resets when pending identity/account changes and its handler sends only the scoped reviewed flag', async () => {
  const view = fixture(); view.context.renderProjectPresetsState({ ...view.state, version: 2, pending: pending() }); handlers(view);
  let calls = 0; view.context.window.desktop.dismissProjectPresetIntent = async () => { calls++; return { ...view.state, version: 5, pending: null, outcome: { kind: 'intent-dismissed', pendingId: 'local-intent-1' } }; };
  await view.context.runProjectPresetsAction('dismissProjectPresetIntent', { scopeId: 'preset-scope', pendingId: 'local-intent-1', reviewed: true }); assert.equal(calls, 0);
  view.element('project-presets-pending-reviewed').listeners.change({ target: { checked: true } }); assert.equal(view.element('project-presets-pending-dismiss').disabled, false);
  view.context.renderProjectPresetsState({ ...view.state, version: 3, pending: pending() }); assert.equal(view.element('project-presets-pending-reviewed').checked, true);
  view.context.renderProjectPresetsState({ ...view.state, version: 4, pending: pending('create', { id: 'new-intent' }) }); assert.equal(view.element('project-presets-pending-reviewed').checked, false);
  view.context.projectPresetPendingReviewed = true; view.context.serviceState.account.id = 'another-account'; view.context.syncProjectPresetsAccount();
  assert.equal(view.context.projectPresetPendingReviewed, false); assert.equal(view.element('project-presets-pending').hidden, true);
});
test('reviewed retry can acknowledge an exact older-team save or creation and retain cleanup guidance after its scope changes', async t => {
  for (const kind of ['save', 'create']) await t.test(kind, async () => {
    const view = fixture(); const old = pending(kind); view.context.renderProjectPresetsState({ ...view.state, version: 2, pending: old, role: 'viewer', teams: [{ ...view.state.teams[0], role: 'viewer' }], mediaAvailable: false });
    const outcome = kind === 'save' ? { kind: 'preset-saved', presetId: old.presetId, version: 4, teamId: old.teamId, name: old.name, branches: old.branches, syncClasses: old.syncClasses }
      : receipt({ teamId: old.teamId, presetId: old.presetId, presetVersion: old.expectedVersion, projectName: old.projectName, branches: old.branches, syncClasses: old.syncClasses });
    view.context.window.desktop.retryProjectPresetIntent = async () => {
      const result = { ...view.context.projectPresetsState, version: 3, scopeId: 'historical-receipt', busy: true, outcome };
      view.context.renderProjectPresetsState(result); return { ...result, version: 4, busy: false, error: 'project-presets-storage-unavailable' };
    };
    await view.context.runProjectPresetsAction('retryProjectPresetIntent', { scopeId: 'preset-scope', pendingId: old.id });
    assert.match(view.element('project-presets-status').textContent, kind === 'save' ? /Template saved · version 4/ : /Prior project.*created/);
    assert.match(view.element('project-presets-pending-status').textContent, /service acknowledged.*cleanup/); assert.equal(view.element('project-presets-pending-retry').disabled, false);
    if (kind === 'create') { assert.equal(view.element('project-presets-receipt').hidden, false); assert.equal(view.element('project-presets-receipt-team').textContent, 'prior-team'); }
  });
});
test('Retry validates captured prior name/branches/classes and cannot acknowledge a different service mutation', async () => {
  const view = fixture(); const old = pending('save'); view.context.renderProjectPresetsState({ ...view.state, version: 2, pending: old });
  view.context.window.desktop.retryProjectPresetIntent = async () => ({ ...view.state, version: 3, scopeId: 'wrong-prior-receipt', pending: null,
    outcome: { kind: 'preset-saved', presetId: old.presetId, version: 4, teamId: old.teamId, name: 'Different name', branches: old.branches, syncClasses: old.syncClasses } });
  await view.context.runProjectPresetsAction('retryProjectPresetIntent', { scopeId: 'preset-scope', pendingId: old.id }); assert.doesNotMatch(view.element('project-presets-status').textContent, /Template saved/);
});
test('explicit local dismissal needs the checkbox, clears only the retry UI and never claims to undo the service change', async () => {
  const view = fixture(); const old = pending(); view.context.renderProjectPresetsState({ ...view.state, version: 2, pending: old }); view.context.projectPresetPendingReviewed = true;
  view.context.window.desktop.dismissProjectPresetIntent = async input => {
    assert.equal(JSON.stringify(input), JSON.stringify({ scopeId: 'preset-scope', pendingId: old.id, reviewed: true }));
    const result = { ...view.state, version: 3, pending: null, outcome: { kind: 'intent-dismissed', pendingId: old.id } }; view.context.renderProjectPresetsState(result); return { ...result, version: 4 };
  };
  await view.context.runProjectPresetsAction('dismissProjectPresetIntent', { scopeId: 'preset-scope', pendingId: old.id, reviewed: true });
  assert.equal(view.element('project-presets-pending').hidden, true); assert.match(view.element('project-presets-status').textContent, /Local retry dismissed.*has not been undone/);
});

test('actual controller publishes verified save/create receipts before RPC, cleanup and catalog refresh finish', async t => {
  for (const [kind, failure] of [['save', null], ['save', 'catalog'], ['save', 'cleanup'], ['create', null], ['create', 'projects'], ['create', 'cleanup']]) await t.test(`${kind}/${failure}`, async t => {
    const view = fixture(), clone = value => structuredClone(value); let record = null, items = [preset()], mutated = false, returned = false, receiptBeforeReturn = false;
    const intents = { async load() { return clone(record); }, async begin(_key, value) {
      if (record) return { record: clone(record), created: false };
      const id = randomUUID(); record = { id, ...clone(value), input: { ...clone(value.input), idempotencyKey: id }, createdAt: 2500 }; return { record: clone(record), created: true };
    }, async complete() { if (failure === 'cleanup') throw Object.assign(new Error('storage unavailable'), { code: 'project-presets-intent-storage-unavailable' }); record = null; return { removed: true }; } };
    const client = {
      async listPresetTeams() { return { teams: clone(view.state.teams), mediaAvailable: true }; },
      async listProjectPresets(teamId) { if (mutated && failure === 'catalog') throw Object.assign(new Error('unavailable'), { code: 'sync-network-unavailable' }); return { teamId, items: clone(items) }; },
      async saveProjectPreset(input) { items = [preset({ name: input.name, branches: input.branches, syncClasses: input.syncClasses, version: 2, updatedAt: 3000 })]; mutated = true; return clone(items[0]); },
      async previewProjectFromPreset(input) { return plan({ projectName: input.projectName }); },
      async createProjectFromPreset(input) { mutated = true; const value = receipt({ projectName: input.projectName }); delete value.kind; return value; }
    };
    const controller = createDesktopProjectPresets({ connection: { getState: () => clone(view.context.serviceState), getClient: () => client, async refreshProjects() {
      if (failure === 'projects') throw Object.assign(new Error('unavailable'), { code: 'sync-network-unavailable' }); return clone(view.context.serviceState);
    } }, intents, now: () => 3000, onChange(state) { if (state.outcome && !returned) receiptBeforeReturn = true; view.context.renderProjectPresetsState(state); } });
    t.after(() => controller.dispose());
    await controller.refreshProjectPresets(); await controller.selectPresetTeam('team-1'); await controller.loadProjectPresets(); await controller.selectProjectPreset('preset-1');
    let method, input;
    if (kind === 'save') { method = 'saveProjectPreset'; view.context.projectPresetDraft.name = 'Changed template'; input = { scopeId: view.context.projectPresetsState.scopeId, ...view.context.parsedProjectPresetDraft() }; }
    else { method = 'createProjectFromPreset'; view.context.projectPresetNameDraft = 'New service project'; await controller.previewProjectFromPreset({ scopeId: view.context.projectPresetsState.scopeId, projectName: 'New service project' }); input = { scopeId: view.context.projectPresetsState.scopeId, planId: view.context.projectPresetsState.preview.planId }; }
    view.context.window.desktop[method] = async value => { const result = await controller[method](clone(value)); returned = true; return result; };
    await view.context.runProjectPresetsAction(method, input);
    assert.equal(receiptBeforeReturn, true); assert.match(view.element('project-presets-status').textContent, kind === 'save' ? /Template saved · version 2/ : /Service project.*created/);
    assert.equal(view.context.projectPresetsAction, null);
    if (failure === 'cleanup') { assert.match(view.element('project-presets-pending-status').textContent, /service acknowledged.*cleanup/); assert.equal(view.element('project-presets-pending-retry').disabled, false); }
    else assert.equal(view.element('project-presets-pending').hidden, true);
    if (kind === 'create') assert.equal(view.element('project-presets-receipt-project').textContent, 'created-project');
  });
});

test('actual controller retries the captured prior intent while a different team/template/media setting is selected', async t => {
  for (const kind of ['save', 'create']) await t.test(kind, async t => {
    const view = fixture(), old = pending(kind), clone = value => structuredClone(value), id = randomUUID();
    const input = { teamId: old.teamId, presetId: old.presetId, expectedVersion: old.expectedVersion, idempotencyKey: id,
      ...(kind === 'save' ? { name: old.name, branches: old.branches, syncClasses: old.syncClasses } : { projectName: old.projectName, planId: 'b'.repeat(64) }) };
    let record = { id, kind, input, createdAt: old.createdAt, plan: kind === 'create' ? plan({ planId: input.planId, teamId: old.teamId, presetId: old.presetId, presetVersion: 3, projectName: old.projectName, branches: old.branches, syncClasses: old.syncClasses }) : null };
    const client = {
      async listPresetTeams() { return { teams: clone(view.state.teams), mediaAvailable: false }; }, async listProjectPresets(teamId) { return { teamId, items: [preset()] }; },
      async saveProjectPreset() { return preset({ id: old.presetId, teamId: old.teamId, version: 4, name: old.name, branches: old.branches, syncClasses: old.syncClasses }); },
      async createProjectFromPreset() { const value = receipt({ teamId: old.teamId, presetId: old.presetId, presetVersion: 3, projectName: old.projectName, branches: old.branches, syncClasses: old.syncClasses }); delete value.kind; return value; }
    };
    const controller = createDesktopProjectPresets({ connection: { getState: () => clone(view.context.serviceState), getClient: () => client, refreshProjects: async () => clone(view.context.serviceState) },
      intents: { load: async () => clone(record), begin: async () => { throw new Error('must not create a new intent'); }, complete: async () => { record = null; return { removed: true }; } },
      onChange: state => view.context.renderProjectPresetsState(state), now: () => 4000 });
    t.after(() => controller.dispose());
    await controller.refreshProjectPresets(); await controller.selectPresetTeam('team-1'); await controller.loadProjectPresets(); await controller.selectProjectPreset('preset-1');
    view.context.window.desktop.retryProjectPresetIntent = value => controller.retryProjectPresetIntent(clone(value));
    await view.context.runProjectPresetsAction('retryProjectPresetIntent', { scopeId: view.context.projectPresetsState.scopeId, pendingId: id });
    assert.match(view.element('project-presets-status').textContent, kind === 'save' ? /Template saved · version 4/ : /Prior project.*created/);
    assert.equal(view.element('project-presets-pending').hidden, true); assert.equal(view.context.projectPresetsState.teamId, 'team-1');
    if (kind === 'create') assert.equal(view.element('project-presets-receipt-team').textContent, old.teamId);
  });
});
