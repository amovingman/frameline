'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopShareLinks } = require('../src/desktop-share-links');
const fail = code => Object.assign(new Error('/private/workspace password-secret bearer-secret'), { code });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cursor = index => `${Buffer.from(`share-page-${index}`).toString('base64url')}.${Buffer.alloc(32, 7).toString('base64url')}`;
const manifestId = `sha256:${'a'.repeat(64)}`;
const day = 86_400_000;
function link(id = 'link-1', patch = {}) { return { id, projectId: 'project-1', branch: 'main', revisionId: 'revision-older', revisionMessage: 'Older pinned cut',
  manifestId, issuerId: 'owner', createdAt: 1000, expiresAt: 1000 + day, revokedAt: null, status: 'active', ...patch }; }
function fixture(t) {
  const account = { origin: 'https://sharing.example.test', status: 'connected', account: { id: 'owner' },
    projects: [{ id: 'project-1', role: 'owner', branches: ['main', 'review'] }, { id: 'project-2', role: 'owner', branches: ['main'] }] };
  const model = { headRevisionId: 'revision-current', revision: { id: 'revision-current', manifestId, message: 'Current cut', createdAt: '2026-11-18T12:00:00.000Z' }, links: [link()] };
  const clock = { value: 2000 }, calls = [], events = [], clipboard = [], hooks = {}, committed = new Map();
  let next = 1;
  const page = (pid = 'project-1', branch = 'main', patch = {}) => ({ projectId: pid, branch, headRevisionId: model.headRevisionId, revision: structuredClone(model.revision),
    links: { items: structuredClone(model.links.map(item => ({ ...item, projectId: pid, branch }))), nextCursor: null, total: model.links.length }, ...patch });
  const creation = (input, patch = {}) => {
    const created = link(`created-${next++}`, { projectId: input.projectId, branch: input.branch, revisionId: input.expectedHead,
      revisionMessage: model.revision.message, manifestId: model.revision.manifestId, issuerId: account.account.id,
      createdAt: clock.value, expiresAt: clock.value + input.ttlMs, ...patch });
    return { link: created, token: Buffer.alloc(32, next).toString('base64url') };
  };
  const client = {
    async getShareReview(pid, branch, input, options) {
      calls.push({ kind: 'read', pid, branch, input: structuredClone(input), signal: options.signal });
      return hooks.read ? hooks.read(pid, branch, input, options) : page(pid, branch);
    },
    async createShareLink(input, options) {
      calls.push({ kind: 'create', input: structuredClone(input), signal: options.signal });
      if (hooks.create) return hooks.create(input, options);
      if (!committed.has(input.idempotencyKey)) { const result = creation(input); model.links.unshift(result.link); committed.set(input.idempotencyKey, result); }
      return structuredClone(committed.get(input.idempotencyKey));
    },
    async revokeShareLink(pid, id, options) {
      calls.push({ kind: 'revoke', pid, id, signal: options.signal });
      if (hooks.revoke) return hooks.revoke(pid, id, options);
      const found = model.links.find(item => item.id === id); Object.assign(found, { status: 'revoked', revokedAt: clock.value }); return structuredClone(found);
    }
  };
  const controller = createDesktopShareLinks({ connection: { getState: () => structuredClone(account), getClient: () => client }, now: () => clock.value,
    async writeClipboard(url) { clipboard.push(url); if (hooks.clipboard) return hooks.clipboard(url); },
    onChange(state) { events.push(state); if (hooks.change) hooks.change(state); } });
  t.after(() => controller.dispose());
  const select = (projectId = 'project-1', branch = 'main') => controller.selectShareLinks({ projectId, branch });
  const refresh = () => controller.refreshShareLinks({ append: false });
  const mutate = async (method, input) => controller[method]({ scopeId: (await controller.getState()).scopeId, ...input });
  const ready = async () => { await select(); return refresh(); };
  return { controller, account, model, clock, calls, events, clipboard, hooks, committed, page, creation, select, refresh, mutate, ready };
}

