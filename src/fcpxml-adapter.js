const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const MAX_XML_BYTES = 20 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: false });
const asArray = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const displayName = value => path.basename(String(value || 'Untitled').replaceAll('\\', '/'));

class ScanError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function rational(value) {
  const match = /^(\d+)(?:\/(\d+))?s$/.exec(String(value ?? ''));
  if (!match || match[2] === '0') throw new ScanError('unsupported-timing');
  return [BigInt(match[1]), BigInt(match[2] || 1)];
}

function frames(value, frameDuration) {
  const [n, d] = rational(value);
  const [fn, fd] = frameDuration;
  const numerator = n * fd;
  const denominator = d * fn;
  if (!fn || numerator % denominator) throw new ScanError('unsupported-timing');
  const result = Number(numerator / denominator);
  if (!Number.isSafeInteger(result)) throw new ScanError('unsupported-timing');
  return result;
}

function buildInventory(xml) {
  if (XMLValidator.validate(xml) !== true) throw new ScanError('malformed-xml');
  const document = parser.parse(xml);
  const root = document.fcpxml;
  if (!root || !root.resources || !root.library) throw new ScanError('unsupported-structure');

  const resources = new Map();
  for (const [kind, nodes] of Object.entries(root.resources)) {
    for (const node of asArray(nodes)) if (node?.id) resources.set(String(node.id), { ...node, kind });
  }
  const projects = asArray(root.library.event).flatMap(event => asArray(event.project));
  const project = projects.find(candidate => candidate.sequence);
  const sequence = project?.sequence;
  const spine = sequence?.spine;
  const format = resources.get(String(sequence?.format));
  if (!spine || !format?.frameDuration) throw new ScanError('unsupported-structure');
  const frameDuration = rational(format.frameDuration);
  if (!frameDuration[0]) throw new ScanError('unsupported-timing');

  const entries = Object.entries(spine).flatMap(([kind, nodes]) => asArray(nodes).map(node => ({ kind, node })));
  // The parser groups sibling tags by name. Offset, rather than XML child order, is authoritative.
  const clips = [];
  const referencedAssets = new Map();
  const warnings = new Set();
  for (const { kind, node } of entries) {
    if (kind === 'gap') continue;
    if (!['asset-clip', 'video'].includes(kind)) {
      warnings.add(`Unsupported timeline element: ${kind}`);
      continue;
    }
    const asset = resources.get(String(node.ref));
    if (!asset || asset.kind !== 'asset') {
      warnings.add('A clip references an unavailable asset');
      continue;
    }
    const offsetFrames = frames(node.offset ?? '0s', frameDuration);
    const durationFrames = frames(node.duration, frameDuration);
    const sourceInFrames = frames(node.start ?? '0s', frameDuration);
    const mediaRep = asArray(asset['media-rep']).find(rep => rep.kind === 'original-media') || asArray(asset['media-rep'])[0];
    const source = mediaRep?.src || asset.src || null;
    const mediaKey = source || `resource:${node.ref}`;
    if (!referencedAssets.has(mediaKey)) referencedAssets.set(mediaKey, { name: displayName(asset.name || 'Unnamed asset'), source });
    clips.push({
      scanKey: `position-${clips.length + 1}`,
      name: displayName(node.name || asset.name || 'Untitled clip'),
      mediaName: displayName(asset.name || 'Unnamed asset'),
      offsetFrames,
      durationFrames,
      sourceInFrames,
      enabled: String(node.enabled ?? '1') !== '0',
      identityStatus: 'unresolved'
    });
  }
  clips.sort((a, b) => a.offsetFrames - b.offsetFrames);
  clips.forEach((clip, index) => { clip.scanKey = `position-${index + 1}`; });
  if (projects.length > 1) warnings.add('Only the first sequence was scanned');
  const durationFrames = sequence.duration ? frames(sequence.duration, frameDuration) : Math.max(0, ...clips.map(clip => clip.offsetFrames + clip.durationFrames));
  const scan = {
    schemaVersion: 1,
    adapter: 'fcpxml',
    readOnly: true,
    identityStatus: 'unresolved',
    sequence: { name: displayName(project.name || 'Untitled sequence'), frameDuration: `${frameDuration[0]}/${frameDuration[1]}s`, durationFrames },
    clips,
    media: [...referencedAssets.values()].map(({ name }) => ({ name, availability: 'unknown' })),
    warnings: [...warnings]
  };
  return { scan, referencedAssets: [...referencedAssets.values()] };
}

function scanXml(xml) {
  return buildInventory(xml).scan;
}

async function checkMedia(source) {
  if (!source) return 'unknown';
  let url;
  try { url = new URL(source); } catch { return 'unknown'; }
  if (url.protocol !== 'file:') return 'external';
  let mediaPath;
  try { mediaPath = fileURLToPath(url); } catch { return 'unknown'; }
  try {
    return (await fs.stat(mediaPath)).isFile() ? 'local' : 'missing';
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable';
  }
}

async function scanFcpXml(selectedPath) {
  const extension = path.extname(selectedPath).toLowerCase();
  if (!['.fcpxml', '.fcpxmld'].includes(extension)) throw new ScanError('unsupported-format');
  const xmlPath = extension === '.fcpxmld' ? path.join(selectedPath, 'Info.fcpxml') : selectedPath;
  let stat;
  try { stat = await fs.stat(xmlPath); } catch { throw new ScanError('file-unavailable'); }
  if (!stat.isFile()) throw new ScanError('file-unavailable');
  if (stat.size > MAX_XML_BYTES) throw new ScanError('file-too-large');
  let xml;
  try { xml = await fs.readFile(xmlPath, 'utf8'); } catch { throw new ScanError('file-unavailable'); }
  const { scan, referencedAssets } = buildInventory(xml);
  scan.media = await Promise.all(referencedAssets.map(async ({ name, source }) => ({ name, availability: await checkMedia(source) })));
  return scan;
}

module.exports = { ScanError, scanFcpXml, scanXml };
