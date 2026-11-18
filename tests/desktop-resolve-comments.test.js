'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopResolveComments } = require('../src/desktop-resolve-comments');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { fingerprint } = require('../src/project-api-contracts');
const observation = require('../phase-0/resolve-xml-proof/live-properties-enabled.json');
const fail = code => Object.assign(new Error('/private/path token-secret'), { code });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cursor = index => `${Buffer.from(`page-${index}`).toString('base64url')}.${Buffer.alloc(32, 5).toString('base64url')}`;
async function post(f, input) { return f.controller.add({ scopeId: (await f.controller.getState()).scopeId, ...input }); }

function fixture(t) {
  const snapshot = structuredClone(observation.snapshot), timeline = snapshot.timelines[0], oldId = timeline.items[0].id;
  timeline.id = 'Timeline 夜 "Été"'; timeline.items[0].id = 'Clip 夜 "Été"';
  for (const value of snapshot.timelines) for (const clip of value.items) clip.linked_item_ids = clip.linked_item_ids.map(id => id === oldId ? timeline.items[0].id : id);
  const manifest = createResolveRevisionManifest(snapshot);
  const account = { status: 'connected', connected: true, origin: 'https://review.example.test', account: { id: 'owner' },
    projects: [{ id: 'remote-project', role: 'owner', branches: ['main', 'review'] }] };
  const target = { scope: { originHash: fingerprint(account.origin), accountId: 'owner', localProjectId: 'local-project',
    localBranch: 'main', remoteProjectId: 'remote-project', remoteBranch: 'main' }, role: 'owner', checkedAt: 1000,
  revision: { id: 'remote-revision', projectId: 'remote-project', manifestId: `sha256:${fingerprint(manifest)}`, message: 'Fetched immutable observation' }, manifest };
  const calls = [], events = [], hooks = {}, rows = [];
  const anchor = { kind: 'clip', timelineId: timeline.id, clipId: timeline.items[0].id };
  const item = (id = 'comment-1', patch = {}) => ({ id, projectId: target.scope.remoteProjectId, revisionId: target.revision.id,
    authorId: account.account?.id || 'owner', anchor: structuredClone(anchor), body: 'Review this clip', status: 'open',
    createdAt: '2026-11-18T12:00:00.000Z', resolvedAt: null, resolvedBy: null, canResolve: true, ...patch });
  rows.push(item());
  const page = (items = rows, patch = {}) => ({ projectId: target.scope.remoteProjectId, revisionId: target.revision.id,
    items: structuredClone(items), nextCursor: null, total: items.length, openCount: items.filter(value => value.status === 'open').length, ...patch });
  const client = {
    async listReviewComments(pid, rid, request, options) {
      calls.push({ kind: 'list', pid, rid, request: structuredClone(request), signal: options.signal });
      return hooks.list ? hooks.list(pid, rid, request, options) : page();
    },
    async addReviewComment(input, options) {
      calls.push({ kind: 'add', input: structuredClone(input), signal: options.signal });
      if (hooks.add) return hooks.add(input, options);
      const created = item(`comment-${rows.length + 1}`, { anchor: structuredClone(input.anchor), body: input.body }); rows.unshift(created); return structuredClone(created);
    },
    async resolveReviewComment(pid, rid, id, options) {
      calls.push({ kind: 'resolve', pid, rid, id, signal: options.signal });
      if (hooks.resolve) return hooks.resolve(pid, rid, id, options);
      const found = rows.find(value => value.id === id); Object.assign(found, { status: 'resolved', resolvedAt: '2026-11-18T12:01:00.000Z', resolvedBy: account.account.id, canResolve: false });
      return structuredClone(found);
    }
  };
  const controller = createDesktopResolveComments({ connection: { getState: () => structuredClone(account), getClient: () => client },
    getTarget: async () => hooks.target ? hooks.target() : structuredClone(target), onChange: state => events.push(state), now: () => 2000 });
  t.after(() => controller.dispose());
  const setRole = role => { account.projects[0].role = role; target.role = role; };
  return { controller, account, target, calls, events, hooks, rows, item, page, anchor, timeline, setRole };
}

