'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseItemStateObservation } = require('./resolve-item-state-observation');
async function createItemStateCaptureCommand(projectName, { maxItems = 50 } = {}) {
  if (typeof projectName !== 'string' || !projectName.trim() || projectName.length > 160 || /[\\/\x00-\x1f\x7f]/.test(projectName)
    || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 200) throw new Error('invalid-item-state-capture-options');
  const [base, effects, state] = await Promise.all(['resolve-internal.lua', 'resolve-effects.lua', 'resolve-item-state.lua']
    .map(name => fs.readFile(path.join(__dirname, 'companion', name), 'utf8')));
  const sentinel = 'return { capture_request = capture_request }';
  if (base.split(sentinel).length !== 2) throw new Error('incompatible-item-state-capture');
  const line = source => source.split('\n').filter(row => !/^\s*--/.test(row)).join(' ');
  const captureId = randomBytes(16).toString('hex');
  const command = `local ok=pcall(function() assert(resolve:GetVersionString()=='21.1.2.10','Unexpected Resolve version');assert(resolve:GetProjectManager():GetCurrentProject():GetName()==${JSON.stringify(projectName)},'Open the named disposable project');local base=(function() ${line(base.replace(sentinel, 'return {capture=capture,encode=encode,array=array}'))} end)();local effects=(function() ${line(effects)} end)();local state=(function() ${line(state)} end)();local s=effects.encode(state.capture(resolve,base,effects.encode,${maxItems}));assert(#s<=2*1024*1024,'Item-state capture exceeds bound');local parts={};local n=1;while n<=#s do local last=math.min(n+8191,#s);while last<#s and s:byte(last+1)>=128 and s:byte(last+1)<=191 do last=last-1 end;assert(last>=n,'Invalid UTF-8 boundary');parts[#parts+1]=s:sub(n,last);n=last+1 end;for index,part in ipairs(parts)do print('FRAMELINE_ITEM_STATE_PART_V1:${captureId}:'..index..':'..#parts..':'..part)end end);if not ok then print('FRAMELINE_ITEM_STATE_ERROR_V1:${captureId}')end`;
  return { captureId, command, maxItems, readOnly: true, safeToApply: false };
}
function readItemStateConsoleResult({ captureId, output } = {}) {
  if (!/^[a-f0-9]{32}$/.test(captureId || '') || typeof output !== 'string' || Buffer.byteLength(output) > 3 * 1024 * 1024) throw new Error('invalid-item-state-console-result');
  const prefix = `FRAMELINE_ITEM_STATE_PART_V1:${captureId}:`;
  const lines = output.split(/\r?\n/);
  if (lines.includes(`FRAMELINE_ITEM_STATE_ERROR_V1:${captureId}`)) throw new Error('item-state-capture-failed');
  const parts = lines.filter(row => row.startsWith(prefix));
  let total = null, bytes = '';
  for (const [index, part] of parts.entries()) {
    const match = /^(\d+):(\d+):(.+)$/.exec(part.slice(prefix.length));
    if (!match || Number(match[1]) !== index + 1 || !Number.isInteger(Number(match[2])) || Number(match[2]) < 1 || Number(match[2]) > 257
      || total !== null && total !== Number(match[2]) || Buffer.byteLength(match[3]) > 8192) throw new Error('invalid-item-state-console-parts');
    total = Number(match[2]); bytes += match[3];
  }
  if (!total || parts.length !== total || Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('incomplete-item-state-console-result');
  parseItemStateObservation(bytes);
  return `${bytes}\n`;
}
module.exports = { createItemStateCaptureCommand, readItemStateConsoleResult };
