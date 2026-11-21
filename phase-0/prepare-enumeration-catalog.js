'use strict';
// Read the installed runtime catalogue; a catalogue never proves applied effects.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { readInput } = require('./integration-input');
const { resultWriter } = require('./gate-lab-session');
const ROOT = path.resolve(__dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = () => Object.fromEntries(['phase-0/prepare-enumeration-catalog.js', 'phase-0/gate-lab-session.js',
  'src/companion/resolve-effects.lua'].map(file => [file, sha(readInput(path.join(ROOT, file)))]));
const q = JSON.stringify;

function renderEnumerationCatalog(record) {
  const encoder = readInput(path.join(ROOT, 'src/companion/resolve-effects.lua')).toString();
  return `local fusion=assert(resolve:Fusion(),'No Fusion')
${resultWriter()}
absent(${q(record.resultPath)});absent(${q(record.markerPath)})
local encode=(function()${encoder}\nend)().encode
local function array()return setmetatable({},{__array=true})end
local function catalogue(kind)
 local ok,list=pcall(function()return resolve:GetEffectsList(kind)end)
 if not ok or list==nil then return {status='unavailable',entries=array()}end
 assert(type(list)=='table','Catalogue is not a list');local count=0
 for key in pairs(list)do if key~='__flags'then assert(type(key)=='number'and key%1==0 and key>=1 and key<=4096,'Catalogue key');count=count+1 end end
 local entries=array();local seen={}
 for index=1,count do local info=list[index];assert(type(info)=='table','Sparse catalogue')
  for key in pairs(info)do assert(key=='id'or key=='name'or key=='category'or key=='__flags','Catalogue field')end
  assert(type(info.id)=='string'and #info.id>0 and #info.id<=2048 and type(info.name)=='string'and #info.name>0 and #info.name<=2048,'Catalogue text')
  assert(info.category=='fusion'or info.category=='ofx'or info.category=='audio','Catalogue category')
  local key=info.category..':'..info.id;assert(not seen[key],'Duplicate catalogue effect');seen[key]=true
  entries[#entries+1]={category=info.category,id=info.id,name=info.name}
 end
 return {status='captured',entries=entries}
end
assert(resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Wrong Resolve')
local value={schemaVersion=1,operation='resolve-enumeration-catalogue',probeId=${q(record.probeId)},resolveVersion=resolve:GetVersionString(),productName=resolve:GetProductName(),isStudio=resolve:IsStudio(),
 video=catalogue('video'),audio=catalogue('audio'),readOnly=true,safeToApply=false,appliedEffectEnumerationProven=false}
write_exact(${q(record.resultPath)},encode(value));write_exact(${q(record.markerPath)},${q('FRAMELINE_ENUMERATION_CATALOGUE:'+record.probeId)})`;
}

async function prepareEnumerationCatalog({ install = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-enumeration-catalogue-')));
  await fs.chmod(directory, 0o700);
  const probeId = randomBytes(16).toString('hex');
  const record = { schemaVersion: 1, operation: 'prepare-enumeration-catalogue', directory, probeId,
    resultPath: path.join(directory, 'result.json'), markerPath: path.join(directory, 'complete.txt'), sourceHashes: sources() };
  record.sourcePath = path.join(directory, `Frameline Enumeration Catalogue ${probeId.slice(0,12)}.lua`);
  const source = renderEnumerationCatalog(record); record.sourceSha256 = sha(source);
  await fs.writeFile(record.sourcePath, source, { flag: 'wx', mode: 0o600 });
  record.installedPath = install ? path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility', path.basename(record.sourcePath)) : null;
  if (install) {
    const folder = path.dirname(record.installedPath), info = await fs.lstat(folder);
    if (!info.isDirectory() || await fs.realpath(folder) !== folder) throw new Error('unsafe-enumeration-install');
    await fs.writeFile(record.installedPath, source, { flag: 'wx', mode: 0o600 });
  }
  const preparation = path.join(directory, 'preparation.json');
  await fs.writeFile(preparation, JSON.stringify(record, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  return { preparation, menuName: path.basename(record.sourcePath, '.lua'), sourceSha256: record.sourceSha256 };
}

async function owned(filename) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw new Error('unsafe-enumeration-output'); await handle.chmod(0o600); }
  finally { await handle.close(); }
  return readInput(filename);
}

async function readEnumerationCatalog(preparation) {
  const record = JSON.parse(readInput(preparation)), directory = path.dirname(preparation), stat = await fs.lstat(directory);
  if (record.operation !== 'prepare-enumeration-catalogue' || record.schemaVersion !== 1 || record.directory !== directory
    || !/^[a-f0-9]{32}$/.test(record.probeId) || !stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid()
    || await fs.realpath(directory) !== directory || record.sourcePath !== path.join(directory, `Frameline Enumeration Catalogue ${record.probeId.slice(0,12)}.lua`)
    || record.resultPath !== path.join(directory,'result.json') || record.markerPath !== path.join(directory,'complete.txt')) throw new Error('invalid-enumeration-record');
  const source = await owned(record.sourcePath);
  if (sha(source) !== record.sourceSha256 || source.toString() !== renderEnumerationCatalog(record)
    || JSON.stringify(record.sourceHashes) !== JSON.stringify(sources())) throw new Error('enumeration-source-changed');
  if ((await owned(record.markerPath)).toString() !== `FRAMELINE_ENUMERATION_CATALOGUE:${record.probeId}\n`) throw new Error('enumeration-incomplete');
  const raw = await owned(record.resultPath), result = JSON.parse(raw);
  if (result.operation !== 'resolve-enumeration-catalogue' || result.probeId !== record.probeId || result.resolveVersion !== '21.1.2.10'
    || result.productName !== 'DaVinci Resolve' || result.isStudio !== false || result.readOnly !== true || result.safeToApply !== false
    || result.appliedEffectEnumerationProven !== false) throw new Error('enumeration-result-differs');
  for (const kind of ['video','audio']) {
    if (!['captured','unavailable'].includes(result[kind]?.status) || !Array.isArray(result[kind].entries) || result[kind].entries.length > 4096) throw new Error('invalid-enumeration-catalogue');
    for (const row of result[kind].entries) if (!['ofx','fusion','audio'].includes(row.category) || typeof row.id !== 'string' || typeof row.name !== 'string'
      || !row.id || !row.name || /[\x00-\x1f\x7f\\]/.test(row.id+row.name)) throw new Error('invalid-enumeration-catalogue');
  }
  return { ...result, resultSha256: sha(raw), resultBytes: raw.length, sourceSha256: record.sourceSha256, sourceHashes: record.sourceHashes };
}
module.exports = { renderEnumerationCatalog, prepareEnumerationCatalog, readEnumerationCatalog };
if (require.main === module) {
  const [operation, input] = process.argv.slice(2);
  (operation === 'prepare' ? prepareEnumerationCatalog({ install: input === '--install' }) : operation === 'read' ? readEnumerationCatalog(input) : Promise.reject(new Error('usage')))
    .then(result => process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error => { process.stderr.write('enumeration-catalogue-failed:'+error.message+'\n'); process.exitCode=1; });
}
