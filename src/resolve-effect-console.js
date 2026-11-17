'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseEffectObservation } = require('./resolve-effect-observation');
const ID = /^[a-f0-9]{32}$/;

async function createEffectCaptureCommand(projectName) {
  if (typeof projectName !== 'string' || !projectName.trim() || projectName.length > 160 || /[\\/\x00-\x1f\x7f]/.test(projectName)) throw new Error('invalid-effect-capture-project');
  const [base, effects] = await Promise.all(['resolve-internal.lua', 'resolve-effects.lua']
    .map(name => fs.readFile(path.join(__dirname, 'companion', name), 'utf8')));
  const sentinel = 'return { capture_request = capture_request }';
  if (!base.includes(sentinel)) throw new Error('incompatible-effect-capture');
  const line = source => source.split('\n').filter(row => !/^\s*--/.test(row)).join(' ');
  const captureId = randomBytes(16).toString('hex');
  const command = `local ok,err=pcall(function() local base=(function() ${line(base.replace(sentinel, 'return {capture=capture, encode=encode, array=array}'))} end)(); local effects=(function() ${line(effects)} end)(); assert(resolve:GetProjectManager():GetCurrentProject():GetName()==${JSON.stringify(projectName)},'Open the named project'); local s=effects.encode(effects.capture(resolve,base)); assert(#s<=20*1024*1024,'Effect capture too large'); local chunks={};local n=1;while n<=#s do local last=math.min(n+8191,#s);while last<#s and s:byte(last+1)>=128 and s:byte(last+1)<=191 do last=last-1 end;assert(last>=n,'Invalid UTF-8 boundary');chunks[#chunks+1]=s:sub(n,last);n=last+1 end;for index,chunk in ipairs(chunks) do print('FRAMELINE_EFFECT_PART_V1:${captureId}:'..index..':'..#chunks..':'..chunk) end end);if not ok then print('FRAMELINE_EFFECT_ERROR_V1:${captureId}:'..tostring(err)) end`;
  return { captureId, command, readOnly: true, safeToApply: false };
}

function readEffectConsoleResult({ captureId, output } = {}) {
  if (!ID.test(captureId || '') || typeof output !== 'string' || Buffer.byteLength(output) > 24 * 1024 * 1024) throw new Error('invalid-effect-console-result');
  const prefix = `FRAMELINE_EFFECT_PART_V1:${captureId}:`;
  const lines = output.split(/\r?\n/);
  if (lines.some(line => line.startsWith(`FRAMELINE_EFFECT_ERROR_V1:${captureId}:`))) throw new Error('effect-capture-failed');
  const parts = lines.filter(line => line.startsWith(prefix));
  let total = null, bytes = '';
  for (const [index, line] of parts.entries()) {
    const match = /^(\d+):(\d+):(.+)$/.exec(line.slice(prefix.length));
    if (!match || Number(match[1]) !== index + 1 || !Number.isSafeInteger(Number(match[2]))
      || Number(match[2]) < 1 || Number(match[2]) > 2561 || (total !== null && Number(match[2]) !== total)
      || Buffer.byteLength(match[3]) > 8192) throw new Error('invalid-effect-console-parts');
    total = Number(match[2]); bytes += match[3];
  }
  if (!total || parts.length !== total || Buffer.byteLength(bytes) > 20 * 1024 * 1024) throw new Error('incomplete-effect-console-result');
  parseEffectObservation(bytes);
  return `${bytes}\n`;
}

module.exports = { createEffectCaptureCommand, readEffectConsoleResult };
