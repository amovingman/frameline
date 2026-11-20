'use strict';
const { createHash } = require('node:crypto');
const { validateTransferBundle } = require('./revision-transfer');
const { fingerprint } = require('./project-api-contracts');
const PAGE_CHARS = 6000, MAX_BYTES = 64 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });

// This projection contains the user metadata the sync executor submits. Session
// headers and derived retry keys are excluded from the displayed document.
function describePublication(source) {
  const publications = source.payloads.map(payload => {
    const records = validateTransferBundle(payload.bundle);
    const selected = []; let id = payload.bundle.branches[payload.branch];
    while (id) { const record = records.get(id); if (!record) throw fail('publication-review-invalid'); selected.push(record); id = record.parentRevisionId; }
    return { projectId: payload.remoteProjectId, branch: source.remoteBranch,
      revisions: selected.reverse().map(record => ({ sourceRevisionId: record.id,
        parentSourceRevisionId: record.parentRevisionId, message: record.message, manifest: record.manifest })) };
  });
  const document = { schemaVersion: 1, destination: source.origin, publications, mediaBytesIncluded: false,
    authentication: 'The signed-in account authorizes HTTPS requests to this service. Credentials are not included in this review.' };
  const text = `${JSON.stringify(document, null, 2)}\n`, bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) throw fail('publication-review-too-large');
  return { text, sha256: createHash('sha256').update(text).digest('hex'), sourceHash: fingerprint(source),
    byteLength: bytes, pageCount: Math.max(1, Math.ceil(text.length / PAGE_CHARS)),
    revisionCount: publications.reduce((sum, item) => sum + item.revisions.length, 0),
    payloadHashes: source.payloads.map(payload => fingerprint(payload)) };
}
function publicationPage(review, page) {
  if (!Number.isSafeInteger(page) || page < 0 || page >= review.pageCount) throw fail('publication-review-invalid');
  let start = page * PAGE_CHARS, end = (page + 1) * PAGE_CHARS;
  const lowSurrogate = index => review.text.charCodeAt(index) >= 0xdc00 && review.text.charCodeAt(index) <= 0xdfff;
  if (start && lowSurrogate(start)) start--;
  if (lowSurrogate(end)) end--;
  return { page, pageCount: review.pageCount, text: review.text.slice(start, end) };
}
module.exports = { describePublication, publicationPage };
