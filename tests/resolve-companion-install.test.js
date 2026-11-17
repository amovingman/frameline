const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installResolveCompanion } = require('../src/resolve-companion-install');

test('bundled Python scripts install as private immutable files and detect tampering', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-companion-install-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const input = { bundledDirectory: path.join(__dirname, '../src/companion'),
    dataDirectory: path.join(parent, 'private') };
  const installed = await installResolveCompanion(input);
  assert.match(installed.packageSha256, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(installed.scriptPath)).mode & 0o077, 0);
  assert.equal((await fs.stat(installed.requestsDirectory)).mode & 0o077, 0);
  assert.deepEqual(await installResolveCompanion(input), installed);
  await fs.writeFile(installed.scriptPath, 'tampered');
  await assert.rejects(installResolveCompanion(input), { code: 'resolve-companion-install-invalid' });
});
