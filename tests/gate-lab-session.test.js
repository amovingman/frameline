'use strict';
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {resultWriter,fileReader,prepareLab,readLab,projectName}=require('../phase-0/gate-lab-session');
const library='/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const fixture=path.join(__dirname,'../phase-0/resolve-xml-proof/live-properties-enabled.json');
const lua=value=>value===null?'{}':Array.isArray(value)?`{${value.map(lua).join(',')}}`:value&&typeof value==='object'?`{${Object.entries(value).map(([k,v])=>`[${JSON.stringify(k)}]=${lua(v)}`).join(',')}}`:JSON.stringify(value);
function run(script){return runVendorLuaMock(script, {library: library, maxBuffer: 2*1024*1024});}
const mock=fs.readFileSync(path.join(__dirname,'fixtures/resolve-editor-mock/fake-editor.lua'),'utf8');

test('lab file writer requires exact readback, refuses replacement, and closes failed writers', {skip:!fs.existsSync(library)},()=>{
  const initial=JSON.parse(fs.readFileSync(fixture));
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'gate-lab-writer-'));
  try{
    const file=path.join(directory,'result.txt');
    const script=`initial=${lua(initial)};options={};${mock}\nlocal fusion=resolve:Fusion();${resultWriter()}\nwrite_exact(${JSON.stringify(file)},'first\\nsecond');local ok=pcall(function()write_exact(${JSON.stringify(file)},'replace')end);assert(not ok);assert(counters.fileOpen==counters.fileClose);print('OK')`;
    const r=run(script);assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(file,'utf8'),'first\nsecond\n');
    const changed=path.join(directory,'changed.txt');
    const bad=run(`initial=${lua(initial)};options={writerReadbackMismatch=true};${mock}\nlocal fusion=resolve:Fusion();${resultWriter()}\nlocal ok=pcall(function()write_exact(${JSON.stringify(changed)},'value')end);assert(not ok);assert(counters.fileOpen==counters.fileClose)`);
    assert.equal(bad.status,0,bad.stderr);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('fixture input guard checks every byte and rejects a changed file before imports', {skip:!fs.existsSync(library)},()=>{
  const initial=JSON.parse(fs.readFileSync(fixture));const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'gate-lab-input-'));
  try{const file=path.join(dir,'fixture.fcpxml');fs.writeFileSync(file,'one\ntwo\n');
    const prefix=`initial=${lua(initial)};options={};${mock}\nlocal fusion=resolve:Fusion();`;
    assert.equal(run(prefix+fileReader(file,'one\ntwo\n')).status,0);
    const bad=run(prefix+`local ok=pcall(function()${fileReader(file,'one\nother\n')}end);assert(not ok);assert(counters.fileOpen==counters.fileClose)`);assert.equal(bad.status,0,bad.stderr);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('lab preparation bounds operation and fifty-clip initialization without touching the editor',async()=>{
  await assert.rejects(prepareLab({operation:'apply'}),/invalid-gate-lab-operation/);
  assert(projectName.startsWith('Frameline '));
});


test('lab reader binds exact source, completion, result shape and represented fixture',async()=>{
  const record=await prepareLab({operation:'capture'});
  const preparation=path.join(record.directory,'preparation.json');
  try{
    const bytes=require('node:zlib').gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/resolve-operation-baseline-observation.json.gz')));
    const observation=JSON.parse(bytes);
    const result={schemaVersion:1,operation:'resolve-gate-lab',stage:'capture',id:record.id,experimental:true,safeToApply:false,
      projectId:observation.snapshot.project_id,itemCount:50,trackCount:5,observationBytes:bytes.length-1};
    fs.writeFileSync(record.paths.observation,bytes,{mode:0o600});
    fs.writeFileSync(record.paths.result,JSON.stringify(result)+'\n',{mode:0o600});
    fs.writeFileSync(record.paths.marker,`FRAMELINE_GATE_LAB_COMPLETE_V1:${record.id}\n`,{mode:0o600});
    assert.equal((await readLab(preparation)).result.projectId,result.projectId);
    fs.appendFileSync(record.sourcePath,'-- changed');
    await assert.rejects(readLab(preparation),/lab-source-changed/);
    fs.writeFileSync(record.sourcePath,await require('../phase-0/gate-lab-session').renderLabSource(record));
    fs.writeFileSync(record.paths.result,JSON.stringify({...result,safeToApply:true})+'\n');
    await assert.rejects(readLab(preparation),/lab-result-mismatch/);
    fs.writeFileSync(record.paths.result,JSON.stringify(result)+'\n');
    fs.writeFileSync(record.paths.marker,'FRAMELINE_GATE_LAB_COMPLETE_V1:wrong\n');
    await assert.rejects(readLab(preparation),/lab-not-complete/);
    fs.writeFileSync(record.paths.marker,`FRAMELINE_GATE_LAB_COMPLETE_V1:${record.id}\n`);
    const other=path.join(record.directory,'other.json');fs.renameSync(record.paths.observation,other);fs.linkSync(other,record.paths.observation);
    await assert.rejects(readLab(preparation),/invalid-lab-output/);
  }finally{fs.rmSync(record.directory,{recursive:true,force:true});}
});

async function writeLabOutputs(record) {
  const bytes=require('node:zlib').gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/resolve-operation-baseline-observation.json.gz')));
  const observation=JSON.parse(bytes);
  fs.writeFileSync(record.paths.observation,bytes,{mode:0o600});
  fs.writeFileSync(record.paths.result,JSON.stringify({schemaVersion:1,operation:'resolve-gate-lab',stage:record.operation,id:record.id,
    experimental:true,safeToApply:false,projectId:observation.snapshot.project_id,itemCount:50,trackCount:5,observationBytes:bytes.length-1})+'\n',{mode:0o600});
  fs.writeFileSync(record.paths.marker,`FRAMELINE_GATE_LAB_COMPLETE_V1:${record.id}\n`,{mode:0o600});
}

test('lab reader refuses XML ancestor symlinks before chmoding an unrelated owned file',async()=>{
  const os=require('node:os');const inputDir=fs.mkdtempSync(path.join(os.tmpdir(),'gate-lab-xml-ancestor-'));
  const input=path.join(inputDir,'input.fcpxml');fs.writeFileSync(input,require('node:zlib').gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/resolve-operation-fixture-input.fcpxml.gz'))));
  const record=await prepareLab({operation:'initialize',input});
  try{
    await writeLabOutputs(record);fs.writeFileSync(record.paths.backup,'mock archive',{mode:0o600});
    const outside=path.join(inputDir,'outside');fs.mkdirSync(outside);const file=path.join(outside,'Info.fcpxml');fs.writeFileSync(file,'Unrelated owned file');fs.chmodSync(file,0o644);
    fs.symlinkSync(outside,record.paths.xmlBundle);
    await assert.rejects(readLab(path.join(record.directory,'preparation.json')),/lab-symlink-ancestor/);
    assert.equal(fs.statSync(file).mode&0o777,0o644);assert.equal(fs.readFileSync(file,'utf8'),'Unrelated owned file');
  }finally{fs.rmSync(record.directory,{recursive:true,force:true});fs.rmSync(inputDir,{recursive:true,force:true});}
});

test('lab reader rejects symlinked directory ancestry and a changed XML bundle scope',async()=>{
  const os=require('node:os'),crypto=require('node:crypto');const aliasRoot=fs.mkdtempSync(path.join(os.tmpdir(),'gate-lab-alias-'));
  const record=await prepareLab({operation:'capture'}),preparation=path.join(record.directory,'preparation.json');
  try{
    const bad={...record,paths:{...record.paths,xmlBundle:path.join(aliasRoot,'outside')}};
    fs.writeFileSync(preparation,JSON.stringify(bad));
    await assert.rejects(readLab(preparation),/invalid-lab-output/);
    fs.symlinkSync(path.dirname(record.directory),path.join(aliasRoot,'parent'));
    const aliasDirectory=path.join(aliasRoot,'parent',path.basename(record.directory));
    const alias=JSON.parse(JSON.stringify(record));alias.directory=aliasDirectory;alias.sourcePath=path.join(aliasDirectory,path.basename(record.sourcePath));
    alias.paths=Object.fromEntries(Object.entries(record.paths).map(([key,file])=>[key,path.join(aliasDirectory,path.relative(record.directory,file))]));
    const source=await require('../phase-0/gate-lab-session').renderLabSource(alias);alias.sourceSha256=crypto.createHash('sha256').update(source).digest('hex');
    fs.writeFileSync(record.sourcePath,source);fs.writeFileSync(preparation,JSON.stringify(alias));
    await assert.rejects(readLab(path.join(aliasDirectory,'preparation.json')),/lab-directory-not-canonical/);
  }finally{fs.rmSync(aliasRoot,{recursive:true,force:true});fs.rmSync(record.directory,{recursive:true,force:true});}
});