test('comment state reads are local and immutable-target scoped; first posting requires an explicit refresh', async t => {
  const f = fixture(t), state = await f.controller.getState();
  assert.equal(state.available, true); assert.equal(state.ready, false); assert.equal(state.postingAvailable, false); assert.equal(f.calls.length, 0);
  assert.notEqual(state.target.serviceProjectId, f.target.manifest.snapshot.project_id);
  assert.equal(state.target.revisionId, 'remote-revision'); assert.equal(state.timelines[0].id, f.anchor.timelineId);
  const blocked = await post(f, { anchor: f.anchor, body: 'Must refresh first' });
  assert.equal(blocked.error, 'comments-refresh-required'); assert.equal(f.calls.length, 0);
  const ready = await f.controller.refresh(); assert.equal(ready.ready, true); assert.equal(ready.postingAvailable, true); assert.equal(ready.lastUpdatedAt, 2000);
  assert.equal(f.calls[0].pid, 'remote-project'); assert.equal(f.calls[0].rid, 'remote-revision');
  assert.doesNotMatch(JSON.stringify(f.events), /token-secret|accessToken|password|sourcePath|originHash|localProjectId|properties/);
});

test('owner/editor posting normalizes plain text and checks exact opaque clip and timeline range boundaries', async t => {
  const f = fixture(t); await f.controller.refresh();
  const posted = await post(f, { anchor: f.anchor, body: '  <b>Été "夜"</b>\n\tPlain text  ' });
  assert.equal(posted.outcome.kind, 'added'); assert.equal(f.calls.find(value => value.kind === 'add').input.body, '<b>Été "夜"</b>\n\tPlain text');
  const baseline = f.calls.filter(value => value.kind === 'add').length;
  const end = Math.max(...f.timeline.items.map(value => value.end_frame));
  for (const anchor of [{ ...f.anchor, clipId: 'wrong' }, { ...f.anchor, timelineId: 'wrong' },
    { kind: 'range', timelineId: f.anchor.timelineId, startFrame: -1, endFrame: 10 },
    { kind: 'range', timelineId: f.anchor.timelineId, startFrame: 0, endFrame: end + 1 }, { ...f.anchor, sourcePath: '/private' }]) {
    assert.match((await post(f, { anchor, body: 'Wrong anchor' })).error, /^comment-anchor-/);
  }
  assert.equal(f.calls.filter(value => value.kind === 'add').length, baseline);
  f.setRole('editor'); await f.controller.selectionChanged(); await f.controller.refresh();
  assert.equal((await post(f, { anchor: { kind: 'range', timelineId: f.anchor.timelineId,
    startFrame: f.timeline.start_frame, endFrame: end }, body: 'Exact full observed range' })).outcome.kind, 'added');
  f.setRole('viewer'); await f.controller.selectionChanged(); await f.controller.refresh();
  const count = f.calls.length, denied = await post(f, { anchor: f.anchor, body: 'Viewer cannot post' });
  assert.equal(denied.error, 'forbidden'); assert.equal(denied.ready, false); assert.equal(f.calls.length, count);
});

test('failed post retries retain a private exact-input key while changed text gets a new key', async t => {
  const f = fixture(t); await f.controller.refresh(); let attempts = 0;
  f.hooks.add = input => { if (++attempts < 3) throw fail('sync-network-unavailable'); return f.item('new-comment', { anchor: input.anchor, body: input.body }); };
  await post(f, { anchor: f.anchor, body: ' First draft ' });
  await post(f, { anchor: f.anchor, body: 'First draft' });
  await post(f, { anchor: f.anchor, body: 'Changed draft' });
  const posts = f.calls.filter(value => value.kind === 'add');
  assert.equal(posts[0].input.idempotencyKey, posts[1].input.idempotencyKey);
  assert.notEqual(posts[1].input.idempotencyKey, posts[2].input.idempotencyKey);
  assert.doesNotMatch(JSON.stringify(f.events), /idempotencyKey|comment-[0-9a-f]{8}-/);
});

test('a failed acknowledgment retains the same request key through unrelated projects and still-authorized role changes', async t => {
  const f = fixture(t); await f.controller.refresh(); let first = true;
  f.hooks.add = input => { if (first) { first = false; throw fail('sync-network-unavailable'); } return f.item('retry-comment', { body: input.body }); };
  await post(f, { anchor: f.anchor, body: 'One server operation' });
  f.account.projects.push({ id: 'unrelated', role: 'viewer', branches: ['main'] }); await f.controller.connectionChanged();
  await f.controller.refresh();
  await post(f, { anchor: f.anchor, body: 'One server operation' });
  let posts = f.calls.filter(value => value.kind === 'add'); assert.equal(posts[0].input.idempotencyKey, posts[1].input.idempotencyKey);
  first = true; await post(f, { anchor: f.anchor, body: 'Role change pending retry' });
  f.setRole('editor'); await f.controller.connectionChanged(); await f.controller.refresh();
  await post(f, { anchor: f.anchor, body: 'Role change pending retry' });
  posts = f.calls.filter(value => value.kind === 'add'); assert.equal(posts[2].input.idempotencyKey, posts[3].input.idempotencyKey);
});

