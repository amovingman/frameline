'use strict';
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {readInput}=require('./integration-input');
const {readCapture,NAME}=require('./prepare-native-blind-capture');
const {parseEffectObservation}=require('../src/resolve-effect-observation');
const {propertyCaptureConfig}=require('../src/resolve-property-observation');
const {readNativeLocationGraph,identityFacts,json,sha}=require('./native-track-location-binding');
const ROOT=path.resolve(__dirname,'..');
const lua=value=>typeof value==='string'?JSON.stringify(value):typeof value==='number'||typeof value==='boolean'?String(value):Array.isArray(value)?`{${value.map(lua).join(',')}}`:`{${Object.entries(value).map(([key,field])=>`[${JSON.stringify(key)}]=${lua(field)}`).join(',')}}`;
const SOURCES=['phase-0/prepare-native-blind-challenge.js','phase-0/resolve-native-track-challenge.lua','phase-0/resolve-native-track-identity.py',
  'phase-0/resolve-native-location-graph.py','phase-0/native-track-location-binding.js','src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/resolve-property-contract.json'];
const hashes=()=>Object.fromEntries(SOURCES.map(file=>[file,sha(readInput(path.join(ROOT,file)))]));
function planChallenge(input,probeId){
 const observation=parseEffectObservation(JSON.stringify(input));
 if(!/^[a-f0-9]{32}$/.test(probeId)||observation.schemaVersion!==2||observation.snapshot.project_name!==NAME||observation.snapshot.resolve_version!=='21.1.2.10'
  ||observation.snapshot.timelines.length!==1||observation.items.length!==52||observation.snapshot.timelines[0].tracks.some(t=>!['video','audio'].includes(t.type)))throw new Error('unsupported-blind-challenge-source');
 const challenged=structuredClone(observation),bindings=[];
 for(const timeline of challenged.snapshot.timelines)for(const track of timeline.tracks){const originalName=track.name,challengeName=`Frameline-TrackProof-${probeId}-${track.type}-${track.index}`;
  bindings.push({timelineId:timeline.id,type:track.type,index:track.index,originalName,challengeName});track.name=challengeName;}
 return{observation,challenged,bindings};
}
async function renderBlindChallenge(record){
 let source=readInput(path.join(__dirname,'resolve-native-track-challenge.lua')).toString();
 const raw=readInput(path.join(ROOT,'src/companion/resolve-internal.lua')).toString(),sentinel='return { capture_request = capture_request }';
 if(raw.split(sentinel).length!==2)throw new Error('incompatible-blind-challenge');
 const values={__EXPECTED_NAME__:JSON.stringify(NAME),__EXPECTED_PROJECT_ID__:JSON.stringify(record.projectId),__EXPECTED_BEFORE__:JSON.stringify(json(record.observation)),
  __EXPECTED_CHALLENGED__:JSON.stringify(json(record.challenged)),__BINDINGS__:lua(record.bindings),__RESULT_PATH__:JSON.stringify(record.resultPath),__MARKER_PATH__:JSON.stringify(record.markerPath),
  __BACKUP_PATH__:JSON.stringify(record.backupPath),__BACKUP_BYTES__:String(record.backupBytes),__EXPORT_BEFORE__:JSON.stringify(record.exports.before),__EXPORT_CHALLENGED__:JSON.stringify(record.exports.challenged),
  __EXPORT_RESTORED__:JSON.stringify(record.exports.restored),__PROBE_ID__:JSON.stringify(record.probeId),__BASE_SOURCE__:raw.replace(sentinel,'return {capture=capture,encode=encode,array=array}'),
  __EFFECT_SOURCE__:readInput(path.join(ROOT,'src/companion/resolve-effects.lua')).toString(),__PROPERTY_CONFIG__:propertyCaptureConfig()};
 for(const[token,value]of Object.entries(values)){if(source.split(token).length!==2)throw new Error('invalid-blind-challenge-template');source=source.replace(token,()=>value);}
 const resultAnchor="local result = {schemaVersion = 1, operation = 'resolve-native-track-challenge', probeId = probe_id,";
 if(source.split(resultAnchor).length!==2)throw new Error('incompatible-prediction-result');
 source=source.replace(resultAnchor,resultAnchor+`\n      frozenPredictionSha256=${JSON.stringify(record.predictionSha256)}, frozenPredictionCanonicalSha256=${JSON.stringify(record.predictionCanonicalSha256)},`);
 const expected=record.frozenPredictionBytes;
 if(typeof expected!=='string'||sha(expected)!==record.predictionSha256||sha(json(JSON.parse(expected)))!==record.predictionCanonicalSha256
  ||expected!==json(JSON.parse(expected))+'\n')throw new Error('invalid-frozen-prediction-bytes');
 const guard=`assert(resolve and resolve:GetProductName()=='DaVinci Resolve' and resolve:IsStudio()==false,'Wrong product')
do
 local fusion=assert(resolve:Fusion(),'No Fusion');local reader=assert(fusion:OpenFile(${JSON.stringify(record.predictionPath)},1),'Frozen prediction unavailable')
 local expected=${JSON.stringify(expected)};local checked,actual=pcall(function()
  assert(reader:GetFileSize()==#expected,'Prediction size changed');local parts,count={},0
  while count<#expected do local part=reader:ReadLine();assert(type(part)=='string'and#part>0 and#part<=#expected-count,'Prediction read failed');parts[#parts+1]=part;count=count+#part end
  assert(reader:ReadLine()==nil and reader:GetFileSize()==#expected,'Prediction EOF differs');return table.concat(parts)
 end);local closed=pcall(function()reader:Close()end);assert(checked and closed and actual==expected,'Frozen prediction bytes differ')
end
`;
 return guard+source;
}
async function prepareChallenge(previousPreparation,{install=false}={}){
 if(!path.isAbsolute(previousPreparation||'')||typeof install!=='boolean')throw new Error('invalid-blind-challenge-options');
 const prior=await readCapture(previousPreparation),previous=JSON.parse(readInput(previousPreparation));
 const frozen=readInput(previous.predictionPath);
 if(sha(frozen)!==prior.predictionSha256||json(JSON.parse(frozen))!==json(prior.prediction))throw new Error('prediction-not-frozen');
 const backup=readInput(previous.paths.second);if(sha(backup)!==prior.graphs[1].archive.sha256)throw new Error('blind-backup-differs');
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-native-blind-challenge-')));await fs.chmod(directory,0o700);
 const probeId=randomBytes(16).toString('hex'),plan=planChallenge(prior.observations[2],probeId);
 const record={schemaVersion:1,operation:'prepare-native-blind-challenge',directory,probeId,projectName:NAME,projectId:prior.projectId,previousPreparation,
  predictionSha256:prior.predictionSha256,predictionCanonicalSha256:prior.predictionCanonicalSha256,predictionPath:previous.predictionPath,frozenPredictionBytes:frozen.toString(),sourceHashes:hashes(),...plan,
  backupPath:path.join(directory,'verified-baseline.drp'),backupBytes:backup.length,backupSha256:sha(backup),resultPath:path.join(directory,'result.json'),markerPath:path.join(directory,'complete.txt'),
  exports:{before:path.join(directory,'before.drp'),challenged:path.join(directory,'challenged.drp'),restored:path.join(directory,'restored.drp')}};
 await fs.writeFile(record.backupPath,backup,{flag:'wx',mode:0o600});record.sourcePath=path.join(directory,`Frameline Blind Challenge ${probeId.slice(0,12)}.lua`);
 const source=await renderBlindChallenge(record);record.sourceSha256=sha(source);await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});
 record.installedPath=install?path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility',path.basename(record.sourcePath)):null;
 if(install){const folder=path.dirname(record.installedPath),s=await fs.lstat(folder);if(!s.isDirectory()||await fs.realpath(folder)!==folder)throw new Error('unsafe-blind-challenge-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
 const preparation=path.join(directory,'preparation.json');await fs.writeFile(preparation,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
 return{preparation,sourcePath:record.sourcePath,sourceSha256:record.sourceSha256,menuName:path.basename(record.sourcePath,'.lua'),predictionSha256:record.predictionSha256,predictionFrozenBeforeChallenge:true};
}
async function owned(filename){const h=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid())throw new Error('unsafe-blind-challenge-output');await h.chmod(0o600);}finally{await h.close();}return readInput(filename);}
async function persist(filename,bytes){try{await fs.writeFile(filename,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||!(await owned(filename)).equals(Buffer.from(bytes)))throw e;}}
async function readChallenge(preparation){
 const record=JSON.parse(readInput(preparation)),directory=path.dirname(preparation),s=await fs.lstat(directory);
 if(!s.isDirectory()||s.mode&0o077||s.uid!==process.getuid()||await fs.realpath(directory)!==directory||record.directory!==directory||record.schemaVersion!==1||record.operation!=='prepare-native-blind-challenge'
  ||record.projectName!==NAME||!/^[a-f0-9]{32}$/.test(record.probeId)||record.sourcePath!==path.join(directory,`Frameline Blind Challenge ${record.probeId.slice(0,12)}.lua`)
  ||record.backupPath!==path.join(directory,'verified-baseline.drp')||record.resultPath!==path.join(directory,'result.json')||record.markerPath!==path.join(directory,'complete.txt')
  ||json(record.exports)!==json({before:path.join(directory,'before.drp'),challenged:path.join(directory,'challenged.drp'),restored:path.join(directory,'restored.drp')}))throw new Error('invalid-blind-challenge-record');
 const prior=await readCapture(record.previousPreparation),previous=JSON.parse(readInput(record.previousPreparation)),plan=planChallenge(prior.observations[2],record.probeId),source=await owned(record.sourcePath);
 if(json(plan)!==json({observation:record.observation,challenged:record.challenged,bindings:record.bindings})||record.projectId!==prior.projectId||prior.predictionSha256!==record.predictionSha256
  ||prior.predictionCanonicalSha256!==record.predictionCanonicalSha256||record.predictionPath!==previous.predictionPath||record.frozenPredictionBytes!==readInput(previous.predictionPath).toString()
  ||sha(source)!==record.sourceSha256||source.toString()!==await renderBlindChallenge(record)||json(record.sourceHashes)!==json(hashes())
  ||sha(await owned(record.backupPath))!==record.backupSha256||record.backupSha256!==prior.graphs[1].archive.sha256)throw new Error('blind-challenge-source-changed');
 if((await owned(record.markerPath)).toString()!==`FRAMELINE_NATIVE_TRACK_CHALLENGE_COMPLETE_V1:${record.probeId}\n`)throw new Error('blind-challenge-incomplete');
 const raw=await owned(record.resultPath),result=JSON.parse(raw);
 if(result.schemaVersion!==1||result.operation!=='resolve-native-track-challenge'||result.probeId!==record.probeId||result.safeToApply!==false||result.ordinaryApplySupported!==false
  ||result.frozenPredictionSha256!==record.predictionSha256||result.frozenPredictionCanonicalSha256!==record.predictionCanonicalSha256)throw new Error('invalid-blind-challenge-result');
 if(result.status!=='restored'||result.stage!=='complete'||result.representedStateRestored!==true)return{status:result.status,stage:result.stage,recoveryRequired:true,ordinaryApplySupported:false};
 for(const[key,expected]of[['before',record.observation],['challenged',record.challenged],['reopened',record.challenged],['restored',record.observation]])if(json(parseEffectObservation(JSON.stringify(result[key])))!==json(expected))throw new Error('blind-challenge-state-differs');
 const graphs={};
 for(const[key,filename]of Object.entries(record.exports)){
  const bytes=await owned(filename),observation=key==='challenged'?result.reopened:result[key],obsPath=path.join(directory,key+'-observation.json');await persist(obsPath,Buffer.from(JSON.stringify(observation)+'\n'));
  graphs[key]=readNativeLocationGraph(filename,undefined);if(graphs[key].archive.sha256!==sha(bytes))throw new Error('blind-challenge-export-changed');
  if(key==='challenged'){
   const independent=JSON.parse(execFileSync('python3',[path.join(__dirname,'resolve-native-track-identity.py'),'bind-challenge',filename,obsPath],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:15000}));
   if(independent.archive.sha256!==graphs[key].archive.sha256)throw new Error('independent-challenge-source-differs');
   graphs[key].apiBindings=independent.apiBindings;graphs[key].bindingMethod=independent.bindingMethod;graphs[key].challengeNonce=independent.challengeNonce;
  }
 }
 if(json(identityFacts(prior.graphs[1]))!==json(identityFacts(graphs.before))||json(identityFacts(graphs.before))!==json(identityFacts(graphs.restored)))throw new Error('blind-challenge-native-restoration-differs');
 const predicted=prior.prediction.timelines.flatMap(t=>t.bindings.map(b=>({timelineId:t.timelineId,type:b.type,index:b.index,nativeTrackId:b.nativeTrackId,itemCount:b.itemCount}))).sort((a,b)=>json(a).localeCompare(json(b)));
 const independent=graphs.challenged.apiBindings.map(({timelineId,type,index,nativeTrackId,itemCount})=>({timelineId,type,index,nativeTrackId,itemCount})).sort((a,b)=>json(a).localeCompare(json(b)));
 if(json(predicted)!==json(independent))throw new Error('blind-prediction-disagrees-with-independent-challenge');
 return{schemaVersion:1,operation:'native-blind-challenge-receipt',status:'restored',projectId:prior.projectId,resultSha256:sha(raw),resultBytes:raw.length,sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,
  frozenPredictionSha256:record.predictionSha256,frozenPredictionCanonicalSha256:record.predictionCanonicalSha256,predictionFrozenBeforeChallenge:true,
  independentGroundTruthMethod:'temporary-unique-name-response-without-vector-index',predictedBindingsMatchIndependentChallenge:true,
  observations:{before:result.before,challenged:result.reopened,restored:result.restored},graphs,priorPrediction:prior.prediction,safeToApply:false,ordinaryApplySupported:false};
}
if(require.main===module){const[op,a,flag]=process.argv.slice(2);const action=op==='prepare'&&a&&(!flag||flag==='--install')?prepareChallenge(a,{install:flag==='--install'}):op==='read'&&a&&!flag?readChallenge(a):Promise.reject(new Error('usage'));
 action.then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(e=>{process.stderr.write('native-blind-challenge-failed:'+e.message+'\n');process.exitCode=1;});}
module.exports={planChallenge,renderBlindChallenge,prepareChallenge,readChallenge};
