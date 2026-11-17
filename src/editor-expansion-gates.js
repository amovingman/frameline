const ID = /^[a-z][a-z0-9-]{1,63}$/;
const GATES = Object.freeze(['read', 'identity', 'diff', 'write', 'validation', 'recovery']);

// Planning gate only. Evidence must come from a separate editor-specific
// compatibility corpus and copied-project tests; booleans cannot prove safety.
function evaluateEditorCandidate({ firstAdapterReady = false, candidate } = {}) {
  if (!candidate || !ID.test(candidate.id || '') || typeof candidate.editorVersion !== 'string'
    || !candidate.editorVersion.trim() || typeof candidate.os !== 'string' || !candidate.os.trim()) {
    throw new TypeError('Invalid editor candidate');
  }
  const blockers = [];
  if (firstAdapterReady !== true) blockers.push('first-adapter-not-release-ready');
  if (!Array.isArray(candidate.corpus) || candidate.corpus.length === 0
    || candidate.corpus.some(item => typeof item !== 'string' || !ID.test(item))) blockers.push('candidate-corpus-missing');
  for (const gate of GATES) if (candidate.evidence?.[gate] !== 'proven') blockers.push(`${gate}-unproven`);
  return { candidateId: candidate.id, eligibleForImplementation: blockers.length === 0, blockers,
    requiredGates: [...GATES] };
}

function sharedProvenCapabilities(adapters) {
  if (!Array.isArray(adapters) || adapters.length < 2
    || new Set(adapters.map(adapter => adapter?.id)).size !== adapters.length
    || adapters.some(adapter => !ID.test(adapter?.id || '') || adapter.releaseReady !== true
      || !adapter.capabilities || typeof adapter.capabilities !== 'object')) {
    return { ready: false, capabilities: [] };
  }
  const shared = Object.keys(adapters[0].capabilities).filter(capability =>
    adapters.every(adapter => adapter.capabilities[capability] === true));
  return { ready: true, capabilities: shared.sort() };
}

module.exports = { GATES, evaluateEditorCandidate, sharedProvenCapabilities };
