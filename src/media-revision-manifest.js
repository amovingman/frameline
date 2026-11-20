'use strict';
// Capture authority comes from exact export bytes and streamed original-file
// hashes. Reference numbers are scoped to that export, never editor object IDs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { validateScanManifest } = require('./scan-manifest');
const { scanFcpXml } = require('./fcpxml-adapter');
const { auditFcpxmlMedia } = require('./fcpxml-media-audit');
const { readVerifiedExport, regularIdentity } = require('./media-render-input');
const { fingerprintFile } = require('./local-media-readiness');
const { createMediaAssetIdentity } = require('./media-asset-identity');
const { fingerprint } = require('./project-api-contracts');
const fail = code => Object.assign(new Error(code), { code });
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const supported = new Set(['library', 'event', 'project', 'sequence', 'spine', 'gap', 'clip', 'asset-clip', 'video', 'audio',
  'asset', 'format', 'media-rep', 'adjust-conform', 'adjust-transform', 'adjust-crop', 'adjust-volume', 'adjust-blend']);
function check(signal) { if (signal?.aborted) throw fail('media-revision-cancelled'); }

function projectMediaBoundScanManifest(manifest) {
  validateScanManifest(manifest);
  const result = structuredClone(manifest); result.schemaVersion = 2; delete result.mediaDependencies;
  return validateScanManifest(result);
}
function createMediaBoundScanManifest(manifest, { coverage, assets } = {}) {
  const result = projectMediaBoundScanManifest(manifest);
  result.schemaVersion = 3; result.mediaDependencies = structuredClone({ version: 1, coverage, assets });
  return validateScanManifest(result);
}
function structural(manifest) {
  const result = projectMediaBoundScanManifest(manifest);
  result.media = result.media.map(({ name }) => ({ name }));
  return result;
}

// Mirror the audit's resource traversal and URL de-duplication exactly. Unlike
// a display scan, missing resource links or unrecognized content cannot establish
// complete dependency coverage. Unused resources are not required assets.
function references(bytes) {
  const xml = bytes.toString('utf8');
  if (/<!ENTITY\b|<!DOCTYPE\b/i.test(xml.replace(/<!DOCTYPE\s+fcpxml\s*>/g, '')) || XMLValidator.validate(xml) !== true) throw fail('media-revision-xml-invalid');
  const root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false }).parse(xml).fcpxml;
  if (!root || root['@_version'] !== '1.10' || !root.resources || !root.library) throw fail('media-revision-xml-invalid');
  let complete = true;
  const resources = new Map(), reached = new Set(), visiting = new Set();
  for (const [kind, nodes] of Object.entries(root.resources)) for (const node of array(nodes)) {
    const id = node?.['@_id'];
    if (!id || resources.has(id)) throw fail('media-revision-resource-invalid');
    resources.set(id, { kind, node });
  }
  const events = array(root.library.event), projects = events.flatMap(event => array(event.project));
  if (array(root.library).length !== 1 || events.length !== 1 || projects.length !== 1 || array(projects[0]?.sequence).length !== 1) complete = false;
  function visit(node, tag) {
    if (!supported.has(tag)) complete = false;
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '@_ref') {
        if (typeof value !== 'string' || !resources.has(value)) { complete = false; continue; }
        if (!['asset-clip', 'video', 'audio'].includes(tag) || resources.get(value).kind !== 'asset') complete = false;
        if (visiting.has(value)) { complete = false; continue; }
        if (!reached.has(value)) {
          reached.add(value); visiting.add(value);
          const resource = resources.get(value); visit(resource.node, resource.kind); visiting.delete(value);
        }
      } else if (key.startsWith('@_')) {
        if (['@_src', '@_href'].includes(key) && tag !== 'asset' && tag !== 'media-rep') complete = false;
      } else if (key !== '#text') for (const child of array(value)) visit(child, key);
    }
  }
  visit(root.library, 'library');
  const urls = new Map(); let unknown = 0;
  for (const id of reached) {
    const { kind, node } = resources.get(id); if (kind !== 'asset') continue;
    const reps = array(node['media-rep']), originals = reps.filter(rep => rep?.['@_kind'] === 'original-media');
    if (originals.length > 1 || !originals.length && reps.length) complete = false;
    if (originals.length && node['@_src'] && node['@_src'] !== originals[0]['@_src']) complete = false;
    const values = originals.length ? originals.map(rep => rep['@_src']) : [node['@_src']];
    for (const url of values) {
      const key = typeof url === 'string' && url ? url : `unknown:${++unknown}`;
      if (!urls.has(key)) urls.set(key, url);
    }
  }
  return { complete, urls: [...urls.values()] };
}
function localPath(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost' || url.username || url.password || url.search || url.hash) return null;
    const filename = fileURLToPath(url);
    return path.isAbsolute(filename) && !filename.includes('\0') ? filename : null;
  } catch { return null; }
}
async function regularExport(exportPath) {
  if (typeof exportPath !== 'string' || !path.isAbsolute(exportPath)) throw fail('media-revision-source-invalid');
  if (path.extname(exportPath).toLowerCase() !== '.fcpxmld') { await regularIdentity(exportPath); return exportPath; }
  const stat = await fs.lstat(exportPath); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('media-revision-source-invalid');
  const filename = path.join(exportPath, 'Info.fcpxml'); await regularIdentity(filename); return filename;
}

// Trusted-main/CLI result: only sources contains private locations. Never send
// this wrapper to a renderer, network service, or public diagnostic report.
async function captureMediaRevision({ exportPath, manifest, signal, onProgress = () => {} } = {}) {
  if (typeof onProgress !== 'function') throw fail('media-revision-input-invalid');
  check(signal);
  const filename = await regularExport(exportPath), scan = await scanFcpXml(exportPath, { signal });
  if (manifest && fingerprint(structural(manifest)) !== fingerprint(structural(scan))) throw fail('media-revision-manifest-mismatch');
  const source = await readVerifiedExport(filename, scan.sourceHash), inventory = references(source.bytes);
  const report = await auditFcpxmlMedia({ exportPath: filename, bytes: source.bytes, expectedSourceHash: scan.sourceHash, signal, onProgress });
  if (report.assets.length !== inventory.urls.length) throw fail('media-revision-inventory-mismatch');
  const assets = [], sources = [];
  let complete = inventory.complete;
  for (const [index, item] of report.assets.entries()) {
    check(signal);
    const sourcePath = localPath(inventory.urls[index]);
    if (!sourcePath || item.id !== `media-${index + 1}` || item.status !== 'local' || !item.fingerprintAvailable || !item.fingerprint) { complete = false; continue; }
    // Recheck a previously hashed file after the rest of the audit. Uploads also
    // validate this expected identity before any immutable revision is published.
    const actual = await fingerprintFile(sourcePath, { signal });
    if (actual.sha256 !== item.fingerprint.sha256 || actual.size !== item.fingerprint.size) throw fail('media-revision-source-changed');
    const identity = createMediaAssetIdentity(actual, { assetClass: 'original' });
    assets.push({ referenceId: item.id, identity, required: true });
    sources.push({ referenceId: item.id, sourcePath, identity: structuredClone(identity) });
  }
  await readVerifiedExport(filename, scan.sourceHash); check(signal);
  return { manifest: createMediaBoundScanManifest(scan, { coverage: complete ? 'complete' : 'incomplete', assets }), sources };
}
async function captureMediaBoundScanManifest(options) { return (await captureMediaRevision(options)).manifest; }
module.exports = { createMediaBoundScanManifest, captureMediaBoundScanManifest, captureMediaRevision, projectMediaBoundScanManifest };
