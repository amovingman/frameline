'use strict';
const { TextDecoder } = require('node:util');
const { createAssetHttpClient } = require('./asset-http-client');
const { fail, exact, id, asset, validateHoldInput, validateRetentionInput, validateReportInput, validatePlanInput } = require('./asset-lifecycle-protocol');
const SAFE = new Set(['asset-lifecycle-invalid', 'asset-lifecycle-version-conflict', 'asset-lifecycle-idempotency-conflict', 'asset-lifecycle-plan-stale',
  'asset-not-found', 'asset-policy-forbidden', 'asset-forbidden', 'forbidden', 'access-token-invalid', 'asset-network-unavailable',
  'asset-origin-invalid', 'asset-response-invalid', 'asset-capacity-exceeded', 'asset-storage-unavailable', 'asset-storage-uncertain']);
function validateLifecycleCliRequest(raw) {
  if (!raw || !['hold-get', 'hold-set', 'hold-release', 'retention-get', 'retention-set', 'report', 'plan'].includes(raw.action)) throw fail('asset-lifecycle-invalid');
  const isHold = raw.action.startsWith('hold-'), withInput = !raw.action.endsWith('-get');
  if (!exact(raw, ['action', 'origin', 'accessToken', 'projectId', ...(isHold ? ['assetId'] : []), ...(withInput ? ['input'] : [])])
    || typeof raw.origin !== 'string' || raw.origin.length > 2048 || typeof raw.accessToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(raw.accessToken) || !id(raw.projectId) || isHold && !asset(raw.assetId)) throw fail('asset-lifecycle-invalid');
  let url; try { url = new URL(raw.origin); } catch { throw fail('asset-origin-invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('asset-origin-invalid');
  let input = raw.input;
  if (raw.action === 'hold-set') {
    if (!exact(input, ['expectedVersion', 'reason', 'until', 'idempotencyKey'])) throw fail('asset-lifecycle-invalid');
    input = validateHoldInput({ ...input, held: true });
  } else if (raw.action === 'hold-release') {
    if (!exact(input, ['expectedVersion', 'idempotencyKey'])) throw fail('asset-lifecycle-invalid');
    input = validateHoldInput({ ...input, held: false, reason: null, until: null });
  } else if (raw.action === 'retention-set') input = validateRetentionInput(input);
  else if (raw.action === 'report') input = validateReportInput(input);
  else if (raw.action === 'plan') input = validatePlanInput(input);
  return { ...structuredClone(raw), origin: url.origin, ...(withInput ? { input } : {}) };
}
async function runAssetLifecycleCli({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, createClient = createAssetHttpClient } = {}) {
  try {
    if (argv.length) throw fail('asset-lifecycle-invalid');
    const chunks = []; let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 64 * 1024) throw fail('asset-lifecycle-invalid'); chunks.push(bytes);
    }
    let raw;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw fail('asset-lifecycle-invalid'); }
    const request = validateLifecycleCliRequest(raw), client = createClient({ origin: request.origin, getAccessToken: () => request.accessToken });
    let result;
    if (request.action === 'hold-get') result = await client.getHold(request.projectId, request.assetId);
    else if (request.action.startsWith('hold-')) result = await client.setHold(request.projectId, request.assetId, request.input);
    else if (request.action === 'retention-get') result = await client.getRetentionPolicy(request.projectId);
    else if (request.action === 'retention-set') result = await client.setRetentionPolicy(request.projectId, request.input);
    else if (request.action === 'report') result = await client.getLifecycleReport(request.projectId, request.input);
    else result = await client.planCleanup(request.projectId, request.input);
    output.write(`${JSON.stringify(result)}\n`); return 0;
  } catch (error) {
    errorOutput.write(`${SAFE.has(error?.code) ? error.code : 'asset-lifecycle-operation-failed'}\n`); return 1;
  }
}
if (require.main === module) runAssetLifecycleCli().then(code => { process.exitCode = code; }, () => {
  process.stderr.write('asset-lifecycle-operation-failed\n'); process.exitCode = 1;
});
module.exports = { validateLifecycleCliRequest, runAssetLifecycleCli };
