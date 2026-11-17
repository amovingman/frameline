const { fingerprint } = require('./project-api-contracts');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');

// A revision resolver supplies the immutable, source-bound Resolve snapshot.
// This verifier never infers a clip from a filename or timeline position.
function createResolveAnchorVerifier(resolveRevisionSnapshot) {
  if (typeof resolveRevisionSnapshot !== 'function') throw new TypeError('Revision resolver required');
  return async (projectId, revisionId, anchor) => {
    try {
      const record = await resolveRevisionSnapshot(projectId, revisionId);
      if (!record || record.projectId !== projectId || record.revisionId !== revisionId) return false;
      const snapshot = validateResolveSnapshot(record.snapshot);
      if (record.snapshotHash !== fingerprint(snapshot)) return false;
      if (snapshot.project_id !== projectId) return false;
      const timeline = snapshot.timelines.find(item => item.id === anchor.timelineId);
      if (!timeline) return false;
      if (anchor.kind === 'clip') return timeline.items.some(item => item.id === anchor.clipId);
      if (anchor.kind === 'range') {
        const end = timeline.items.reduce((maximum, item) => Math.max(maximum, item.end_frame), timeline.start_frame);
        return Number.isSafeInteger(anchor.startFrame) && Number.isSafeInteger(anchor.endFrame)
          && anchor.startFrame >= timeline.start_frame && anchor.endFrame > anchor.startFrame && anchor.endFrame <= end;
      }
      return false;
    } catch { return false; }
  };
}

module.exports = { createResolveAnchorVerifier };
