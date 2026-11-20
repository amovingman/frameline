'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { prepareInventory, renderInventory } = require('./prepare-menu-inventory');
const { readInput } = require('./integration-input');
const sha = value => createHash('sha256').update(value).digest('hex');
const stages = ['entry', 'guarded', 'first-capture', 'first-encode', 'second-capture', 'envelope-encode', 'result-write', 'marker-write', 'complete'];
const name = id => `Frameline Inventory Diagnostic ${id.slice(0, 12)}.lua`;

function renderDiagnostic(template, base, binding) {
  let source = renderInventory(template, base, binding);
  const quote = value => JSON.stringify(value);
  const stageFile = stage => path.join(binding.directory, `stage-${binding.probeId}-${stage}.txt`);
  const raw = path.join(binding.directory, `error-${binding.probeId}.txt`);
  const report = path.join(binding.directory, `diagnostic-${binding.probeId}.json`);
  const writer = String.raw`local diagnostic_stage='entry';
local function diagnostic_write(filename,value)
  assert(#value+1<=8192,'Diagnostic exceeds limit')
  local fusion=assert(resolve:Fusion(),'Diagnostic writer unavailable')
  local prior=fusion:OpenFile(filename,1);if prior~=nil then prior:Close();error('Diagnostic file exists')end
  local f=assert(fusion:OpenFile(filename,2),'Diagnostic writer unavailable')
  local ok=pcall(function()assert(f:WriteLine(value)==#value+1,'Diagnostic write failed');assert(f:Flush()==true,'Diagnostic flush failed')end)
  local closed=pcall(function()f:Close()end);assert(ok and closed,'Diagnostic write failed')
  local expected=value..'\n';local h=assert(fusion:OpenFile(filename,1),'Diagnostic reader unavailable')
  local read_ok,actual=pcall(function()assert(h:GetFileSize()==#expected,'Diagnostic size differs');local parts,n={},0
    while n<#expected do local p=h:ReadLine();assert(type(p)=='string'and #p>0 and #p<=#expected-n,'Diagnostic read differs');parts[#parts+1]=p;n=n+#p end
    assert(h:ReadLine()==nil,'Diagnostic EOF differs');return table.concat(parts)end)
  local read_closed=pcall(function()h:Close()end);assert(read_ok and read_closed and actual==expected,'Diagnostic readback differs')
end
local function diagnostic_step(stage,filename)diagnostic_stage=stage;diagnostic_write(filename,'FRAMELINE_MENU_INVENTORY_STAGE_V1:${binding.probeId}:'..stage)end
`;
  const replace = (needle, value) => {
    if (source.split(needle).length !== 2) throw new Error('incompatible-diagnostic-source');
    source = source.replace(needle, () => value);
  };
  const step = stage => `diagnostic_step(${quote(stage)},${quote(stageFile(stage))})\n`;
  replace('local ok = pcall(function()', 'local ok,diagnostic_error = pcall(function()\n' + step('entry'));
  replace('  local fusion = assert(resolve:Fusion()', '  ' + step('guarded') + 'local fusion = assert(resolve:Fusion()');
  replace('  local snapshot = base.capture(resolve)', '  ' + step('first-capture') + 'local snapshot = base.capture(resolve)');
  replace('  local first_bytes = base.encode(snapshot)', '  ' + step('first-encode') + 'local first_bytes = base.encode(snapshot)');
  replace('  local second_bytes = base.encode(base.capture(resolve))', '  ' + step('second-capture') + 'local second_bytes = base.encode(base.capture(resolve))');
  replace('  local payload = base.encode(result)', '  ' + step('envelope-encode') + 'local payload = base.encode(result)');
  replace('  write_and_verify(result_path, payload)', '  ' + step('result-write') + 'write_and_verify(result_path, payload)');
  replace("  write_and_verify(complete_path, 'FRAMELINE_MENU_INVENTORY_COMPLETE_V1:' .. probe_id)", '  ' + step('marker-write') + "write_and_verify(complete_path, 'FRAMELINE_MENU_INVENTORY_COMPLETE_V1:' .. probe_id)\n" + step('complete'));
  const trailer = `
local diagnostic_status=ok and 'complete' or 'failed';local diagnostic_code='none'
if not ok then
  local text=tostring(diagnostic_error or '')
  if text:find('Unsafe or missing Resolve text',1,true)then diagnostic_code='unsafe-or-missing-snapshot-text'
  elseif text:find('Non-integer Resolve value',1,true)then diagnostic_code='non-integer-snapshot-value'
  elseif text:find('Duplicate item ID',1,true)then diagnostic_code='duplicate-item-id'
  elseif text:find('Invalid effects list',1,true)then diagnostic_code='invalid-effects-list'
  elseif text:find('Represented project state changed',1,true)then diagnostic_code='represented-state-changed'
  elseif text:find('Unexpected disposable project',1,true)then diagnostic_code='unexpected-disposable-project'
  elseif text:find('Unexpected Resolve version',1,true)then diagnostic_code='unexpected-resolve-version'
  else diagnostic_code='unclassified-runtime-error' end
  pcall(function()diagnostic_write(${quote(raw)},text:sub(1,4096))end)
end
local diagnostic_payload='{"schemaVersion":1,"operation":"resolve-menu-inventory-diagnostic","probeId":"${binding.probeId}","readOnly":true,"safeToApply":false,"status":"'..diagnostic_status..'","stage":"'..diagnostic_stage..'","errorCode":"'..diagnostic_code..'"}'
pcall(function()diagnostic_write(${quote(report)},diagnostic_payload)end)
`;
  return writer + source + trailer;
}

