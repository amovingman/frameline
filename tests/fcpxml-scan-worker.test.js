const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { createFcpXmlScanner, scanXml, ScanError } = require('../src/fcpxml-adapter');
const sha = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function xml(count = 1, { uniqueMedia = false, source = 'file:///nonexistent/picture.mov', sequenceDuration = true } = {}) {
  const assets = Array.from({ length: uniqueMedia ? count : 1 }, (_, index) => `<asset id="a${index}" name="Picture ${index}" src="${source}${uniqueMedia ? index : ''}"/>`).join('');
  const clips = Array.from({ length: count }, (_, index) => `<asset-clip ref="a${uniqueMedia ? index : 0}" name="Clip ${index}" offset="${index}s" start="0s" duration="1s"/>`).join('');
  return `<?xml version="1.0"?><!DOCTYPE fcpxml><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/>${assets}</resources><library><event><project name="Large fixture"><sequence format="f"${sequenceDuration ? ` duration="${count}s"` : ''}><spine>${clips}</spine></sequence></project></event></library></fcpxml>`;
}
async function setup(t, options) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fcpxml-worker-')));
  const scanner = createFcpXmlScanner(options);
  t.after(async () => { await scanner.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, 'edit.fcpxml'); return { directory, scanner, filename };
}
test('off-thread scan preserves exact diagnostic manifest and hashes; cached rescans recheck media', async t => {
  const f = await setup(t); const media = path.join(f.directory, 'private.mov');
  const bytes = xml(3, { source: pathToFileURL(media).href }); await fs.writeFile(f.filename, bytes);
  const progress = []; const first = await f.scanner.scan(f.filename, { onProgress: value => progress.push(value) });
  const expected = scanXml(bytes); expected.media[0].availability = 'missing'; assert.deepEqual(first, expected);
  assert.equal(first.sourceHash, sha(bytes)); assert.equal(progress.find(value => value.phase === 'inventory').cacheHit, false);
  await fs.writeFile(media, 'media'); first.clips[0].name = 'Caller mutation';
  const cachedProgress = []; const second = await f.scanner.scan(f.filename, { onProgress: value => cachedProgress.push(value) });
  assert.equal(cachedProgress.find(value => value.phase === 'inventory').cacheHit, true);
  assert.equal(second.clips[0].name, 'Clip 0'); assert.equal(second.media[0].availability, 'local');
  assert.doesNotMatch(JSON.stringify([second, progress, cachedProgress]), /file:\/\/|fcpxml-worker-|private\.mov/);
  await f.scanner.verifySource(f.filename, sha(bytes));
});
test('byte-bound LRU cache evicts deterministically and equal-size changed sources never reuse stale inventory', async t => {
  const f = await setup(t, { maxCacheEntries: 1 });
  const a = xml(1); const b = a.replace('Clip 0', 'Clip 1');
  async function scan(bytes) {
    await fs.writeFile(f.filename, bytes); let hit;
    const result = await f.scanner.scan(f.filename, { onProgress: value => { if (value.phase === 'inventory') hit = value.cacheHit; } });
    return { result, hit };
  }
  assert.equal((await scan(a)).hit, false); assert.equal((await scan(a)).hit, true);
  const changed = await scan(b); assert.equal(changed.hit, false); assert.equal(changed.result.clips[0].name, 'Clip 1');
  assert.equal((await scan(a)).hit, false);
  const tiny = createFcpXmlScanner({ maxCacheBytes: 1024 }); t.after(() => tiny.dispose()); await fs.writeFile(f.filename, xml(50));
  const cacheHits = [];
  for (let i = 0; i < 2; i++) await tiny.scan(f.filename, { onProgress: value => { if (value.phase === 'inventory') cacheHits.push(value.cacheHit); } });
  assert.deepEqual(cacheHits, [false, false]);
});
test('real parse/build cancellation terminates work while the main event loop remains responsive', async t => {
  const f = await setup(t); await fs.writeFile(f.filename, xml(70000));
  const abort = new AbortController(); let parsing = false; let heartbeat = 0; let timer;
  const interval = setInterval(() => { if (parsing) heartbeat++; }, 1);
  try {
    await assert.rejects(f.scanner.scan(f.filename, { signal: abort.signal, onProgress: value => {
      if (value.phase === 'parsing') { parsing = true; timer = setTimeout(() => abort.abort(), 20); }
    } }), error => error instanceof ScanError && error.code === 'scan-cancelled');
  } finally { clearInterval(interval); clearTimeout(timer); }
  assert.equal(parsing, true); assert.ok(heartbeat >= 2, 'main event loop serviced timers during actual parse work');
  await fs.writeFile(f.filename, xml(2)); let cacheHit;
  const result = await f.scanner.scan(f.filename, { onProgress: value => { if (value.phase === 'inventory') cacheHit = value.cacheHit; } });
  assert.equal(result.clips.length, 2); assert.equal(cacheHit, false);
});
test('media discovery is incremental in at most64-reference batches and cancellation fences later batches', async t => {
  const f = await setup(t); await fs.writeFile(f.filename, xml(193, { uniqueMedia: true }));
  const abort = new AbortController(); const batches = [];
  await assert.rejects(f.scanner.scan(f.filename, { signal: abort.signal, onProgress: value => {
    if (value.phase === 'media') { batches.push(value.checked); if (value.checked === 128) abort.abort(); }
  } }), { code: 'scan-cancelled' });
  assert.deepEqual(batches, [0, 64, 128]);
  const completed = []; const scan = await f.scanner.scan(f.filename, { onProgress: value => { if (value.phase === 'media') completed.push(value.checked); } });
  assert.deepEqual(completed, [0, 64, 128, 192]); assert.equal(scan.media.length, 193);
});
test('queued cancellation does not start another request; dispose cancels and drains active/queued work', async t => {
  const f = await setup(t); await fs.writeFile(f.filename, xml(1));
  let release; let began; const hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { began = resolve; });
  const active = f.scanner.scan(f.filename, { onProgress: async value => { if (value.phase === 'reading' && value.bytesRead === 0) { began(); await hold; } } });
  const activeFailure = assert.rejects(active, { code: 'scan-disposed' }); await started;
  const abort = new AbortController(); let queuedStarted = false;
  const queued = f.scanner.scan(f.filename, { signal: abort.signal, onProgress: () => { queuedStarted = true; } });
  const queuedFailure = assert.rejects(queued, { code: 'scan-cancelled' }); abort.abort(); await queuedFailure;
  const pending = f.scanner.scan(f.filename); const pendingFailure = assert.rejects(pending, { code: 'scan-disposed' });
  await f.scanner.dispose(); release(); await Promise.all([activeFailure, pendingFailure]);
  assert.equal(queuedStarted, false); await assert.rejects(f.scanner.scan(f.filename), { code: 'scan-disposed' });
});
test('source growth during read and atomic replacement after inventory are rejected before returning a manifest', async t => {
  const f = await setup(t); const original = xml(70, { uniqueMedia: true }); await fs.writeFile(f.filename, original);
  await assert.rejects(f.scanner.scan(f.filename, { onProgress: async value => {
    if (value.phase === 'reading' && value.bytesRead === 0) await fs.appendFile(f.filename, ' ');
  } }), { code: 'revision-source-changed' });
  await fs.writeFile(f.filename, original);
  await assert.rejects(f.scanner.scan(f.filename, { onProgress: async value => {
    if (value.phase === 'inventory') { const replacement = `${f.filename}.replacement`; await fs.writeFile(replacement, original); await fs.rename(replacement, f.filename); }
  } }), { code: 'revision-source-changed' });
});
test('safe bounded reads reject oversized and symlinked exports and preserve verification errors', async t => {
  const f = await setup(t); await fs.writeFile(f.filename, xml(1)); const link = path.join(f.directory, 'linked.fcpxml'); await fs.symlink(f.filename, link);
  await assert.rejects(f.scanner.scan(link), { code: 'file-unavailable' });
  const oversized = path.join(f.directory, 'large.fcpxml'); const handle = await fs.open(oversized, 'w'); await handle.truncate(20 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(f.scanner.scan(oversized), { code: 'file-too-large' });
  await assert.rejects(f.scanner.verifySource(oversized, 'a'.repeat(64)), { code: 'revision-source-changed' });
  await assert.rejects(f.scanner.verifySource(f.filename, 'a'.repeat(64)), { code: 'revision-source-changed' });
  await assert.rejects(f.scanner.verifySource(path.join(f.directory, 'missing.fcpxml'), 'a'.repeat(64)), { code: 'file-unavailable' });
});
test('progress callback failures are sanitized, and a fresh worker can scan afterward', async t => {
  const f = await setup(t); await fs.writeFile(f.filename, xml(1));
  await assert.rejects(f.scanner.scan(f.filename, { onProgress: () => { throw new Error('/private/source token'); } }), error => error.code === 'scan-progress-failed' && error.message === 'scan-progress-failed');
  assert.equal((await f.scanner.scan(f.filename)).clips.length, 1);
});
test('a rejected stale progress callback cannot cancel the newer worker after its scan was aborted', async t => {
  const f = await setup(t); await fs.writeFile(f.filename, xml(1));
  const abort = new AbortController(); let firstBegan; let rejectOld;
  const firstStarted = new Promise(resolve => { firstBegan = resolve; });
  const oldProgress = new Promise((resolve, reject) => { rejectOld = reject; });
  const first = f.scanner.scan(f.filename, { signal: abort.signal, onProgress: async value => {
    if (value.phase === 'reading' && value.bytesRead === 0) { firstBegan(); await oldProgress; }
  } });
  const cancelled = assert.rejects(first, { code: 'scan-cancelled' }); await firstStarted; abort.abort(); await cancelled;
  let secondBegan; let releaseSecond; const secondStarted = new Promise(resolve => { secondBegan = resolve; });
  const holdSecond = new Promise(resolve => { releaseSecond = resolve; });
  const second = f.scanner.scan(f.filename, { onProgress: async value => {
    if (value.phase === 'reading' && value.bytesRead === 0) { secondBegan(); await holdSecond; }
  } });
  await secondStarted; rejectOld(new Error('/private/stale-path'));
  await new Promise(resolve => setImmediate(resolve)); releaseSecond();
  assert.equal((await second).clips.length, 1);
});
test('invalid source and hash request values fail before worker serialization', async t => {
  const f = await setup(t); await fs.writeFile(f.filename, xml(1));
  for (const selectedPath of [undefined, null, {}, () => {}, '', `${f.filename}\0hidden`]) {
    await assert.rejects(f.scanner.scan(selectedPath), { code: 'file-unavailable' });
  }
  for (const sourceHash of [undefined, null, {}, () => {}, 'not-a-hash', 'A'.repeat(64)]) {
    await assert.rejects(f.scanner.verifySource(f.filename, sourceHash), { code: 'revision-source-changed' });
  }
  assert.equal((await f.scanner.scan(f.filename)).clips.length, 1);
});
test('relative filesystem paths retain the public scanner and source-verification contract', async t => {
  const f = await setup(t); const bytes = xml(2); await fs.writeFile(f.filename, bytes);
  const relativePath = path.relative(process.cwd(), f.filename);
  const scan = await f.scanner.scan(relativePath);
  assert.equal(scan.clips.length, 2); assert.equal(scan.sourceHash, sha(bytes));
  await f.scanner.verifySource(relativePath, scan.sourceHash);
  await fs.appendFile(f.filename, ' ');
  await assert.rejects(f.scanner.verifySource(relativePath, scan.sourceHash), { code: 'revision-source-changed' });
});
test('default facade leaves no referenced idle worker keeping a plain Node process alive', async () => {
  const modulePath = require.resolve('../src/fcpxml-adapter');
  const fixture = path.join(__dirname, '..', 'phase-0/resolve-xml-proof/sample.fcpxml');
  const source = `require(${JSON.stringify(modulePath)}).scanFcpXml(${JSON.stringify(fixture)}).then(s=>process.stdout.write(String(s.clips.length)))`;
  const result = await promisify(execFile)(process.execPath, ['-e', source], { timeout: 5000 });
  assert.equal(result.stdout, '2');
});
