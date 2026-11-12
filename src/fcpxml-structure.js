// A read-only inventory of the structure explicitly represented in FCPXML.
// FCPXML lanes are not Resolve track numbers and cannot recover empty tracks.
const path = require('node:path');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { ScanError } = require('./fcpxml-adapter');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: false });
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const name = value => path.basename(String(value || 'Untitled').replaceAll('\\', '/'));
const time = value => /^(?:\d+)(?:\/[1-9]\d*)?s$/.test(String(value ?? '')) ? String(value) : null;

function inventoryStructure(xml) {
  if (typeof xml !== 'string' || XMLValidator.validate(xml) !== true) throw new ScanError('malformed-xml');
  const root = parser.parse(xml).fcpxml;
  if (!root || root.resources === undefined || root.library === undefined) throw new ScanError('unsupported-structure');
  if (String(root.version) !== '1.10') throw new ScanError('unsupported-fcpxml-version');
  const assets = new Map(array(root.resources?.asset).map(asset => [String(asset.id), asset]));
  const projects = array(root.library.event).flatMap(event => array(event.project));
  const sequences = projects.filter(project => project.sequence).map((project, sequenceIndex) => {
    const sequence = project.sequence;
    const tracks = new Map();
    const unsupported = new Set(['empty-tracks-unavailable', 'resolve-track-numbers-unavailable']);
    const links = [];
    const containers = [];
    let entryCount = 0;
    const track = (type, lane) => {
      const key = `${type}:${lane}`;
      if (!tracks.has(key)) tracks.set(key, { type, lane, entries: [] });
      return tracks.get(key);
    };
    const add = (type, lane, node, kind, linkId, parentId) => {
      const entry = { id: `entry-${++entryCount}`, kind, name: name(node.name), offset: time(node.offset), duration: time(node.duration), start: time(node.start), enabled: String(node.enabled ?? '1') !== '0' };
      if (linkId) entry.linkId = linkId;
      entry.parentId = parentId;
      track(type, lane).entries.push(entry);
      return entry;
    };
    const visit = (container, inheritedLane = 0, parentId = null) => {
      for (const [kind, value] of Object.entries(container || {})) {
        if (!value || typeof value !== 'object') continue;
        for (const node of array(value)) {
          if (!node || typeof node !== 'object') continue;
          const laneValue = node.lane === undefined ? inheritedLane : Number(node.lane);
          if (!Number.isSafeInteger(laneValue)) { unsupported.add('invalid-lane'); continue; }
          if (kind === 'gap' || kind === 'spine') {
            const id = `container-${containers.length + 1}`;
            containers.push({ id, parentId, kind, lane: laneValue, offset: time(node.offset), start: time(node.start), duration: time(node.duration) });
            visit(node, laneValue, id); continue;
          }
          if (kind === 'transition') { add('unknown', laneValue, node, kind, null, parentId); unsupported.add('transition-details-not-inventoried'); continue; }
          if (kind === 'ref-clip') { add('unknown', laneValue, node, kind, null, parentId); unsupported.add('nested-sequences-not-inventoried'); continue; }
          if (!['asset-clip', 'clip', 'video', 'audio'].includes(kind)) { unsupported.add('other-elements-not-inventoried'); continue; }
          const video = kind === 'video' ? [node] : array(node.video);
          const audio = kind === 'audio' ? [node] : array(node.audio);
          const asset = assets.get(String(node.ref));
          const implicitVideo = kind === 'asset-clip' && String(asset?.hasVideo) === '1';
          if (kind === 'asset-clip' && !asset) unsupported.add('unresolved-asset');
          const hasVideo = implicitVideo || video.length > 0;
          const hasAudio = audio.length > 0;
          if (!hasVideo && !hasAudio) { unsupported.add('clip-media-type-unavailable'); continue; }
          const linkId = hasVideo && hasAudio ? `link-${links.length + 1}` : null;
          const ids = [];
          if (hasVideo) ids.push(add('video', laneValue, node, kind, linkId, parentId).id);
          if (hasAudio) ids.push(add('audio', laneValue, node, kind, linkId, parentId).id);
          if (linkId) links.push({ id: linkId, entryIds: ids, basis: 'same-clip', status: 'candidate' });
          if (kind === 'clip' && (video.length > 1 || audio.length > 1)) unsupported.add('multiple-components-collapsed');
          if (Object.keys(node).some(key => /^(filter-|adjust-|timeMap|conform-rate)/.test(key))) unsupported.add('effects-and-retiming-not-inventoried');
        }
      }
    };
    if (sequence.spine) visit(sequence.spine); else unsupported.add('missing-spine');
    return { id: `sequence-${sequenceIndex + 1}`, name: name(project.name), duration: time(sequence.duration), containers, tracks: [...tracks.values()], linkedAudio: links, unsupported: [...unsupported] };
  });
  return { schemaVersion: 1, readOnly: true, laneMeaning: 'fcpxml-lane', timingMeaning: 'xml-serialized-unresolved', sequences };
}

module.exports = { inventoryStructure };
