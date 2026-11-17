const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyCandidate } = require('./local-media-readiness');
function fail(code) { const error = new Error(code); error.code = code; return error; }

// Verifies a user-selected file inside one canonical mounted root. Returns no
// location and performs no project relink or upload.
async function verifySharedStorageCandidate({ root, candidate, expected } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof candidate !== 'string'
    || !path.isAbsolute(candidate)) throw fail('shared-storage-invalid');
  let canonicalRoot;
  let rootStat;
  try { canonicalRoot = await fs.realpath(root); rootStat = await fs.stat(canonicalRoot); }
  catch { throw fail('shared-storage-unavailable'); }
  if (canonicalRoot !== path.resolve(root) || !rootStat.isDirectory()) throw fail('shared-storage-invalid');
  const relative = path.relative(canonicalRoot, path.resolve(candidate));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('shared-storage-outside-root');
  const result = await verifyCandidate(candidate, expected);
  return { verified: result.verified, reason: result.reason, withinSelectedRoot: true };
}

module.exports = { verifySharedStorageCandidate };
