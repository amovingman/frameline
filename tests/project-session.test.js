const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectSession } = require('../src/project-session');

test('rescans the privately held path and replaces stale media results', async () => {
  const calls = [];
  const session = createProjectSession(async filePath => {
    calls.push(filePath);
    return { clips: [], media: [{ name: 'a.mov', availability: calls.length === 1 ? 'missing' : 'local' }], warnings: [] };
  });
  const filePath = '/private/project/cut.fcpxml';
  const initial = await session.select(filePath);
  assert.equal(initial.scan.media[0].availability, 'missing');
  const refreshed = await session.rescan();
  assert.equal(refreshed.scan.media[0].availability, 'local');
  assert.deepEqual(calls, [filePath, filePath]);
  assert.doesNotMatch(JSON.stringify(refreshed), /\/private\/project/);
});

test('rescan retries a failed scan and clears its error on success', async () => {
  let attempts = 0;
  const session = createProjectSession(async () => {
    if (++attempts === 1) throw Object.assign(new Error('missing'), { code: 'file-unavailable' });
    return { clips: [], media: [], warnings: [] };
  });
  const failed = await session.select('/private/project/cut.fcpxml');
  assert.equal(failed.scanStatus, 'error');
  assert.equal(failed.error, 'file-unavailable');
  assert.equal(failed.scan, null);
  const recovered = await session.rescan();
  assert.equal(recovered.scanStatus, 'ready');
  assert.equal(recovered.error, null);
});

test('an older scan cannot overwrite the newest selection', async () => {
  let finishFirst;
  const session = createProjectSession(filePath => filePath.endsWith('first.fcpxml')
    ? new Promise(resolve => { finishFirst = resolve; })
    : Promise.resolve({ sequence: { name: 'Second' }, clips: [], media: [], warnings: [] }));
  const first = session.select('/private/first.fcpxml');
  const second = await session.select('/private/second.fcpxml');
  finishFirst({ sequence: { name: 'First' }, clips: [], media: [], warnings: [] });
  await first;
  assert.equal(second.selectedProject.name, 'second.fcpxml');
  assert.equal(session.getState().scan.sequence.name, 'Second');
});

test('rescan with no selected file does not invoke the adapter', async () => {
  const session = createProjectSession(() => { throw new Error('should not scan'); });
  assert.deepEqual(await session.rescan(), session.getState());
});
