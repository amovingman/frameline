const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocalMetadataStore } = require('../src/local-metadata');

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-metadata-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('project IDs survive restart and metadata stores no project paths', async () => withStore(async directory => {
  const filePath = '/private/editing/client-cut.fcpxml';
  const first = await createLocalMetadataStore(directory).getProjectId(filePath);
  const second = await createLocalMetadataStore(directory).getProjectId(filePath);
  assert.equal(first.id, second.id);
  assert.equal(first.recovered, false);
  const saved = await fs.readFile(path.join(directory, 'metadata.json'), 'utf8');
  assert.doesNotMatch(saved, /private|editing|client-cut|fcpxml/);
  assert.deepEqual(JSON.parse(saved).schemaVersion, 1);
  assert.equal(await fs.readFile(path.join(directory, 'metadata.json.bak'), 'utf8'), saved);
}));

test('restores a damaged primary from backup and preserves the damaged file', async () => withStore(async directory => {
  const store = createLocalMetadataStore(directory);
  const filePath = '/private/editing/client-cut.fcpxml';
  const first = await store.getProjectId(filePath);
  await fs.writeFile(path.join(directory, 'metadata.json'), '{broken');
  const restored = await createLocalMetadataStore(directory).getProjectId(filePath);
  assert.equal(restored.id, first.id);
  assert.equal(restored.recovered, true);
  assert.equal((await createLocalMetadataStore(directory).getProjectId(filePath)).recovered, false);
  assert.ok((await fs.readdir(directory)).some(name => name.startsWith('metadata.json.corrupt-')));
}));

test('rejects a future schema version without overwriting it', async () => withStore(async directory => {
  const filePath = path.join(directory, 'metadata.json');
  const newer = '{"schemaVersion":2,"projects":{}}';
  await fs.writeFile(filePath, newer);
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-newer-version' });
  assert.equal(await fs.readFile(filePath, 'utf8'), newer);
}));

test('reports damage when no valid backup exists', async () => withStore(async directory => {
  await fs.writeFile(path.join(directory, 'metadata.json'), '{broken');
  await assert.rejects(createLocalMetadataStore(directory).getProjectId('/private/cut.fcpxml'), { code: 'metadata-invalid' });
}));
