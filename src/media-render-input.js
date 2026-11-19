// Trusted-main-process inputs only. Nothing exported here is a renderer DTO.
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const fail = code => Object.assign(new Error(code), { code });
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const MAX_XML_BYTES = 20 * 1024 * 1024;
async function regularIdentity(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw fail('invalid-source');
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw fail('symlink-unsupported');
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw fail('not-regular-file');
  return { size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs };
}
const sameIdentity = (a, b) => !!a && !!b && ['size', 'dev', 'ino', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every(key => a[key] === b[key]);
async function readVerifiedExport(exportPath, expectedSourceHash) {
  const before = await regularIdentity(exportPath);
  if (before.size > MAX_XML_BYTES) throw fail('export-too-large');
  const handle = await fs.open(exportPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw fail('source-changed');
    // A writer growing the export after stat must not cause an unbounded read.
    const chunks = []; let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length; if (total > MAX_XML_BYTES || total > before.size) throw fail('source-changed');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks, total);
    if (total !== before.size) throw fail('source-changed');
  } finally { await handle.close(); }
  if (!sameIdentity(before, await regularIdentity(exportPath))) throw fail('source-changed');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  if (typeof expectedSourceHash !== 'string' || sourceHash !== expectedSourceHash) throw fail('selection-changed');
  return { bytes, sourceHash, identity: before };
}
function rational(value) {
  const match = /^(\d{1,16})(?:\/(\d{1,16}))?s$/.exec(String(value));
  if (!match || BigInt(match[2] || 1) === 0n) throw fail('unsupported-preview-timing');
  return [BigInt(match[1]), BigInt(match[2] || 1)];
}
function frameCount(value, duration) {
  const [n, d] = rational(value); const numerator = n * duration[1]; const denominator = d * duration[0];
  if (!denominator || numerator % denominator) throw fail('unsupported-preview-timing');
  const result = Number(numerator / denominator);
  if (!Number.isSafeInteger(result) || result < 0) throw fail('unsupported-preview-timing');
  return result;
}
function onlyChildren(node, allowed) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw fail('unsupported-preview-structure');
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@_') && key !== '#text' && !allowed.includes(key)) throw fail('unsupported-preview-structure');
    if (key === '#text' && String(value).trim()) throw fail('unsupported-preview-structure');
  }
}
function one(value) { const values = array(value); if (values.length !== 1) throw fail('ambiguous-preview-sequence'); return values[0]; }
function localPath(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash) throw fail('nonlocal-preview-source');
    return fileURLToPath(url);
  } catch (error) { throw fail(error.code === 'nonlocal-preview-source' ? error.code : 'invalid-preview-source'); }
}
function label(value, index) {
  return path.basename(String(value || `Clip ${index + 1}`).replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || `Clip ${index + 1}`;
}

// Deliberately a small renderable subset: one flat picture spine, no effects,
// retiming, connected lanes, nested clips, transitions, or alternate media.
// Timeline offsets determine ordering; source starts determine captured frames.
function parseTimelinePreview(bytes) {
  const xml = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  if (Buffer.byteLength(xml) > MAX_XML_BYTES) throw fail('export-too-large');
  if (/<!ENTITY/i.test(xml) || /<!DOCTYPE(?!\s+fcpxml\s*>)/i.test(xml)) throw fail('unsafe-preview-xml');
  if (XMLValidator.validate(xml) !== true) throw fail('malformed-preview-xml');
  let parsed;
  try { parsed = new XMLParser({ ignoreAttributes: false, processEntities: true, parseAttributeValue: false }).parse(xml); }
  catch { throw fail('malformed-preview-xml'); }
  const root = parsed.fcpxml;
  if (!root || root['@_version'] !== '1.10') throw fail('unsupported-preview-version');
  onlyChildren(root, ['resources', 'library']);
  const resources = one(root.resources); onlyChildren(resources, ['format', 'asset']);
  const formats = new Map(); const assets = new Map(); const ids = new Set();
  for (const [kind, nodes] of [['format', array(resources.format)], ['asset', array(resources.asset)]]) {
    for (const node of nodes) {
      const id = node['@_id']; if (typeof id !== 'string' || !id || ids.has(id)) throw fail('ambiguous-preview-resource');
      ids.add(id); (kind === 'format' ? formats : assets).set(id, node);
    }
  }
  const library = one(root.library); onlyChildren(library, ['event']);
  const event = one(library.event); onlyChildren(event, ['project']);
  const project = one(event.project); onlyChildren(project, ['sequence']);
  const sequence = one(project.sequence); onlyChildren(sequence, ['spine']);
  const format = formats.get(sequence['@_format']);
  if (!format) throw fail('missing-preview-format');
  const frameDuration = rational(format['@_frameDuration']);
  if (!frameDuration[0]) throw fail('unsupported-preview-timing');
  const spine = one(sequence.spine); onlyChildren(spine, ['asset-clip', 'video', 'gap']);
  const entries = [];
  for (const kind of ['asset-clip', 'video', 'gap']) for (const node of array(spine[kind])) {
    onlyChildren(node, []);
    if (node['@_lane'] !== undefined && node['@_lane'] !== '0') throw fail('unsupported-preview-lane');
    if (node['@_enabled'] !== undefined && node['@_enabled'] !== '1') throw fail('unsupported-preview-disabled-clip');
    // Reject time-mapping attributes even when a future exporter expresses them as attributes.
    if (['@_timeMap', '@_speed', '@_srcEnable'].some(key => node[key] !== undefined)) throw fail('unsupported-preview-structure');
    const offsetFrames = frameCount(node['@_offset'], frameDuration);
    const durationFrames = frameCount(node['@_duration'], frameDuration);
    if (!durationFrames) throw fail('unsupported-preview-timing');
    const entry = { kind, offsetFrames, durationFrames };
    if (kind !== 'gap') {
      const asset = assets.get(node['@_ref']);
      if (!asset || asset['@_hasVideo'] === '0') throw fail('missing-preview-picture');
      onlyChildren(asset, ['media-rep']);
      const reps = array(asset['media-rep']);
      const originals = reps.filter(rep => rep['@_kind'] === 'original-media');
      if (originals.length > 1 || (!originals.length && reps.length > 1)) throw fail('ambiguous-preview-source');
      if (!originals.length && reps.length) throw fail('missing-preview-original');
      const rep = originals[0];
      const sourcePath = localPath(rep ? rep['@_src'] : asset['@_src']);
      const sourceInFrames = frameCount(node['@_start'] ?? '0s', frameDuration);
      const assetStart = frameCount(asset['@_start'] ?? '0s', frameDuration);
      if (sourceInFrames < assetStart) throw fail('preview-source-out-of-range');
      // Bounds are exact where the export provides an asset duration/start.
      if (asset['@_duration'] !== undefined) {
        const assetDuration = frameCount(asset['@_duration'], frameDuration);
        if (sourceInFrames < assetStart || sourceInFrames + durationFrames > assetStart + assetDuration) throw fail('preview-source-out-of-range');
      }
      Object.assign(entry, { sourcePath, sourceInFrames, label: label(node['@_name'] || asset['@_name'], entries.length),
        seconds: (sourceInFrames - assetStart) * Number(frameDuration[0]) / Number(frameDuration[1]) });
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.offsetFrames - b.offsetFrames);
  let end = 0;
  for (const entry of entries) {
    if (entry.offsetFrames < end) throw fail('ambiguous-preview-overlap');
    end = entry.offsetFrames + entry.durationFrames;
    if (!Number.isSafeInteger(end)) throw fail('unsupported-preview-timing');
  }
  const clips = entries.filter(entry => entry.kind !== 'gap');
  if (!clips.length) throw fail('no-preview-picture');
  if (clips.length > 24) throw fail('preview-clip-limit');
  return { clips, frameDuration: format['@_frameDuration'], frameRate: Number(frameDuration[1]) / Number(frameDuration[0]), clipCount: clips.length };
}
async function loadTimelinePreview({ exportPath, sourceHash }) {
  const verified = await readVerifiedExport(exportPath, sourceHash);
  const timeline = parseTimelinePreview(verified.bytes);
  for (const clip of timeline.clips) clip.identity = await regularIdentity(clip.sourcePath);
  return { ...timeline, exportIdentity: verified.identity };
}

module.exports = { regularIdentity, sameIdentity, readVerifiedExport, parseTimelinePreview, loadTimelinePreview };
