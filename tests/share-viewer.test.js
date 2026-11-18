'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { API_VERSION, fingerprint } = require('../src/project-api-contracts');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { validateRevisionManifest } = require('../src/revision-manifest');
const source = fs.readFileSync(path.join(__dirname, '../src/share-viewer-client.js'), 'utf8');
const token = Buffer.alloc(32, 11).toString('base64url');
const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved', sourceHash: 'a'.repeat(64),
  sequence: { name: '<img src=x onerror=alert(1)> 夜', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
const data = () => ({ permission: 'read', projectId: 'film', projectName: '<script>alert(1)<script> Été', revision: { id: 'revision',
  manifestId: `sha256:${fingerprint(manifest)}`, message: '<svg onload=alert(1)> literal text', createdAt: '2026-11-18T12:00:00.000Z' }, manifest, expiresAt: 1795010000000 });
function fixture({ hash = `#${token}`, query = '', send = null, payload = data() } = {}) {
  const nodes = new Map(), created = [], calls = [], replacements = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.events = new Map(); this.hidden = false; this.disabled = false; }
    set innerHTML(_) { throw Error('HTML execution sink must never be used'); }
    append(value) { this.children.push(value); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.events.set(name, listener); }
    focus() { this.focused = true; }
  }
  for (const name of ['open-share', 'share-status', 'revision', 'revision-title', 'revision-message', 'revision-facts', 'revision-summary', 'metadata-details', 'metadata-json']) nodes.set(name, new Element(name));
  const location = { hash, pathname: '/share', search: query };
  const context = vm.createContext({ location, history: { replaceState(_state, _title, url) { replacements.push(url); location.hash = ''; location.search = ''; } },
    document: { readyState: 'complete', getElementById: id => nodes.get(id), querySelector: () => ({ content: API_VERSION }),
      createElement: tag => { created.push(tag); return new Element(tag); } },
    crypto: webcrypto, AbortSignal, TextDecoder, TextEncoder, Uint8Array, atob, btoa,
    fetch: async (url, options) => { calls.push({ url, options }); return send ? send(url, options) : new Response(JSON.stringify({
      apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data: payload }), { headers: { 'content-type': 'application/json' } }); }
  });
  vm.runInContext(source, context);
  return { nodes, created, calls, replacements, location, click: () => nodes.get('open-share').events.get('click')(),
    texts: () => [...nodes.values()].map(node => node.textContent).join('\n') };
}

test('recipient clears the fragment before any request and opens only after explicit intent without storing credentials', async () => {
  const f = fixture(); assert.deepEqual(f.replacements, ['/share']); assert.equal(f.location.hash, ''); assert.equal(f.calls.length, 0);
  assert.equal(f.nodes.get('open-share').disabled, false); await f.click(); assert.equal(f.calls.length, 1);
  const call = f.calls[0]; assert.equal(call.url, '/shares/redeem'); assert.equal(JSON.parse(call.options.body).token, token);
  assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.referrerPolicy, 'no-referrer');
  assert.equal(call.options.headers.authorization, undefined); assert(!JSON.stringify(call.options.headers).includes(token));
  assert.equal(f.nodes.get('open-share').hidden, true); assert(!f.texts().includes(token));
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|\.innerHTML\s*=/);
});

test('untrusted metadata stays literal text and the full document is rendered only when expanded', async () => {
  const f = fixture(); await f.click(); assert.equal(f.nodes.get('revision-title').textContent, data().projectName);
  assert.equal(f.nodes.get('revision-message').textContent, data().revision.message);
  assert(!f.created.some(tag => ['img', 'svg', 'script', 'iframe'].includes(tag)));
  assert.equal(f.nodes.get('metadata-json').textContent, '');
  const details = f.nodes.get('metadata-details'); details.open = true; details.events.get('toggle')({ target: details });
  assert.deepEqual(JSON.parse(f.nodes.get('metadata-json').textContent), manifest);
});

