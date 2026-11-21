// Private worker: source paths and parsed source references never leave here.
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { MAX_XML_BYTES, ScanError, fileErrorCode, buildInventory } = require('./fcpxml-scan-core');
const { validateScanManifest } = require('./scan-manifest');
const cache = new Map(); let cacheBytes = 0; const acks = new Map();
const allowedErrors = new Set(['unsupported-format', 'file-access-denied', 'file-busy', 'file-unavailable', 'file-too-large',
  'revision-source-changed', 'malformed-xml', 'unsupported-structure', 'unsupported-fcpxml-version', 'unsupported-timing', 'ambiguous-resource-id', 'ambiguous-original-media', 'invalid-manifest']);
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every(key => a[key] === b[key]);
async function checkMedia(source) {
  if (!source) return 'unknown';
  let url; try { url = new URL(source); } catch { return 'unknown'; }
  if (url.protocol !== 'file:') return 'external';
  let filename; try { filename = fileURLToPath(url); } catch { return 'unknown'; }
  try { return (await fs.stat(filename)).isFile() ? 'local' : 'missing'; }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable'; }
}
async function sourcePath(selectedPath, verify) {
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath) || selectedPath.includes('\0')) throw new ScanError('file-unavailable');
  const extension = path.extname(selectedPath).toLowerCase();
  if (!verify && !['.fcpxml', '.fcpxmld'].includes(extension)) throw new ScanError('unsupported-format');
  let bundle = null;
  if (extension === '.fcpxmld') {
    bundle = await fs.lstat(selectedPath);
    if (!bundle.isDirectory() || bundle.isSymbolicLink()) throw new ScanError('file-unavailable');
  }
  const filename = bundle ? path.join(selectedPath, 'Info.fcpxml') : selectedPath;
  return { filename, bundle, selectedPath };
}
async function readSource(input, progress, verify) {
  let handle;
  try {
    const source = await sourcePath(input.selectedPath, verify);
    const before = await fs.lstat(source.filename);
    if (!before.isFile() || before.isSymbolicLink()) throw new ScanError(verify ? 'revision-source-changed' : 'file-unavailable');
    if (!Number.isSafeInteger(before.size) || before.size > MAX_XML_BYTES) throw new ScanError(verify ? 'revision-source-changed' : 'file-too-large');
    handle = await fs.open(source.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!same(before, await handle.stat())) throw new ScanError('revision-source-changed');
    const hash = createHash('sha256'); const chunks = []; let bytesRead = 0;
    await progress({ phase: 'reading', bytesRead: 0, totalBytes: before.size });
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      bytesRead += chunk.length;
      if (bytesRead > MAX_XML_BYTES || bytesRead > before.size) throw new ScanError('revision-source-changed');
      hash.update(chunk); if (!verify) chunks.push(chunk);
      await progress({ phase: 'reading', bytesRead, totalBytes: before.size });
    }
    if (bytesRead !== before.size || !same(before, await handle.stat()) || !same(before, await fs.lstat(source.filename))) throw new ScanError('revision-source-changed');
    if (source.bundle) {
      const current = await fs.lstat(source.selectedPath);
      if (current.dev !== source.bundle.dev || current.ino !== source.bundle.ino || !current.isDirectory() || current.isSymbolicLink()) throw new ScanError('revision-source-changed');
    }
    return { ...source, identity: before, sourceHash: hash.digest('hex'), bytes: verify ? null : Buffer.concat(chunks, bytesRead) };
  } finally { if (handle) await handle.close(); }
}
async function verifyUnchanged(source) {
  const current = await fs.lstat(source.filename);
  if (!current.isFile() || current.isSymbolicLink() || !same(source.identity, current)) throw new ScanError('revision-source-changed');
  if (source.bundle) {
    const bundle = await fs.lstat(source.selectedPath);
    if (bundle.dev !== source.bundle.dev || bundle.ino !== source.bundle.ino || bundle.isSymbolicLink() || !bundle.isDirectory()) throw new ScanError('revision-source-changed');
  }
}
async function execute(input, progress) {
  const verify = input.operation === 'verify';
  const source = await readSource(input, progress, verify);
  if (verify) {
    if (source.sourceHash !== input.sourceHash) throw new ScanError('revision-source-changed');
    await progress({ phase: 'complete', bytesRead: source.identity.size, totalBytes: source.identity.size });
    await verifyUnchanged(source); return null;
  }
  let entry = cache.get(source.sourceHash); const cacheHit = !!entry;
  if (!entry) {
    await progress({ phase: 'parsing', bytesRead: source.identity.size, totalBytes: source.identity.size, cacheHit: false });
    const inventory = buildInventory(source.bytes.toString('utf8'), source.sourceHash);
    const size = Buffer.byteLength(JSON.stringify(inventory));
    entry = { inventory, size };
    if (size <= workerData.maxCacheBytes) {
      while (cache.size >= workerData.maxCacheEntries || cacheBytes + size > workerData.maxCacheBytes) {
        const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).size; cache.delete(oldest);
      }
      cache.set(source.sourceHash, entry); cacheBytes += size;
    }
  } else { cache.delete(source.sourceHash); cache.set(source.sourceHash, entry); }
  const { scan, referencedAssets } = structuredClone(entry.inventory);
  await progress({ phase: 'inventory', bytesRead: source.identity.size, totalBytes: source.identity.size,
    checked: 0, total: referencedAssets.length, cacheHit });
  scan.media = [];
  for (let start = 0; start < referencedAssets.length; start += 64) {
    await progress({ phase: 'media', bytesRead: source.identity.size, totalBytes: source.identity.size,
      checked: start, total: referencedAssets.length, cacheHit });
    scan.media.push(...await Promise.all(referencedAssets.slice(start, start + 64)
      .map(async ({ name, source }) => ({ name, availability: await checkMedia(source) }))));
  }
  validateScanManifest(scan);
  await progress({ phase: 'complete', bytesRead: source.identity.size, totalBytes: source.identity.size,
    checked: referencedAssets.length, total: referencedAssets.length, cacheHit });
  await verifyUnchanged(source); return scan;
}
parentPort.on('message', input => {
  if (input.type === 'ack') { const key = `${input.id}:${input.sequence}`; const ack = acks.get(key); if (ack) { acks.delete(key); ack(); } return; }
  if (input.type !== 'request') return;
  let sequence = 0;
  const progress = value => new Promise(resolve => {
    const current = sequence++; acks.set(`${input.id}:${current}`, resolve);
    parentPort.postMessage({ type: 'progress', id: input.id, sequence: current, value });
  });
  execute(input, progress).then(result => parentPort.postMessage({ type: 'result', id: input.id, result }))
    .catch(error => parentPort.postMessage({ type: 'error', id: input.id,
      code: allowedErrors.has(error.code) ? error.code : error instanceof ScanError ? 'scan-failed' : fileErrorCode(error) }));
});
