const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { inspectAvailability, fingerprintFile } = require('./local-media-readiness');

const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
function fail(code) { const error = new Error(code); error.code = code; return error; }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function name(value) {
  // Export names are untrusted, and occasionally contain full paths or URLs.
  const result = String(value || '').split(/[?#]/)[0].replaceAll('\\', '/').split('/').pop().replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return result && !result.includes(':') ? result.slice(0, 240) : 'Untitled media';
}
async function readExport(filename) {
  let handle;
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw fail('invalid-export-path');
    let current = path.parse(filename).root;
    for (const part of path.resolve(filename).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if ((await fsp.lstat(current)).isSymbolicLink()) throw fail('symlink-export-unsupported');
    }
    handle = await fsp.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) throw fail('export-not-regular-file');
    if (before.size > MAX_EXPORT_BYTES) throw fail('export-too-large');
    const chunks = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_EXPORT_BYTES) throw fail('export-too-large');
      chunks.push(chunk);
    }
    const after = await handle.stat();
    if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw fail('stale-export');
    return Buffer.concat(chunks);
  } catch (error) {
    throw fail(['invalid-export-path', 'symlink-export-unsupported', 'export-not-regular-file',
      'export-too-large', 'stale-export'].includes(error.code) ? error.code : 'export-unreadable');
  } finally { if (handle) await handle.close(); }
}
function dependencies(bytes) {
  const xml = bytes.toString('utf8');
  // External/internal entity declarations are unnecessary for these exports.
  const withoutBareDoctype = xml.replace(/<!DOCTYPE\s+fcpxml\s*>/g, '');
  if (/<!ENTITY\b|<!DOCTYPE\b/i.test(withoutBareDoctype) || XMLValidator.validate(xml) !== true) throw fail('malformed-xml');
  let root;
  try { root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false }).parse(xml).fcpxml; }
  catch { throw fail('malformed-xml'); }
  if (!root || typeof root !== 'object' || !root.resources || !root.library) throw fail('unsupported-structure');
  if (String(root['@_version']) !== '1.10') throw fail('unsupported-fcpxml-version');
  const resources = new Map();
  for (const [kind, nodes] of Object.entries(root.resources)) {
    for (const node of array(nodes)) {
      if (!node || typeof node !== 'object' || !node['@_id']) continue;
      if (resources.has(node['@_id'])) throw fail('duplicate-resource-id');
      resources.set(node['@_id'], { kind, node });
    }
  }
  const referenced = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '@_ref' && resources.has(value) && !referenced.has(value)) {
        referenced.add(value); visit(resources.get(value).node);
      } else if (!key.startsWith('@_')) for (const child of array(value)) visit(child);
    }
  }
  visit(root.library);
  const results = new Map(); let unknown = 0;
  for (const id of referenced) {
    const { kind, node } = resources.get(id);
    if (kind !== 'asset') continue;
    const originals = array(node['media-rep']).filter(rep => rep?.['@_kind'] === 'original-media');
    // FCPXML assets can also carry the original URL directly in src.
    const urls = originals.length ? originals.map(rep => rep['@_src']) : [node['@_src']];
    for (const url of urls) {
      const key = typeof url === 'string' && url ? url : `unknown:${++unknown}`;
      if (!results.has(key)) results.set(key, { url, displayNames: [] });
      const names = results.get(key).displayNames; const display = name(node['@_name']);
      if (!names.includes(display)) names.push(display);
    }
  }
  return [...results.values()];
}
function localReference(value) {
  if (typeof value !== 'string' || !value) return { status: 'unknown', reason: 'no-original-reference' };
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return { status: 'external', reason: 'non-file-url' };
    if (url.hostname && url.hostname !== 'localhost') return { status: 'external', reason: 'remote-file-host' };
    if (url.search || url.hash || url.username || url.password) throw fail('invalid-reference');
    const filename = fileURLToPath(url);
    if (filename.includes('\0') || !path.isAbsolute(filename)) throw fail('invalid-reference');
    return { filename };
  } catch { return { status: 'unknown', reason: 'invalid-original-reference' }; }
}

// Read-only inventory of referenced originals. Availability and a newly observed
// fingerprint are evidence about this machine, not proof of expected identity.
// No source location or media URL is returned or persisted.
async function auditFcpxmlMedia(options = {}) {
  if (typeof options === 'string') options = { exportPath: options };
  const { exportPath, bytes, expectedSourceHash, evidenceById = {}, signal, onProgress = () => {} } = options;
  if (typeof onProgress !== 'function') throw fail('invalid-progress-handler');
  const checkCancelled = () => { if (signal?.aborted) throw fail('media-job-cancelled'); };
  checkCancelled();
  if (!evidenceById || typeof evidenceById !== 'object' || Array.isArray(evidenceById)) throw fail('invalid-evidence');
  const observed = await readExport(exportPath);
  const sourceHash = hash(observed);
  if ((bytes !== undefined && (!Buffer.isBuffer(bytes) && typeof bytes !== 'string' && !(bytes instanceof Uint8Array)))
    || (bytes !== undefined && hash(Buffer.from(bytes)) !== sourceHash)
    || (expectedSourceHash !== undefined && expectedSourceHash !== sourceHash)) throw fail('stale-export');
  const references = dependencies(observed);
  const assets = [];
  await onProgress({ phase: 'checking', checked: 0, total: references.length, bytesRead: 0, totalBytes: null });
  for (const reference of references) {
    checkCancelled();
    const id = `media-${assets.length + 1}`;
    const evidence = evidenceById[id] || {};
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw fail('invalid-evidence');
    const local = localReference(reference.url);
    const hasExplicitEvidence = ['excluded', 'volumeOffline', 'proxyOnly'].some(key => evidence[key] === true);
    let availability = hasExplicitEvidence ? await inspectAvailability({ evidence })
      : local.status ? { state: local.status, reason: local.reason }
        : await inspectAvailability({ path: local.filename, evidence });
    let fingerprint = null;
    if (availability.state === 'local') {
      try { fingerprint = await fingerprintFile(local.filename, { signal, onProgress: progress => onProgress({
        phase: 'hashing', checked: assets.length, total: references.length, ...progress }) }); }
      catch (error) {
        if (error.code === 'fingerprint-cancelled') throw fail('media-job-cancelled');
        if (error.code === 'fingerprint-progress-failed') throw fail('media-job-progress-failed');
        availability = { state: 'unknown', reason: error.code === 'file-changed' ? 'file-changed' : 'fingerprint-unavailable' };
      }
    }
    assets.push({ id, displayNames: reference.displayNames,
      status: availability.state, reason: availability.reason,
      fingerprintAvailable: !!fingerprint, fingerprint });
    await onProgress({ phase: 'checking', checked: assets.length, total: references.length, bytesRead: 0, totalBytes: null });
  }
  checkCancelled();
  // Bind the result to the bytes still at the selected location after media IO.
  if (hash(await readExport(exportPath)) !== sourceHash) throw fail('stale-export');
  checkCancelled();
  const counts = { total: assets.length, local: 0, missing: 0, 'offline-volume': 0,
    'proxy-only': 0, excluded: 0, external: 0, unknown: 0, fingerprinted: 0 };
  for (const asset of assets) { counts[asset.status] += 1; if (asset.fingerprintAvailable) counts.fingerprinted++; }
  return { schemaVersion: 1, readOnly: true, sourceFormat: 'fcpxml', sourceVersion: '1.10', sourceHash,
    counts, assets };
}
module.exports = { auditFcpxmlMedia };
