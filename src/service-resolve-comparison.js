'use strict';
const { createHash } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { bindServiceComparisonSources } = require('./service-comparison-sources');
const { validateResolveRevisionManifest } = require('./resolve-revision-manifest');
const { createResolvePreviewPlan } = require('./resolve-preview-plan');

const MAX_SOURCE_BYTES = 20 * 1024 * 1024, MAX_PLAN_BYTES = 31 * 1024 * 1024;
const ROLES = ['base', 'local', 'incoming'];
const fail = suffix => Object.assign(new Error(`service-resolve-comparison-${suffix}`), { code: `service-resolve-comparison-${suffix}` });
const sha = value => createHash('sha256').update(value).digest('hex');
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
  });

function validateVerification(value, now) {
  if (exact(value, ['mode']) && value.mode === 'saved-head') return { mode: 'saved-head' };
  if (!exact(value, ['mode', 'generation', 'requestId', 'requestSha256', 'acceptedAt']) || value.mode !== 'verified-capture'
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || typeof value.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(value.requestId)
    || typeof value.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestSha256) || !time(value.acceptedAt)) throw fail('verification-invalid');
  let at; try { at = now(); } catch { throw fail('verification-invalid'); }
  if (!time(at)) throw fail('verification-invalid');
  if (at < value.acceptedAt || at - value.acceptedAt > 300000) throw fail('capture-expired');
  return structuredClone(value);
}

// The service witness binds history; this local receipt binds only an accepted
// capture generation. Neither is executable authority for an editor mutation.
function createServiceResolveComparison(input, verification, options = {}) {
  if (!exact(options, Object.hasOwn(options || {}, 'now') ? ['now'] : []) || options.now !== undefined && typeof options.now !== 'function') throw fail('verification-invalid');
  const localVerification = validateVerification(verification, options.now || Date.now);
  const bound = bindServiceComparisonSources(input);
  const documents = Object.fromEntries(ROLES.map(role => [role, bound[role]]));
  if (Object.values(documents).some(value => value?.format !== 'resolve-api-observation')) throw fail('unsupported');
  try { for (const value of Object.values(documents)) validateResolveRevisionManifest(value); }
  catch { throw fail('invalid'); }
  const snapshot = bound.base.snapshot;
  if ([bound.local, bound.incoming].some(value => value.snapshot.project_id !== snapshot.project_id
    || value.snapshot.resolve_version !== snapshot.resolve_version)) throw fail('invalid');
  const head = input.bundle.records.find(item => item.summary.id === bound.binding.localHead);
  let headManifest;
  try { headManifest = JSON.parse(head.bytes).manifest; validateResolveRevisionManifest(headManifest); }
  catch { throw fail('invalid'); }
  if (headManifest.snapshot.project_id !== snapshot.project_id || headManifest.snapshot.resolve_version !== snapshot.resolve_version
    || localVerification.mode === 'saved-head' && fingerprint(headManifest) !== fingerprint(bound.local)) throw fail('verification-invalid');

  const sources = Object.fromEntries(ROLES.map(role => {
    const value = documents[role];
    // Legacy trial manifests hash their snapshot separately. Preserve the exact
    // richer after-observation bytes rather than reserializing or dropping them.
    const bytes = value.observation ? JSON.stringify(value.observation)
      : value.transactionAudit?.effects ? value.transactionAudit.effects.after : JSON.stringify(value.snapshot);
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_SOURCE_BYTES) throw fail('too-large');
    return [role, bytes];
  }));
  let plan;
  try { plan = createResolvePreviewPlan(sources); } catch { throw fail('invalid'); }
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_BYTES) throw fail('too-large');
  const binding = { ...bound.binding, localVerification, sourceHashes: Object.fromEntries(ROLES.map(role => [role, sha(sources[role])])) };
  const payload = { readOnly: true, safeToApply: false, binding, sources, plan };
  return { id: `sha256:${fingerprint(payload)}`, ...payload };
}

module.exports = { createServiceResolveComparison };
