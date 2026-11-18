'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real storage-rendering functions without booting the unrelated
// desktop views. These controls only require text, checked and disabled fields.
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const start = renderer.indexOf('function assetClassLabel(');
const end = renderer.indexOf('function currentAssetAvailability(', start);
assert(start >= 0 && end > start);
const storageFunctions = renderer.slice(start, end);
function fixture(state, matches = false) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, checked: false });
    return elements.get(id);
  };
  const context = vm.createContext({
    assetTransferState: state, serviceState: null,
    assetPolicyClasses: ['original', 'proxy', 'audio', 'graphics', 'other'],
    assetPolicyDraft: null, assetStorageAction: null, assetStorageActionNotice: '',
    currentAssetTransferContext: () => matches ? 'linked-context' : '',
    assetTransferScopeMatches: () => matches,
    assetTransferErrorLabel: () => 'Storage action failed.',
    assetBytes: value => `${value} bytes`,
    setServiceText: (node, value) => { node.textContent = value; },
    document: { getElementById: element }, window: { desktop: { refreshAssetStorage() {} } }
  });
  vm.runInContext(storageFunctions, context);
  return { element, policy: () => context.currentAssetPolicy(), render: available => context.renderAssetStorage(available) };
}
test('storage render stays usable when signed out or unbound, including before the first state event', () => {
  for (const state of [null, {}, { scope: null, storage: null },
    { scope: null, storage: { status: 'idle', policy: null, usage: null } }]) {
    const view = fixture(state);
    assert.equal(view.policy(), null);
    assert.equal(view.render(false), null);
    for (const kind of ['published', 'available', 'archived', 'excluded', 'partial']) {
      assert.equal(view.element(`asset-usage-${kind}`).textContent, 'Not loaded');
    }
    assert.equal(view.element('asset-policy-fields').disabled, true);
    assert.equal(view.element('asset-policy-save').disabled, true);
    assert.equal(view.element('asset-storage-refresh').disabled, true);
    assert.match(view.element('asset-storage-status').textContent, /Sign in and link/);
  }
});
test('storage rendering requires a scoped project and matching nonnull usage', () => {
  for (const state of [{ scope: null, storage: {} },
    { scope: { remoteProjectId: 'film' }, storage: null },
    { scope: { remoteProjectId: 'film' }, storage: { usage: null } },
    { scope: { remoteProjectId: 'film' }, storage: { usage: { projectId: 'other' } } }]) {
    const view = fixture(state, true);
    assert.equal(view.render(true), null);
    assert.equal(view.element('asset-usage-published').textContent, 'Not loaded');
  }
  const view = fixture({ scope: { remoteProjectId: 'film' }, storage: { status: 'ready',
    usage: { projectId: 'film', assetCount: 2, logicalBytes: 10, availableBytes: 5, archivedBytes: 3,
      excludedBytes: 2, inProgressUploads: 1, inProgressReceivedBytes: 4, inProgressDeclaredBytes: 8 } } }, true);
  view.render(true);
  assert.equal(view.element('asset-usage-published').textContent, '2 assets · 10 bytes');
  assert.equal(view.element('asset-usage-available').textContent, '5 bytes');
  assert.equal(view.element('asset-usage-partial').textContent, '1 upload · 4 bytes received of 8 bytes declared');
});
