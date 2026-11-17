const { createHash } = require('node:crypto');

function fail(code) { const error = new Error(code); error.code = code; return error; }

// Rendering is supplied by an editor or licensed media provider. This worker
// never creates a preview when rights or the provider are unavailable.
function createMediaPreviewHandlers({ renderThumbnail, renderTimeline, savePreview } = {}) {
  async function render(kind, job, controls) {
    if (job.options?.rightsConfirmed !== true) throw fail('preview-rights-required');
    const provider = kind === 'thumbnail' ? renderThumbnail : renderTimeline;
    if (typeof provider !== 'function' || typeof savePreview !== 'function') throw fail('preview-provider-unavailable');
    const output = await provider(job, controls);
    if (!output || !Buffer.isBuffer(output.bytes) || output.bytes.length < 1
      || output.bytes.length > 4 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(output.mimeType)) throw fail('preview-output-invalid');
    const digest = createHash('sha256').update(output.bytes).digest('hex');
    const stored = await savePreview({ projectId: job.projectId, sourceId: job.sourceId,
      mimeType: output.mimeType, bytes: output.bytes, sha256: digest, canonical: false });
    if (!stored || typeof stored.id !== 'string' || !stored.id) throw fail('preview-storage-invalid');
    return { previewId: stored.id, sha256: digest, mimeType: output.mimeType, canonical: false };
  }
  return { thumbnail: (job, controls) => render('thumbnail', job, controls),
    'timeline-preview': (job, controls) => render('timeline-preview', job, controls) };
}

module.exports = { createMediaPreviewHandlers };
