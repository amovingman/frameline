// Policy assessment is descriptive only: no result from this module authorizes a write.
const WARNING_CODES = Object.freeze([
  'addition-deletion', 'conflict', 'effect-change', 'linked-item-change',
  'read-only-preview', 'timing-ripple-interaction', 'track-index-identity',
  'unsupported-item-type'
]);
const STATUSES = new Set(['incoming-only', 'local-only', 'already-applied', 'conflict']);
const TIMING_FIELDS = new Set(['startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame']);
const SUPPORTED_TYPES = new Set(['video', 'audio']);

function invalid() {
  const error = new Error('Invalid Resolve classification.');
  error.code = 'invalid-resolve-classification';
  throw error;
}

// Canonical copies keep plan ordering stable and prevent callers mutating its inputs.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const decisionOrder = (a, b) => compare(a.timelineId, b.timelineId)
  || compare(a.itemId || '', b.itemId || '') || compare(a.field, b.field)
  || compare(JSON.stringify(a), JSON.stringify(b));

function assembleDetails(decisions) {
  const ordered = decisions.map(canonical).sort(decisionOrder);
  const changes = ordered.filter(value => value.status === 'incoming-only').map(value => ({
    ...value,
    operation: value.field === 'existence' ? (value.incoming === null ? 'remove' : 'add') : 'update'
  }));
  const conflicts = ordered.filter(value => value.status === 'conflict');
  const requirements = new Map();
  function requireMedia(timelineId, itemId, mediaPoolId, status) {
    const requirement = { timelineId, itemId, mediaPoolId: typeof mediaPoolId === 'string' ? mediaPoolId : null,
      availability: 'unknown', identity: typeof mediaPoolId === 'string' ? 'resolve-media-pool-id' : 'unknown',
      pendingConflictResolution: status === 'conflict' };
    requirements.set(JSON.stringify(requirement), requirement);
  }
  for (const value of ordered) {
    if (!['incoming-only', 'conflict'].includes(value.status)) continue;
    if (value.field === 'existence') {
      if (value.incoming === null) continue;
      const items = value.itemId === null ? value.incoming.items : [value.incoming];
      if (Array.isArray(items)) for (const item of items) {
        requireMedia(value.timelineId, item.id || value.itemId, item.mediaPoolId, value.status);
      }
    } else if (value.itemId !== null && (value.field === 'mediaPoolId' || TIMING_FIELDS.has(value.field)
      || value.field === 'type')) {
      // A field-only classifier cannot establish the item's current media identity.
      requireMedia(value.timelineId, value.itemId, value.field === 'mediaPoolId' ? value.incoming : null, value.status);
    }
  }
  return { changes, conflicts, mediaRequirements: [...requirements.values()].sort((a, b) =>
    compare(a.timelineId, b.timelineId) || compare(a.itemId || '', b.itemId || '')
    || compare(JSON.stringify(a), JSON.stringify(b))) };
}

function assessResolvePlan(classification) {
  if (!classification || classification.schemaVersion !== 1 || classification.readOnly !== true
    || classification.safeToApply !== false || !Array.isArray(classification.decisions)) invalid();
  const countsByCode = new Map(WARNING_CODES.map(code => [code, 0]));
  // API snapshots expose tracks by index, even when no track change was observed.
  countsByCode.set('read-only-preview', 1);
  countsByCode.set('track-index-identity', 1);
  let conflicts = 0;
  for (const decision of classification.decisions) {
    if (!decision || typeof decision.timelineId !== 'string' || !decision.timelineId
      || (decision.itemId !== null && (typeof decision.itemId !== 'string' || !decision.itemId))
      || typeof decision.field !== 'string' || !decision.field || !STATUSES.has(decision.status)
      || !['base', 'local', 'incoming'].every(key => Object.hasOwn(decision, key))) invalid();
    const codes = new Set();
    if (decision.status === 'conflict') { codes.add('conflict'); conflicts++; }
    const field = decision.field;
    if (field === 'existence') codes.add('addition-deletion');
    if (TIMING_FIELDS.has(field)) codes.add('timing-ripple-interaction');
    if (field === 'linkedItemIds') codes.add('linked-item-change');
    if (field === 'effectCounts' || field.startsWith('effectCounts.')) codes.add('effect-change');
    if (field === 'type' && [decision.base, decision.local, decision.incoming]
      .some(value => value !== null && !SUPPORTED_TYPES.has(value))) codes.add('unsupported-item-type');
    // Whole entities carry risks which would otherwise be hidden behind existence.
    if (field === 'existence') {
      function inspect(value) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(inspect); return; }
        if ((Object.hasOwn(value, 'track') || Object.hasOwn(value, 'trackIndex'))
          && !SUPPORTED_TYPES.has(value.type)) codes.add('unsupported-item-type');
        if (Object.hasOwn(value, 'linkedItemIds') && value.linkedItemIds?.length) codes.add('linked-item-change');
        if ((value.effectCounts && Object.values(value.effectCounts).some(count => count === null || count > 0))
          || Object.entries(value).some(([key, count]) => key.startsWith('effectCounts.') && (count === null || count > 0))) {
          codes.add('effect-change');
        }
        if ([...TIMING_FIELDS].some(key => Object.hasOwn(value, key))) codes.add('timing-ripple-interaction');
        Object.values(value).forEach(inspect);
      }
      [decision.base, decision.local, decision.incoming].forEach(inspect);
    }
    for (const code of codes) countsByCode.set(code, countsByCode.get(code) + 1);
  }
  const warnings = WARNING_CODES.filter(code => countsByCode.get(code) > 0)
    .map(code => ({ code, count: countsByCode.get(code) }));
  return {
    schemaVersion: 1, readOnly: true, safeToApply: false,
    ...assembleDetails(classification.decisions),
    warnings,
    validationWarnings: warnings.map(warning => ({ ...warning })),
    counts: {
      decisions: classification.decisions.length,
      conflicts,
      warningCategories: warnings.length,
      warningOccurrences: warnings.reduce((sum, warning) => sum + warning.count, 0)
    }
  };
}

module.exports = { assessResolvePlan, WARNING_CODES };
