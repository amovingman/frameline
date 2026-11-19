'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createNativeMediaRenderer } = require('../src/native-media-renderer');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, behavior = async request => {
  if (request.operation === 'ping') return { provider: 'apple-native', version: 1, canonical: false };
  if (request.operation === 'inspect') return { kind: 'image', width: 1, height: 1, frameRate: null, durationSeconds: null, canonical: false };
  await fs.writeFile(request.outputPath, PNG, { flag: 'wx', mode: 0o600 });
  return { kind: request.operation === 'proxy' ? 'image-proxy' : request.operation, mimeType: 'image/png', width: 1, height: 1, canonical: false };
}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'native-media-test-'));
  const directory = await fs.realpath(temporary);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'input.png'), helperPath = path.join(directory, 'helper');
  await fs.writeFile(sourcePath, PNG); await fs.writeFile(helperPath, 'fixture helper', { mode: 0o700 });
  const calls = [], children = [];
  const spawn = (binary, args, options) => {
    assert.equal(binary, helperPath); assert.deepEqual(args, []);
    assert.equal(options.shell, false); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.exitCode = null;
    child.kill = signal => { child.killedWith = signal; child.exitCode = 1; queueMicrotask(() => child.emit('close', null)); return true; };
    child.stdin.end = bytes => {
      const request = JSON.parse(bytes.toString()); calls.push(request);
      Promise.resolve().then(() => behavior(request, child)).then(result => {
        if (result === undefined || child.exitCode !== null) return;
        child.stdout.emit('data', Buffer.from(JSON.stringify(result))); child.exitCode = result.error ? 1 : 0; child.emit('close', child.exitCode);
      }).catch(error => { child.stdout.emit('data', Buffer.from(JSON.stringify({ error: error.message }))); child.exitCode = 1; child.emit('close', 1); });
    };
    children.push(child); return child;
  };
  return { directory, sourcePath, helperPath, calls, children, spawn,
    renderer: createNativeMediaRenderer({ helperPath, spawn, platform: 'darwin' }),
    input: { sourcePath, outputPath: path.join(directory, 'result.png'), width: 1, height: 1 } };
}
async function noStaging(directory) { assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.native-media-')), false); }

test('native provider reports only verified helper capabilities and stays unavailable on unsupported hosts', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.renderer.getAvailability(), { available: true, provider: 'apple-native', version: 1, capabilities: ['inspect', 'thumbnail', 'proxy', 'storyboard'] });
  const unavailable = createNativeMediaRenderer({ platform: 'linux', helperPath: f.helperPath });
  assert.equal(await unavailable.isAvailable(), false);
  assert.equal((await unavailable.getAvailability()).available, false);
  await assert.rejects(unavailable.inspect({ sourcePath: f.sourcePath }), { code: 'native-media-provider-unavailable' });
});
test('availability rejects executable with a mismatched helper protocol', async t => {
  const f = await fixture(t, async () => ({ provider: 'untrusted', version: 1, canonical: false }));
  assert.equal((await f.renderer.getAvailability()).available, false);
});
test('inspect returns allowlisted truthful metadata without source paths', async t => {
  const f = await fixture(t, async () => ({ kind: 'video', width: 3840, height: 2160, durationSeconds: 2, frameRate: 24,
    canonical: false, sourcePath: '/private/secret.mov', errors: ['private'] }));
  assert.deepEqual(await f.renderer.inspect({ sourcePath: f.sourcePath }), { kind: 'video', width: 3840, height: 2160, durationSeconds: 2, frameRate: 24, canonical: false });
});
test('publishes an exclusive durable private PNG with a verified digest and source unchanged', async t => {
  const f = await fixture(t); const before = await fs.stat(f.sourcePath, { bigint: true }); const progress = [];
  const result = await f.renderer.renderThumbnail(f.input, { progress: value => progress.push(value) });
  assert.deepEqual(result, { kind: 'thumbnail', mimeType: 'image/png', width: 1, height: 1, byteLength: PNG.length, sha256: digest(PNG), canonical: false });
  assert.deepEqual(await fs.readFile(f.input.outputPath), PNG);
  assert.equal((await fs.stat(f.input.outputPath)).mode & 0o777, 0o600);
  const after = await fs.stat(f.sourcePath, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
  assert.deepEqual(progress, [5, 100]); await noStaging(f.directory);
  await assert.rejects(f.renderer.renderThumbnail(f.input), { code: 'native-media-output-exists' });
});
test('progress reporting cannot invalidate a successfully published artifact', async t => {
  const f = await fixture(t);
  assert.equal((await f.renderer.renderThumbnail(f.input, { progress: value => { if (value === 100) throw new Error('telemetry'); } })).canonical, false);
});
test('ordered storyboard samples preserve exact supplied source time, rational frames, and labels', async t => {
  const f = await fixture(t);
  await f.renderer.renderStoryboard({ ...f.input, clips: [{ sourcePath: f.sourcePath, seconds: 1 / 24, label: 'First' },
    { sourcePath: f.sourcePath, frame: 12, frameRate: { numerator: 24000, denominator: 1001 }, label: 'Second' }] });
  assert.deepEqual(f.calls[0].clips, [{ sourcePath: f.sourcePath, seconds: 1 / 24, label: 'First' },
    { sourcePath: f.sourcePath, frame: 12, frameRate: { numerator: 24000, denominator: 1001 }, label: 'Second' }]);
});
test('thumbnail accepts observed numeric frame rate without assuming one', async t => {
  const f = await fixture(t);
  await f.renderer.renderThumbnail({ ...f.input, frame: 12, frameRate: 24 });
  assert.equal(f.calls[0].frame, 12); assert.equal(f.calls[0].frameRate, 24);
  await assert.rejects(f.renderer.renderThumbnail({ ...f.input, outputPath: path.join(f.directory, 'missing-rate.png'), frame: 12 }), { code: 'native-media-input-invalid' });
});
test('still proxy is explicitly an image derivative', async t => {
  const f = await fixture(t);
  assert.equal((await f.renderer.renderProxy(f.input)).kind, 'image-proxy');
});
test('video proxy requires MP4 and enforces actual dimensions, duration, and configurable byte ceiling', async t => {
  const f = await fixture(t, async request => {
    await fs.writeFile(request.outputPath, Buffer.from('0000ftyp00000000'));
    return { kind: 'video-proxy', mimeType: 'video/mp4', width: 640, height: 360, durationSeconds: 2, canonical: false };
  });
  const sourcePath = path.join(f.directory, 'source.mp4'); await fs.writeFile(sourcePath, 'source');
  await assert.rejects(f.renderer.renderProxy({ ...f.input, sourcePath }), { code: 'native-media-input-invalid' });
  const result = await f.renderer.renderProxy({ sourcePath, outputPath: path.join(f.directory, 'proxy.mp4') });
  assert.equal(result.kind, 'video-proxy'); assert.equal(result.durationSeconds, 2);
  const bounded = createNativeMediaRenderer({ helperPath: f.helperPath, spawn: f.spawn, platform: 'darwin', maxProxyBytes: 8 });
  await assert.rejects(bounded.renderProxy({ sourcePath, outputPath: path.join(f.directory, 'too-large.mp4') }), { code: 'native-media-limit-exceeded' });
  await noStaging(f.directory);
});
test('invalid sizes, unbounded boards, protocols, output types, and source overwrites fail before invoking helper', async t => {
  const f = await fixture(t);
  for (const input of [{ ...f.input, width: 0 }, { ...f.input, width: 4097 }, { ...f.input, outputPath: f.sourcePath },
    { ...f.input, sourcePath: 'https://host/clip.mp4' }, { ...f.input, sourcePath: path.join(f.directory, 'source.svg') },
    { ...f.input, outputPath: path.join(f.directory, 'out.jpg') }, { ...f.input, seconds: NaN }, { ...f.input, seconds: -1 }]) {
    await assert.rejects(f.renderer.renderThumbnail(input));
  }
  await assert.rejects(f.renderer.renderStoryboard({ ...f.input, clips: Array(25).fill({ sourcePath: f.sourcePath }) }), { code: 'native-media-input-invalid' });
  assert.equal(f.calls.length, 0);
});
test('source symlinks and symlink output directories are rejected', async t => {
  const f = await fixture(t); const sourceLink = path.join(f.directory, 'link.png'); await fs.symlink(f.sourcePath, sourceLink);
  await assert.rejects(f.renderer.renderThumbnail({ ...f.input, sourcePath: sourceLink }), { code: 'native-media-source-unavailable' });
  const dirLink = path.join(f.directory, 'dir'); await fs.symlink(f.directory, dirLink);
  await assert.rejects(f.renderer.renderThumbnail({ ...f.input, outputPath: path.join(dirLink, 'out.png') }), { code: 'native-media-source-unavailable' });
});
test('source changes during native work prevent publication and remove staging', async t => {
  let sourcePath;
  const f = await fixture(t, async request => {
    await fs.appendFile(sourcePath, 'changed'); await fs.writeFile(request.outputPath, PNG);
    return { kind: 'thumbnail', mimeType: 'image/png', width: 1, height: 1, canonical: false };
  }); sourcePath = f.sourcePath;
  await assert.rejects(f.renderer.renderThumbnail(f.input), { code: 'native-media-source-changed' });
  await assert.rejects(fs.stat(f.input.outputPath), { code: 'ENOENT' }); await noStaging(f.directory);
});
test('pre-cancelled work does not spawn a native process or publish artifacts', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.renderer.renderThumbnail(f.input, { signal: controller.signal }), { code: 'media-job-cancelled' });
  assert.equal(f.calls.length, 0); await noStaging(f.directory);
});
test('cancellation kills native work, waits for exit, and removes partial output', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async request => { await fs.writeFile(request.outputPath, PNG); started(); });
  const controller = new AbortController(); const pending = f.renderer.renderThumbnail(f.input, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending, { code: 'media-job-cancelled' });
  assert.equal(f.children[0].killedWith, 'SIGTERM'); await noStaging(f.directory);
  await assert.rejects(fs.stat(f.input.outputPath), { code: 'ENOENT' });
});
test('malformed output and overlarge output are rejected without publication', async t => {
  for (const [bytes, expected] of [[Buffer.from('bad image'), 'native-media-output-invalid'], [Buffer.alloc(4 * 1024 * 1024 + 1), 'native-media-limit-exceeded']]) {
    const f = await fixture(t, async request => {
      await fs.writeFile(request.outputPath, bytes);
      return { kind: 'thumbnail', mimeType: 'image/png', width: 1, height: 1, canonical: false };
    });
    await assert.rejects(f.renderer.renderThumbnail(f.input), { code: expected }); await noStaging(f.directory);
  }
});
test('helper errors and oversized stdout do not expose paths or arbitrary diagnostic text', async t => {
  const f = await fixture(t, async () => ({ error: 'private /Users/person/secret.png' }));
  await assert.rejects(f.renderer.renderThumbnail(f.input), error => error.code === 'native-media-unavailable' && !error.message.includes('/Users/'));
  const large = await fixture(t, async (request, child) => { child.stdout.emit('data', Buffer.alloc(65537)); });
  await assert.rejects(large.renderer.renderThumbnail(large.input), { code: 'native-media-output-invalid' }); await noStaging(large.directory);
});
test('native work timeout terminates the child and cleans its private staging directory', async t => {
  const f = await fixture(t, async () => undefined);
  const renderer = createNativeMediaRenderer({ helperPath: f.helperPath, spawn: f.spawn, platform: 'darwin', timeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(renderer.renderThumbnail(f.input), { code: 'native-media-timeout' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(f.children[0].killedWith, 'SIGTERM'); await noStaging(f.directory);
});
test('helper metadata cannot mislabel operation or disagree with PNG dimensions', async t => {
  for (const metadata of [{ kind: 'image-proxy', width: 1, height: 1 }, { kind: 'thumbnail', width: 2, height: 1 }]) {
    const f = await fixture(t, async request => {
      await fs.writeFile(request.outputPath, PNG);
      return { ...metadata, mimeType: 'image/png', canonical: false };
    });
    await assert.rejects(f.renderer.renderThumbnail(f.input), { code: 'native-media-output-invalid' }); await noStaging(f.directory);
  }
});
test('native staging has a bounded private ownership marker and preserves unfamiliar entries', async t => {
  let stagedDirectory;
  const f = await fixture(t, async request => {
    stagedDirectory = path.dirname(request.outputPath);
    const markerPath = path.join(stagedDirectory, 'owner.json');
    assert.equal((await fs.stat(markerPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(markerPath, 'utf8')), {
      version: 1, owner: 'frameline-native-media', token: path.basename(stagedDirectory).slice('.native-media-'.length)
    });
    await fs.writeFile(request.outputPath, PNG);
    await fs.writeFile(path.join(stagedDirectory, 'unfamiliar.txt'), 'preserve me');
    return { kind: 'thumbnail', mimeType: 'image/png', width: 1, height: 1, canonical: false };
  });
  assert.equal((await f.renderer.renderThumbnail(f.input)).sha256, digest(PNG));
  assert.equal(await fs.readFile(path.join(stagedDirectory, 'unfamiliar.txt'), 'utf8'), 'preserve me');
});
