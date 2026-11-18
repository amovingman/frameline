'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
  const source = `io.stderr:write('mock:lua-start\\n');io.stderr:flush();local initial=${lua(observation)};local options=${lua(options)};io.stderr:write('mock:fixture-start\\n');io.stderr:flush();${fixture}\n`
    + `hostIO.stderr:write('mock:command-start\\n');hostIO.stderr:flush();local ok,err=pcall(function() ${command} end);hostIO.stderr:write('mock:command-done\\n');hostIO.stderr:flush();local commandCounters=copy(counters);local commandOpen=opened;`
    + `local base=(function() ${base} end)();local effects=(function() ${supplement} end)();`
    + `local current=nil;if opened then current=effects.capture(resolve,base,${propertyCaptureConfig()}) end;hostIO.stderr:write('mock:current-captured\\n');hostIO.stderr:flush();`
    + `local old=working;working=copy(saved);opened=true;local savedObservation=effects.capture(resolve,base,${propertyCaptureConfig()});working=old;opened=commandOpen;`
    + `hostPrint('FRAMELINE_FAKE_RESULT:'..effects.encode({ok=ok,error=ok and '' or tostring(err),counters=commandCounters,opened=commandOpen,observation=current or {},saved=savedObservation}));`;
  const bootstrap = `import sys, runpy, ctypes\nsys.stderr.write('mock:python-start\\n'); sys.stderr.flush()\noriginal_cdll = ctypes.CDLL\ndef traced_cdll(*args, **kwargs):\n sys.stderr.write('mock:library-start\\n'); sys.stderr.flush()\n result = original_cdll(*args, **kwargs)\n sys.stderr.write('mock:library-done\\n'); sys.stderr.flush()\n return result\nctypes.CDLL = traced_cdll\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name='__main__')`;
  // A regular stdin file gives the bounded Python reader a deterministic EOF.
  // Large synchronous input pipes intermittently stalled before library load.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'resolve-command-input-'));
  let descriptor, run;
  try {
    fs.chmodSync(root, 0o700);
    const filename = path.join(root, 'command.lua'); fs.writeFileSync(filename, source, { mode: 0o600 });
    descriptor = fs.openSync(filename, 'r');
    run = spawnSync('python3', ['-c', bootstrap, path.join(__dirname, '../../../phase-0/run-lua-observation-mock.py'), library],
      { stdio: [descriptor, 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (run.status !== 0) throw Object.assign(new Error('resolve-editor-mock-failed'), { code: 'resolve-editor-mock-failed',
    details: { error: run.error?.code || null, signal: run.signal, stages: run.stderr } });
  const lines = run.stdout.trimEnd().split('\n'), marker = lines.find(line => line.startsWith('FRAMELINE_FAKE_RESULT:'));
  if (!marker) throw new Error('resolve-editor-mock-result-missing');
  return { ...JSON.parse(marker.slice('FRAMELINE_FAKE_RESULT:'.length)), consoleOutput: lines.filter(line => !line.startsWith('FRAMELINE_FAKE_RESULT:')).join('\n') };
}
module.exports = { executeCommand, library };
