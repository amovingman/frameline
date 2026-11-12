const { XMLParser, XMLValidator } = require('fast-xml-parser');

const MAX_XML_BYTES = 20 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: false });
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const safeName = (value, fallback) => typeof value === 'string' && !/[\\/:\u0000-\u001f]/.test(value) ? value.slice(0, 240) : fallback;
const time = value => /^-?\d+(?:\/[1-9]\d*)?s$/.test(String(value)) ? String(value) : null;

class DecorationInventoryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Locators describe this document's tree only. They are not persistent edit identities.
// Timing is copied from XML; connected-lane coordinate semantics are unresolved.
function buildDecorationInventory(xml, options = {}) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_XML_BYTES) throw new DecorationInventoryError('invalid-xml-input');
  if (/<!ENTITY\s/i.test(xml) || XMLValidator.validate(xml) !== true) throw new DecorationInventoryError('malformed-xml');
  const root = parser.parse(xml).fcpxml;
  if (!root || String(root.version) !== '1.10') throw new DecorationInventoryError('unsupported-fcpxml-version');
  const projects = array(root.library?.event).flatMap(event => array(event.project))
    .filter(project => typeof project?.name === 'string' && /^Frameline(?:\s|$)/.test(project.name) && project.sequence);
  const selected = options.projectName === undefined ? projects : projects.filter(project => project.name === options.projectName);
  if (selected.length !== 1) throw new DecorationInventoryError(selected.length ? 'ambiguous-project' : 'frameline-project-required');
  const project = selected[0];
  const resources = new Map(array(root.resources?.effect).filter(effect => effect?.id).map(effect => [String(effect.id), effect]));
  const transitions = [];
  const effects = [];
  const warnings = new Set();
  function walk(node, locator, parentKind, transitionContext = false) {
    for (const [kind, value] of Object.entries(node || {})) {
      if (!value || typeof value !== 'object') continue;
      array(value).forEach((child, index) => {
        if (!child || typeof child !== 'object') return;
        const location = `${locator}/${kind}[${index + 1}]`;
        const inTransition = transitionContext || kind === 'transition';
        if (kind === 'transition') {
          const entry = {
            locator: location, name: safeName(child.name, 'Unnamed transition'),
            timing: { basis: 'xml-serialized-unresolved', offset: time(child.offset), duration: time(child.duration) },
            effectNames: array(child['filter-video']).concat(array(child['filter-audio'])).map(filter => safeName(resources.get(String(filter?.ref))?.name, 'Unresolved effect'))
          };
          if (entry.timing.offset === null || entry.timing.duration === null) warnings.add('Some transition timing is unavailable or unsupported');
          transitions.push(entry);
        }
        if (['filter-video', 'filter-audio'].includes(kind) || kind.startsWith('adjust-')) {
          const resource = resources.get(String(child.ref));
          effects.push({ locator: location, kind, name: safeName(resource?.name || child.name, kind),
            usage: inTransition ? 'transition' : 'clip-or-container', parentKind,
            resourceResolved: kind.startsWith('adjust-') ? null : Boolean(resource), parametersIncluded: false });
          if (child.ref && !resource) warnings.add('Some effect references could not be resolved');
        }
        // Parameter payloads and metadata are deliberately excluded, even if nested.
        if (!['param', 'metadata', 'md', 'media-rep'].includes(kind)) walk(child, location, kind, inTransition);
      });
    }
  }
  walk(project.sequence, 'sequence', 'sequence');
  return { schemaVersion: 1, readOnly: true, projectName: safeName(project.name, 'Frameline project'),
    scope: 'selected-project-xml-tree', coverage: 'serialized-xml-only',
    limitation: 'Effects absent from XML cannot be assessed; no write or round-trip support is implied', timingBasis: 'xml-serialized-unresolved', transitions, effects, warnings: [...warnings] };
}

function inventoryTransitions(xml, options) {
  const { effects, ...inventory } = buildDecorationInventory(xml, options);
  return inventory;
}

function inventoryEffects(xml, options) {
  const { transitions, ...inventory } = buildDecorationInventory(xml, options);
  return inventory;
}

module.exports = { DecorationInventoryError, buildDecorationInventory, inventoryTransitions, inventoryEffects };
