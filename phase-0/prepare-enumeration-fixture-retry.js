'use strict';
// Retry only the owned empty fixture whose first factory stopped at settings.
// The original factory/issued program and failed outcome remain unchanged.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),os=require('node:os');
const{randomBytes,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const{readInput}=require('./integration-input');
const{NAME,renderEnumerationFixture,readEnumerationFixture}=require('./prepare-enumeration-fixture');
const{parseEffectObservation}=require('../src/resolve-effect-observation');
const ROOT=path.resolve(__dirname,'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const json=value=>JSON.stringify(canonical(value));
const SOURCE_FILES=['phase-0/prepare-enumeration-fixture-retry.js','phase-0/prepare-enumeration-fixture.js','phase-0/gate-lab-session.js','phase-0/resolve-native-track-identity.py',
 'phase-0/compare-native-resolve-exports.py','src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/resolve-property-contract.json'];
const hashes=()=>Object.fromEntries(SOURCE_FILES.map(file=>[file,sha(readInput(path.join(ROOT,file)))]));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function inspectEmptyArchive(filename){
 const bytes=readInput(filename);
 const script=`import os,stat,io,zipfile,hashlib,importlib.util,json,sys
s=importlib.util.spec_from_file_location('n',sys.argv[1]);n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
fd=os.open(sys.argv[2],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,'rb')as f:
 before=os.fstat(f.fileno());assert stat.S_ISREG(before.st_mode)and 0<before.st_size<=8*1024*1024
 raw=f.read(8*1024*1024+1);assert len(raw)==before.st_size and n._reader.identity(before)==n._reader.identity(os.fstat(f.fileno()))
with zipfile.ZipFile(io.BytesIO(raw))as z:
 entries=z.infolist();assert len(entries)==3 and set(e.filename for e in entries)=={'project.xml','MediaPool/Master/MpFolder.xml','Gallery.xml'}
 assert all(not e.is_dir()and 0<=e.file_size<=1024*1024 for e in entries)
 data={e.filename:z.read(e)for e in entries};project=n.native_tree(data['project.xml']);assert project.tag=='SM_Project'
 pool=n.native_tree(data['MediaPool/Master/MpFolder.xml']);assert not list(pool.iter('Sm2Timeline'))
 assert not any(node.tag.startswith('Sm2Mp')and node.tag.endswith('Clip')for node in pool.iter())
 print(json.dumps({'projectId':n.identifier(project.attrib.get('DbId')),'sha256':hashlib.sha256(raw).hexdigest(),'size':len(raw),'timelineCount':0}))`;
 const result=JSON.parse(execFileSync('python3',['-c',script,path.join(__dirname,'resolve-native-track-identity.py'),filename],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024}));
 if(result.sha256!==sha(bytes)||result.size!==bytes.length||!UUID.test(result.projectId)||result.timelineCount!==0)throw new Error('empty-backup-source-differs');
 return result;
}
function renderEnumerationRetry(record){
 if(!UUID.test(record.expectedProjectId))throw new Error('invalid-retry-project');
 let source=renderEnumerationFixture(record);
 const settings="stage='settings';assert(p:SetSettings({timelineFrameRate='24',timelinePlaybackFrameRate='24'})==true,'Settings failed')";
 const project='local project_id=nil';
 if(source.split(settings).length!==2||source.split(project).length!==2)throw new Error('incompatible-frozen-enumeration-factory');
 source=source.replace(settings,"stage='settings-omitted-for-owned-empty-retry'").replace(project,'local project_id='+JSON.stringify(record.expectedProjectId));
 return source;
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-enumeration-retry-file');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function verifyFailedSource(preparation){
 const record=JSON.parse(readInput(preparation)),failure=await readEnumerationFixture(preparation);
 if(failure.status!=='native-error'||failure.sourceSha256!==record.sourceSha256||failure.error.schemaVersion!==1||failure.error.operation!=='resolve-enumeration-fixture-error'
  ||failure.error.probeId!==record.probeId||failure.error.stage!=='settings'||failure.error.mutated!==true||failure.error.safeToApply!==false)throw new Error('not-the-settings-only-failure');
 if((await owned(record.paths.started)).toString()!==`FRAMELINE_ENUMERATION_FIXTURE_STARTED:${record.probeId}\n`)throw new Error('failed-start-marker-differs');
 for(const key of['saved','baseline','result','marker']){try{await fs.lstat(record.paths[key]);throw new Error('failed-source-has-later-output');}catch(error){if(error.code!=='ENOENT')throw error;}}
 const empty=inspectEmptyArchive(record.paths.empty),errorBytes=await owned(record.paths.error);
 return{record,failure,empty,errorSha256:sha(errorBytes)};
}
async function prepareEnumerationRetry(failedPreparation,{install=false}={}){
 if(!path.isAbsolute(failedPreparation||'')||typeof install!=='boolean')throw new Error('invalid-enumeration-retry-options');
 const prior=await verifyFailedSource(failedPreparation),directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-enumeration-retry-')));await fs.chmod(directory,0o700);
 const input=readInput(prior.record.inputPath),movie=readInput(prior.record.moviePath),backup=readInput(prior.record.paths.empty);
 const record={schemaVersion:1,operation:'prepare-enumeration-fixture-retry',directory,probeId:randomBytes(16).toString('hex'),projectName:NAME,expectedProjectId:prior.empty.projectId,
  failedPreparation,failedSourceSha256:prior.record.sourceSha256,failedErrorSha256:prior.errorSha256,failedEmptyArchive:prior.empty,failedBackupPath:path.join(directory,'failed-empty-backup.drp'),
  inputPath:path.join(directory,'input.fcpxml'),inputSha256:sha(input),moviePath:path.join(directory,'enumeration-movie.mov'),movieSha256:sha(movie),movieBytes:movie.length,sourceHashes:hashes(),
  paths:Object.fromEntries(Object.entries({empty:'empty.drp',saved:'saved.drp',started:'started.txt',baseline:'baseline.json',result:'result.json',marker:'complete.txt',error:'error.json'}).map(([key,name])=>[key,path.join(directory,name)]))};
 for(const[filename,bytes]of[[record.inputPath,input],[record.moviePath,movie],[record.failedBackupPath,backup]])await fs.writeFile(filename,bytes,{flag:'wx',mode:0o600});
 record.sourcePath=path.join(directory,`Frameline Enumeration Retry ${record.probeId.slice(0,12)}.lua`);const source=renderEnumerationRetry(record);record.sourceSha256=sha(source);await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});
 record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.sourcePath)):null;
 if(install){const folder=path.dirname(record.installedPath),s=await fs.lstat(folder);if(!s.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('unsafe-retry-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
 const preparation=path.join(directory,'retry-preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
 return{preparation,sourcePath:record.sourcePath,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua'),expectedProjectId:record.expectedProjectId,originalSettingsFailurePreserved:true};
}
async function readEnumerationRetry(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),s=await fs.lstat(directory);
 if(record.schemaVersion!==1||record.operation!=='prepare-enumeration-fixture-retry'||record.directory!==directory||record.projectName!==NAME||!UUID.test(record.expectedProjectId)||!/^[a-f0-9]{32}$/.test(record.probeId)
  ||!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid()||await fs.realpath(directory)!==directory||record.sourcePath!==path.join(directory,`Frameline Enumeration Retry ${record.probeId.slice(0,12)}.lua`)
  ||record.inputPath!==path.join(directory,'input.fcpxml')||record.moviePath!==path.join(directory,'enumeration-movie.mov')||record.failedBackupPath!==path.join(directory,'failed-empty-backup.drp')
  ||json(record.paths)!==json(Object.fromEntries(Object.entries({empty:'empty.drp',saved:'saved.drp',started:'started.txt',baseline:'baseline.json',result:'result.json',marker:'complete.txt',error:'error.json'}).map(([key,name])=>[key,path.join(directory,name)]))))throw new Error('invalid-retry-record');
 const prior=await verifyFailedSource(record.failedPreparation),source=await owned(record.sourcePath);
 if(prior.record.sourceSha256!==record.failedSourceSha256||prior.errorSha256!==record.failedErrorSha256||json(prior.empty)!==json(record.failedEmptyArchive)||prior.empty.projectId!==record.expectedProjectId
  ||sha(source)!==record.sourceSha256||source.toString()!==renderEnumerationRetry(record)||json(record.sourceHashes)!==json(hashes())||sha(await owned(record.inputPath))!==record.inputSha256||sha(await owned(record.moviePath))!==record.movieSha256
  ||sha(await owned(record.failedBackupPath))!==prior.empty.sha256)throw new Error('retry-source-changed');
 try{return{status:'native-error',error:JSON.parse(await owned(record.paths.error)),sourceSha256:record.sourceSha256,safeToApply:false};}catch(error){if(error.code!=='ENOENT')throw error;}
 if((await owned(record.paths.started)).toString()!==`FRAMELINE_ENUMERATION_FIXTURE_STARTED:${record.probeId}\n`||(await owned(record.paths.marker)).toString()!==`FRAMELINE_ENUMERATION_FIXTURE_COMPLETE:${record.probeId}\n`)throw new Error('retry-incomplete');
 const raw=await owned(record.paths.result),result=JSON.parse(raw),baseline=parseEffectObservation(await owned(record.paths.baseline));
 if(result.schemaVersion!==1||result.operation!=='resolve-enumeration-fixture'||result.probeId!==record.probeId||result.projectId!==record.expectedProjectId||result.status!=='saved-reopened'||result.stage!=='complete'||result.saveReopenVerified!==true
  ||result.safeToApply!==false||result.ordinaryApplySupported!==false||baseline.snapshot.project_id!==record.expectedProjectId||baseline.snapshot.project_name!==NAME||baseline.snapshot.timelines.length!==2||baseline.items.length!==60||baseline.tracks.length!==12
  ||result.itemCount!==60||result.trackCount!==12||result.legacyGuardDoesNotProveEnumeration!==true)throw new Error('retry-result-differs');
 const archives={};for(const key of['empty','saved']){const bytes=await owned(record.paths[key]);archives[key]={sha256:sha(bytes),size:bytes.length};}
 const freshEmpty=inspectEmptyArchive(record.paths.empty);if(freshEmpty.projectId!==record.expectedProjectId)throw new Error('retry-empty-project-differs');
 return{...result,baseline,savedArchivePath:record.paths.saved,archives,sourceSha256:record.sourceSha256,resultSha256:sha(raw),sourceHashes:record.sourceHashes,
  retryOfSettingsOnlyFailure:true,failedSourceSha256:record.failedSourceSha256,failedErrorSha256:record.failedErrorSha256,failedEmptyArchive:record.failedEmptyArchive};
}
if(require.main===module){const[op,a,flag]=process.argv.slice(2);const action=op==='prepare'&&(!flag||flag==='--install')?prepareEnumerationRetry(a,{install:flag==='--install'}):op==='read'&&!flag?readEnumerationRetry(a):Promise.reject(new Error('usage'));action.then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(e=>{process.stderr.write('enumeration-retry-failed:'+e.message+'\n');process.exitCode=1;});}
module.exports={inspectEmptyArchive,renderEnumerationRetry,prepareEnumerationRetry,readEnumerationRetry};