test('a successful post acknowledgment survives a failed follow-up list without claiming a refreshed page', async t => {
  const f = fixture(t); await f.controller.refresh(); f.hooks.list = () => { throw fail('sync-network-unavailable'); };
  const state = await post(f, { anchor: f.anchor, body: 'Saved remotely once' });
  assert.equal(state.outcome.kind, 'added'); assert.equal(state.ready, false); assert.equal(state.postingAvailable, false);
  assert.equal(state.error, 'sync-network-unavailable'); assert.equal(state.items[0].body, 'Saved remotely once');
  assert.equal(state.total, null); assert.equal(state.nextCursor, null); assert.equal(f.calls.filter(value => value.kind === 'add').length, 1);
});

test('account, binding, fetched head and role changes abort pending pages and discard late results', async t => {
  for (const change of ['account', 'origin', 'branch', 'head', 'role']) await t.test(change, async t => {
    const f = fixture(t), entered = deferred(), gate = deferred(), previous = f.page();
    f.hooks.list = (_pid, _rid, _page, options) => { entered.resolve(options.signal); return gate.promise; };
    const reading = f.controller.refresh(), signal = await entered.promise;
    if (change === 'account') { f.account.account.id = 'other-account'; f.target.scope.accountId = 'other-account'; }
    else if (change === 'origin') { f.account.origin = 'https://other.example.test'; f.target.scope.originHash = fingerprint(f.account.origin); }
    else if (change === 'branch') f.target.scope.remoteBranch = 'review';
    else if (change === 'head') f.target.revision.id = 'new-head';
    else f.setRole('viewer');
    const changed = await f.controller.connectionChanged(); assert.equal(signal.aborted, true); assert.equal(changed.ready, false); assert.equal(changed.items.length, 0);
    gate.resolve(previous); await reading;
    const final = await f.controller.getState(); assert.equal(final.items.length, 0); assert.equal(final.outcome, null);
  });
});

test('late post acknowledgments cannot restore old-scope rows or reuse its private retry key', async t => {
  const f = fixture(t); await f.controller.refresh(); const entered = deferred(), gate = deferred();
  f.hooks.add = input => { entered.resolve(input); return gate.promise; };
  const posting = post(f, { anchor: f.anchor, body: 'Old binding' }), input = await entered.promise;
  const oldResult = f.item('old-result', { body: input.body });
  f.target.scope.remoteBranch = 'review'; await f.controller.selectionChanged(); gate.resolve(oldResult); await posting;
  assert.equal((await f.controller.getState()).items.length, 0);
  f.hooks.add = value => f.item('new-result', { body: value.body }); await f.controller.refresh();
  await post(f, { anchor: f.anchor, body: 'Old binding' });
  const posts = f.calls.filter(value => value.kind === 'add'); assert.notEqual(posts[0].input.idempotencyKey, posts[1].input.idempotencyKey);
});

test('a draft scope cannot be silently rebound to a newer fetched revision containing the same clip ID', async t => {
  const f = fixture(t); const before = await f.controller.refresh(), oldScope = before.scopeId;
  f.target.revision.id = 'newer-remote-revision'; for (const row of f.rows) row.revisionId = f.target.revision.id;
  await f.controller.selectionChanged(); await f.controller.refresh();
  const count = f.calls.length;
  const state = await f.controller.add({ scopeId: oldScope, anchor: f.anchor, body: 'Draft for the old revision' });
  assert.equal(state.error, 'comments-selection-changed'); assert.equal(f.calls.length, count);
  assert.equal((await post(f, { anchor: f.anchor, body: 'Explicit new-target intent' })).outcome.kind, 'added');
});

test('forbidden or revoked access clears rows; signing out removes the complete comment target', async t => {
  for (const code of ['forbidden', 'access-token-invalid', 'service-sign-in-required']) await t.test(code, async t => {
    const f = fixture(t); await f.controller.refresh(); f.hooks.list = () => { throw fail(code); };
    const state = await f.controller.refresh(); assert.equal(state.error, code); assert.equal(state.items.length, 0); assert.equal(state.ready, false);
    f.account.status = 'not-configured'; f.account.account = null; f.account.origin = null; f.account.projects = [];
    const signedOut = await f.controller.connectionChanged(); assert.equal(signedOut.target, null); assert.equal(signedOut.scopeId, null); assert.equal(signedOut.timelines.length, 0);
  });
});

