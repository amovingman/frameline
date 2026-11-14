'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', processEntities: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function bytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail('INVALID_SOURCE_BYTES');
  if (value.byteLength > 20 * 1024 * 1024) fail('SOURCE_TOO_LARGE');
  return Buffer.from(value);
}
function decode(value) { try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { fail('INVALID_SOURCE_ENCODING'); } }
function nodes(parent, name) { return (parent || []).filter(n => Object.hasOwn(n, name)); }
function only(parent, name) { const found = nodes(parent, name); if (found.length !== 1) fail('UNSUPPORTED_EXPORT_STRUCTURE'); return found[0]; }
function children(node) { const key = Object.keys(node).find(k => k !== ':@'); return node[key] || []; }
function attrs(node) { return node[':@'] || {}; }
function elementName(node) { return Object.keys(node).find(k => k !== ':@'); }
function elements(node) { return children(node).filter(n => !elementName(n).startsWith('#')); }
function rational(value) {
  const m = /^(\d+)(?:\/(\d+))?s$/.exec(String(value));
  if (!m || m[2] === '0') fail('UNSUPPORTED_EXPORT_TIMING');
  return [BigInt(m[1]), BigInt(m[2] || '1')];
}
function frames(value, rate) {
  const [n, d] = rational(value); const divisor = d * rate[0]; const numerator = n * rate[1];
  if (!divisor || numerator % divisor) fail('UNSUPPORTED_EXPORT_TIMING');
  const result = Number(numerator / divisor);
  if (!Number.isSafeInteger(result)) fail('UNSUPPORTED_EXPORT_TIMING');
  return result;
}
function compareResolveSnapshotToExport(snapshotBytes, xmlBytes, timelineId) {
  const snapshotSource = bytes(snapshotBytes); const xmlSource = bytes(xmlBytes);
  let snapshot;
  try { snapshot = JSON.parse(decode(snapshotSource)); } catch { fail('INVALID_RESOLVE_SNAPSHOT'); }
  validateResolveSnapshot(snapshot);
  const timeline = snapshot.timelines.find(t => t.id === timelineId);
  if (!timeline || typeof timelineId !== 'string') fail('INVALID_TIMELINE_SELECTION');
  const xml = decode(xmlSource);
  // External and internal entities are never needed by the supported subset.
  const withoutBareDoctype = xml.replace(/<!DOCTYPE\s+fcpxml\s*>/g, '');
  if (/<!ENTITY\b|<!DOCTYPE\b/i.test(withoutBareDoctype) || XMLValidator.validate(xml) !== true) fail('INVALID_EXPORT_XML');
  let doc; try { doc = parser.parse(xml); } catch { fail('INVALID_EXPORT_XML'); }
  const root = only(doc, 'fcpxml');
  if (String(attrs(root).version) !== '1.10') fail('UNSUPPORTED_EXPORT_VERSION');
  const resourceNode = only(children(root), 'resources');
  const resources = new Map();
  for (const node of elements(resourceNode)) {
    const id = attrs(node).id;
    if (id !== undefined) { if (resources.has(String(id))) fail('UNSUPPORTED_EXPORT_STRUCTURE'); resources.set(String(id), node); }
  }
  const library = only(children(root), 'library');
  const sequences = nodes(children(library), 'event').flatMap(event => nodes(children(event), 'project')).flatMap(project => nodes(children(project), 'sequence'));
  if (sequences.length !== 1) fail('UNSUPPORTED_EXPORT_STRUCTURE');
  const sequence = sequences[0]; const format = resources.get(String(attrs(sequence).format));
  if (!format || elementName(format) !== 'format' || !attrs(format).frameDuration) fail('UNSUPPORTED_EXPORT_STRUCTURE');
  const rate = rational(attrs(format).frameDuration); if (!rate[0]) fail('UNSUPPORTED_EXPORT_TIMING');
  const spine = only(children(sequence), 'spine');
  if (elements(sequence).some(node => elementName(node) !== 'spine')) fail('UNSUPPORTED_TIMELINE_CONTENT');
  const signatures = new Map();
  function add(key, side, value) { const k = key.join(','); if (!signatures.has(k)) signatures.set(k, { frames: key, apiItemIds: [], xmlSpineIndices: [] }); signatures.get(k)[side].push(value); }
  const adjustment = new Set(['adjust-conform', 'adjust-transform']);
  const laneOk = node => attrs(node).lane === undefined || String(attrs(node).lane) === '0';
  const adjustmentsOnly = node => elements(node).every(child => adjustment.has(elementName(child)) && elements(child).length === 0);
  elements(spine).forEach((clip, index) => {
    const kind = elementName(clip);
    if (!laneOk(clip)) fail('UNSUPPORTED_TIMELINE_CONTENT');
    if (kind === 'gap') { if (elements(clip).length) fail('UNSUPPORTED_TIMELINE_CONTENT'); return; }
    if (kind === 'clip') {
      const parts = elements(clip); const videos = parts.filter(n => elementName(n) === 'video');
      if (videos.length !== 1 || parts.some(n => elementName(n) !== 'video' && !adjustment.has(elementName(n)))) fail('UNSUPPORTED_TIMELINE_CONTENT');
      if (parts.filter(n => adjustment.has(elementName(n))).some(n => elements(n).length)) fail('UNSUPPORTED_TIMELINE_CONTENT');
      const video = videos[0]; const asset = resources.get(String(attrs(video).ref));
      if (!laneOk(video) || !adjustmentsOnly(video) || !asset || elementName(asset) !== 'asset' || String(attrs(asset).hasVideo) !== '1') fail('UNSUPPORTED_TIMELINE_CONTENT');
    } else {
      const asset = resources.get(String(attrs(clip).ref));
      if (!['video', 'asset-clip'].includes(kind) || !adjustmentsOnly(clip) || !asset || elementName(asset) !== 'asset' || String(attrs(asset).hasVideo) !== '1') fail('UNSUPPORTED_TIMELINE_CONTENT');
    }
    add([frames(attrs(clip).offset ?? '0s', rate), frames(attrs(clip).start ?? '0s', rate), frames(attrs(clip).duration ?? '0s', rate)], 'xmlSpineIndices', index);
  });
  for (const item of timeline.items) {
    if (item.track_type !== 'video' || item.track_index !== 1 || item.type !== 'video') fail('UNSUPPORTED_TIMELINE_CONTENT');
    add([item.start_frame - timeline.start_frame, item.source_start_frame, item.end_frame - item.start_frame], 'apiItemIds', item.id);
  }
  const matches = []; const unresolved = [];
  const groups = [...signatures.values()].sort((a, b) => a.frames[0] - b.frames[0] || a.frames[1] - b.frames[1] || a.frames[2] - b.frames[2]);
  for (const group of groups) {
    if (group.apiItemIds.length === 1 && group.xmlSpineIndices.length === 1) matches.push({ apiItemId: group.apiItemIds[0], xmlSpineIndex: group.xmlSpineIndices[0] });
    else { group.apiItemIds.sort(); unresolved.push(group); }
  }
  matches.sort((a, b) => a.xmlSpineIndex - b.xmlSpineIndex);
  return { status: unresolved.length ? 'unresolved' : 'candidates-only', snapshotSha256: hash(snapshotSource), exportSha256: hash(xmlSource), projectId: snapshot.project_id, timelineId, matches, unresolved, safeToApply: false };
}
module.exports = { compareResolveSnapshotToExport };
