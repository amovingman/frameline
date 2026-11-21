'use strict';

// Main-process projection of authenticated local transaction revisions. It
// never accepts a renderer completion claim, writes an event, or contacts a
// service. Retrying or restarting projects the same deterministic event IDs.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROJECT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_TRANSACTIONS = 1000, PAGE_SIZE = 20;
const fail = () => Object.assign(new Error('local-pull-activity-unverified'), { code: 'local-pull-activity-unverified' });
const need = value => { if (!value) throw fail(); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => isDeepStrictEqual(a, b);

function projectRecord(record) {
  need(record && UUID.test(record.transactionId || '') && record.plan?.schemaVersion === 1
    && record.plan.operation === 'closed-project-name-apply-plan'
    && record.plan.adapterProfile === 'resolve-free-21.1.2-closed-name-v1'
    && SHA.test(record.plan.planId || '') && PROJECT.test(record.plan.projectId || '')
    && SHA.test(record.plan.review?.planHash || '') && SHA.test(record.plan.review?.auditHash || '')
    && Array.isArray(record.plan.review?.choices) && record.plan.sourceBindings
    && record.plan.edit?.kind === 'video' && record.plan.edit.field === 'Name'
    && SHA.test(record.source?.sha256 || '') && record.source.sha256 === record.plan.source?.sha256
    && Number.isSafeInteger(record.source.bytes) && record.source.bytes > 0
    && Number.isSafeInteger(record.journal?.events) && record.journal.events > 0 && SHA.test(record.journal.head || ''));
  const revisions = record.nativeRevisions || [];
  need(Array.isArray(revisions) && revisions.length <= 2);
  if (!revisions.length) { need(!record.resultingRevision); return []; }
  need(same(record.resultingRevision, revisions.at(-1))
    && SHA.test(record.candidate?.sha256 || '') && record.candidate.sha256 !== record.source.sha256
    && SHA.test(record.backup?.sha256 || '') && record.backup.sha256 === record.source.sha256
    && record.backup.bytes === record.source.bytes);
  const seen = new Set();
  return revisions.map((revision, index) => {
    const restored = revision.direction === 'rollback', expected = restored ? record.source : record.candidate;
    need(revision.schemaVersion === 1 && revision.kind === 'closed-project-native-revision'
      && ['apply', 'rollback'].includes(revision.direction) && !seen.has(revision.direction)
      && (index === 0 ? revision.direction === 'apply' : revision.direction === 'rollback')
      && revision.transactionId === record.transactionId && revision.planId === record.plan.planId
      && SHA.test(revision.revisionId || '') && revision.revisionId === expected.sha256
      && revision.sourceSha256 === revision.revisionId && revision.bytes === expected.bytes
      && revision.parentSourceSha256 === (restored ? record.candidate.sha256 : record.source.sha256)
      && same(revision.review, { planHash: record.plan.review.planHash, auditHash: record.plan.review.auditHash,
        choices: record.plan.review.choices, sourceBindings: record.plan.sourceBindings })
      && same(revision.backup, { path: record.backup.path, sha256: record.backup.sha256, bytes: record.backup.bytes })
      && SHA.test(revision.editorProofSha256 || '') && typeof revision.createdAt === 'string');
    const at = Date.parse(revision.createdAt);
    need(Number.isSafeInteger(at) && at >= 0 && new Date(at).toISOString() === revision.createdAt);
    seen.add(revision.direction);
    // These immutable fields identify one verified effect, independent of how
    // often the source journal is read or a view is refreshed.
    const binding = { transactionId: record.transactionId, direction: revision.direction,
      revisionId: revision.revisionId, planId: revision.planId, editorProofSha256: revision.editorProofSha256 };
    return { id: hash(binding), projectId: record.plan.projectId, actorId: 'local-owner',
      type: restored ? 'pull.restored' : 'pull.completed', subjectId: revision.revisionId, at,
      transactionId: record.transactionId, direction: revision.direction, revisionId: revision.revisionId,
      parentSourceSha256: revision.parentSourceSha256, planId: revision.planId,
      editorProofSha256: revision.editorProofSha256, scope: 'local-native-project', delivery: 'local-only' };
  });
}

function createClosedProjectPullActivity({ transactionService } = {}) {
  need(transactionService && ['listTransactionIds', 'inspect'].every(key => typeof transactionService[key] === 'function'));
  let records = [], shown = PAGE_SIZE, version = 0;
  let state = { status: 'loading', scope: 'local-native-project', delivery: 'local-only', items: [], total: 0,
    hasMore: false, error: null };
  function getState() { return structuredClone(state); }
  function display() { state = { ...state, items: records.slice(0, shown), total: records.length, hasMore: shown < records.length }; return getState(); }
  async function refresh() {
    const generation = ++version;
    try {
      const ids = await transactionService.listTransactionIds();
      need(Array.isArray(ids) && ids.length <= MAX_TRANSACTIONS && new Set(ids).size === ids.length
        && ids.every(id => UUID.test(id)));
      const next = [];
      for (const id of ids) {
        const record = await transactionService.inspect(id); need(record.transactionId === id);
        next.push(...projectRecord(record));
      }
      need(new Set(next.map(item => item.id)).size === next.length);
      if (generation !== version) return getState();
      records = next.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id, 'en'));
      state = { ...state, status: 'ready', error: null }; return display();
    } catch {
      if (generation !== version) return getState();
      records = []; state = { ...state, status: 'unavailable', items: [], total: 0, hasMore: false,
        error: 'local-pull-activity-unverified' }; return getState();
    }
  }
  function loadOlder() {
    if (state.status !== 'ready') return getState();
    shown = Math.min(MAX_TRANSACTIONS * 2, shown + PAGE_SIZE); return display();
  }
  return Object.freeze({ getState, refresh, loadOlder });
}
module.exports = { createClosedProjectPullActivity };
