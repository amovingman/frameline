'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomBytes } = require('node:crypto');

const MENU_NAME = 'Frameline Read Only Capture.py';
function fail() { const error = new Error('resolve-menu-companion-invalid'); error.code = 'resolve-menu-companion-invalid'; throw error; }

function menuSource(scriptPath, pointerPath) {
  return Buffer.from(`"""Frameline read-only Resolve capture. Run from Workspace > Scripts > Utility."""\n`
    + `from pathlib import Path\nimport runpy\nimport stat\n\n`
    + `_pointer = Path(${JSON.stringify(pointerPath)})\n`
    + `_script = Path(${JSON.stringify(scriptPath)})\n`
    + `if _pointer.is_symlink() or not _pointer.is_file():\n    raise ValueError('No active Frameline request')\n`
    + `_info = _pointer.stat()\n`
    + `if not stat.S_ISREG(_info.st_mode) or _info.st_mode & 0o077 or _info.st_size < 1 or _info.st_size > 1024:\n`
    + `    raise ValueError('Invalid Frameline request pointer')\n`
    + `_request = _pointer.read_text(encoding='utf-8').strip()\n`
    + `if not _request or '\\n' in _request:\n    raise ValueError('Invalid Frameline request pointer')\n`
    + `_result = runpy.run_path(str(_script))['capture_request'](resolve, _request)\n`
    + `print('Frameline read-only capture written:', _result['responseWritten'])\n`);
}

async function verifyFile(filename, expected) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size !== expected.length) fail();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { if (!(await handle.readFile()).equals(expected)) fail(); }
  finally { await handle.close(); }
}

async function installResolveMenuCompanion({ scriptsDirectory, scriptPath, pointerPath } = {}) {
  if (![scriptsDirectory, scriptPath, pointerPath].every(value => typeof value === 'string' && path.isAbsolute(value))) fail();
  const utility = path.join(scriptsDirectory, 'Utility');
  await fs.mkdir(utility, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(scriptsDirectory);
  const stat = await fs.lstat(utility);
  if (!rootStat.isDirectory() || !stat.isDirectory()
    || (await fs.realpath(utility)) !== path.join(await fs.realpath(scriptsDirectory), 'Utility')) fail();
  const filename = path.join(utility, MENU_NAME);
  const source = menuSource(scriptPath, pointerPath);
  let installed = false;
  try { await fs.writeFile(filename, source, { flag: 'wx', mode: 0o600 }); installed = true; }
  catch (error) { if (error.code !== 'EEXIST') fail(); await verifyFile(filename, source); }
  return { installed, menuName: 'Frameline Read Only Capture' };
}

async function activateResolveMenuRequest({ pointerPath, requestFile, requestsDirectory } = {}) {
  if (![pointerPath, requestFile, requestsDirectory].every(value => typeof value === 'string' && path.isAbsolute(value))
    || path.dirname(pointerPath) !== path.dirname(requestsDirectory)
    || path.dirname(requestFile) !== requestsDirectory
    || !/^[a-f0-9]{32}\.request\.json$/.test(path.basename(requestFile))) fail();
  const directory = path.dirname(pointerPath);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) fail();
  const requestStat = await fs.lstat(requestFile);
  if (!requestStat.isFile() || requestStat.mode & 0o077 || requestStat.size < 1 || requestStat.size > 4096) fail();
  const temporary = path.join(directory, `.active-${randomBytes(8).toString('hex')}`);
  try {
    await fs.writeFile(temporary, `${requestFile}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, pointerPath);
  } catch { await fs.rm(temporary, { force: true }); fail(); }
  return pointerPath;
}

function createLuaCaptureCommand({ luaScriptPath, luaSource, request, expectedProjectName } = {}) {
  if (typeof luaScriptPath !== 'string' || !path.isAbsolute(luaScriptPath)
    || typeof luaSource !== 'string' || !luaSource.includes('return { capture_request = capture_request }')
    || !request || typeof request.requestFile !== 'string' || !path.isAbsolute(request.requestFile)
    || path.dirname(request.requestFile) !== path.join(path.dirname(luaScriptPath), 'requests')
    || path.basename(request.requestFile) !== `${request.requestId}.request.json`
    || !/^[a-f0-9]{32}$/.test(request.requestId || '')
    || !/^[a-f0-9]{64}$/.test(request.requestSha256 || '')
    || !Number.isSafeInteger(request.expiresAt) || request.expiresAt < 0
    || typeof expectedProjectName !== 'string' || !expectedProjectName.trim()
    || /[\\/\x00-\x1f\x7f]/.test(expectedProjectName)) fail();
  const oneLineSource = luaSource.split('\n').filter(line => !/^\s*--/.test(line)).join(' ');
  return `local ok,err=pcall(function() local companion=(function() ${oneLineSource} end)(); companion.capture_request(resolve, ${JSON.stringify(request.requestId)}, ${JSON.stringify(request.requestSha256)}, ${JSON.stringify(expectedProjectName)}, ${request.expiresAt}) end); if not ok then print('FRAMELINE_CAPTURE_ERROR_V1:'..tostring(err)) end`;
}

module.exports = { installResolveMenuCompanion, activateResolveMenuRequest,
  createLuaCaptureCommand };
