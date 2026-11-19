const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { parseTimelinePreview, loadTimelinePreview } = require('../src/media-render-input');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const xml = (clips = '<asset-clip ref="a" offset="0s" start="3601s" duration="1s"/>', asset = '') => `<?xml version="1.0"?><!DOCTYPE fcpxml><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="Picture" start="3600s" duration="10s" hasVideo="1">${asset || '<media-rep kind="original-media" src="file:///private/picture.mov"/>'}</asset></resources><library><event><project><sequence format="f"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`;

test('storyboard uses actual offsets and source time relative to nonzero media timecode', () => {
  const result = parseTimelinePreview(xml('<asset-clip ref="a" offset="3s" start="3602s" duration="1s"/><gap offset="1s" duration="2s"/><asset-clip ref="a" offset="0s" start="3601s" duration="1s"/>'));
  assert.equal(result.clipCount, 2); assert.equal(result.frameRate, 24);
  assert.deepEqual(result.clips.map(clip => [clip.offsetFrames, clip.sourceInFrames, clip.seconds]), [[0, 86424, 1], [72, 86448, 2]]);
});
test('rejects nesting, transitions, connected lanes, overlaps, missing offsets and proxy-only references', () => {
  for (const clips of [
    '<asset-clip ref="a" offset="0s" duration="1s"><video ref="a"/></asset-clip>',
    '<transition offset="0s" duration="1s"/>',
    '<asset-clip ref="a" lane="1" offset="0s" start="3600s" duration="1s"/>',
    '<asset-clip ref="a" offset="0s" start="3600s" duration="2s"/><asset-clip ref="a" offset="1s" start="3600s" duration="1s"/>',
    '<asset-clip ref="a" start="3600s" duration="1s"/>',
  ]) assert.throws(() => parseTimelinePreview(xml(clips)));
  assert.throws(() => parseTimelinePreview(xml(undefined, '<media-rep kind="proxy-media" src="file:///private/proxy.mov"/>')), { code: 'missing-preview-original' });
});
test('rejects hostile XML, network sources, ambiguous projects and excessive boards without guessing', () => {
  assert.throws(() => parseTimelinePreview(xml().replace('<!DOCTYPE fcpxml>', '<!DOCTYPE fcpxml [<!ENTITY x SYSTEM "file:///secret">]>')), { code: 'unsafe-preview-xml' });
  assert.throws(() => parseTimelinePreview(xml().replace('file:///private/picture.mov', 'https://user:password@example.test/a')), { code: 'nonlocal-preview-source' });
  assert.throws(() => parseTimelinePreview(xml().replace('1/24s', `${'9'.repeat(100000)}s`)), { code: 'unsupported-preview-timing' });
  assert.throws(() => parseTimelinePreview(xml().replace('</event>', '<project><sequence format="f"><spine/></sequence></project></event>')), { code: 'ambiguous-preview-sequence' });
  assert.throws(() => parseTimelinePreview(xml(Array.from({ length: 25 }, (_, i) => `<asset-clip ref="a" offset="${i}s" start="3600s" duration="1s"/>`).join(''))), { code: 'preview-clip-limit' });
});
test('verified inputs reject stale selection and symlinked exports or dependencies', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-render-input-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'picture.mov'); await fs.writeFile(source, 'picture');
  const exportPath = path.join(directory, 'edit.fcpxml');
  const bytes = xml().replace('file:///private/picture.mov', pathToFileURL(source).href);
  await fs.writeFile(exportPath, bytes);
  assert.equal((await loadTimelinePreview({ exportPath, sourceHash: sha(bytes) })).clips[0].sourcePath, source);
  await assert.rejects(loadTimelinePreview({ exportPath, sourceHash: 'a'.repeat(64) }), { code: 'selection-changed' });
  const linkedExport = path.join(directory, 'linked.fcpxml'); await fs.symlink(exportPath, linkedExport);
  await assert.rejects(loadTimelinePreview({ exportPath: linkedExport, sourceHash: sha(bytes) }), { code: 'symlink-unsupported' });
  await fs.rename(source, `${source}.real`); await fs.symlink(`${source}.real`, source);
  await assert.rejects(loadTimelinePreview({ exportPath, sourceHash: sha(bytes) }), { code: 'symlink-unsupported' });
});
