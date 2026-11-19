const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fingerprintFile } = require('./local-media-readiness');
const { regularIdentity, sameIdentity } = require('./media-render-input');
const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[a-f0-9-]{36}$/;

async function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw fail('invalid-cache-directory');
  let current = path.parse(directory).root;
  for (const segment of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unsafe-cache-directory');
  }
  await fs.chmod(directory, 0o700);
}
function createMediaArtifactStore({ directory }) {
  const root = path.join(directory, 'artifacts'); const staging = path.join(root, 'staging');
  async function ownedFiles(dir, token, native = false) {
    const stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const markerPath = path.join(dir, 'owner.json'); const identity = await regularIdentity(markerPath);
    if (identity.size > 512) return null;
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (marker.version !== 1 || marker.token !== token || marker.owner !== (native ? 'frameline-native-media' : 'frameline-media-artifact')) return null;
    const files = []; const dirs = [];
    for (const name of await fs.readdir(dir)) {
      if ((native ? ['owner.json', 'render.png', 'render.mp4'] : ['owner.json', 'output.png', 'output.mp4']).includes(name)) {
        const filename = path.join(dir, name); files.push({ filename, identity: await regularIdentity(filename) });
      } else if (!native && /^\.native-media-[a-f0-9-]{36}$/.test(name)) {
        const nested = await ownedFiles(path.join(dir, name), name.slice('.native-media-'.length), true);
        if (!nested) return null; files.push(...nested.files); dirs.push(...nested.dirs);
      } else return null;
    }
    dirs.push({ filename: dir, dev: stat.dev, ino: stat.ino }); return { files, dirs };
  }
  async function cleanOwned(dir, token) {
    const owned = await ownedFiles(dir, token); if (!owned) return;
    // Individual unlinks and empty-directory removals cannot recursively erase
    // an unexpected file added after the ownership check.
    for (const file of owned.files.sort((a, b) => Number(path.basename(a.filename) === 'owner.json') - Number(path.basename(b.filename) === 'owner.json'))) {
      if (!sameIdentity(file.identity, await regularIdentity(file.filename))) return;
      await fs.unlink(file.filename);
      // Native publication can briefly leave two owned hardlinks to the same
      // payload. Our unlink changes ctime on its remaining owned alias.
      for (const remaining of owned.files) if (remaining.filename !== file.filename && remaining.identity.dev === file.identity.dev && remaining.identity.ino === file.identity.ino) {
        try { remaining.identity = await regularIdentity(remaining.filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    for (const item of owned.dirs) {
      const stat = await fs.lstat(item.filename);
      if (stat.dev !== item.dev || stat.ino !== item.ino || stat.isSymbolicLink()) return;
      await fs.rmdir(item.filename);
    }
  }
  async function initialize() {
    await privateDirectory(root); await privateDirectory(staging);
    // Only our exact marker, directory name and fixed filenames establish
    // ownership. Unknown or modified staging entries are left untouched.
    for (const entry of await fs.readdir(staging, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try { await cleanOwned(path.join(staging, entry.name), entry.name); } catch { /* Preserve ambiguous data. */ }
    }
  }
  const bucketName = projectId => require('node:crypto').createHash('sha256').update(projectId).digest('hex');
  async function stage(kind, projectId) {
    const token = randomUUID(); const dir = path.join(staging, token);
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ version: 1, owner: 'frameline-media-artifact', token, projectBucket: bucketName(projectId) }), { flag: 'wx', mode: 0o600 });
    return { token, directory: dir, projectBucket: bucketName(projectId), outputPath: path.join(dir, kind === 'proxy' ? 'output.mp4' : 'output.png') };
  }
  async function discard(stage) {
    if (!stage || !UUID.test(stage.token) || stage.directory !== path.join(staging, stage.token)) return;
    // A provider only receives the output filename. Never recursively remove
    // entries it unexpectedly adds, or a directory replaced by a symlink.
    try { await cleanOwned(stage.directory, stage.token); } catch { /* Unknown/changed staging is preserved. */ }
  }
  async function publish(stage, metadata, guard) {
    if (!metadata || metadata.canonical !== false || !['image/png', 'video/mp4'].includes(metadata.mimeType)
      || !Number.isInteger(metadata.width) || metadata.width < 1 || metadata.width > 4096
      || !Number.isInteger(metadata.height) || metadata.height < 1 || metadata.height > 4096
      || !/^[a-f0-9]{64}$/.test(metadata.sha256 || '')) throw fail('invalid-render-output');
    const extension = metadata.mimeType === 'image/png' ? 'png' : 'mp4';
    if (!stage.outputPath.endsWith(`.${extension}`)) throw fail('invalid-render-output');
    let before = await regularIdentity(stage.outputPath);
    const limit = extension === 'png' ? 4 * 1024 * 1024 : 50 * 1024 * 1024;
    if (!before.size || before.size > limit || before.size !== metadata.byteLength) throw fail('invalid-render-output');
    const handle = await fs.open(stage.outputPath, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
    const magic = Buffer.alloc(12);
    try {
      const opened = await handle.stat();
      if (opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw fail('invalid-render-output');
      await handle.read(magic, 0, 12, 0);
      await handle.chmod(0o600);
      const permissioned = await regularIdentity(stage.outputPath);
      if (permissioned.dev !== before.dev || permissioned.ino !== before.ino) throw fail('render-output-changed');
      before = permissioned;
    } finally { await handle.close(); }
    if ((extension === 'png' && !magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (extension === 'mp4' && magic.toString('ascii', 4, 8) !== 'ftyp')) throw fail('invalid-render-output');
    const actual = await fingerprintFile(stage.outputPath);
    if (actual.sha256 !== metadata.sha256 || !sameIdentity(before, await regularIdentity(stage.outputPath))) throw fail('render-output-changed');
    await guard();
    const id = randomUUID(); const filename = `${id}.${extension}`;
    const bucket = path.join(root, stage.projectBucket); await privateDirectory(bucket);
    const rootDirectory = await fs.open(root, 'r'); try { await rootDirectory.sync(); } finally { await rootDirectory.close(); }
    const destination = path.join(bucket, filename);
    await fs.link(stage.outputPath, destination); // Exclusive publication, never overwrite.
    try {
      const published = await fingerprintFile(destination);
      if (published.sha256 !== metadata.sha256 || published.size !== metadata.byteLength) throw fail('render-output-changed');
      await guard();
      const output = await fs.open(destination, 'r'); try { await output.sync(); } finally { await output.close(); }
      const dir = await fs.open(bucket, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      return { id, filename, projectBucket: stage.projectBucket, mimeType: metadata.mimeType, width: metadata.width, height: metadata.height,
        byteLength: actual.size, sha256: actual.sha256, canonical: false,
        ...(Number.isFinite(metadata.durationSeconds) ? { durationSeconds: metadata.durationSeconds } : {}) };
    } catch (error) { await fs.unlink(destination).catch(() => {}); throw error; }
  }
  async function get(artifact) {
    if (!artifact || !UUID.test(artifact.id) || !/^[a-f0-9]{64}$/.test(artifact.projectBucket || '') || !['png', 'mp4'].some(ext => artifact.filename === `${artifact.id}.${ext}`)) throw fail('artifact-unavailable');
    const filename = path.join(root, artifact.projectBucket, artifact.filename);
    const actual = await fingerprintFile(filename);
    if (actual.size !== artifact.byteLength || actual.sha256 !== artifact.sha256) throw fail('artifact-changed');
    return { path: filename, mimeType: artifact.mimeType, byteLength: actual.size, sha256: actual.sha256, canonical: false };
  }
  async function measure(projectId) {
    const bucket = path.join(root, bucketName(projectId)); let bytes = 0;
    const seen = new Set();
    async function count(filename) {
      const identity = await regularIdentity(filename); const key = `${identity.dev}:${identity.ino}`;
      if (seen.has(key)) return 0; seen.add(key); return identity.size;
    }
    try {
      const stat = await fs.lstat(bucket); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unsafe-cache-directory');
      for (const entry of await fs.readdir(bucket, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9-]{36}\.(png|mp4)$/.test(entry.name)) continue;
        bytes += await count(path.join(bucket, entry.name));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    async function payloadBytes(dir, depth = 0) {
      let sum = 0;
      if (depth > 3) return sum;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const filename = path.join(dir, entry.name);
        if (entry.isFile() && entry.name !== 'owner.json') sum += await count(filename);
        else if (entry.isDirectory()) sum += await payloadBytes(filename, depth + 1);
      }
      return sum;
    }
    for (const entry of await fs.readdir(staging, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const dir = path.join(staging, entry.name); const markerPath = path.join(dir, 'owner.json');
        if ((await regularIdentity(markerPath)).size > 512) continue;
        const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        if (marker.owner === 'frameline-media-artifact' && marker.version === 1 && marker.token === entry.name && marker.projectBucket === bucketName(projectId)) bytes += await payloadBytes(dir);
      } catch { /* Changed staging is revisited by the next measurement. */ }
    }
    return bytes;
  }
  return { initialize, stage, discard, publish, get, measure };
}
module.exports = { createMediaArtifactStore, privateDirectory };
