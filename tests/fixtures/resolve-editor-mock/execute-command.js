'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { propertyCaptureConfig } = require('../../../src/resolve-property-observation');
const library = process.env.FRAMELINE_LUA_LIBRARY || '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
function lua(value) {
  if (value === null || value === undefined) return 'nil';
  if (Array.isArray(value)) return `{${value.map(lua).join(',')}}`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${lua(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function executeCommand(command, observation, options = {}) {
  options = { noIo: true, ...options };
  const base = fs.readFileSync(path.join(__dirname, '../../../src/companion/resolve-internal.lua'), 'utf8')
    .replace('return { capture_request = capture_request }', 'return {capture=capture,encode=encode,array=array}');
  const supplement = fs.readFileSync(path.join(__dirname, '../../../src/companion/resolve-effects.lua'), 'utf8');
  const fixture = fs.readFileSync(path.join(__dirname, 'fake-editor.lua'), 'utf8');
  const source = `local initial=${lua(observation)};local options=${lua(options)};${fixture}\n`
    + `local ok,err=pcall(function() ${command} end);local commandCounters=copy(counters);local commandOpen=opened;`
    + `local base=(function() ${base} end)();local effects=(function() ${supplement} end)();`
    + `local current=nil;if opened then current=effects.capture(resolve,base,${propertyCaptureConfig()}) end;`
    + `local old=working;working=copy(saved);opened=true;local savedObservation=effects.capture(resolve,base,${propertyCaptureConfig()});working=old;opened=commandOpen;`
    + `print('FRAMELINE_FAKE_RESULT:'..effects.encode({ok=ok,error=ok and '' or tostring(err),counters=commandCounters,opened=commandOpen,observation=current or {},saved=savedObservation}));`;
  const run = spawnSync('python3', [path.join(__dirname, '../../../phase-0/run-lua-observation-mock.py'), library],
    { input: source, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
  if (run.status !== 0) throw Object.assign(new Error('resolve-editor-mock-failed'), { code: 'resolve-editor-mock-failed', details: run.stderr });
  const lines = run.stdout.trimEnd().split('\n'), marker = lines.find(line => line.startsWith('FRAMELINE_FAKE_RESULT:'));
  if (!marker) throw new Error('resolve-editor-mock-result-missing');
  return { ...JSON.parse(marker.slice('FRAMELINE_FAKE_RESULT:'.length)), consoleOutput: lines.filter(line => !line.startsWith('FRAMELINE_FAKE_RESULT:')).join('\n') };
}
module.exports = { executeCommand, library };
