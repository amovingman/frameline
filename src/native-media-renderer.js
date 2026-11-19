'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const IMAGES = new Set(['.png', '.jpg', '.jpeg']), VIDEOS = new Set(['.mov', '.mp4', '.m4v']);
const MAX_IMAGE = 4 * 1024 * 1024, MAX_PROXY = 50 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value > 0 && value <= 4096;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
async function plain(filename, regular = true) {
  try {
    if (typeof filename !== 'string' || filename.length > 8192 || !path.isAbsolute(filename) || /[\x00-\x1f\x7f]/.test(filename)
      || await fs.realpath(filename) !== path.resolve(filename)) throw fail('native-media-source-unavailable');
    const stat = await fs.lstat(filename, { bigint: true });
    if (stat.isSymbolicLink() || (regular ? !stat.isFile() : !stat.isDirectory())) throw fail('native-media-source-unavailable');
    return stat;
  } catch { throw fail('native-media-source-unavailable'); }
}
function sample(input) {
  if (!input || typeof input !== 'object' || typeof input.sourcePath !== 'string'
    || !IMAGES.has(path.extname(input.sourcePath).toLowerCase()) && !VIDEOS.has(path.extname(input.sourcePath).toLowerCase())) throw fail('native-media-input-invalid');
  const output = { sourcePath: input.sourcePath };
  if (input.frame !== undefined) {
    if (!Number.isSafeInteger(input.frame) || input.frame < 0) throw fail('native-media-input-invalid');
    const rate = input.frameRate;
    if (typeof rate === 'number') {
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) throw fail('native-media-input-invalid');
      output.frameRate = rate;
    } else {
      if (!rate || typeof rate !== 'object' || !Number.isFinite(rate.numerator) || !Number.isFinite(rate.denominator)
        || rate.numerator <= 0 || rate.denominator <= 0 || rate.numerator > 1000000 || rate.denominator > 1000000) throw fail('native-media-input-invalid');
      output.frameRate = { numerator: rate.numerator, denominator: rate.denominator };
    }
    output.frame = input.frame;
  } else {
    if (input.seconds !== undefined && (!Number.isFinite(input.seconds) || input.seconds < 0 || input.seconds > 86400)) throw fail('native-media-input-invalid');
    output.seconds = input.seconds ?? 0;
  }
  if (input.label !== undefined) {
    if (typeof input.label !== 'string' || input.label.length > 160 || /[\x00-\x1f\x7f]/.test(input.label)) throw fail('native-media-input-invalid');
    output.label = input.label;
  }
  return output;
}
function createNativeMediaRenderer({ helperPath = path.join(__dirname, 'native/bin/media-renderer'), spawn = defaultSpawn,
  platform = process.platform, timeoutMs = 125000, maxProxyBytes = MAX_PROXY } = {}) {
  if (!path.isAbsolute(helperPath || '') || typeof spawn !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000
    || !Number.isSafeInteger(maxProxyBytes) || maxProxyBytes < 1 || maxProxyBytes > MAX_PROXY) throw fail('native-media-input-invalid');
  async function isAvailable() {
    if (platform !== 'darwin') return false;
    try { const stat = await plain(helperPath); return (stat.mode & 0o111n) !== 0n; } catch { return false; }
  }
  async function invoke(request, { signal, progress = async () => {} } = {}, deadline = timeoutMs) {
    if (signal?.aborted) throw fail('media-job-cancelled');
    if (!await isAvailable()) throw fail('native-media-provider-unavailable');
    const bytes = Buffer.from(JSON.stringify(request));
    if (bytes.length > 256 * 1024) throw fail('native-media-input-invalid');
    await progress(5);
    return new Promise((resolve, reject) => {
      let child, output = Buffer.alloc(0), overflow = false, aborted = false, timedOut = false, settled = false, killTimer;
      const stop = () => { if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
        child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 500); killTimer.unref?.(); };
      const cancel = () => { aborted = true; stop(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, deadline); timer.unref?.();
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(value);
      };
      try { child = spawn(helperPath, [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
      catch { finish(fail('native-media-provider-unavailable')); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout.on('data', chunk => { if (output.length + chunk.length > 65536) { overflow = true; stop(); } else output = Buffer.concat([output, chunk]); });
      child.on('error', () => finish(fail('native-media-provider-unavailable')));
      child.on('close', code => {
        if (aborted || signal?.aborted) return finish(fail('media-job-cancelled'));
        if (overflow) return finish(fail('native-media-output-invalid'));
        if (timedOut) return finish(fail('native-media-timeout'));
        let value;
        try { value = JSON.parse(output.toString('utf8')); } catch { return finish(fail('native-media-output-invalid')); }
        if (code !== 0 || value?.error) return finish(fail(['native-media-input-invalid', 'native-media-limit-exceeded', 'native-media-output-invalid', 'native-media-unavailable'].includes(value?.error) ? value.error : 'native-media-unavailable'));
        if (request.operation === 'ping') {
          if (value?.provider !== 'apple-native' || value.version !== 1 || value.canonical !== false) return finish(fail('native-media-output-invalid'));
          return finish(null, value);
        }
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.canonical !== false
          || typeof value.kind !== 'string' || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
          || value.width < 1 || value.height < 1 || value.width > 32768 || value.height > 32768) return finish(fail('native-media-output-invalid'));
        finish(null, value);
      });
      child.stdin.on('error', () => {}); child.stdin.end(bytes);
    });
  }
  async function getAvailability() {
    try {
      await invoke({ operation: 'ping' }, {}, Math.min(timeoutMs, 5000));
      return { available: true, provider: 'apple-native', version: 1, capabilities: ['inspect', 'thumbnail', 'proxy', 'storyboard'] };
    } catch { return { available: false, provider: 'apple-native', version: 1, capabilities: [] }; }
  }
  async function inspect(input, controls = {}) {
    const request = sample(input), before = await plain(request.sourcePath);
    const result = await invoke({ operation: 'inspect', sourcePath: request.sourcePath }, controls);
    if (identity(before) !== identity(await plain(request.sourcePath))) throw fail('native-media-source-changed');
    if (!['image', 'video'].includes(result.kind)
      || result.kind === 'video' && (!Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0)
      || result.frameRate !== null && (!Number.isFinite(result.frameRate) || result.frameRate <= 0 || result.frameRate > 1000)) throw fail('native-media-output-invalid');
    return { kind: result.kind, width: result.width, height: result.height,
      durationSeconds: result.kind === 'video' ? result.durationSeconds : null, frameRate: result.frameRate, canonical: false };
  }
  async function render(operation, input, controls = {}) {
    if (!input || typeof input !== 'object' || !path.isAbsolute(input.outputPath || '')
      || /[\x00-\x1f\x7f]/.test(input.outputPath)) throw fail('native-media-input-invalid');
    const width = input.width ?? (operation === 'storyboard' ? 1280 : 640), height = input.height ?? (operation === 'storyboard' ? 720 : 360);
    if (!integer(width) || !integer(height) || width * height > 4096 * 2160) throw fail('native-media-input-invalid');
    const samples = operation === 'storyboard' ? input.clips : [input];
    if (!Array.isArray(samples) || samples.length < 1 || samples.length > 24) throw fail('native-media-input-invalid');
    const sources = samples.map(sample), stats = await Promise.all(sources.map(value => plain(value.sourcePath)));
    if (sources.some(value => path.resolve(value.sourcePath) === path.resolve(input.outputPath))) throw fail('native-media-input-invalid');
    const videoProxy = operation === 'proxy' && VIDEOS.has(path.extname(sources[0].sourcePath).toLowerCase());
    if (path.extname(input.outputPath).toLowerCase() !== (videoProxy ? '.mp4' : '.png')) throw fail('native-media-input-invalid');
    const directory = path.dirname(input.outputPath), parent = await plain(directory, false);
    try { await fs.lstat(input.outputPath); throw fail('native-media-output-exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const token = randomUUID(), staging = path.join(directory, `.native-media-${token}`); await fs.mkdir(staging, { mode: 0o700 });
    const stagingIdentity = await plain(staging, false);
    const markerPath = path.join(staging, 'owner.json');
    const marker = await fs.open(markerPath, 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ version: 1, owner: 'frameline-native-media', token })); await marker.sync(); }
    finally { await marker.close(); }
    const staged = path.join(staging, videoProxy ? 'render.mp4' : 'render.png');
    let published = false, stagedIdentity;
    try {
      const result = await invoke({ operation, outputPath: staged, width, height,
        ...(operation === 'storyboard' ? { clips: sources } : sources[0]) }, controls);
      if (controls.signal?.aborted) throw fail('media-job-cancelled');
      for (let index = 0; index < sources.length; index++) if (identity(stats[index]) !== identity(await plain(sources[index].sourcePath))) throw fail('native-media-source-changed');
      const namedParent = await plain(directory, false);
      if (namedParent.dev !== parent.dev || namedParent.ino !== parent.ino) throw fail('native-media-output-invalid');
      const expectedKind = operation === 'proxy' ? videoProxy ? 'video-proxy' : 'image-proxy' : operation;
      if (result.kind !== expectedKind || !integer(result.width) || !integer(result.height)
        || !videoProxy && (result.width !== width || result.height !== height)
        || videoProxy && (result.width > 640 || result.height > 640 || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > 300.2)) throw fail('native-media-output-invalid');
      const stat = await plain(staged), maximum = videoProxy ? maxProxyBytes : MAX_IMAGE;
      stagedIdentity = stat;
      if (stat.size < 1n || stat.size > BigInt(maximum)) throw fail('native-media-limit-exceeded');
      const bytes = await fs.readFile(staged);
      if (BigInt(bytes.length) !== stat.size || identity(stat) !== identity(await plain(staged))) throw fail('native-media-output-invalid');
      if (videoProxy ? result.mimeType !== 'video/mp4' || bytes.subarray(4, 8).toString() !== 'ftyp'
        : result.mimeType !== 'image/png' || bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw fail('native-media-output-invalid');
      await fs.chmod(staged, 0o600); const file = await fs.open(staged, 'r'); try { await file.sync(); } finally { await file.close(); }
      if (controls.signal?.aborted) throw fail('media-job-cancelled');
      try { await fs.link(staged, input.outputPath); published = true; }
      catch (error) { throw fail(error.code === 'EEXIST' ? 'native-media-output-exists' : 'native-media-output-invalid'); }
      const folder = await fs.open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); }
      // Publication has completed; telemetry must not turn a durable successful result into a failure.
      try { await controls.progress?.(100); } catch {}
      return { kind: result.kind, mimeType: result.mimeType, width: result.width, height: result.height,
        ...(Number.isFinite(result.durationSeconds) ? { durationSeconds: result.durationSeconds } : {}),
        byteLength: bytes.length, sha256: hash(bytes), canonical: false };
    } catch (error) {
      if (published) {
        try { const named = await plain(input.outputPath); if (named.dev === stagedIdentity.dev && named.ino === stagedIdentity.ino) await fs.unlink(input.outputPath); } catch {}
      }
      throw error?.code && /^(native-media-|media-job-)/.test(error.code) ? error : fail('native-media-output-invalid');
    } finally {
      // Only remove our own staging directory and expected output, never recurse into a replacement.
      try {
        const named = await plain(staging, false);
        if (named.dev === stagingIdentity.dev && named.ino === stagingIdentity.ino) {
          const names = await fs.readdir(staging);
          const markerStat = await plain(markerPath);
          if (markerStat.size > 512n) throw fail('native-media-output-invalid');
          const owned = JSON.parse(await fs.readFile(markerPath, 'utf8'));
          if (names.every(name => ['owner.json', path.basename(staged)].includes(name)) && owned.version === 1
            && Object.keys(owned).sort().join(',') === 'owner,token,version' && owned.owner === 'frameline-native-media' && owned.token === token) {
            await fs.unlink(staged).catch(() => {}); await fs.unlink(markerPath); await fs.rmdir(staging).catch(() => {});
          }
        }
      } catch {}
    }
  }
  return { isAvailable, getAvailability, inspect, renderThumbnail: (input, controls) => render('thumbnail', input, controls),
    renderProxy: (input, controls) => render('proxy', input, controls), renderStoryboard: (input, controls) => render('storyboard', input, controls) };
}
module.exports = { createNativeMediaRenderer };
