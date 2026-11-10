const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fcpxmlProjectAdapter, requireProjectAdapter } = require('../src/project-adapter');
const { createProjectSession } = require('../src/project-session');

test('read-only adapter scans and verifies while refusing unproven write operations', async () => {
  const filePath = path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml');
  const manifest = await fcpxmlProjectAdapter.scan(filePath);
  await fcpxmlProjectAdapter.verifySource(filePath, manifest.sourceHash);
  assert.equal(fcpxmlProjectAdapter.capabilities.readOnly, true);
  assert.equal(fcpxmlProjectAdapter.capabilities.stableIds, false);
  for (const operation of ['mapStableIds', 'apply', 'save', 'validate']) {
    await assert.rejects(fcpxmlProjectAdapter[operation](), { code: 'adapter-operation-unavailable' });
  }
  const state = await createProjectSession(fcpxmlProjectAdapter).select(filePath);
  assert.equal(state.scanStatus, 'ready');
});

test('adapter contract rejects missing safety methods', () => {
  assert.throws(() => requireProjectAdapter({ id: 'incomplete', capabilities: {}, scan() {} }), TypeError);
});