test('only an authorized visible comment can be resolved and the acknowledged result is refreshed', async t => {
  const f = fixture(t); f.rows.push(f.item('other-comment', { authorId: 'other', canResolve: false })); await f.controller.refresh();
  assert.equal((await f.controller.resolve('not-visible')).error, 'comment-not-found');
  assert.equal((await f.controller.resolve('other-comment')).error, 'comment-not-found');
  assert.equal(f.calls.filter(value => value.kind === 'resolve').length, 0);
  const state = await f.controller.resolve('comment-1'); assert.equal(state.outcome.kind, 'resolved'); assert.equal(state.ready, true);
  assert.equal(state.items.find(value => value.id === 'comment-1').status, 'resolved');
});

test('resolution acknowledgment cannot substitute the immutable original comment fields', async t => {
  for (const patch of [{ body: 'Changed body' }, { authorId: 'other' }, { createdAt: '2026-11-18T11:00:00.000Z' },
    { anchor: { kind: 'range', timelineId: 'Timeline 夜 "Été"', startFrame: 0, endFrame: 1 } }]) await t.test(Object.keys(patch)[0], async t => {
    const f = fixture(t); await f.controller.refresh();
    f.hooks.resolve = () => f.item('comment-1', { status: 'resolved', resolvedAt: '2026-11-18T12:01:00.000Z', resolvedBy: 'owner', canResolve: false, ...patch });
    const state = await f.controller.resolve('comment-1');
    assert.equal(state.error, 'sync-response-invalid'); assert.equal(state.outcome, null); assert.equal(state.items[0].status, 'open');
  });
});

test('malformed or duplicate pages cannot publish private fields or append duplicate rows', async t => {
  const f = fixture(t);
  for (const bad of [f.page([f.item(), f.item()]), f.page([f.item('foreign', { revisionId: 'foreign' })]),
    f.page([f.item('private', { privatePath: '/private/source' })]), f.page([f.item('anchor', { anchor: { ...f.anchor, clipId: 'missing' } })])]) {
    f.hooks.list = () => bad; const state = await f.controller.refresh();
    assert.equal(state.ready, false); assert.equal(state.items.length, 0); assert.match(state.error, /sync-response-invalid|comment-anchor-unverified/);
  }
  const initial = Array.from({ length: 20 }, (_, index) => f.item(`row-${index}`));
  f.hooks.list = () => f.page(initial, { nextCursor: cursor(1), total: 40, openCount: 40 }); await f.controller.refresh();
  f.hooks.list = () => f.page(initial, { total: 40, openCount: 40 });
  const state = await f.controller.refresh(true); assert.equal(state.error, 'sync-response-invalid'); assert.equal(state.items.length, 20);
});

test('explicit paging stops at the 500-comment display cap without duplicate requests', async t => {
  const f = fixture(t); let offset = 0;
  f.hooks.list = () => {
    const items = Array.from({ length: 20 }, (_, index) => f.item(`row-${offset + index}`)); offset += 20;
    return f.page(items, { nextCursor: cursor(offset), total: 600, openCount: 600 });
  };
  await f.controller.refresh(); for (let index = 0; index < 24; index++) await f.controller.refresh(true);
  const state = await f.controller.getState(); assert.equal(state.items.length, 500); assert.equal(state.nextCursor, null); assert.equal(state.error, 'comments-display-limit');
  const count = f.calls.length; await f.controller.refresh(true); assert.equal(f.calls.length, count);
});

test('dispose aborts and drains pending actions and prevents late state publication or further requests', async t => {
  const f = fixture(t), entered = deferred(), gate = deferred(), initial = f.page();
  f.hooks.list = (_pid, _rid, _page, options) => { entered.resolve(options.signal); return gate.promise; };
  const reading = f.controller.refresh(), signal = await entered.promise, disposing = f.controller.dispose();
  assert.equal(signal.aborted, true); gate.resolve(initial); await Promise.all([reading, disposing]);
  const count = f.calls.length, eventCount = f.events.length, state = await f.controller.refresh();
  assert.equal(state.available, false); assert.equal(state.items.length, 0); assert.equal(f.calls.length, count); assert.equal(f.events.length, eventCount);
});
