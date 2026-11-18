'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { API_VERSION } = require('../src/project-api-contracts');
const source = fs.readFileSync(path.join(__dirname, '../src/unsubscribe-viewer-client.js'), 'utf8'), token = Buffer.alloc(32, 19).toString('base64url');
function fixture({ hash = `#${token}`, query = '', send = null } = {}) {
  const nodes = Object.fromEntries(['unsubscribe', 'unsubscribe-status'].map(id => [id, { textContent: '', disabled: false, events: {}, addEventListener(name, fn) { this.events[name] = fn; } }]));
  const calls = [], replacements = [], location = { hash, search: query, pathname: '/unsubscribe' };
  vm.runInNewContext(source, { location, history: { replaceState(_state, _title, value) { replacements.push(value); location.hash = ''; location.search = ''; } },
    document: { readyState: 'complete', getElementById: id => nodes[id], querySelector: () => ({ content: API_VERSION }) }, crypto: webcrypto,
    AbortSignal, TextDecoder, Uint8Array, atob, btoa, fetch: async (url, options) => { calls.push({ url, options });
      return send ? send(url, options) : new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data: { unsubscribed: true } }), { headers: { 'content-type': 'application/json' } }); } });
  return { nodes, calls, replacements, location, click: () => nodes.unsubscribe.events.click(), text: () => nodes['unsubscribe-status'].textContent };
}
test('unsubscribe clears its fragment immediately and requires explicit intent using only a body capability', async () => {
  const f = fixture(); assert.deepEqual(f.replacements, ['/unsubscribe']); assert.equal(f.location.hash, ''); assert.equal(f.calls.length, 0);
  await f.click(); assert.equal(f.calls.length, 1); const call = f.calls[0]; assert.equal(call.url, '/notifications/unsubscribe');
  assert.equal(JSON.parse(call.options.body).token, token); assert.equal(call.options.headers.authorization, undefined);
  assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.referrerPolicy, 'no-referrer');
  assert.equal(f.nodes.unsubscribe.disabled, true); assert.match(f.text(), /request has been processed/); assert(!f.text().includes(token));
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|innerHTML|\/account/);
});
test('incomplete links cannot submit and private errors or identity-bearing receipts never enter the page', async () => {
  for (const options of [{ hash: '' }, { hash: '#invalid' }, { hash: `#${'A'.repeat(42)}B` }, { query: '?token=private' }]) {
    const f = fixture(options); assert.equal(f.nodes.unsubscribe.disabled, true); await f.click(); assert.equal(f.calls.length, 0);
  }
  const failure = fixture({ send: async () => { throw Error(`/Users/private ${token}`); } }); await failure.click();
  assert.match(failure.text(), /connection was interrupted/); assert(!failure.text().includes(token)); assert(!failure.text().includes('/Users/'));
  const bad = fixture({ send: async (_url, options) => new Response(JSON.stringify({ apiVersion: API_VERSION, requestId: options.headers['x-request-id'], data: { unsubscribed: true, accountEmail: 'private@example.test' } }), { headers: { 'content-type': 'application/json' } }) });
  await bad.click(); assert.match(bad.text(), /could not be verified/); assert(!bad.text().includes('private@example.test')); assert.equal(bad.nodes.unsubscribe.disabled, true);
});
