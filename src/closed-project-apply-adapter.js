'use strict';
// Trusted host adapter for the scoped, owner-controlled offline Name workflow.
// All renderer actions are IDs. Paths, reviewed bytes and native observations
// live in authenticated private records and are rechecked at each boundary.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {constants}=require('node:fs'),{createHash,createHmac,randomBytes}=require('node:crypto'),{isDeepStrictEqual}=require('node:util');
const {createClosedProjectApplyPlan,verifyClosedProjectApplyPlan}=require('./closed-project-apply-plan');
const {createClosedProjectOfflineGuard,assertSameClosedProjectObservation}=require('./closed-project-apply-offline-guard');
const native=require('./closed-project-native-store');
const sourceBindings=require('./closed-project-apply-source-binding');
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=c=>Object.assign(Error(c),{code:c});
const need=(v,c)=>{if(!v)throw fail(c);};
async function privateDir(p){await fs.mkdir(p,{recursive:true,mode:0o700});const s=await fs.lstat(p);need(s.isDirectory()&&!s.isSymbolicLink()&&!(s.mode&0o077)&&s.uid===process.getuid()&&await fs.realpath(p)===p,'apply-private-directory-required');return p;}
async function readPrivate(p){const h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await h.stat();need(s.isFile()&&s.nlink===1&&s.uid===process.getuid()&&!(s.mode&0o077)&&s.size<=128*1024*1024,'apply-private-record-invalid');return await h.readFile();}finally{await h.close();}}
async function writePrivate(p,b){const h=await fs.open(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(b);await h.sync();}finally{await h.close();}const d=await fs.open(path.dirname(p),'r');try{await d.sync();}finally{await d.close();}}
function createClosedProjectApplyAdapter({directory,getCurrentReview,guard=createClosedProjectOfflineGuard(),nativeStore=native,publishFile,companion,sourceBindingService=sourceBindings}={}){
 need(path.isAbsolute(directory||'')&&typeof getCurrentReview==='function'&&typeof sourceBindingService?.prepareClosedProjectSourceBinding==='function'&&typeof sourceBindingService?.observeLoadedProjectSource==='function','apply-adapter-invalid');
 let ready;async function initialize(){if(!ready)ready=(async()=>{await privateDir(directory);await privateDir(path.join(directory,'plans'));const p=path.join(directory,'context.key');try{await writePrivate(p,randomBytes(32));}catch(e){if(e.code!=='EEXIST')throw e;}const k=await readPrivate(p);need(k.length===32,'apply-context-key-invalid');return k;})();return ready;}
 const mac=(k,b)=>createHmac('sha256',k).update(b).digest('hex');
 async function retain(p,value){const body=JSON.stringify(value),key=await initialize();await writePrivate(p,JSON.stringify({body,mac:mac(key,body)}));}
 async function retained(p){const key=await initialize(),v=JSON.parse(await readPrivate(p));need(typeof v.body==='string'&&v.mac===mac(key,v.body),'apply-context-invalid');return JSON.parse(v.body);}
 function planDir(plan){need(/^[a-f0-9]{64}$/.test(plan?.planId),'apply-plan-invalid');return path.join(directory,'plans',plan.planId);}
 async function context(plan){const c=await retained(path.join(planDir(plan),'context.json'));need(isDeepStrictEqual(c.plan,plan),'apply-context-plan-mismatch');return c;}
 async function recheckSourceBinding(c){const current=await sourceBindingService.prepareClosedProjectSourceBinding({sourcePath:c.sourcePath,projectName:c.plan.projectName});need(isDeepStrictEqual(current,c.sourceBinding),'apply-source-library-binding-changed');return current;}
 async function workspace(parent,prefix){await privateDir(parent);return fs.mkdtemp(path.join(parent,prefix));}
 async function createPlan({review,source}){
  await initialize();need(typeof source==='string','closed-apply-source-required');
  const before=JSON.parse(review.sources.local),sourceBinding=await sourceBindingService.prepareClosedProjectSourceBinding({sourcePath:source,projectName:before.project_name}),observation=await guard.inspect({sourcePath:source});
  const scratch=await workspace(directory,'prepare-');
  const captured=await nativeStore.inspectClosedDatabase({sourcePath:source,directory:scratch,projectId:before.project_id,projectName:before.project_name});
  assertSameClosedProjectObservation(observation,await guard.inspect({sourcePath:source,expectedSourceHash:observation.sha256}));
  need(sha(captured.databaseBytes)===observation.sha256,'apply-source-capture-mismatch');
  const plan=createClosedProjectApplyPlan({...review,databaseBytes:captured.databaseBytes,censusBytes:captured.censusBytes});
  const dir=planDir(plan);await privateDir(dir);
  const saved={plan,sourcePath:source,sourceBinding,observation,sources:Object.fromEntries(Object.entries(review.sources).map(([k,v])=>[k,v.toString('base64')])),reviewPlan:review.plan,audit:review.audit,snapshotPath:captured.snapshotPath,censusPath:captured.censusPath};
  try{await retain(path.join(dir,'context.json'),saved);}catch(e){if(e.code!=='EEXIST')throw e;const existing=await context(plan);need(existing.sourcePath===source,'apply-plan-source-conflict');}
  return plan;
 }
 async function verifyPlan(plan){const c=await context(plan),review=await getCurrentReview();await recheckSourceBinding(c);const observation=await guard.inspect({sourcePath:c.sourcePath,expectedSourceHash:plan.source.sha256});need(isDeepStrictEqual(observation.metadata,c.observation.metadata),'apply-source-metadata-changed');
  const dir=await workspace(directory,'verify-'),captured=await nativeStore.inspectClosedDatabase({sourcePath:c.sourcePath,directory:dir,projectId:plan.projectId,projectName:plan.projectName});
  need(sha(captured.databaseBytes)===observation.sha256,'apply-source-capture-mismatch');verifyClosedProjectApplyPlan(plan,{...review,databaseBytes:captured.databaseBytes,censusBytes:captured.censusBytes});assertSameClosedProjectObservation(observation,await guard.inspect({sourcePath:c.sourcePath,expectedSourceHash:plan.source.sha256}));return true;}
 async function inspectSource({plan}){const c=await context(plan);await recheckSourceBinding(c);await guard.inspect({sourcePath:c.sourcePath});return{path:c.sourcePath};}
 async function createBackup({plan,directory:dir}){const c=await context(plan),before=await guard.inspect({sourcePath:c.sourcePath,expectedSourceHash:plan.source.sha256});const dest=await workspace(dir,'backup-'),capture=await nativeStore.inspectClosedDatabase({sourcePath:c.sourcePath,directory:dest,projectId:plan.projectId,projectName:plan.projectName});assertSameClosedProjectObservation(before,await guard.inspect({sourcePath:c.sourcePath,expectedSourceHash:plan.source.sha256}));return{path:capture.snapshotPath};}
 async function createCandidate({plan,backup,directory:dir}){const dest=await workspace(dir,'candidate-');const result=await nativeStore.createNameCandidate({snapshotPath:backup.path,directory:dest,plan});return{path:result.candidatePath};}
 async function verifyPreservation({plan,backup,candidate,transactionId}){const dest=await workspace(planDir(plan),'comparison-');return nativeStore.compareNameCandidate({plan,backup,candidate,directory:dest});}
 async function publish(options){const c=await context(options.plan);await recheckSourceBinding(c);const publisher=publishFile||require('./closed-project-apply-publisher').publishClosedProjectFile;return publisher({...options,sourcePath:c.sourcePath,originalMetadata:c.observation.metadata,offlineGuard:guard});}
 function readbackDirectory(plan,id,direction){need(/^[a-f0-9-]{36}$/.test(id)&&['apply','rollback'].includes(direction),'apply-readback-binding-invalid');return path.join(planDir(plan),`${id}-${direction}-readback`);}
 const preparingChecks=new Set();
 async function currentReadback(plan,transactionId,direction,allowMissing=false){
  const base=readbackDirectory(plan,transactionId,direction);let files;
  try{files=await fs.readdir(base);}catch(error){if(allowMissing&&error.code==='ENOENT')return null;throw error;}
  let saved=null,attemptDirectory=null,previous=null;
  // Keep pre-attempt-format records readable; a retry retains this original
  // record and includes its authenticated content hash in the pointer chain.
  if(files.includes('host-binding.json')){saved=await retained(path.join(base,'host-binding.json'));attemptDirectory=base;previous=sha(JSON.stringify(saved));}
  const pointers=files.filter(name=>/^current-[0-9]{6}\.json$/.test(name)).sort();
  for(let index=0;index<pointers.length;index++){
   need(pointers[index]===`current-${String(index).padStart(6,'0')}.json`,'apply-readback-pointer-chain-invalid');
   const pointer=await retained(path.join(base,pointers[index]));
   need(pointer.schemaVersion===1&&pointer.operation==='closed-project-editor-attempt'&&pointer.index===index
    &&pointer.transactionId===transactionId&&pointer.direction===direction&&pointer.planId===plan.planId
    &&pointer.previous===previous&&/^attempt-[0-9]{6}-[a-f0-9]{16}$/.test(pointer.attempt||''),'apply-readback-pointer-chain-invalid');
   attemptDirectory=path.join(base,pointer.attempt);saved=await retained(path.join(attemptDirectory,'host-binding.json'));
   need(sha(JSON.stringify(saved))===pointer.hostBindingSha256,'apply-readback-pointer-binding-invalid');
   previous=sha(JSON.stringify(pointer));
  }
  if(!saved){if(allowMissing)return null;throw Object.assign(Error('apply-editor-check-missing'),{code:'ENOENT'});}
  need(saved.binding?.transactionId===transactionId&&saved.binding.direction===undefined&&saved.binding.planId===plan.planId
   &&saved.prepared?.preparationPath===path.join(attemptDirectory,'preparation.json'),'apply-readback-binding-invalid');
  return{saved,directory:attemptDirectory,previous,nextIndex:pointers.length};
 }
 async function prepareEditorCheck({plan,transactionId,direction,expectedSource}){
  const base=readbackDirectory(plan,transactionId,direction);
  need(!preparingChecks.has(base),'apply-readback-preparation-in-progress');preparingChecks.add(base);
  try{
   const c=await context(plan);await recheckSourceBinding(c);const observed=await guard.inspect({sourcePath:c.sourcePath,expectedSourceHash:expectedSource.sha256});need(isDeepStrictEqual(observed.metadata,c.observation.metadata),'apply-source-metadata-changed');
   const api=companion||require('./closed-project-apply-companion');
   const binding={sourceBinding:c.sourceBinding,transactionId,planId:plan.planId,projectId:plan.projectId,projectName:plan.projectName,timelineId:plan.edit.timelineId,itemId:plan.edit.itemId,expectedName:direction==='apply'?plan.edit.newName:plan.edit.oldName,expectedDatabaseSha256:expectedSource.sha256,timelineIds:JSON.parse(Buffer.from(c.sources.local,'base64')).timelines.map(t=>t.id).sort()};
   const current=await currentReadback(plan,transactionId,direction,true);let reason='initial',previousError=null;
   if(current){
    need(isDeepStrictEqual(current.saved.binding,binding),'apply-readback-binding-invalid');
    let outcome;
    try{outcome=await api.readClosedProjectApplyCompanion(current.saved.prepared.preparationPath,binding);}
    catch(error){outcome={status:'unreadable'};previousError=String(error.code||'unreadable-native-attempt').slice(0,100);}
    if(outcome.status==='verified-open'||(outcome.status==='pending'&&!outcome.started&&!outcome.doNotReplay))return current.saved.prepared;
    need(['native-error','pending','unreadable'].includes(outcome.status),'apply-readback-retry-state-invalid');
    reason=outcome.status==='pending'?'interrupted-offline':outcome.status==='native-error'?'native-error':'unreadable-offline';
   }
   await privateDir(base);
   const index=current?.nextIndex||0,attempt=`attempt-${String(index).padStart(6,'0')}-${randomBytes(8).toString('hex')}`,dir=path.join(base,attempt);
   const prepared=await api.prepareClosedProjectApplyCompanion({...binding,directory:dir,scriptsDirectory:path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility')});
   const saved={binding,prepared};await retain(path.join(dir,'host-binding.json'),saved);
   assertSameClosedProjectObservation(observed,await guard.inspect({sourcePath:c.sourcePath,expectedSourceHash:expectedSource.sha256}));
   const pointer={schemaVersion:1,operation:'closed-project-editor-attempt',index,transactionId,direction,planId:plan.planId,
    previous:current?.previous||null,attempt,hostBindingSha256:sha(JSON.stringify(saved)),reason,previousError,createdAt:new Date().toISOString()};
   // An exclusive append is the authenticated current-pointer commit. A
   // concurrent preparation may leave an orphaned retained attempt, but can
   // never replace the winning pointer or erase an earlier native result.
   await retain(path.join(base,`current-${String(index).padStart(6,'0')}.json`),pointer);return prepared;
  }finally{preparingChecks.delete(base);}
 }
 async function readEditorCheck({plan,transactionId,direction,admit=false}){
  need(typeof admit==='boolean','apply-readback-admission-invalid');
  const c=await context(plan),{saved}=await currentReadback(plan,transactionId,direction);
  need(isDeepStrictEqual(saved.binding.sourceBinding,c.sourceBinding),'apply-readback-binding-invalid');
  const api=companion||require('./closed-project-apply-companion');
  let result=await api.readClosedProjectApplyCompanion(saved.prepared.preparationPath,saved.binding);
  if(!admit||result.status!=='pending')return result;
  // Only an explicit interactive read-check may admit the waiting native
  // command. Startup recovery and final validation never issue a ticket.
  const deadline=Date.now()+15000;let admitted=false;
  while(result.status==='pending'&&Date.now()<deadline){
   if(!admitted){const admission=await api.admitClosedProjectApplyCompanion(saved.prepared.preparationPath,{expectedBinding:saved.binding,observeSource:input=>sourceBindingService.observeLoadedProjectSource(input)});admitted=admission.admitted===true;if(admission.status==='native-error')return admission;}
   result=await api.readClosedProjectApplyCompanion(saved.prepared.preparationPath,saved.binding);
   if(result.status==='pending')await new Promise(resolve=>setTimeout(resolve,100));
  }
  return result;
 }
 async function verifyEditor({plan,transactionId,direction,expectedSource}){const c=await context(plan),opened=await readEditorCheck({plan,transactionId,direction});need(opened.status==='verified-open'&&opened.actualOpenFileBindingVerified===true&&opened.sourceBinding?.actualOpenFileBindingVerified===true&&opened.sourceBinding.concurrentWriterResistanceProven===false&&opened.sourceBinding.source?.path===c.sourcePath&&opened.sourceBinding.source.sha256===expectedSource.sha256&&opened.sourceBinding.configSha256===c.sourceBinding.configSha256&&/^[a-f0-9]{64}$/.test(opened.hostAdmissionReceiptSha256||''),'apply-editor-readback-required');await recheckSourceBinding(c);const final=await guard.inspect({sourcePath:c.sourcePath,expectedSourceHash:expectedSource.sha256});need(isDeepStrictEqual(final.metadata,c.observation.metadata),'apply-source-metadata-changed');const proof={transactionId,planId:plan.planId,direction,sourceSha256:final.sha256,projectId:plan.projectId,timelineId:plan.edit.timelineId,itemId:plan.edit.itemId,name:direction==='apply'?plan.edit.newName:plan.edit.oldName,closed:true,verified:true,metadataPreserved:true,openEvidence:opened,closedEvidence:final};const proofSha256=sha(JSON.stringify(proof));const current=await currentReadback(plan,transactionId,direction);const p=path.join(current.directory,`final-${proofSha256}.json`);await retain(p,proof);return{...proof,proofSha256};}
 return{createPlan,verifyPlan,inspectSource,createBackup,createCandidate,verifyPreservation,publish,prepareEditorCheck,readEditorCheck,verifyEditor};
}
module.exports={createClosedProjectApplyAdapter};
