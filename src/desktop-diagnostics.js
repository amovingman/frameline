const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDiagnosticsReport, diagnosticsOptions } = require('./diagnostics-report');

function createDesktopDiagnostics({ getInput, chooseDestination, storage = fs }) {
  let reviewed = null, busy = false;
  const current = options => createDiagnosticsReport({ ...getInput(), options });
  function preview(options) {
    const selected = diagnosticsOptions(options);
    const result = current(selected);
    reviewed = { ...result, options: selected, reviewId: randomUUID() };
    return { report: result.report, sha256: result.sha256, reviewId: reviewed.reviewId };
  }
  async function exportReviewed(input = {}) {
    if (busy) return { saved: false, error: 'diagnostics-busy' };
    const review = reviewed;
    if (!review || input?.confirmed !== true || input.reviewId !== review.reviewId || input.sha256 !== review.sha256)
      return { saved: false, error: 'diagnostics-review-required' };
    busy = true;
    let temporary = null;
    try {
      const valid = () => reviewed === review && current(review.options).sha256 === review.sha256;
      if (!valid()) return { saved: false, error: 'diagnostics-changed' };
      const destination = await chooseDestination();
      if (!destination) return { saved: false, cancelled: true };
      if (!valid()) return { saved: false, error: 'diagnostics-changed' };
      const candidate = path.join(path.dirname(destination), `.frameline-diagnostics-${randomUUID()}.tmp`);
      const file = await storage.open(candidate, 'wx', 0o600);
      temporary = candidate;
      try { await file.writeFile(review.bytes); await file.sync(); }
      finally { await file.close(); }
      if (!valid()) return { saved: false, error: 'diagnostics-changed' };
      // Publish a complete private file without replacing an existing path. A
      // write or fsync failure leaves only our temporary sibling to clean up.
      await storage.link(temporary, destination);
      reviewed = null;
      return { saved: true, sha256: review.sha256, byteLength: review.bytes.length };
    } catch { return { saved: false, error: 'diagnostics-save-failed' }; }
    finally {
      if (temporary) await storage.unlink(temporary).catch(() => {});
      busy = false;
    }
  }
  return { preview, exportReviewed };
}
module.exports = { createDesktopDiagnostics };
