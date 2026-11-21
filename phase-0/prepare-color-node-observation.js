'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomBytes,createHash}=require('node:crypto');
const {inspectApi,reference}=require('./inspect-resolve-api');
const {readInput}=require('./integration-input');
const {parseEffectObservation}=require('../src/resolve-effect-observation');
const {propertyCaptureConfig}=require('../src/resolve-property-observation');
const {parseColorNodeObservation,describeColorNodeCoverage}=require('../src/resolve-color-node-observation');
const root=path.resolve(__dirname,'..');
const projectName='Frameline Integration Gate Fixture 20261120',projectId='dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff';
const utility=path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');
const files=['src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/companion/resolve-color-nodes.lua','src/resolve-property-contract.json','phase-0/resolve-color-node-menu.lua'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const json=value=>JSON.stringify(canonical(value));
const name=id=>`Frameline Color Node Reads ${id.slice(0,12)}.lua`;
const pathsFor=directory=>Object.fromEntries(Object.entries({baseline:'baseline.json',result:'result.json',observation:'observation.json',marker:'complete.txt',failure:'failure.json'}).map(([key,file])=>[key,path.join(directory,file)]));
async function sources(){return Object.fromEntries(await Promise.all(files.map(async file=>[file,await fs.readFile(path.join(root,file),'utf8')])));}
function baseline(bytes){const observation=parseEffectObservation(bytes);if(observation.schemaVersion!==2||observation.snapshot.project_name!==projectName||observation.snapshot.project_id!==projectId||observation.snapshot.resolve_version!=='21.1.2.10'||observation.items.length!==50||observation.snapshot.timelines.length!==1||observation.tracks.length!==5||observation.items.some(item=>item.propertyReadStatus!=='captured'))throw new Error('unexpected-color-node-baseline');return observation;}
function renderColorNodeMenu(source,record,expected){
  if(!/^[a-f0-9]{32}$/.test(record.id||'')||Object.values(record.paths||{}).some(p=>typeof p!=='string'||!path.isAbsolute(p)||/[\x00-\x1f\x7f"\\]/.test(p)))throw new Error('invalid-color-node-binding');
  const sentinel='return { capture_request = capture_request }';if(source[files[0]].split(sentinel).length!==2)throw new Error('incompatible-color-node-base');
  const bindings={__PROJECT_NAME__:JSON.stringify(projectName),__PROJECT_ID__:JSON.stringify(projectId),__REQUEST_ID__:JSON.stringify(record.id),
    __RESULT_PATH__:JSON.stringify(record.paths.result),__OBSERVATION_PATH__:JSON.stringify(record.paths.observation),__MARKER_PATH__:JSON.stringify(record.paths.marker),__FAILURE_PATH__:JSON.stringify(record.paths.failure),
    __BASE_SOURCE__:source[files[0]].replace(sentinel,'return {capture=capture,encode=encode,array=array}'),__EFFECT_SOURCE__:source[files[1]],__NODE_SOURCE__:source[files[2]],
    __EXPECTED_RICH_JSON__:JSON.stringify(json(expected)),__PROPERTY_CONFIG__:propertyCaptureConfig()};
  let rendered=source[files[4]];for(const[token,value]of Object.entries(bindings)){if(rendered.split(token).length!==2)throw new Error('incompatible-color-node-template');rendered=rendered.replace(token,()=>value);}return rendered;
}
async function owned(filename,limit,tighten=false,directory=null){
  async function checkDirectory(){if(!directory)return;const info=await fs.lstat(directory);if(!info.isDirectory()||info.mode&0o077||info.uid!==process.getuid()||await fs.realpath(directory)!==directory)throw new Error('invalid-color-node-directory');}
  await checkDirectory();const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  try{const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid()||before.size>limit)throw new Error('invalid-color-node-file');
    await checkDirectory();const named=await fs.lstat(filename);if(!named.isFile()||before.dev!==named.dev||before.ino!==named.ino||named.nlink!==1)throw new Error('invalid-color-node-file');
    if(tighten)await handle.chmod(0o600);const start=await handle.stat();const bytes=Buffer.alloc(start.size+1);let count=0,n;while(count<bytes.length&&(n=(await handle.read(bytes,count,bytes.length-count,count)).bytesRead))count+=n;
    const after=await handle.stat();if(count!==start.size||after.size!==start.size||after.mtimeMs!==start.mtimeMs||after.ctimeMs!==start.ctimeMs)throw new Error('color-node-file-changed');return bytes.subarray(0,count);
  }finally{await handle.close();}
}
async function prepareColorNodeObservation({baselineFile,install=false}={}){
  if(!path.isAbsolute(baselineFile||'')||typeof install!=='boolean')throw new Error('invalid-color-node-options');
  const api=inspectApi(readInput(reference)),input=await owned(baselineFile,2*1024*1024),expected=baseline(input),source=await sources();
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-color-node-')));await fs.chmod(directory,0o700);const id=randomBytes(16).toString('hex');
  const record={schemaVersion:1,operation:'prepare-color-node-observation',id,directory,projectName,projectId,paths:pathsFor(directory),baselineSha256:sha(input),referenceSha256:api.referenceSha256,
    sourceHashes:Object.fromEntries(files.map(file=>[file,sha(source[file])])),sourcePath:path.join(directory,name(id)),installedPath:install?path.join(utility,name(id)):null};
  const rendered=renderColorNodeMenu(source,record,expected);record.sourceSha256=sha(rendered);
  await fs.writeFile(record.paths.baseline,input,{flag:'wx',mode:0o600});await fs.writeFile(record.sourcePath,rendered,{flag:'wx',mode:0o600});
  if(install){const dir=await fs.lstat(utility);if(!dir.isDirectory()||dir.uid!==process.getuid()||await fs.realpath(utility)!==utility)throw new Error('unsafe-color-node-install');await fs.writeFile(record.installedPath,rendered,{flag:'wx',mode:0o600});if(!(await fs.readFile(record.installedPath)).equals(Buffer.from(rendered)))throw new Error('color-node-install-changed');}
  record.preparationFile=path.join(directory,'preparation.json');await fs.writeFile(record.preparationFile,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});return record;
}
async function readColorNodeObservation(preparationFile){
  const directory=path.dirname(path.resolve(preparationFile));const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.mode&0o077||dir.uid!==process.getuid()||await fs.realpath(directory)!==directory)throw new Error('invalid-color-node-directory');
  const record=JSON.parse(await owned(preparationFile,16384,false,directory));
  if(record.schemaVersion!==1||record.operation!=='prepare-color-node-observation'||!/^[a-f0-9]{32}$/.test(record.id||'')||record.directory!==directory||record.projectName!==projectName||record.projectId!==projectId||record.sourcePath!==path.join(directory,name(record.id))||json(record.paths)!==json(pathsFor(directory)))throw new Error('invalid-color-node-record');
  const source=await sources(),expected=baseline(await owned(record.paths.baseline,2*1024*1024,false,directory));
  if(record.referenceSha256!==inspectApi(readInput(reference)).referenceSha256||json(record.sourceHashes)!==json(Object.fromEntries(files.map(file=>[file,sha(source[file])]))))throw new Error('color-node-program-changed');
  const rendered=renderColorNodeMenu(source,record,expected),actual=await owned(record.sourcePath,384*1024,false,directory);
  if(sha(await owned(record.paths.baseline,2*1024*1024,false,directory))!==record.baselineSha256||sha(actual)!==record.sourceSha256||!actual.equals(Buffer.from(rendered)))throw new Error('color-node-program-changed');
  try{const failure=JSON.parse(await owned(record.paths.failure,4096,true,directory));if(Object.keys(failure).sort().join(',')!=='errorCode,operation,readOnly,requestId,safeToApply,schemaVersion,stage'||failure.schemaVersion!==1||failure.operation!=='resolve-color-node-menu-failure'||failure.readOnly!==true||failure.safeToApply!==false||failure.requestId!==record.id||!['guard','capture','observation-write','result-write','marker-write'].includes(failure.stage)||!['capture-failed','output-failed','oversize','state-changed','invalid-value'].includes(failure.errorCode))throw new Error('invalid-color-node-failure');return{status:'failed',...failure};}catch(error){if(error.code!=='ENOENT')throw error;}
  const raw=await owned(record.paths.observation,2*1024*1024,true,directory),observation=parseColorNodeObservation(raw),result=JSON.parse(await owned(record.paths.result,4096,true,directory)),marker=await owned(record.paths.marker,256,true,directory);
  if(Object.keys(result).sort().join(',')!=='itemCount,observationBytes,operation,projectId,readOnly,requestId,safeToApply,schemaVersion'||result.schemaVersion!==1||result.operation!=='resolve-color-node-menu'||result.requestId!==record.id||result.readOnly!==true||result.safeToApply!==false||result.projectId!==projectId||result.itemCount!==50||result.observationBytes!==raw.length-1||json(observation.snapshot)!==json(expected.snapshot)||marker.toString('utf8')!==`FRAMELINE_COLOR_NODE_COMPLETE_V1:${record.id}\n`)throw new Error('invalid-color-node-result');
  return{status:'complete',readOnly:true,safeToApply:false,requestId:record.id,observation,observationSha256:sha(raw),completionMarkerSha256:sha(marker),completionMarkerVerified:true,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,referenceSha256:record.referenceSha256,baselineSha256:record.baselineSha256,coverage:describeColorNodeCoverage(observation),projectMutationCalls:0};
}
if(require.main===module){const[op,...args]=process.argv.slice(2);const task=op==='prepare'?prepareColorNodeObservation({baselineFile:args[0],install:args.includes('--install')}):op==='read'&&args.length===1?readColorNodeObservation(args[0]).then(({observation,...report})=>report):Promise.reject(new Error('usage'));task.then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(()=>{process.stderr.write('color-node-observation-failed\n');process.exitCode=1;});}
module.exports={prepareColorNodeObservation,readColorNodeObservation,renderColorNodeMenu,projectName,projectId};