test('selection/state reads are local and owner-only review requires an explicit server refresh', async t => {
  const f = fixture(t); assert.equal((await f.controller.getState()).available, false);
  const selected = await f.select(); assert.equal(selected.available, true); assert.equal(selected.ready, false); assert.equal(f.calls.length, 0);
  assert.equal((await f.mutate('copyShareLink', { ttlMs: day })).error, 'share-refresh-required'); assert.equal(f.calls.length, 0);
  const ready = await f.refresh(); assert.equal(ready.ready, true); assert.equal(ready.checkedAt, 2000); assert.equal(ready.revision.message, 'Current cut');
  ready.links[0].revisionMessage = 'Tampered copy'; f.events.at(-1).revision.message = 'Changed event';
  assert.equal((await f.controller.getState()).links[0].revisionMessage, 'Older pinned cut'); assert.equal((await f.controller.getState()).revision.message, 'Current cut');
  await f.controller.selectShareLinks(null); assert.equal((await f.controller.getState()).selection, null);
});

test('only owners can read private links or mutate; invalid HTTPS origins and revoked membership fail closed', async t => {
  for (const change of ['editor', 'viewer', 'http', 'path', 'removed']) await t.test(change, async t => {
    const f = fixture(t); await f.ready();
    if (change === 'editor' || change === 'viewer') f.account.projects[0].role = change;
    else if (change === 'http') f.account.origin = 'http://sharing.example.test';
    else if (change === 'path') f.account.origin = 'https://sharing.example.test/private';
    else f.account.projects = [];
    const state = await f.controller.connectionChanged(); assert.equal(state.available, false); assert.equal(state.links.length, 0); assert.equal(state.revision, null);
    const count = f.calls.length; await f.refresh(); await f.mutate('copyShareLink', { ttlMs: day }); await f.mutate('revokeShareLink', { linkId: 'link-1' }); assert.equal(f.calls.length, count);
  });
});

