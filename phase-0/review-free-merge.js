// Read-only conflict review for named Resolve Free schema-3 captures.
const fs = require('node:fs');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { parseResolvePreviewSource } = require('../src/resolve-preview-source');
const { assessResolveRiskGates } = require('../src/resolve-risk-gates');
const { createResolveConflictReview, createResolveDecisionAudit, verifyResolveDecisionAudit } = require('../src/resolve-review-decisions');

const MAX_BYTES = 20 * 1024 * 1024;
function readBytes(selectedPath, maximum = MAX_BYTES) {
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile() || stat.size > maximum) throw new Error('invalid-input');
  const bytes = fs.readFileSync(selectedPath);
  if (bytes.length > maximum || bytes.length !== stat.size) throw new Error('invalid-input');
  return bytes;
}
const readJson = selectedPath => JSON.parse(readBytes(selectedPath, 32 * 1024 * 1024).toString('utf8'));
const sources = (base, local, incoming) => ({ base: readBytes(base), local: readBytes(local), incoming: readBytes(incoming) });

function riskSnapshotFiles(base, local, incoming) {
  const input = sources(base, local, incoming);
  const plan = createResolvePreviewPlan(input);
  const manifests = Object.fromEntries(Object.entries(input).map(([role, bytes]) =>
    [role, parseResolvePreviewSource(bytes).normalized]));
  return assessResolveRiskGates(plan.classification, manifests);
}
function reviewSnapshotFiles(planPath, base, local, incoming) {
  return createResolveConflictReview(readJson(planPath), sources(base, local, incoming));
}
function auditSnapshotFiles(planPath, decisionsPath, base, local, incoming) {
  return createResolveDecisionAudit(readJson(planPath), sources(base, local, incoming), readJson(decisionsPath));
}
function verifyAuditFiles(auditPath, planPath, base, local, incoming) {
  return verifyResolveDecisionAudit(readJson(auditPath), readJson(planPath), sources(base, local, incoming));
}

if (require.main === module) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const result = mode === 'risk' && args.length === 3 ? riskSnapshotFiles(...args)
      : mode === 'review' && args.length === 4 ? reviewSnapshotFiles(...args)
        : mode === 'audit' && args.length === 5 ? auditSnapshotFiles(...args)
          : mode === 'verify-audit' && args.length === 5 ? verifyAuditFiles(...args)
            : (() => { throw new Error('usage'); })();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message === 'usage' ? 'usage' : 'invalid-or-stale-review'}\n`);
    process.exitCode = 1;
  }
}

module.exports = { riskSnapshotFiles, reviewSnapshotFiles, auditSnapshotFiles, verifyAuditFiles };