test('missing, noncanonical or query-carried capabilities never redeem and private failures stay generic', async () => {
  for (const options of [{ hash: '' }, { hash: '#bad' }, { hash: `#${'A'.repeat(42)}B` }, { query: '?token=bad' }]) {
    const f = fixture(options); assert.equal(f.nodes.get('open-share').disabled, true); await f.click(); assert.equal(f.calls.length, 0);
    assert.equal(f.location.hash, ''); assert(!f.texts().includes(token));
  }
  const failure = fixture({ send: async () => { throw Error(`private error ${token} /Users/private`); } });
  await failure.click(); assert.match(failure.nodes.get('share-status').textContent, /connection was interrupted/);
  assert(!failure.texts().includes(token)); assert(!failure.texts().includes('/Users/'));
});

test('recipient refuses substituted canonical content and oversized responses without rendering them', async () => {
  for (const oversized of [false, true]) {
    const f = fixture({ send: async (_url, options) => new Response(JSON.stringify({ apiVersion: API_VERSION,
      requestId: options.headers['x-request-id'], data: { ...data(), manifest: { ...manifest, sourceHash: 'b'.repeat(64) } } }),
    { headers: { 'content-type': 'application/json', ...(oversized ? { 'content-length': String(8 * 1024 * 1024 + 1) } : {}) } }) });
    await f.click(); assert.equal(f.nodes.get('revision-title').textContent, ''); assert.match(f.nodes.get('share-status').textContent, /could not be verified/);
    assert.equal(f.nodes.get('open-share').disabled, true);
  }
});

const withManifest = document => ({ ...data(), manifest: document,
  revision: { ...data().revision, manifestId: `sha256:${fingerprint(document)}` } });
const summaryValues = f => f.nodes.get('revision-summary').children.map(row => row.children[1]?.textContent).filter(Boolean);
test('Resolve summaries use singular names only for exactly one timeline, item or track', async () => {
  const original = require('../phase-0/resolve-xml-proof/live-properties-enabled.json').snapshot;
  for (const [timelines, items, tracks, totalText, rowText] of [
    [0, 0, 0, '0 timelines · 0 timeline items', null],
    [1, 0, 0, '1 timeline · 0 timeline items', '0 items · 0 tracks'],
    [1, 1, 1, '1 timeline · 1 timeline item', '1 item · 1 track'],
    [2, 2, 2, '2 timelines · 4 timeline items', '2 items · 2 tracks']
  ]) {
    const snapshot = structuredClone(original);
    snapshot.timelines = Array.from({ length: timelines }, (_, index) => {
      const value = structuredClone(original.timelines[0]); value.id = `timeline-${index}`;
      value.items = value.items.slice(0, items); for (const item of value.items) item.linked_item_ids = [];
      value.tracks = value.tracks.slice(0, tracks); return value;
    });
    const document = createResolveRevisionManifest(snapshot), f = fixture({ payload: withManifest(document) }); await f.click();
    assert.equal(summaryValues(f)[0], totalText); if (rowText) assert.equal(summaryValues(f)[1], rowText);
  }
});
test('sequence frame, clip and media-reference counts distinguish zero, one and multiple', async () => {
  for (const count of [0, 1, 2]) {
    const document = structuredClone(manifest); document.sequence.durationFrames = count;
    document.clips = Array.from({ length: count }, (_, index) => ({ scanKey: `position-${index + 1}`, name: `Clip ${index + 1}`,
      mediaName: `Media ${index + 1}`, offsetFrames: index, durationFrames: 1, sourceInFrames: 0, enabled: true, identityStatus: 'unresolved' }));
    document.media = Array.from({ length: count }, (_, index) => ({ name: `Media ${index + 1}`, availability: 'unknown' }));
    validateRevisionManifest(document);
    const f = fixture({ payload: withManifest(document) }); await f.click(); const values = summaryValues(f), suffix = count === 1 ? '' : 's';
    assert.equal(values[0], `${count} frame${suffix}`); assert.equal(values[2], `${count} clip${suffix}`); assert.equal(values[3], `${count} reference${suffix}`);
  }
});