test('copy creates exactly checked revision/TTL and keeps bearer material confined to the clipboard callback', async t => {
  const f = fixture(t); const before = await f.ready(), state = await f.mutate('copyShareLink', { ttlMs: day });
  assert.equal(state.outcome.kind, 'copied'); assert.equal(state.outcome.revisionId, 'revision-current'); assert.equal(state.outcome.expiresAt, 2000 + day);
  const input = f.calls.find(item => item.kind === 'create').input; assert.equal(input.expectedHead, before.revision.id); assert.equal(input.ttlMs, day); assert.equal(input.branch, 'main');
  assert.match(f.clipboard[0], /^https:\/\/sharing\.example\.test\/share#[A-Za-z0-9_-]{43}$/);
  for (const result of f.committed.values()) assert.equal(JSON.stringify(f.events).includes(result.token), false);
  assert.doesNotMatch(JSON.stringify(f.events), /tokenHash|"token"|"url"|idempotencyKey|password-secret|bearer-secret|\/private\//);
  await f.mutate('copyShareLink', { ttlMs: day }); assert.equal(f.committed.size, 2); assert.equal(f.clipboard.length, 2); assert.notEqual(f.clipboard[0], f.clipboard[1]);
});

test('exact inputs reject stale guards, arbitrary revisions/private fields, out-of-range TTLs and unknown link IDs without IO', async t => {
  for (const [method, input, code] of [
    ['copyShareLink', { ttlMs: 3_599_999 }, 'share-links-invalid'], ['copyShareLink', { ttlMs: 2_592_000_001 }, 'share-links-invalid'],
    ['copyShareLink', { ttlMs: day, revisionId: 'arbitrary-revision' }, 'share-links-invalid'],
    ['copyShareLink', { ttlMs: day, url: 'https://untrusted.example/share' }, 'share-links-invalid'],
    ['revokeShareLink', { linkId: 'unknown-link' }, 'share-link-not-found']]) await t.test(`${method}/${code}/${Object.keys(input)}`, async t => {
    const f = fixture(t); await f.ready(); const count = f.calls.length; assert.equal((await f.mutate(method, input)).error, code); assert.equal(f.calls.length, count); assert.equal(f.clipboard.length, 0);
  });
  const f = fixture(t); await f.ready(); const count = f.calls.length;
  assert.equal((await f.controller.copyShareLink({ scopeId: 'old-scope', ttlMs: day })).error, 'share-selection-changed'); assert.equal(f.calls.length, count);
});

test('a committed create with lost acknowledgment replays one private key through refresh, unrelated projects and same selection', async t => {
  const f = fixture(t); await f.ready(); let first = true;
  f.hooks.create = input => {
    if (!f.committed.has(input.idempotencyKey)) { const result = f.creation(input); f.committed.set(input.idempotencyKey, result); f.model.links.unshift(result.link); }
    if (first) { first = false; throw fail('sync-network-unavailable'); } return structuredClone(f.committed.get(input.idempotencyKey));
  };
  let state = await f.mutate('copyShareLink', { ttlMs: day }); assert.equal(state.error, 'sync-network-unavailable'); assert.equal(state.outcome, null); assert.equal(f.clipboard.length, 0);
  f.account.projects.push({ id: 'unrelated', role: 'viewer', branches: ['main'] }); await f.controller.connectionChanged(); await f.refresh();
  await f.select(); await f.refresh(); state = await f.mutate('copyShareLink', { ttlMs: day });
  assert.equal(state.outcome.kind, 'copied'); assert.equal(f.committed.size, 1); assert.equal(f.clipboard.length, 1);
  const calls = f.calls.filter(item => item.kind === 'create'); assert.equal(calls[0].input.idempotencyKey, calls[1].input.idempotencyKey);
});

test('a pending copy key survives authorized identity restoration, while changed TTL/head/account get a new intent key', async t => {
  const f = fixture(t); await f.ready(); f.hooks.create = () => { throw fail('sync-network-unavailable'); };
  await f.mutate('copyShareLink', { ttlMs: day });
  f.account.projects[0].role = 'editor'; await f.controller.connectionChanged(); f.account.projects[0].role = 'owner'; await f.controller.connectionChanged(); await f.refresh();
  await f.mutate('copyShareLink', { ttlMs: day }); let calls = f.calls.filter(item => item.kind === 'create'); assert.equal(calls[0].input.idempotencyKey, calls[1].input.idempotencyKey);
  await f.mutate('copyShareLink', { ttlMs: day * 7 }); calls = f.calls.filter(item => item.kind === 'create'); assert.notEqual(calls[1].input.idempotencyKey, calls[2].input.idempotencyKey);
  f.model.headRevisionId = 'new-head'; f.model.revision.id = 'new-head'; await f.refresh(); await f.mutate('copyShareLink', { ttlMs: day * 7 });
  calls = f.calls.filter(item => item.kind === 'create'); assert.notEqual(calls[2].input.idempotencyKey, calls[3].input.idempotencyKey);
  f.account.account.id = 'new-owner'; await f.controller.connectionChanged(); await f.refresh(); await f.mutate('copyShareLink', { ttlMs: day * 7 });
  assert.notEqual(calls[3].input.idempotencyKey, f.calls.filter(item => item.kind === 'create').at(-1).input.idempotencyKey);
});

test('clipboard rejection immediately revokes the new link, or exposes explicit manual cleanup when revocation is unconfirmed', async t => {
  for (const cleanup of ['confirmed', 'failed', 'mismatched-receipt']) await t.test(cleanup, async t => {
    const f = fixture(t); await f.ready(); f.hooks.clipboard = () => { throw fail('clipboard'); };
    if (cleanup === 'failed') f.hooks.revoke = () => { throw fail('sync-network-unavailable'); };
    if (cleanup === 'mismatched-receipt') f.hooks.revoke = (_pid, id) => ({ ...f.model.links.find(item => item.id === id), manifestId: `sha256:${'b'.repeat(64)}`, status: 'revoked', revokedAt: 2000 });
    const state = await f.mutate('copyShareLink', { ttlMs: day });
    assert.equal(state.outcome.kind, 'copy-failed'); assert.equal(state.outcome.revoked, cleanup === 'confirmed'); assert.equal(state.ready, false);
    assert.equal(state.error, cleanup === 'confirmed' ? 'share-clipboard-unavailable' : 'share-copy-revoke-required');
    assert.equal(f.calls.filter(item => item.kind === 'revoke').length, 1); assert.equal(state.outcome.linkId, f.model.links[0].id);
  });
});

test('copy and revoke acknowledgments survive reload failure without claiming a refreshed list', async t => {
  for (const method of ['copyShareLink', 'revokeShareLink']) await t.test(method, async t => {
    const f = fixture(t); const before = await f.ready(); f.hooks.read = () => { throw fail('sync-network-unavailable'); };
    const state = await f.mutate(method, method === 'copyShareLink' ? { ttlMs: day } : { linkId: 'link-1' });
    assert.equal(state.outcome.kind, method === 'copyShareLink' ? 'copied' : 'revoked'); assert.equal(state.ready, false); assert.equal(state.error, 'sync-network-unavailable'); assert.notEqual(state.scopeId, before.scopeId);
    const count = f.calls.length; assert.equal((await f.mutate(method, method === 'copyShareLink' ? { ttlMs: day } : { linkId: 'link-1' })).error, 'share-refresh-required'); assert.equal(f.calls.length, count);
  });
});

test('all nonrevoked link states can be revoked only with an exact immutable receipt', async t => {
  for (const status of ['active', 'expired', 'unavailable']) await t.test(status, async t => {
    const f = fixture(t); f.model.links[0].status = status; await f.ready();
    const state = await f.mutate('revokeShareLink', { linkId: 'link-1' }); assert.equal(state.outcome.kind, 'revoked'); assert.equal(state.links[0].status, 'revoked');
  });
  const f = fixture(t); await f.ready(); f.hooks.revoke = () => link('link-1', { status: 'revoked', revokedAt: 2000, issuerId: 'other-issuer' });
  assert.equal((await f.mutate('revokeShareLink', { linkId: 'link-1' })).error, 'sync-response-invalid'); assert.equal((await f.controller.getState()).outcome, null);
});

test('account/origin/branch/role/removal/signout invalidate pending creates before any bearer reaches the clipboard', async t => {
  for (const change of ['account', 'origin', 'branch', 'role', 'removed', 'signout']) await t.test(change, async t => {
    const f = fixture(t); await f.ready(); const entered = deferred(), gate = deferred(); let receipt;
    f.hooks.create = (input, options) => { receipt = f.creation(input); entered.resolve(options.signal); return gate.promise; };
    const copying = f.mutate('copyShareLink', { ttlMs: day }), signal = await entered.promise;
    if (change === 'account') f.account.account.id = 'other-account';
    else if (change === 'origin') f.account.origin = 'https://other.example.test';
    else if (change === 'branch') await f.select('project-1', 'review');
    else if (change === 'role') f.account.projects[0].role = 'editor';
    else if (change === 'removed') f.account.projects = [];
    else { f.account.account = null; f.account.status = 'sign-in-required'; }
    await f.controller.connectionChanged(); assert.equal(signal.aborted, true); gate.resolve(receipt); await copying;
    const state = await f.controller.getState(); assert.equal(f.clipboard.length, 0); assert.equal(state.links.length, 0); assert.equal(state.outcome, null); assert.equal(state.busy, false);
  });
});

test('independent signed paging preserves old pinned messages and rejects duplicate/replayed cursor pages', async t => {
  const f = fixture(t); let append = false;
  f.hooks.read = (pid, branch) => f.page(pid, branch, { links: append ? { items: [link('link-20')], nextCursor: null, total: 21 }
    : { items: Array.from({ length: 20 }, (_, i) => link(`link-${i}`)), nextCursor: cursor(1), total: 21 } });
  await f.ready(); append = true; let state = await f.controller.refreshShareLinks({ append: true }); assert.equal(state.links.length, 21); assert.equal(state.links[0].revisionMessage, 'Older pinned cut');
  append = false; await f.refresh(); f.hooks.read = (pid, branch) => f.page(pid, branch, { links: { items: [link('link-0')], nextCursor: null, total: 21 } });
  state = await f.controller.refreshShareLinks({ append: true }); assert.equal(state.error, 'sync-response-invalid'); assert.equal(state.links.length, 20);
});

test('paging head changes invalidate old link review; the explicit 500-row cap stops further requests', async t => {
  const f = fixture(t); let index = 0;
  f.hooks.read = (pid, branch, input) => { if (!input.cursor) index = 0; else index++; return f.page(pid, branch, {
    links: { items: Array.from({ length: 20 }, (_, i) => link(`bounded-${index * 20 + i}`)), nextCursor: cursor(index + 1), total: 600 } }); };
  let state = await f.ready(); for (let i = 1; i < 25; i++) state = await f.controller.refreshShareLinks({ append: true });
  assert.equal(state.links.length, 500); assert.equal(state.nextCursor, null); assert.equal(state.error, 'share-display-limit');
  const count = f.calls.length; await f.controller.refreshShareLinks({ append: true }); assert.equal(f.calls.length, count);
  const old = await f.refresh(); f.model.headRevisionId = 'new-head'; f.model.revision.id = 'new-head';
  state = await f.controller.refreshShareLinks({ append: true }); assert.equal(state.error, 'share-selection-changed'); assert.equal(state.ready, false); assert.equal(state.links.length, 0); assert.notEqual(state.scopeId, old.scopeId);
});

test('invalid create receipts never copy, and empty/expired/unavailable revisions cannot create a usable link', async t => {
  for (const mismatch of ['issuer', 'manifest', 'message', 'ttl', 'token', 'extra-private', 'expired', 'unavailable']) await t.test(mismatch, async t => {
    const f = fixture(t); await f.ready();
    f.hooks.create = input => {
      const result = f.creation(input);
      if (mismatch === 'issuer') result.link.issuerId = 'other-user';
      if (mismatch === 'manifest') result.link.manifestId = `sha256:${'b'.repeat(64)}`;
      if (mismatch === 'message') result.link.revisionMessage = 'Different pinned message';
      if (mismatch === 'ttl') result.link.expiresAt += 1;
      if (mismatch === 'token') result.token = 'not-a-valid-token';
      if (mismatch === 'extra-private') result.privatePath = '/private/workspace';
      if (mismatch === 'expired') { result.link.createdAt = 0; result.link.expiresAt = input.ttlMs; f.clock.value = input.ttlMs + 1; }
      if (mismatch === 'unavailable') result.link.status = 'unavailable';
      return result;
    };
    const state = await f.mutate('copyShareLink', { ttlMs: day }); assert.equal(f.clipboard.length, 0); assert.equal(state.outcome, null);
    assert.equal(state.error, ['expired', 'unavailable'].includes(mismatch) ? 'share-link-unavailable' : 'sync-response-invalid');
  });
  const f = fixture(t); f.model.revision = null; f.model.headRevisionId = null; await f.ready(); assert.equal((await f.mutate('copyShareLink', { ttlMs: day })).error, 'share-revision-unavailable'); assert.equal(f.clipboard.length, 0);
});

test('offline state blocks mutations before IO; unknown errors and malformed public pages are sanitized', async t => {
  const f = fixture(t); await f.ready(); f.account.status = 'offline'; await f.controller.connectionChanged(); const count = f.calls.length;
  assert.equal((await f.mutate('copyShareLink', { ttlMs: day })).error, 'service-offline'); assert.equal(f.calls.length, count);
  f.account.status = 'connected'; f.hooks.read = () => { throw fail('/private/workspace bearer-secret'); }; let state = await f.refresh(); assert.equal(state.error, 'share-local-error');
  f.hooks.read = (pid, branch) => f.page(pid, branch, { tokenHash: 'secret-hash' }); state = await f.refresh(); assert.equal(state.error, 'sync-response-invalid');
  f.hooks.read = () => { throw fail('forbidden'); }; state = await f.refresh(); assert.equal(state.links.length, 0); assert.equal(state.revision, null); assert.equal(state.ready, false);
  assert.doesNotMatch(JSON.stringify(f.events), /tokenHash|secret-hash|\/private|bearer-secret|password-secret/);
});

test('dispose aborts/drains pending IO; duplicate actions cannot replace busy work or leak a late receipt', async t => {
  const f = fixture(t); await f.select(); const entered = deferred(), gate = deferred();
  f.hooks.read = (_pid, _branch, _input, options) => { entered.resolve(options.signal); return gate.promise; };
  const reading = f.refresh(), signal = await entered.promise, count = f.calls.length;
  assert.equal((await f.refresh()).busy, true); assert.equal(f.calls.length, count);
  const closing = f.controller.dispose(); assert.equal(signal.aborted, true); gate.resolve(f.page()); await closing; await reading;
  const state = await f.controller.getState(); assert.equal(state.selection, null); assert.equal(state.busy, false); assert.equal(state.links.length, 0); assert.equal(state.outcome, null);
});
