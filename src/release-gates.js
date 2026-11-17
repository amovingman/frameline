const { createHash, verify } = require('node:crypto');
function fail(code) { const error = new Error(code); error.code = code; return error; }
const SHA = /^[a-f0-9]{64}$/;
function verifyInstallerEvidence(evidence, { platform, teamId } = {}) {
  if (!evidence || evidence.platform !== platform || !['darwin', 'win32'].includes(platform)
    || !SHA.test(evidence.sha256 || '') || evidence.signed !== true
    || platform === 'darwin' && (evidence.notarized !== true || evidence.teamId !== teamId || !teamId)
    || platform === 'win32' && evidence.authenticodeVerified !== true) throw fail('release-artifact-untrusted');
  return { releaseReady: true, platform, sha256: evidence.sha256 };
}
function versionParts(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw fail('update-version-invalid');
  return version.split('.').map(Number);
}
function verifyUpdateManifest({ manifest, signature, publicKey, currentVersion, installId, channel = 'stable' }) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof signature !== 'string' || !publicKey
    || typeof installId !== 'string' || !installId || !['stable', 'beta'].includes(channel)) throw fail('update-manifest-invalid');
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (!verify(null, bytes, publicKey, Buffer.from(signature, 'base64'))) throw fail('update-signature-invalid');
  let url;
  try { url = new URL(manifest.url); }
  catch { throw fail('update-manifest-invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || !SHA.test(manifest.sha256 || '')
    || manifest.channel !== channel || !Number.isSafeInteger(manifest.rolloutPercent)
    || manifest.rolloutPercent < 0 || manifest.rolloutPercent > 100) throw fail('update-manifest-invalid');
  const current = versionParts(currentVersion), next = versionParts(manifest.version);
  const newer = next.some((part, i) => part > current[i] && next.slice(0, i).every((value, j) => value === current[j]));
  const bucket = Number.parseInt(createHash('sha256').update(installId).digest('hex').slice(0, 8), 16) % 100;
  return { eligible: newer && bucket < manifest.rolloutPercent, version: manifest.version,
    channel, rolloutPercent: manifest.rolloutPercent, requiresSignedArtifact: true };
}
module.exports = { verifyInstallerEvidence, verifyUpdateManifest };
