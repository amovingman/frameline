'use strict';
// Explicit host-only verification. Historical records are checked without
// reopening a project, repairing data or granting permission to Apply.
const fs=require('node:fs/promises'),path=require('node:path'),{constants}=require('node:fs');
const {createHash}=require('node:crypto'),{isDeepStrictEqual}=require('node:util');
const {validateTransferBundle}=require('./revision-transfer');
const {validateScanManifest}=require('./scan-manifest');
const {validateNativeCensus,compareNativeThreeWay}=require('./native-checkpoint-diff');
const {nativeGraph}=require('./closed-project-checkpoint-store');
const native=require('./closed-project-native-store');
const HASH=/^[a-f0-9]{64}$/,ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
function verifyIdentityHistory(records){
 need(records.reduce((n,r)=>n+(r.entities?.length||0),0)<=200000,'integrity-capacity-exceeded');
 const byId=new Map(records.map(r=>[r.checkpointId,r]));need(byId.size===records.length,'integrity-identity-collision');
 const states=new Map(),visiting=new Set();let derivedEntries=0;
 function visit(r){if(states.has(r.checkpointId))return states.get(r.checkpointId);need(!visiting.has(r.checkpointId),'integrity-ancestry-cycle');visiting.add(r.checkpointId);
  const parentId=r.parentCheckpointId||r.forkParentCheckpointId,parent=parentId?byId.get(parentId):null;need(!parentId||parent,'integrity-parent-missing');
  need(Array.isArray(r.entities)&&Array.isArray(r.nativeGraph)&&r.entities.length===r.nativeGraph.length,'integrity-identity-graph');
  const prior=parent?visit(parent):new Map(),sameLineage=parent?.lineageId===r.lineageId;
  const derivedSize=sameLineage?prior.size+r.entities.filter(e=>!prior.has(e.kind+':'+e.nativeId)).length:r.entities.length;
  need(derivedEntries+derivedSize<=200000,'integrity-capacity-exceeded');derivedEntries+=derivedSize;
  const current=sameLineage?new Map([...prior].map(([k,v])=>[k,{...v,present:false}])):new Map(),appIds=new Set(),comparisonIds=new Set();
  const graphByKey=new Map(r.nativeGraph.map(e=>[e.kind+':'+e.nativeId,e])),entityByKey=new Map(r.entities.map(e=>[e.kind+':'+e.nativeId,e]));need(graphByKey.size===r.nativeGraph.length&&entityByKey.size===r.entities.length,'integrity-identity-collision');
  for(const entity of r.entities){const key=entity.kind+':'+entity.nativeId,graph=graphByKey.get(key),old=prior.get(key);need(graph&&ID.test(entity.appId||'')&&ID.test(entity.comparisonId||'')&&!appIds.has(entity.appId)&&!comparisonIds.has(entity.comparisonId)&&Number.isSafeInteger(entity.generation)&&entity.generation>=1,'integrity-identity-invalid');appIds.add(entity.appId);comparisonIds.add(entity.comparisonId);
   for(const field of ['dbType','parentKind','parentNativeId'])need(entity[field]===graph[field],'integrity-identity-parent');
   const p=entity.parentKind?entityByKey.get(entity.parentKind+':'+entity.parentNativeId):null;need(entity.parentAppId===(p?.appId||null),'integrity-identity-parent');
   if(sameLineage&&old){if(old.present)need(entity.appId===old.appId&&entity.generation===old.generation&&entity.comparisonId===old.comparisonId,'integrity-identity-reused');else need(entity.generation===old.generation+1&&entity.appId!==old.appId&&entity.comparisonId!==old.comparisonId,'integrity-identity-reused');}
   else if(parent&&!sameLineage){need(r.forkParentCheckpointId===parent.checkpointId&&HASH.test(r.copyProofSha256||'')&&ID.test(r.copyTransactionId||'')&&old&&entity.appId!==old.appId&&entity.comparisonId===old.comparisonId,'integrity-fork-unverified');}
   else need(entity.generation===1,'integrity-identity-generation');
   current.set(key,{appId:entity.appId,comparisonId:entity.comparisonId,generation:entity.generation,present:true});
  }
  need(r.entities.find(e=>e.kind==='project')?.appId===r.projectAppId,'integrity-project-identity');visiting.delete(r.checkpointId);states.set(r.checkpointId,current);return current;
 }
 for(const r of records)visit(r);return{checkpoints:records.length,entities:records.reduce((n,r)=>n+r.entities.length,0)};
}
async function verifyArtifact(file,roots){
 need(file&&path.isAbsolute(file.path||'')&&HASH.test(file.sha256||'')&&Number.isSafeInteger(file.bytes)&&file.bytes>0&&file.bytes<=128*1024*1024,'integrity-artifact-invalid');
 const real=await fs.realpath(file.path);need(real===file.path&&roots.some(root=>real.startsWith(root+path.sep)),'integrity-artifact-outside-store');
 const h=await fs.open(real,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const a=await h.stat({bigint:true});need(a.isFile()&&a.nlink===1n&&a.uid===BigInt(process.getuid())&&!(Number(a.mode)&0o077)&&Number(a.size)===file.bytes,'integrity-artifact-unsafe');const hash=createHash('sha256'),buf=Buffer.alloc(1024*1024);let bytes=0;while(true){const r=await h.read(buf,0,buf.length,null);if(!r.bytesRead)break;bytes+=r.bytesRead;need(bytes<=file.bytes,'integrity-artifact-changed');hash.update(buf.subarray(0,r.bytesRead));}const z=await h.stat({bigint:true}),n=await fs.lstat(real,{bigint:true});need(['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===z[k]&&a[k]===n[k])&&hash.digest('hex')===file.sha256&&bytes===file.bytes,'integrity-artifact-changed');return bytes;}finally{await h.close();}
}
function createLocalIntegrityVerifier({getSelection=async()=>null,getHistory=async()=>null,listCheckpoints=async()=>[],readCheckpoint,listIntents=async()=>[],readTransaction,verifyResult=async()=>false,artifactRoots=[],workDirectory,onChange=()=>{},canRun=()=>true}={}){
 need(path.isAbsolute(workDirectory||'')&&artifactRoots.every(r=>path.isAbsolute(r))&&[getSelection,getHistory,listCheckpoints,readCheckpoint,listIntents,readTransaction,verifyResult,onChange,canRun].every(f=>typeof f==='function'),'integrity-config-invalid');
 let state={busy:false,status:'not-checked',checkedAt:null,checks:[],error:null,scope:'owner-local',safeToApply:false};
 const getState=()=>structuredClone(state),publish=()=>{const s=getState();try{Promise.resolve(onChange(s)).catch(()=>{});}catch{}return s;};
 async function run(){if(state.busy)return getState();state={...state,busy:true,status:'checking',checkedAt:null,checks:[],error:null};publish();const add=(id,status,count=0)=>{state.checks.push({id,status,count});publish();};
  try{need(canRun()===true,'integrity-work-active');const selected=await getSelection();if(selected){validateScanManifest(selected.manifest);const bundle=await getHistory(selected);need(bundle?.projectId===selected.projectId,'integrity-history-scope');const records=validateTransferBundle(bundle);add('immutable-history-records','verified',records.size);add('branch-ancestry','verified',Object.keys(bundle.branches).length);add('exact-frame-coordinates','verified',selected.manifest.clips.length);}else{add('immutable-history-records','not-selected');add('exact-frame-coordinates','not-selected');}
   const checkpoints=await listCheckpoints();need(Array.isArray(checkpoints)&&checkpoints.length<=100,'integrity-capacity-exceeded');const retained=[];let coordinates=0;for(const record of checkpoints){const cp=await readCheckpoint(record.checkpointId);need(isDeepStrictEqual(cp.record,record),'integrity-checkpoint-changed');validateNativeCensus(cp.census);need(sha(cp.databaseBytes)===record.source.sha256&&sha(cp.censusBytes)===record.source.censusSha256&&isDeepStrictEqual(nativeGraph(cp.census),record.nativeGraph),'integrity-checkpoint-changed');const input={base:cp.census,local:cp.census,incoming:cp.census,namespace:sha((record.comparisonRootLineageId||record.lineageId)+':'+record.projectId)},a=compareNativeThreeWay(input),b=compareNativeThreeWay(input);need(a.reportId===b.reportId&&a.summary.changed===0,'integrity-determinism-failed');coordinates+=a.summary.totalCompared;need(coordinates<=2000000,'integrity-capacity-exceeded');retained.push(record);await new Promise(done=>setImmediate(done));}
   add('authenticated-checkpoints',checkpoints.length?'verified':'empty',checkpoints.length);verifyIdentityHistory(retained);add('persistent-native-identities',retained.length?'verified':'empty',retained.reduce((n,r)=>n+r.entities.length,0));add('deterministic-stored-comparison',retained.length?'verified':'empty',coordinates);
   const intents=await listIntents();
   need(Array.isArray(intents)&&intents.length<=100,'integrity-capacity-exceeded');
   const transactions=new Set();let backups=0,preservations=0,validatedResults=0;
   for(const intent of intents){
    if(!intent.transactionId)continue;
    need(!transactions.has(intent.transactionId),'integrity-transaction-collision');transactions.add(intent.transactionId);
    const tx=await readTransaction(intent.transactionId);
    need(tx.transactionId===intent.transactionId&&tx.plan?.planId===intent.plan?.executionPlan?.planId,'integrity-transaction-scope');
    for(const result of tx.nativeRevisions||[]){need(await verifyResult(intent.intentId,result.direction)===true,'integrity-result-unverified');validatedResults++;}
    if(tx.backup){await verifyArtifact(tx.backup,artifactRoots);need(tx.backup.sha256===tx.source.sha256,'integrity-backup-binding');backups++;}
    if(tx.candidate){
     await verifyArtifact(tx.candidate,artifactRoots);
     if(tx.preservation){
      await fs.mkdir(workDirectory,{recursive:true,mode:0o700});
      const ws=await fs.lstat(workDirectory);
      need(ws.isDirectory()&&!ws.isSymbolicLink()&&ws.uid===process.getuid()&&!(ws.mode&0o077)&&await fs.realpath(workDirectory)===workDirectory,'integrity-workspace-unsafe');
      const temp=await fs.mkdtemp(path.join(workDirectory,'check-'));
      try{const proof=await native.compareNameCandidate({plan:tx.plan,backup:tx.backup,candidate:tx.candidate,directory:temp});need(isDeepStrictEqual(proof,tx.preservation),'integrity-preservation-changed');preservations++;}
      finally{await fs.rm(temp,{recursive:true,force:true});}
     }
    }
   }
   add('authenticated-native-transactions',transactions.size?'verified':'empty',transactions.size);add('verified-restore-points',backups?'verified':'empty',backups);add('all-other-fields-preserved',preservations?'verified':'empty',preservations);
   add('native-editor-results',validatedResults?'verified':'empty',validatedResults);
   need(isDeepStrictEqual(await getSelection(),selected)&&isDeepStrictEqual(await listCheckpoints(),checkpoints)&&isDeepStrictEqual(await listIntents(),intents)&&canRun()===true,'integrity-selection-changed');state.status=state.checks.some(c=>c.status==='verified')?'verified':'empty';state.checkedAt=new Date().toISOString();
  }catch(e){state.status='failed';state.error=typeof e.code==='string'&&/^integrity-[a-z-]+$/.test(e.code)?e.code:'integrity-record-unverified';}
  finally{state.busy=false;}return publish();
 }
 return{run,getState,isBusy:()=>state.busy};
}
module.exports={createLocalIntegrityVerifier,verifyIdentityHistory,verifyArtifact};
