'use strict';
const { createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const expected = require('../src/resolve-property-contract.json').referenceSha256;
const reference = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/DaVinciResolveScript.pyi';

function inspectApi(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024) throw new Error('invalid-api-reference');
  const referenceSha256 = createHash('sha256').update(bytes).digest('hex');
  if (referenceSha256 !== expected) throw new Error('api-reference-changed');
  const text = bytes.toString('utf8');
  const classes = Object.create(null);
  let current;
  for (const line of text.split('\n')) {
    const cls = /^class ([A-Za-z0-9_]+)(?:\([^)]*\))?:/.exec(line);
    if (cls) { current = cls[1]; classes[current] = []; }
    const method = /^\s+def ([A-Za-z0-9_]+)\(/.exec(line);
    if (method && current) classes[current].push(method[1]);
  }
  for (const name of ['Project', 'Timeline', 'TimelineItem', 'Effect']) if (!classes[name]?.length) throw new Error('api-class-missing');
  const methods = Object.fromEntries(['Project', 'Timeline', 'TimelineItem', 'Effect'].map(name => [name, classes[name].sort()]));
  return { schemaVersion: 1, readOnly: true, safeToApply: false, referenceSha256, methods,
    documentedTrackIdentityAccessor: methods.Timeline.filter(name => /Track.*(?:UniqueId|UUID)|(?:UniqueId|UUID).*Track/.test(name)),
    documentedEffectParameterAccessors: methods.Effect.filter(name => /Param/.test(name)),
    documentedEffectInstanceIdentityAccessors: methods.Effect.filter(name => /UniqueId|UUID/.test(name)),
    limitations: ['Documentation inventory is not a runtime capability probe.', 'Absence in this pinned reference does not prove absence in every edition or build.'] };
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(inspectApi(readInput(process.argv[2] || reference)), null, 2)}\n`); }
  catch { process.stderr.write('resolve-api-inspection-failed\n'); process.exitCode = 1; }
}
module.exports = { inspectApi, reference };
