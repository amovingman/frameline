'use strict';

const { assessResolvePlan } = require('./resolve-plan-policy');
const { equivalentObservationValue } = require('./resolve-observation-values');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const MAX_CHANGED_FIELDS = 100;
const MAX_CHANGED_FIELD_BYTES = 4096;
const MAX_TOTAL_CHANGED_FIELD_BYTES = 256 * 1024;
const invalid = () => { throw Object.assign(new Error('Invalid Resolve classification.'), { code: 'invalid-resolve-classification' }); };

// Collection order is not an edit for these keyed observations. Keep decimal
// spellings exact until equivalentObservationValue compares their represented
// values; do not round them through JavaScript Number.
function keyed(value, field) {
  if (!Array.isArray(value)) return null;
  if (field === 'items') return new Map(value.map(item => [JSON.stringify(item.id), item]));
  if (field === 'tracks') return new Map(value.map(track => [JSON.stringify([track.type, track.index]), track]));
  if (field === 'effects') return new Map(value.map(effect => [JSON.stringify([effect.category, effect.index]), effect]));
  if (field === 'linkedItemIds') return new Map(value.map(id => [JSON.stringify(id), id]));
  return null;
}
function changedFields(before, after, budget) {
  const fields = [];
  let count = 0, bytes = 0;
  const add = path => {
    count++;
    const size = Buffer.byteLength(path);
    if (fields.length < MAX_CHANGED_FIELDS && bytes + size <= MAX_CHANGED_FIELD_BYTES && size <= budget.remaining) {
      fields.push(path); bytes += size; budget.remaining -= size;
    }
  };
  function visit(a, b, path, field) {
    const oldEntries = keyed(a, field), newEntries = keyed(b, field);
    if (oldEntries && newEntries) {
      for (const id of [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort(compare)) {
        const at = `${path}[${id}]`;
        if (!oldEntries.has(id) || !newEntries.has(id)) add(at);
        else visit(oldEntries.get(id), newEntries.get(id), at, '');
      }
      return;
    }
    if (equivalentObservationValue(a, b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
      && !Object.hasOwn(a, 'decimal') && !Object.hasOwn(b, 'decimal')) {
      for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compare)) {
        const at = path ? `${path}.${name}` : name;
        if (!Object.hasOwn(a, name) || !Object.hasOwn(b, name)) add(at);
        else visit(a[name], b[name], at, name);
      }
    } else add(path);
  }
  visit(before, after, '', '');
  return { changedFields: fields, changedFieldCount: count, changedFieldsTruncated: count > fields.length };
}

// Descriptive metadata is separate from canonical preview/review hashes so old
// content-addressed previews and immutable trial audits retain their identities.
// Existing role values and audit selectedValue remain the authoritative values.
function describeResolveDeletionPolicy(classification) {
  assessResolvePlan(classification);
  const conflicts = [];
  const budget = { remaining: MAX_TOTAL_CHANGED_FIELD_BYTES };
  const ordered = [...classification.decisions].sort((a, b) => compare(a.timelineId, b.timelineId) || compare(a.itemId || '', b.itemId || ''));
  for (const decision of ordered) {
    if (decision.status !== 'conflict' || decision.field !== 'existence' || decision.base === null
      || (decision.local === null) === (decision.incoming === null)) continue;
    const deletedBy = decision.local === null ? 'local' : 'incoming';
    const editedBy = deletedBy === 'local' ? 'incoming' : 'local';
    const edited = decision[editedBy];
    if (!decision.base || typeof decision.base !== 'object' || Array.isArray(decision.base)
      || !edited || typeof edited !== 'object' || Array.isArray(edited)) invalid();
    const entityKind = decision.itemId === null ? 'timeline' : 'clip';
    const noun = entityKind === 'timeline' ? 'timeline and its observed contents' : 'clip';
    const incomingDeletes = deletedBy === 'incoming';
    conflicts.push({ timelineId: decision.timelineId, itemId: decision.itemId, field: 'existence',
      rule: 'delete-edit-conflict', deletedBy, editedBy, entityKind,
      ...changedFields(decision.base, edited, budget),
      consequences: {
        'keep-local': {
          action: incomingDeletes ? 'retain-edited' : 'keep-deleted',
          description: incomingDeletes ? `Retain the locally edited ${noun} in this review.`
            : `Keep the local deletion in this review. The incoming ${entityKind} edits would be discarded by a future supported apply.`
        },
        'take-incoming': {
          action: incomingDeletes ? 'delete-edited' : 'restore-edited',
          description: incomingDeletes ? `Record incoming deletion of the locally edited ${noun}. Its represented local changes would be discarded by a future supported apply.`
            : `Record restoring the ${noun} with its observed incoming edits in this review.`
        }
      },
      requiresExplicitChoice: true, safeToApply: false,
      coverageComplete: false
    });
  }
  conflicts.sort((a, b) => compare(a.timelineId, b.timelineId) || compare(a.itemId || '', b.itemId || ''));
  return { schemaVersion: 1, readOnly: true, safeToApply: false, conflicts,
    warnings: ['Deletion never wins automatically over an observed edit. Each conflict requires an explicit review choice.',
      'Changed fields describe represented observations only. Unknown or missing coverage does not establish complete entity equivalence.',
      'Choices record review intent only. No clip, timeline, project file, or media is modified.'] };
}

module.exports = { describeResolveDeletionPolicy, MAX_CHANGED_FIELDS, MAX_CHANGED_FIELD_BYTES, MAX_TOTAL_CHANGED_FIELD_BYTES };
