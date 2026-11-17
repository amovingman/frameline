function decision(required) {
  const blockers = Object.entries(required).filter(([, proven]) => proven !== true).map(([name]) => `${name}-unproven`);
  return { eligibleForResearchPrototype: blockers.length === 0, blockers, productEnabled: false };
}

// Evidence gates only; these do not start a collaborative editor session or
// send media to a renderer. Each capability requires a separate product scope.
function assessLiveCoediting(evidence = {}) {
  return decision({ firstAdapterReliable: evidence.firstAdapterReliable,
    stableIdentity: evidence.stableIdentity, editorEventApi: evidence.editorEventApi,
    transactionalRecovery: evidence.transactionalRecovery, userResearch: evidence.userResearch });
}
function assessCloudRendering(evidence = {}) {
  return decision({ explicitOptIn: evidence.explicitOptIn, mediaRights: evidence.mediaRights,
    processorContract: evidence.processorContract, dataRegion: evidence.dataRegion,
    costLimit: evidence.costLimit, outputProvenance: evidence.outputProvenance });
}

module.exports = { assessLiveCoediting, assessCloudRendering };
