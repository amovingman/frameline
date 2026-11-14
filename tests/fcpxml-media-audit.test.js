const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { auditFcpxmlMedia } = require('../src/fcpxml-media-audit');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
async function setup(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-audit-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const exportPath = path.join(directory, 'edit.fcpxml');
  async function write(assets, refs = assets.map((_, i) => `a${i}`)) {
    const xml = `<?xml version="1.0"?><!DOCTYPE fcpxml><fcpxml version="1.10"><resources>${assets.map((asset, i) => `<asset id="a${i}" name="${escape(asset.name || 'same.mov')}"><media-rep kind="original-media" src="${escape(asset.url)}"/></asset>`).join('')}</resources><library><event><project><sequence><spine>${refs.map(ref => `<asset-clip ref="${ref}"/>`).join('')}</spine></sequence></project></event></library></fcpxml>`;
    await fs.writeFile(exportPath, xml); return xml;
  }
  return { directory, exportPath, write };
}
test('audits original dependencies, streams hashes and omits all locations', async t => {
  const { directory, exportPath, write } = await setup(t);
  const media = path.join(directory, 'private.mov'); await fs.writeFile(media, 'media bytes');
  const xml = await write([{ url: pathToFileURL(media).href, name: '/secret/private.mov' },
    { url: pathToFileURL(path.join(directory, 'missing.mov')).href },
    { url: 'https://example.com/private.mov' }, { url: 'file:///bad%2Fname.mov' }]);
  const result = await auditFcpxmlMedia({ exportPath, bytes: Buffer.from(xml) });
  assert.deepEqual(result.counts, { total: 4, local: 1, missing: 1, 'offline-volume': 0,
    'proxy-only': 0, excluded: 0, external: 1, unknown: 1, fingerprinted: 1 });
  assert.equal(result.sourceHash, createHash('sha256').update(xml).digest('hex'));
  assert.equal(result.assets[0].fingerprint.sha256, createHash('sha256').update('media bytes').digest('hex'));
  assert.deepEqual(result.assets[0].displayNames, ['private.mov']);
  assert.equal(JSON.stringify(result).includes(directory), false);
  assert.equal(JSON.stringify(result).includes('https:'), false);
  assert.equal('ready' in result, false);
});
test('shows explicit offline, proxy and exclusion evidence without reading media', async t => {
  const { directory, exportPath, write } = await setup(t);
  await write([{ url: pathToFileURL(path.join(directory, 'offline.mov')).href },
    { url: pathToFileURL(path.join(directory, 'proxy.mov')).href },
    { url: pathToFileURL(path.join(directory, 'excluded.mov')).href }]);
  const result = await auditFcpxmlMedia({ exportPath, evidenceById: {
    'media-1': { volumeOffline: true }, 'media-2': { proxyOnly: true }, 'media-3': { excluded: true }
  } });
  assert.deepEqual(result.assets.map(asset => asset.status), ['offline-volume', 'proxy-only', 'excluded']);
  assert.equal(result.counts['offline-volume'], 1); assert.equal(result.counts['proxy-only'], 1);
  assert.equal(result.counts.excluded, 1); assert.equal(result.counts.fingerprinted, 0);
});
test('deduplicates URLs without conflating same names and excludes unused assets', async t => {
  const { directory, exportPath, write } = await setup(t);
  const url = pathToFileURL(path.join(directory, 'missing.mov')).href;
  await write([{ url }, { url, name: 'other.mov' }, { url: 'https://a.test/a' }, { url: 'https://a.test/unused' }], ['a0', 'a1', 'a2', 'a0']);
  const result = await auditFcpxmlMedia(exportPath);
  assert.equal(result.counts.total, 2);
  assert.deepEqual(result.assets[0].displayNames, ['same.mov', 'other.mov']);
});
test('does not follow media or export symlinks', async t => {
  const { directory, exportPath, write } = await setup(t);
  const media = path.join(directory, 'real.mov'); const link = path.join(directory, 'link.mov');
  await fs.writeFile(media, 'hello'); await fs.symlink(media, link);
  await write([{ url: pathToFileURL(link).href }]);
  const result = await auditFcpxmlMedia(exportPath);
  assert.equal(result.assets[0].status, 'unknown');
  assert.equal(result.assets[0].reason, 'symlink-unsupported');
  const exportLink = path.join(directory, 'linked.fcpxml'); await fs.symlink(exportPath, exportLink);
  await assert.rejects(auditFcpxmlMedia(exportLink), { code: 'symlink-export-unsupported' });
});
test('rejects malformed, unsupported and stale export inputs with generic errors', async t => {
  const { exportPath, write } = await setup(t);
  const xml = await write([{ url: 'https://a.test/a' }]);
  await assert.rejects(auditFcpxmlMedia({ exportPath, bytes: `${xml} ` }), { code: 'stale-export' });
  await assert.rejects(auditFcpxmlMedia({ exportPath, expectedSourceHash: 'bad' }), { code: 'stale-export' });
  await fs.writeFile(exportPath, xml.replace('version="1.10"', 'version="1.9"'));
  await assert.rejects(auditFcpxmlMedia(exportPath), { code: 'unsupported-fcpxml-version' });
  await fs.writeFile(exportPath, '<fcpxml>');
  await assert.rejects(auditFcpxmlMedia(exportPath), { code: 'malformed-xml' });
});
