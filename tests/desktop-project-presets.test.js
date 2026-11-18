'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fingerprint } = require('../src/project-api-contracts');
const { createDesktopProjectPresets } = require('../src/desktop-project-presets');
const { createProjectPresetIntents } = require('../src/project-preset-intents');
const fail = code => Object.assign(new Error('/private/workspace bearer-secret password-secret'), { code });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => structuredClone(value);
function preset(id = 'preset-1', teamId = 'team-1', patch = {}) { return { id, teamId, name: 'Review workflow', branches: ['edit', 'review'], syncClasses: ['audio', 'proxy'], version: 1, createdAt: 1000, updatedAt: 2000, ...patch }; }
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-presets-controller-')));
  const journalDirectory = path.join(directory, 'intents');
  const account = { origin: 'https://presets.example.test', status: 'connected', account: { id: 'owner-1' }, projects: [{ id: 'unrelated-project', role: 'viewer' }] };
  const teams = [{ id: 'team-1', name: 'First team', role: 'owner' }, { id: 'team-2', name: 'Second team', role: 'owner' }];
  const catalogs = new Map([['team-1', [preset()]], ['team-2', [preset('preset-2', 'team-2')]]]), committed = new Map(), projects = new Map();
  const media = { available: true }, calls = [], events = [], journalCalls = [], hooks = {}, controllers = []; let controller, rawIntents, adapter, nextId = 1;
  const makePlan = input => {
    const selected = catalogs.get(input.teamId)?.find(item => item.id === input.presetId);
    if (!selected || selected.version !== input.expectedVersion) throw fail('preset-plan-stale');
    const value = { teamId: input.teamId, presetId: input.presetId, presetVersion: input.expectedVersion, projectName: input.projectName,
      branches: ['main', ...selected.branches], syncClasses: clone(selected.syncClasses), mediaAvailable: media.available };
    return { planId: fingerprint(value), ...value };
  };
  function commitSave(input) {
    const key = `save:${input.idempotencyKey}`; if (committed.has(key)) return clone(committed.get(key));
    if (teams.find(team => team.id === input.teamId)?.role !== 'owner') throw fail('preset-forbidden');
    const items = catalogs.get(input.teamId), previous = items.find(item => item.id === input.presetId);
    if (input.presetId !== null && (!previous || previous.version !== input.expectedVersion)) throw fail('preset-version-conflict');
    const changed = !previous || previous.name !== input.name || fingerprint(previous.branches) !== fingerprint(input.branches) || fingerprint(previous.syncClasses) !== fingerprint(input.syncClasses);
    const result = preset(previous?.id || `saved-${nextId++}`, input.teamId, { name: input.name, branches: clone(input.branches), syncClasses: clone(input.syncClasses),
      version: previous ? previous.version + (changed ? 1 : 0) : 1, createdAt: previous?.createdAt ?? 3000, updatedAt: changed ? 3000 : previous.updatedAt });
    catalogs.set(input.teamId, [...items.filter(item => item.id !== result.id), result]); committed.set(key, result); return clone(result);
  }
  function commitCreate(input) {
    const key = `create:${input.idempotencyKey}`; if (committed.has(key)) return clone(committed.get(key));
    if (teams.find(team => team.id === input.teamId)?.role !== 'owner') throw fail('preset-forbidden');
    const plan = makePlan(input); if (plan.syncClasses.length && !media.available) throw fail('preset-media-unavailable');
    if (plan.planId !== input.planId) throw fail('preset-plan-stale');
    const result = { projectId: `created-project-${nextId++}`, teamId: plan.teamId, presetId: plan.presetId, presetVersion: plan.presetVersion,
      projectName: plan.projectName, branches: clone(plan.branches), syncClasses: clone(plan.syncClasses), createdAt: 3000 };
    committed.set(key, result); projects.set(result.projectId, result); return clone(result);
  }
  const client = {
    async listPresetTeams(options) { calls.push({ kind: 'teams', signal: options.signal }); return hooks.teams ? hooks.teams(options) : { teams: clone(teams), mediaAvailable: media.available }; },
    async listProjectPresets(teamId, options) { calls.push({ kind: 'catalog', teamId, signal: options.signal }); return hooks.catalog ? hooks.catalog(teamId, options) : { teamId, items: clone(catalogs.get(teamId) || []) }; },
    async saveProjectPreset(input, options) { calls.push({ kind: 'save', input: clone(input), signal: options.signal }); return hooks.save ? hooks.save(input, options) : commitSave(input); },
    async previewProjectFromPreset(input, options) { calls.push({ kind: 'preview', input: clone(input), signal: options.signal }); return hooks.preview ? hooks.preview(input, options) : makePlan(input); },
    async createProjectFromPreset(input, options) { calls.push({ kind: 'create', input: clone(input), signal: options.signal }); return hooks.create ? hooks.create(input, options) : commitCreate(input); }
  };
  const connection = { getState: () => clone(account), getClient: () => client, async refreshProjects() {
    calls.push({ kind: 'projects-refresh' }); if (hooks.refreshProjects) return hooks.refreshProjects(); return clone(account);
  } };
  function open() {
    rawIntents = createProjectPresetIntents({ directory: journalDirectory, now: () => 2500 });
    adapter = Object.fromEntries(['load', 'begin', 'complete'].map(method => [method, (...args) => {
      journalCalls.push({ method, args: clone(args) }); return hooks[method] ? hooks[method](...args) : rawIntents[method](...args);
    }]));
    controller = createDesktopProjectPresets({ connection, intents: adapter, onChange(state) { events.push(state); if (hooks.change) hooks.change(state); }, now: () => 4000 }); controllers.push(controller);
  }
  open(); t.after(async () => { for (const value of controllers) await value.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const ready = async (teamId = 'team-1', presetId = 'preset-1') => { await controller.refreshProjectPresets(); await controller.selectPresetTeam(teamId); await controller.loadProjectPresets(); if (presetId) await controller.selectProjectPreset(presetId); return controller.getState(); };
  const save = async (name = 'Changed workflow', branches = ['edit', 'review'], syncClasses = ['audio', 'proxy']) => controller.saveProjectPreset({ scopeId: (await controller.getState()).scopeId, name, branches, syncClasses });
  const preview = async (projectName = 'Fixture project') => controller.previewProjectFromPreset({ scopeId: (await controller.getState()).scopeId, projectName });
  const create = async () => { const state = await controller.getState(); return controller.createProjectFromPreset({ scopeId: state.scopeId, planId: state.preview?.planId }); };
  const retry = async () => { const state = await controller.getState(); return controller.retryProjectPresetIntent({ scopeId: state.scopeId, pendingId: state.pending?.id }); };
  return { get controller() { return controller; }, get rawIntents() { return rawIntents; }, directory, journalDirectory, account, teams, catalogs, media, calls, events, journalCalls, hooks, projects, committed,
    commitSave, commitCreate, makePlan, ready, save, preview, create, retry, async restart() { await controller.dispose(); open(); return controller; } };
}

test('getState and selection are local; explicit initialization loads only the private journal and team/catalog discovery requires requests', async t => {
  const f = await fixture(t); const state = await f.controller.getState(); assert.equal(state.available, true); assert.equal(state.teamsReady, false); assert.equal(f.calls.length, 0); assert.equal(f.journalCalls.length, 0);
  await f.controller.initialize(); assert.equal(f.calls.length, 0); assert.equal(f.journalCalls.length, 1);
  await f.controller.refreshProjectPresets(); const count = f.calls.length; await f.controller.selectPresetTeam('team-1'); assert.equal(f.calls.length, count);
  await f.controller.loadProjectPresets(); const before = f.calls.length; await f.controller.selectProjectPreset('preset-1'); assert.equal(f.calls.length, before);
  const loaded = await f.controller.getState(); loaded.items[0].name = 'Changed copy'; assert.equal((await f.controller.getState()).items[0].name, 'Review workflow');
});

test('TEAM owner authority is independent of project role; members can read but cannot save, preview or create', async t => {
  const f = await fixture(t); await f.ready(); assert.equal((await f.save()).outcome.kind, 'preset-saved');
  for (const role of ['editor', 'viewer']) {
    f.teams[0].role = role; await f.ready(); f.account.projects[0].role = 'owner'; const count = f.calls.length;
    assert.equal((await f.save()).error, 'preset-forbidden'); assert.equal(f.calls.length, count);
    await f.ready(); assert.equal((await f.preview()).error, 'preset-forbidden');
  }
});

test('save uses checked version and exact branch/class settings; unchanged saves preserve version and clear durable intent after ACK', async t => {
  const f = await fixture(t); await f.ready(); let result = await f.save(); assert.equal(result.outcome.kind, 'preset-saved'); assert.equal(result.outcome.version, 2); assert.equal(result.pending, null);
  const first = f.calls.find(value => value.kind === 'save').input; assert.equal(first.expectedVersion, 1); assert.equal(first.teamId, 'team-1'); assert.equal(first.presetId, 'preset-1');
  result = await f.save(); assert.equal(result.outcome.version, 2); assert.equal(result.items[0].version, 2);
  assert.equal((await fs.stat(path.join(f.journalDirectory, 'presets-intents.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes('idempotencyKey'), false);
});

test('preview binds exact saved settings and media availability; create does not upload, select or bind a local editor branch', async t => {
  const f = await fixture(t); await f.ready(); let state = await f.preview(); assert.deepEqual(state.preview.branches, ['main', 'edit', 'review']); assert.deepEqual(state.preview.syncClasses, ['audio', 'proxy']);
  state = await f.create(); assert.equal(state.outcome.kind, 'project-created'); assert.equal(state.outcome.projectName, 'Fixture project'); assert.equal(state.preview, null); assert.equal(state.pending, null); assert.equal(f.projects.size, 1);
  assert.equal(f.calls.filter(value => value.kind === 'projects-refresh').length, 1);
  f.media.available = false; await f.controller.loadProjectPresets(); await f.preview('Unavailable media'); const count = f.calls.filter(value => value.kind === 'create').length;
  assert.equal((await f.create()).error, 'preset-media-unavailable'); assert.equal(f.calls.filter(value => value.kind === 'create').length, count);
  f.catalogs.set('team-1', [preset('preset-1', 'team-1', { syncClasses: [] })]); await f.controller.loadProjectPresets(); await f.preview('Metadata only'); assert.equal((await f.create()).outcome.kind, 'project-created');
});

test('lost save/create ACK survives actual journal restart and retries one historical intent after other team/version/media changes', async t => {
  for (const kind of ['save', 'create']) await t.test(kind, async t => {
    const f = await fixture(t); await f.ready();
    if (kind === 'create') await f.preview('Durable created project');
    f.hooks[kind] = input => { const result = kind === 'save' ? f.commitSave(input) : f.commitCreate(input); throw fail('sync-network-unavailable'); };
    const failed = kind === 'save' ? await f.save() : await f.create(); assert.equal(failed.error, 'sync-network-unavailable'); assert(failed.pending); assert.equal(failed.outcome, null);
    const original = f.calls.find(value => value.kind === kind).input.idempotencyKey;
    const key = f.journalCalls.find(value => value.method === 'begin').args[0], durable = await f.rawIntents.load(key); assert.equal(durable.input.idempotencyKey, original);
    await f.restart(); const before = f.calls.length; assert.equal((await f.controller.getState()).pending, null); await f.controller.initialize(); assert.equal(f.calls.length, before); assert.equal((await f.controller.getState()).pending.id, durable.id);
    f.catalogs.set('team-1', [preset('preset-1', 'team-1', { version: 9, branches: ['different'], syncClasses: [] })]); f.media.available = false;
    await f.ready('team-2', 'preset-2'); delete f.hooks[kind]; const restored = await f.retry();
    assert.equal(restored.outcome.kind, kind === 'save' ? 'preset-saved' : 'project-created'); assert.equal(restored.outcome.teamId, 'team-1'); assert.equal(restored.teamId, 'team-2'); assert.equal(restored.pending, null);
    assert.equal(f.calls.filter(value => value.kind === kind).at(-1).input.idempotencyKey, original);
    if (kind === 'create') { assert.equal(f.projects.size, 1); assert.deepEqual(restored.outcome.branches, ['main', 'edit', 'review']); assert.deepEqual(restored.outcome.syncClasses, ['audio', 'proxy']); }
    else assert.equal([...f.committed.keys()].filter(value => value.startsWith('save:')).length, 1);
  });
});

test('first definite service rejection clears the new intent, but a prior ambiguous request remains until guarded local dismissal', async t => {
  const f = await fixture(t); await f.ready(); f.hooks.save = () => { throw fail('preset-capacity'); };
  assert.equal((await f.save()).pending, null);
  f.hooks.save = () => { throw fail('sync-network-unavailable'); }; const pending = (await f.save()).pending; assert(pending);
  f.hooks.save = () => { throw fail('preset-forbidden'); }; const denied = await f.retry(); assert.equal(denied.pending.id, pending.id); assert.equal(denied.error, 'preset-forbidden');
  let state = await f.controller.getState(); const count = f.calls.length;
  assert.equal((await f.controller.dismissProjectPresetIntent({ scopeId: state.scopeId, pendingId: pending.id, reviewed: false })).error, 'preset-invalid');
  state = await f.controller.getState(); const result = await f.controller.dismissProjectPresetIntent({ scopeId: state.scopeId, pendingId: pending.id, reviewed: true });
  assert.equal(result.outcome.kind, 'intent-dismissed'); assert.equal(result.pending, null); assert.equal(f.calls.length, count);
});

test('service ACK is published before journal cleanup; cleanup failure retains exact retry and follow-up failures never erase success', async t => {
  for (const failure of ['cleanup', 'catalog', 'projects']) await t.test(failure, async t => {
    const f = await fixture(t); await f.ready(); if (failure === 'projects') await f.preview();
    if (failure === 'cleanup') f.hooks.complete = () => { assert(f.events.at(-1).outcome); throw fail('project-presets-intent-storage-unavailable'); };
    if (failure === 'catalog') f.hooks.catalog = () => { throw fail('sync-network-unavailable'); };
    if (failure === 'projects') f.hooks.refreshProjects = () => { throw fail('sync-network-unavailable'); };
    const result = failure === 'projects' ? await f.create() : await f.save(); assert.equal(result.outcome.kind, failure === 'projects' ? 'project-created' : 'preset-saved'); assert(result.error);
    assert.equal(!!result.pending, failure === 'cleanup'); if (failure !== 'projects') assert.equal(result.ready, false);
    if (failure === 'cleanup') { const key = f.calls.filter(value => value.kind === 'save').at(-1).input.idempotencyKey; delete f.hooks.complete; const retried = await f.retry(); assert.equal(retried.pending, null); assert.equal(f.calls.filter(value => value.kind === 'save').at(-1).input.idempotencyKey, key); }
  });
});

test('account/selection aborts cannot expose late receipts, but interrupted mutations stay recoverable in their original account journal', async t => {
  for (const change of ['account', 'origin', 'selection']) await t.test(change, async t => {
    const f = await fixture(t); await f.ready(); const entered = deferred(), gate = deferred(); let result;
    f.hooks.save = (input, options) => { result = f.commitSave(input); entered.resolve(options.signal); return gate.promise; };
    const saving = f.save(), signal = await entered.promise;
    if (change === 'account') { f.account.account.id = 'other-account'; await f.controller.connectionChanged(); }
    else if (change === 'origin') { f.account.origin = 'https://other.example.test'; await f.controller.connectionChanged(); }
    else await f.controller.selectPresetTeam('team-2');
    assert.equal(signal.aborted, true); gate.resolve(result); await saving; let state = await f.controller.getState(); assert.equal(state.outcome, null);
    if (change !== 'selection') { assert.equal(state.pending, null); assert.equal(state.items.length, 0); f.account.account.id = 'owner-1'; f.account.origin = 'https://presets.example.test'; await f.controller.connectionChanged(); state = await f.controller.getState(); }
    assert(state.pending); assert.equal(state.pending.name, 'Changed workflow');
  });
});

test('pending intent is account-private, blocks conflicting mutations, and public recovery never exposes private request keys/plan internals', async t => {
  const f = await fixture(t); await f.ready(); f.hooks.save = () => { throw fail('sync-network-unavailable'); }; const failed = await f.save();
  assert.equal(failed.pending.kind, 'save'); const count = f.calls.filter(value => value.kind === 'save').length;
  assert.equal((await f.save('Different intent')).error, 'project-presets-retry-required'); assert.equal(f.calls.filter(value => value.kind === 'save').length, count);
  assert.doesNotMatch(JSON.stringify(failed.pending), /idempotencyKey|planId|"input"|"plan"|accessToken|origin/);
  const original = f.account.account.id; f.account.account.id = 'another-account'; await f.controller.connectionChanged(); assert.equal((await f.controller.getState()).pending, null);
  f.account.account.id = original; await f.controller.connectionChanged(); assert.equal((await f.controller.getState()).pending.id, failed.pending.id);
});

test('invalid scope/plan/body/media and malformed service replies never become acknowledged mutations', async t => {
  const f = await fixture(t); const state = await f.ready(), count = f.calls.length;
  assert.equal((await f.controller.saveProjectPreset({ scopeId: 'stale', name: 'Wrong', branches: [], syncClasses: [] })).error, 'project-presets-selection-changed'); assert.equal(f.calls.length, count);
  assert.equal((await f.controller.saveProjectPreset({ scopeId: state.scopeId, name: 'Wrong', branches: ['main'], syncClasses: [] })).error, 'preset-invalid');
  await f.preview(); assert.equal((await f.controller.createProjectFromPreset({ scopeId: (await f.controller.getState()).scopeId, planId: 'b'.repeat(64) })).error, 'preset-plan-stale');
  f.hooks.preview = input => ({ ...f.makePlan(input), branches: ['main', 'unreviewed'] }); assert.equal((await f.preview()).error, 'sync-response-invalid'); assert.equal((await f.controller.getState()).outcome, null);
});

test('journal read/write failures fail closed before network mutation, and sanitized failures reveal no paths or credentials', async t => {
  const f = await fixture(t); await f.ready(); f.hooks.begin = () => { throw fail('project-presets-intent-storage-uncertain'); }; const count = f.calls.length;
  let state = await f.save(); assert.equal(state.error, 'project-presets-intent-storage-uncertain'); assert.equal(f.calls.length, count);
  f.hooks.load = () => { throw fail('project-presets-intent-invalid'); }; state = await f.controller.refreshProjectPresets(); assert.equal(state.error, 'project-presets-intent-invalid'); assert.equal(f.calls.length, count);
  delete f.hooks.load; delete f.hooks.begin; f.hooks.teams = () => { throw fail('/private/workspace bearer-secret'); }; state = await f.controller.refreshProjectPresets(); assert.equal(state.error, 'project-presets-local-error');
  assert.doesNotMatch(JSON.stringify(f.events), /bearer-secret|password-secret|\/private|idempotencyKey/);
});

test('busy operations are not replaced; dispose aborts/drains pending reads and leaves no actionable state', async t => {
  const f = await fixture(t); const entered = deferred(), gate = deferred(); f.hooks.teams = options => { entered.resolve(options.signal); return gate.promise; };
  const loading = f.controller.refreshProjectPresets(), signal = await entered.promise, count = f.calls.length;
  assert.equal((await f.controller.refreshProjectPresets()).busy, true); assert.equal(f.calls.length, count);
  const closing = f.controller.dispose(); assert.equal(signal.aborted, true); gate.resolve({ teams: f.teams, mediaAvailable: true }); await closing; await loading;
  const state = await f.controller.getState(); assert.equal(state.available, false); assert.equal(state.busy, false); assert.equal(state.pending, null); assert.equal(state.outcome, null);
});
