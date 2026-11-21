'use strict';
// A one-use readback of an already-open project. It proves only the observed
// editor identity and Name; final closed-file validation remains a separate gate.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomBytes, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
// Lua 5.1 does not implement JSON's \u escape. Byte escapes preserve UTF-8 and
// prevent names or filesystem paths from becoming Lua source.
const q = value => '"' + [...Buffer.from(value)].map(byte => `\\${String(byte).padStart(3, '0')}`).join('') + '"';
const need = (value, code) => { if (!value) throw Object.assign(new Error(`closed-apply-companion-${code}`), { code: `closed-apply-companion-${code}` }); };
const keys = ['transactionId', 'planId', 'projectId', 'projectName', 'timelineId', 'itemId',
  'expectedName', 'expectedDatabaseSha256', 'timelineIds', 'sourceBinding'];

function binding(input) {
  need(input && typeof input === 'object', 'input');
  for (const key of ['transactionId', 'projectId', 'timelineId', 'itemId']) need(UUID.test(input[key] || ''), 'identity');
  for (const key of ['planId', 'expectedDatabaseSha256']) need(SHA.test(input[key] || ''), 'hash');
  for (const key of ['projectName', 'expectedName']) need(typeof input[key] === 'string' && input[key].trim()
    && Buffer.byteLength(input[key]) <= 512 && !/[\\/\x00-\x1f\x7f]/.test(input[key]), 'name');
  need(Array.isArray(input.timelineIds) && input.timelineIds.length >= 1 && input.timelineIds.length <= 1000
    && input.timelineIds.every(id => UUID.test(id)) && new Set(input.timelineIds).size === input.timelineIds.length
    && input.timelineIds.includes(input.timelineId), 'timelines');
  const source = input.sourceBinding;
  need(source?.schemaVersion === 1 && source.projectName === input.projectName && source.expectedCurrentFolder === 'Root'
    && ['sourcePath', 'libraryRoot', 'configPath'].every(key => typeof source[key] === 'string' && path.isAbsolute(source[key]))
    && SHA.test(source.configSha256 || '') && source.expectedCurrentDatabase?.DbType === 'Disk'
    && typeof source.expectedCurrentDatabase.DbName === 'string' && source.expectedCurrentDatabase.DbName.length > 0
    && Object.keys(source.expectedCurrentDatabase).sort().join(',') === 'DbName,DbType', 'source-binding');
  return Object.fromEntries(keys.map(key => [key, key === 'timelineIds' ? [...input.timelineIds].sort() : input[key]]));
}
async function directorySafe(directory, privateMode = true) {
  need(typeof directory === 'string' && path.isAbsolute(directory), 'directory');
  const stat = await fs.lstat(directory);
  need(stat.isDirectory() && !stat.isSymbolicLink() && (!privateMode || !(stat.mode & 0o077))
    && (process.getuid === undefined || stat.uid === process.getuid()) && await fs.realpath(directory) === directory, 'directory');
}
async function readOwned(filename, max = 2 * 1024 * 1024, privateMode = true) {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    need(before.isFile() && before.nlink === 1 && (!privateMode || !(before.mode & 0o077))
      && (process.getuid === undefined || before.uid === process.getuid()) && before.size > 0 && before.size <= max, 'file');
    const bytes = await handle.readFile(), after = await handle.stat(), named = await fs.lstat(filename);
    need(!named.isSymbolicLink() && before.ino === named.ino && before.dev === named.dev
      && before.size === bytes.length && before.size === after.size && before.size === named.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && before.mtimeMs === named.mtimeMs && before.ctimeMs === named.ctimeMs, 'file-changed');
    return bytes;
  } finally { await handle.close(); }
}
async function writeNew(filename, value) {
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
const outputPaths = directory => Object.fromEntries(['ready', 'started', 'native-source', 'result', 'complete', 'error']
  .map(key => [key, path.join(directory, key + (['native-source', 'result', 'error'].includes(key) ? '.json' : '.txt'))]));
const ticketPrefix = record => `FRAMELINE_CLOSED_APPLY_ADMIT:${record.token}:${record.requestSha256}:`;
function nativeSourceExpected(record) {
  return { schemaVersion: 1, operation: 'closed-project-native-source-ready', token: record.token,
    requestSha256: record.requestSha256, projectId: record.binding.projectId, projectName: record.binding.projectName,
    currentDatabase: record.binding.sourceBinding.expectedCurrentDatabase,
    currentFolder: record.binding.sourceBinding.expectedCurrentFolder };
}

async function renderClosedProjectApplyCompanion(record) {
  const b = binding(record.binding), p = outputPaths(record.directory);
  const base = await fs.readFile(path.join(__dirname, 'companion', 'resolve-internal.lua'), 'utf8');
  const start = base.indexOf('local NULL = {}'), end = base.indexOf('local function count_entries(');
  need(start >= 0 && end > start, 'encoder');
  const encoder = base.slice(start, end);
  const mark = stage => `FRAMELINE_CLOSED_APPLY_${stage}:${record.token}:${record.requestSha256}`;
  return `-- Frameline: read an already-open project; do not save or close it here.
local fusion=assert(resolve:Fusion(),'Fusion unavailable')
${encoder}
local function absent(file)local h=fusion:OpenFile(file,1);if h then h:Close();error('Retained output exists')end end
local function read_exact(file,value)
 local h=assert(fusion:OpenFile(file,1),'Bound input absent');local ok,result=pcall(function()
  assert(h:GetFileSize()==#value,'Bound input size');local parts,n={},0
  while n<#value do local s=h:ReadLine();assert(type(s)=='string'and #s>0 and #s<=#value-n,'Bound input read');n=n+#s;parts[#parts+1]=s end
  assert(h:ReadLine()==nil,'Bound input grew');return table.concat(parts)
 end);local closed=pcall(function()h:Close()end);assert(ok and closed and result==value,'Bound input differs')
end
local function write_exact(file,value)
 absent(file);assert(#value<1024*1024,'Output bound');local h=assert(fusion:OpenFile(file,2),'Writer absent')
 local ok=pcall(function()assert(h:WriteLine(value)==#value+1,'Write failed');assert(h:Flush()==true,'Flush failed')end)
 local closed=pcall(function()h:Close()end);assert(ok and closed,'Write failed');read_exact(file,value..'\\n')
end
local may_report=false;local stage='admission'
local ok=pcall(function()
 for _,file in ipairs({${[...Object.values(p), path.join(record.directory, 'ticket.txt'), path.join(record.directory, 'host-admission.json')].map(q).join(',')}})do absent(file)end
 read_exact(${q(path.join(record.directory, 'request.json'))},${q(record.requestBytes)})
 may_report=true;stage='editor-identity'
 local version,product,studio=resolve:GetVersionString(),resolve:GetProductName(),resolve:IsStudio()
 assert(version=='21.1.2.10'and product=='DaVinci Resolve'and studio==false,'Unsupported Resolve')
 local pm=assert(resolve:GetProjectManager(),'Manager absent')
 local function library()
  local db=assert(pm:GetCurrentDatabase(),'Database unavailable');assert(type(db)=='table','Database invalid')
  local values={};for key,value in pairs(db)do if key~='__flags'then values[key]=value end end
  assert(encode(values)==${q(JSON.stringify({ DbName: b.sourceBinding.expectedCurrentDatabase.DbName, DbType: 'Disk' }))},'Database differs')
  -- Resolve Free 21.1.2.10 returns an empty string for the root folder. Keep
  -- the host binding's canonical Root spelling; reject non-root folders.
  local native_folder=pm:GetCurrentFolder();assert(native_folder=='','Folder differs');local folder='Root'
  assert(folder==${q(b.sourceBinding.expectedCurrentFolder)},'Folder differs');return values,folder
 end
 local function current()
  library()
  local project=assert(pm:GetCurrentProject(),'Project absent')
  assert(project:GetUniqueId()==${q(b.projectId)}and project:GetName()==${q(b.projectName)},'Project differs');return project
 end
 local project=current();local db,folder=library()
 write_exact(${q(p['native-source'])},encode({schemaVersion=1,operation='closed-project-native-source-ready',token=${q(record.token)},requestSha256=${q(record.requestSha256)},projectId=project:GetUniqueId(),projectName=project:GetName(),currentDatabase=db,currentFolder=folder}))
 write_exact(${q(p.ready)},${q(mark('READY'))});write_exact(${q(p.started)},${q(mark('STARTED'))})
 stage='waiting-host-admission';assert(type(os)=='table'and type(os.time)=='function'and type(bmd)=='table'and type(bmd.wait)=='function','Admission clock unavailable')
 local began=os.time();local previous=began;local host_receipt=nil
 for poll=1,1200 do
  local now=os.time();assert(type(now)=='number'and now>=previous and now-began<=120,'Admission timeout');previous=now
  local h=fusion:OpenFile(${q(path.join(record.directory, 'ticket.txt'))},1)
  if h then local size=h:GetFileSize();assert(size==${Buffer.byteLength(ticketPrefix(record)) + 65},'Ticket size');local parts,n={},0
   while n<size do local value=h:ReadLine();assert(type(value)=='string'and #value>0 and n+#value<=size,'Ticket read');parts[#parts+1]=value;n=n+#value end
   assert(h:ReadLine()==nil,'Ticket grew');h:Close();local value=table.concat(parts)
   assert(value:sub(1,${Buffer.byteLength(ticketPrefix(record))})==${q(ticketPrefix(record))},'Ticket identity');host_receipt=value:sub(${Buffer.byteLength(ticketPrefix(record)) + 1},-2)
   assert(#host_receipt==64 and host_receipt:match('^[a-f0-9]+$')and value:sub(-1)=='\\n','Ticket receipt');break
  end
  bmd.wait(0.1)
 end
 assert(host_receipt,'Host admission absent');stage='editor-read';project=current();local count=project:GetTimelineCount()
 assert(type(count)=='number'and count==${b.timelineIds.length},'Timeline count differs')
 local ids,seen,target=array(),{},nil
 for index=1,count do local timeline=assert(project:GetTimelineByIndex(index),'Timeline absent');local id=timeline:GetUniqueId()
  assert(type(id)=='string'and not seen[id],'Timeline identity differs');seen[id]=true;ids[#ids+1]=id
  if id==${q(b.timelineId)}then assert(not target,'Duplicate target timeline');target=timeline end
 end
 table.sort(ids);assert(encode(ids)==${q(JSON.stringify(b.timelineIds))}and target,'Timeline inventory differs')
 local track_count=target:GetTrackCount('video');assert(type(track_count)=='number'and track_count%1==0 and track_count>=1 and track_count<=64,'Track count invalid')
 local found=nil;local seen_items={};local total=0
 for track=1,track_count do local items=assert(target:GetItemListInTrack('video',track),'Items unavailable');assert(type(items)=='table','Item list invalid')
  local n,max=0,0;for key in pairs(items)do if key~='__flags'then assert(type(key)=='number'and key>=1 and key%1==0,'Item list key');n=n+1;max=math.max(max,key)end end
  total=total+n;assert(n==#items and max==n and total<=10000,'Item list bounds')
  for _,item in ipairs(items)do local id=item:GetUniqueId();assert(type(id)=='string'and not seen_items[id],'Item identity differs');seen_items[id]=true
   if id==${q(b.itemId)}then assert(not found,'Duplicate target item');found=item end
  end
 end
 local observed_name=assert(found,'Target item absent'):GetName();assert(observed_name==${q(b.expectedName)},'Name differs')
 current();assert(project:GetTimelineCount()==count,'Timeline count changed');local second_seen={};for index=1,count do local t=assert(project:GetTimelineByIndex(index),'Timeline changed');local id=t:GetUniqueId();assert(seen[id]and not second_seen[id],'Timeline changed');second_seen[id]=true end
 assert(found:GetName()==observed_name,'Name changed')
 stage='complete';write_exact(${q(p.result)},encode({schemaVersion=1,operation='closed-project-name-editor-readback',
  token=${q(record.token)},requestSha256=${q(record.requestSha256)},transactionId=${q(b.transactionId)},planId=${q(b.planId)},
  expectedDatabaseSha256=${q(b.expectedDatabaseSha256)},projectId=project:GetUniqueId(),projectName=project:GetName(),
  timelineId=${q(b.timelineId)},itemId=found:GetUniqueId(),storedName=observed_name,timelineIds=ids,
  resolveVersion=version,productName=product,isStudio=studio,readOnly=true,saveCloseLoadPerformed=false,
  contentSettersPerformed=false,postCloseDatabaseValidationRequired=true,hostAdmissionReceiptSha256=host_receipt}))
 write_exact(${q(p.complete)},${q(mark('COMPLETE'))})
end)
if not ok and may_report then write_exact(${q(p.error)},encode({schemaVersion=1,operation='closed-project-name-editor-readback-error',token=${q(record.token)},requestSha256=${q(record.requestSha256)},stage=stage}))
elseif not ok then print('FRAMELINE_CLOSED_APPLY_READBACK_REFUSED')end
`;
}

async function prepareClosedProjectApplyCompanion(input = {}) {
  const b = binding(input), directory = input.directory;
  need(typeof directory === 'string' && path.isAbsolute(directory), 'directory');
  await directorySafe(path.dirname(directory));
  await fs.mkdir(directory, { mode: 0o700 });
  await directorySafe(directory);
  const token = randomBytes(16).toString('hex');
  const requestBytes = json({ schemaVersion: 1, operation: 'closed-project-name-editor-readback-request', token, binding: b }) + '\n';
  const record = { schemaVersion: 1, operation: 'prepare-closed-project-name-editor-readback', directory, token,
    binding: b, requestBytes, requestSha256: sha(requestBytes), installedPath: null };
  const menuName = `Frameline Verify Applied Name ${token.slice(0, 12)}`;
  record.scriptPath = path.join(directory, menuName + '.lua');
  const source = await renderClosedProjectApplyCompanion(record);
  record.sourceSha256 = sha(source);
  await writeNew(path.join(directory, 'request.json'), requestBytes);
  await writeNew(record.scriptPath, source);
  if (input.scriptsDirectory !== undefined) {
    await directorySafe(input.scriptsDirectory, false);
    record.installedPath = path.join(input.scriptsDirectory, menuName + '.lua');
    await writeNew(record.installedPath, source);
  }
  const preparationPath = path.join(directory, 'preparation.json');
  await writeNew(preparationPath, json(record) + '\n');
  const parent = await fs.open(directory, constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
  return { preparationPath, menuName, scriptPath: record.scriptPath,
    sourceSha256: record.sourceSha256, requestSha256: record.requestSha256 };
}

async function readPreparation(preparationPath, expectedBinding) {
  need(typeof preparationPath === 'string' && path.isAbsolute(preparationPath)
    && path.basename(preparationPath) === 'preparation.json', 'preparation');
  const directory = path.dirname(preparationPath); await directorySafe(directory);
  const record = JSON.parse(await readOwned(preparationPath));
  need(record.schemaVersion === 1 && record.operation === 'prepare-closed-project-name-editor-readback'
    && record.directory === directory && /^[a-f0-9]{32}$/.test(record.token || '')
    && SHA.test(record.sourceSha256 || '') && SHA.test(record.requestSha256 || ''), 'preparation');
  const b = binding(record.binding);
  need(isDeepStrictEqual(b, record.binding), 'binding');
  if (expectedBinding !== undefined) need(isDeepStrictEqual(b, binding(expectedBinding)), 'binding');
  const requestBytes = json({ schemaVersion: 1, operation: 'closed-project-name-editor-readback-request', token: record.token, binding: b }) + '\n';
  const menuFile = `Frameline Verify Applied Name ${record.token.slice(0, 12)}.lua`;
  need(record.scriptPath === path.join(directory, menuFile) && record.requestBytes === requestBytes
    && sha(requestBytes) === record.requestSha256
    && (await readOwned(path.join(directory, 'request.json'))).equals(Buffer.from(requestBytes)), 'request');
  const source = await renderClosedProjectApplyCompanion(record);
  need(sha(source) === record.sourceSha256 && (await readOwned(record.scriptPath)).equals(Buffer.from(source)), 'source');
  if (record.installedPath !== null) {
    need(typeof record.installedPath === 'string' && path.isAbsolute(record.installedPath)
      && path.basename(record.installedPath) === menuFile, 'installed');
    await directorySafe(path.dirname(record.installedPath), false);
    need((await readOwned(record.installedPath)).equals(Buffer.from(source)), 'installed');
  }
  return record;
}
async function readOutputs(record) {
  const directory = record.directory;
  const outputs = outputPaths(directory), found = {};
  for (const [key, filename] of Object.entries(outputs)) {
    try { found[key] = await readOwned(filename, 1024 * 1024, false); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const mark = stage => Buffer.from(`FRAMELINE_CLOSED_APPLY_${stage}:${record.token}:${record.requestSha256}\n`);
  for (const key of ['ready', 'started', 'complete']) if (found[key]) need(found[key].equals(mark(key.toUpperCase())), 'marker');
  need(!found.started || found.ready, 'order');
  need(!found.ready || found['native-source'], 'order');
  need(!found.result || found.started, 'order');
  need(!found.complete || found.result, 'order');
  if (found['native-source']) need(isDeepStrictEqual(JSON.parse(found['native-source']), nativeSourceExpected(record)), 'native-source');
  return found;
}
function admissionExpected(record, observation) {
  const b = record.binding;
  need(observation?.actualOpenFileBindingVerified === true && observation.concurrentWriterResistanceProven === false
    && observation.source?.path === b.sourceBinding.sourcePath && observation.source.sha256 === b.expectedDatabaseSha256
    && observation.configSha256 === b.sourceBinding.configSha256
    && Number.isSafeInteger(observation.process?.pid) && observation.process.pid > 0
    && typeof observation.process.started === 'string' && observation.process.started.length > 0
    && typeof observation.source.device === 'string' && typeof observation.source.inode === 'string'
    && Number.isSafeInteger(observation.source.size) && observation.source.size > 0, 'host-source-observation');
  return { schemaVersion: 1, operation: 'closed-project-native-source-admission', token: record.token,
    requestSha256: record.requestSha256, sourceSha256: record.sourceSha256, observation };
}
async function readAdmission(record) {
  const bytes = await readOwned(path.join(record.directory, 'host-admission.json'));
  const value = JSON.parse(bytes);
  need(isDeepStrictEqual(value, admissionExpected(record, value.observation)), 'host-admission');
  const hash = sha(bytes);
  need((await readOwned(path.join(record.directory, 'ticket.txt'))).toString() === ticketPrefix(record) + hash + '\n', 'host-ticket');
  return { hash, value };
}
async function admitClosedProjectApplyCompanion(preparationPath, { observeSource, expectedBinding } = {}) {
  need(typeof observeSource === 'function', 'host-observer-required');
  const record = await readPreparation(preparationPath, expectedBinding), found = await readOutputs(record);
  if (found.error) return { admitted: false, status: 'native-error' };
  if (!found.started) return { admitted: false, status: 'pending' };
  try { const existing = await readAdmission(record); return { admitted: true, receiptSha256: existing.hash }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  need(!found.result && !found.complete, 'admission-too-late');
  const observation = await observeSource({ binding: record.binding.sourceBinding, expectedSha256: record.binding.expectedDatabaseSha256 });
  const value = admissionExpected(record, observation), bytes = Buffer.from(json(value) + '\n');
  // Recheck the exact prepared program and native gate before issuing a ticket.
  await readPreparation(preparationPath, expectedBinding);
  const current = await readOutputs(record);
  need(current.started && !current.result && !current.complete && !current.error, 'admission-raced');
  await writeNew(path.join(record.directory, 'host-admission.json'), bytes);
  const hash = sha(bytes), temporary = path.join(record.directory, `.ticket-${randomBytes(8).toString('hex')}`);
  await writeNew(temporary, ticketPrefix(record) + hash + '\n');
  try { await fs.link(temporary, path.join(record.directory, 'ticket.txt')); }
  finally { await fs.unlink(temporary); }
  const parent = await fs.open(record.directory, constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
  return { admitted: true, receiptSha256: hash };
}
async function readClosedProjectApplyCompanion(preparationPath, expectedBinding) {
  const record = await readPreparation(preparationPath, expectedBinding), b = record.binding;
  const found = await readOutputs(record);
  if (found.error) {
    const err = JSON.parse(found.error);
    need(!found.complete && err.schemaVersion === 1 && err.operation === 'closed-project-name-editor-readback-error'
      && err.token === record.token && err.requestSha256 === record.requestSha256
      && ['admission', 'editor-identity', 'waiting-host-admission', 'editor-read', 'complete'].includes(err.stage), 'error');
    return { status: 'native-error', stage: err.stage, doNotReplay: true, editorVerified: false };
  }
  if (!found.complete) return { status: 'pending', started: Boolean(found.started), doNotReplay: Boolean(found.ready), editorVerified: false };
  const admission = await readAdmission(record);
  const result = JSON.parse(found.result);
  const expected = { schemaVersion: 1, operation: 'closed-project-name-editor-readback', token: record.token,
    requestSha256: record.requestSha256, transactionId: b.transactionId, planId: b.planId,
    expectedDatabaseSha256: b.expectedDatabaseSha256, projectId: b.projectId, projectName: b.projectName,
    timelineId: b.timelineId, itemId: b.itemId, storedName: b.expectedName, timelineIds: b.timelineIds,
    resolveVersion: '21.1.2.10', productName: 'DaVinci Resolve', isStudio: false, readOnly: true,
    saveCloseLoadPerformed: false, contentSettersPerformed: false, postCloseDatabaseValidationRequired: true,
    hostAdmissionReceiptSha256: admission.hash };
  need(isDeepStrictEqual(result, expected), 'result');
  return { ...result, status: 'verified-open', editorVerified: true, sourceSha256: record.sourceSha256,
    resultSha256: sha(found.result), postCloseDatabaseValidated: false, doNotReplay: true,
    sourceBinding: admission.value.observation, actualOpenFileBindingVerified: true };
}

module.exports = { prepareClosedProjectApplyCompanion, readClosedProjectApplyCompanion,
  renderClosedProjectApplyCompanion, admitClosedProjectApplyCompanion };