async function prepareDiagnostic({ install = false } = {}) {
  const record = await prepareInventory();
  const template = await fs.readFile(path.join(__dirname,'resolve-menu-inventory.lua'),'utf8');
  const base = await fs.readFile(path.join(__dirname,'../src/companion/resolve-internal.lua'),'utf8');
  const source = renderDiagnostic(template,base,record);
  record.operation='prepare-resolve-menu-inventory-diagnostic';record.preparedPath=path.join(record.directory,name(record.probeId));
  record.sourceSha256=sha(source);record.diagnosticGeneratorSha256=sha(await fs.readFile(__filename));
  record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',name(record.probeId)):null;
  await fs.writeFile(record.preparedPath,source,{flag:'wx',mode:0o600});
  if(install){const utility=path.dirname(record.installedPath);const info=await fs.lstat(utility);
    if(!info.isDirectory()||await fs.realpath(utility)!==utility)throw new Error('unsafe-diagnostic-install-directory');
    await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});
    if(!(await fs.readFile(record.installedPath)).equals(Buffer.from(source)))throw new Error('diagnostic-install-mismatch');}
  await fs.writeFile(path.join(record.directory,'preparation.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
  return record;
}

async function readDiagnostic(preparationFile) {
  const record=JSON.parse(readInput(preparationFile));const directory=path.dirname(preparationFile);
  if(record.operation!=='prepare-resolve-menu-inventory-diagnostic'||!/^[a-f0-9]{32}$/.test(record.probeId)
    ||record.directory!==directory||record.preparedPath!==path.join(directory,name(record.probeId)))throw new Error('invalid-diagnostic-preparation');
  const owner=typeof process.getuid==='function'?process.getuid():null;const dirInfo=await fs.lstat(directory);
  if(!dirInfo.isDirectory()||dirInfo.mode&0o077||owner!==null&&dirInfo.uid!==owner)throw new Error('unsafe-diagnostic-directory');
  const template=await fs.readFile(path.join(__dirname,'resolve-menu-inventory.lua'),'utf8');const base=await fs.readFile(path.join(__dirname,'../src/companion/resolve-internal.lua'),'utf8');
  const expected=renderDiagnostic(template,base,record),source=readInput(record.preparedPath);
  if(sha(source)!==record.sourceSha256||!source.equals(Buffer.from(expected)))throw new Error('diagnostic-source-changed');
  const readOwned=async(filename,limit)=>{const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
    try{const info=await handle.stat();if(!info.isFile()||info.nlink!==1||owner!==null&&info.uid!==owner||info.size>limit)throw new Error('invalid-diagnostic-file');await handle.chmod(0o600);}finally{await handle.close();}
    const value=readInput(filename);if(value.length>limit)throw new Error('invalid-diagnostic-file');return value;};
  const completedStages=[];
  for(const stage of stages){try{const bytes=await readOwned(path.join(directory,`stage-${record.probeId}-${stage}.txt`),256);
    if(bytes.toString('utf8')!==`FRAMELINE_MENU_INVENTORY_STAGE_V1:${record.probeId}:${stage}\n`)throw new Error('invalid-diagnostic-stage');completedStages.push(stage);
  }catch(error){if(error.code!=='ENOENT')throw error;}}
  let report=null,rawError=null;
  try{const bytes=await readOwned(path.join(directory,`diagnostic-${record.probeId}.json`),4096);report=JSON.parse(bytes);
    if(report.probeId!==record.probeId||report.operation!=='resolve-menu-inventory-diagnostic'||report.readOnly!==true||report.safeToApply!==false
      ||!['complete','failed'].includes(report.status)||!stages.includes(report.stage)
      ||!['none','unsafe-or-missing-snapshot-text','non-integer-snapshot-value','duplicate-item-id','invalid-effects-list','represented-state-changed','unexpected-disposable-project','unexpected-resolve-version','unclassified-runtime-error'].includes(report.errorCode))throw new Error('invalid-diagnostic-report');
    const keys=['schemaVersion','operation','probeId','readOnly','safeToApply','status','stage','errorCode'];
    if(report.schemaVersion!==1||Object.keys(report).sort().join(',')!==keys.sort().join(','))throw new Error('invalid-diagnostic-report');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  try{const raw=await readOwned(path.join(directory,`error-${record.probeId}.txt`),8192);rawError={byteLength:raw.length,sha256:sha(raw),retainedPrivately:true};}catch(error){if(error.code!=='ENOENT')throw error;}
  return{schemaVersion:1,readOnly:true,safeToApply:false,probeId:record.probeId,completedStages,status:report?.status||'incomplete-or-not-run',stage:report?.stage||completedStages.at(-1)||null,errorCode:report?.errorCode||null,rawError,
    sourceSha256:record.sourceSha256,limitation:'Raw error text stays private; stage progress does not prove complete editor coverage or authorize writes.'};
}
if(require.main===module){const[operation,...args]=process.argv.slice(2);const action=operation==='prepare'&&(args.length===0||args.length===1&&args[0]==='--install')?prepareDiagnostic({install:args[0]==='--install'}):operation==='read'&&args.length===1?readDiagnostic(args[0]):Promise.reject(new Error('usage'));
  action.then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(()=>{process.stderr.write('resolve-menu-inventory-diagnostic-failed\n');process.exitCode=1;});}
module.exports={renderDiagnostic,prepareDiagnostic,readDiagnostic};
