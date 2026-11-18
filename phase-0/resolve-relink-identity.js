'use strict';
// Console-only disposable experiment. No desktop mutation endpoint uses this.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { fingerprintFile } = require('../src/local-media-readiness');
const { parseEffectObservation } = require('../src/resolve-effect-observation');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, names) => plain(value) && Object.keys(value).sort().join('|') === names.slice().sort().join('|');
function invalid() { throw new Error('invalid-relink-identity-proof'); }
function validName(name) { return typeof name === 'string' && name.length > 0 && name.length <= 160 && !/[\\/\x00-\x1f\x7f]/.test(name) && !['.', '..'].includes(name) && !/^[a-z]:/i.test(name); }
function validateMedia(media, observation) {
  const references = new Set(observation.snapshot.timelines.flatMap(t => t.items.map(i => i.media_pool_id)).filter(Boolean));
  if (!Array.isArray(media) || !media.length || media.length > 1000 || media.length !== references.size) invalid();
  const seen = new Set(), names = new Set();
  for (const item of media) {
    if (!keys(item, ['mediaPoolId', 'name', 'size', 'sha256']) || !references.has(item.mediaPoolId)
      || seen.has(item.mediaPoolId) || !validName(item.name) || names.has(item.name)
      || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) invalid();
    seen.add(item.mediaPoolId); names.add(item.name);
  }
}
function parseSource(bytes) {
  if ((!Buffer.isBuffer(bytes) && typeof bytes !== 'string') || Buffer.byteLength(bytes) > 20 * 1024 * 1024) invalid();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes));
  const value = parseEffectObservation(text);
  if (value.schemaVersion !== 2 || value.snapshot.project_name !== 'Frameline Relink Identity Proof'
    || value.snapshot.timelines.length !== 1 || !value.items.length
    || value.items.some(item => item.propertyReadStatus !== 'captured' || !Object.keys(item.properties).length)
    || value.tracks.some(track => typeof track.enabled !== 'boolean' || typeof track.locked !== 'boolean')) invalid();
  return value;
}
async function createRelinkIdentityCommand({ observationBytes, media, sourceDirectory, targetDirectory } = {}) {
  const observation = parseSource(observationBytes);
  validateMedia(media, observation);
  for (const directory of [sourceDirectory, targetDirectory]) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) invalid();
  }
  if (path.resolve(sourceDirectory) === path.resolve(targetDirectory)) invalid();
  for (const item of media) for (const directory of [sourceDirectory, targetDirectory]) {
    const identity = await fingerprintFile(path.join(directory, item.name));
    if (identity.size !== item.size || identity.sha256 !== item.sha256) throw new Error('relink-media-content-mismatch');
  }
  const [baseSource, effectSource, spikeSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/companion/resolve-effects.lua'), 'utf8'),
    fs.readFile(path.join(__dirname, 'resolve-relink-identity-spike.lua'), 'utf8')]);
  const sentinel = 'return { capture_request = capture_request }';
  if (!baseSource.includes(sentinel)) throw new Error('incompatible-relink-capture');
  const line = source => source.split('\n').filter(row => !/^\s*--/.test(row)).join(' ');
  const captureId = randomBytes(16).toString('hex');
  const config = `{projectId=${JSON.stringify(observation.snapshot.project_id)},expectedObservation=${JSON.stringify(json(observation))},sourceDirectory=${JSON.stringify(path.resolve(sourceDirectory))},targetDirectory=${JSON.stringify(path.resolve(targetDirectory))},media={${media.map(item => `{mediaPoolId=${JSON.stringify(item.mediaPoolId)},name=${JSON.stringify(item.name)}}`).join(',')}}}`;
  const command = `local ok,err=pcall(function() local base=(function() ${line(baseSource.replace(sentinel, 'return {capture=capture,encode=encode,array=array}'))} end)();local effects=(function() ${line(effectSource)} end)();local spike=(function() ${line(spikeSource)} end)();local result=spike.run(resolve,function()return effects.capture(resolve,base,${propertyCaptureConfig()})end,effects.encode,${config});local bytes=effects.encode(result);assert(#bytes<=20*1024*1024,'Proof result too large');local chunks={};local position=1;while position<=#bytes do local last=math.min(position+3999,#bytes);while last<#bytes and bytes:byte(last+1)>=128 and bytes:byte(last+1)<=191 do last=last-1 end;assert(last>=position,'Invalid UTF-8 boundary');chunks[#chunks+1]=bytes:sub(position,last);position=last+1 end;for index,chunk in ipairs(chunks)do print('FRAMELINE_RELINK_IDENTITY_PART_V1:${captureId}:'..index..':'..#chunks..':'..chunk)end end);if not ok then print('FRAMELINE_RELINK_IDENTITY_ERROR_V1:${captureId}:failed')end`;
  return { captureId, command, sourceSha256: sha(observationBytes), media: structuredClone(media),
    experimental: true, runtimeContentHashGuard: false, safeToApply: false };
}
function readRelinkIdentityResult({ captureId, output, observationBytes, media } = {}) {
  if (!/^[a-f0-9]{32}$/.test(captureId || '') || typeof output !== 'string' || Buffer.byteLength(output) > 24 * 1024 * 1024) invalid();
  const expected = parseSource(observationBytes); validateMedia(media, expected);
  const lines = output.split(/\r?\n/);
  if (lines.some(line => line.startsWith(`FRAMELINE_RELINK_IDENTITY_ERROR_V1:${captureId}:`))) throw new Error('relink-identity-command-failed');
  const prefix = `FRAMELINE_RELINK_IDENTITY_PART_V1:${captureId}:`;
  const parts = lines.filter(line => line.startsWith(prefix)); let total = null, bytes = '';
  for (const [index, line] of parts.entries()) {
    const match = /^(\d+):(\d+):(.+)$/.exec(line.slice(prefix.length));
    if (!match || Number(match[1]) !== index + 1 || Number(match[2]) < 1 || Number(match[2]) > 5248
      || (total !== null && total !== Number(match[2])) || Buffer.byteLength(match[3]) > 4000) invalid();
    total = Number(match[2]); bytes += match[3];
  }
  if (!total || parts.length !== total || Buffer.byteLength(bytes) > 20 * 1024 * 1024) invalid();
  const result = JSON.parse(bytes);
  if (!keys(result, ['schemaVersion', 'operation', 'projectId', 'experimental', 'safeToApply', 'savedAndReopened', 'media', 'observation'])
    || result.schemaVersion !== 1 || result.operation !== 'resolve-relink-identity-result' || result.experimental !== true
    || result.safeToApply !== false || result.savedAndReopened !== true || result.projectId !== expected.snapshot.project_id
    || !Array.isArray(result.media) || result.media.length !== media.length) invalid();
  const byId = new Map(media.map(item => [item.mediaPoolId, item]));
  for (const item of result.media) {
    if (!keys(item, ['mediaPoolId', 'name', 'pathMatches']) || item.pathMatches !== true || byId.get(item.mediaPoolId)?.name !== item.name) invalid();
    byId.delete(item.mediaPoolId);
  }
  if (byId.size || json(parseSource(JSON.stringify(result.observation))) !== json(expected)) throw new Error('relink-observation-changed');
  return { result, resultSha256: sha(bytes), sourceSha256: sha(observationBytes), readOnly: true, safeToApply: false };
}
module.exports = { createRelinkIdentityCommand, readRelinkIdentityResult };
