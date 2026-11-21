'use strict';
const path=require('node:path');
const {createMediaRelinkService}=require('./media-relink-service');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const need=(v,c)=>{if(!v)throw Object.assign(Error('media-relink-'+c),{code:'media-relink-'+c});};
const label=v=>path.basename(String(v||'')).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180);
const ERRORS={
 'media-relink-candidate-content-mismatch':'The replacement does not match the captured size and SHA-256 fingerprint. Choose the same media bytes.',
 'media-relink-asset-class-mismatch':'This file has another declared media role. Choose the captured original or proxy bytes for this reference.',
 'media-relink-candidate-changed':'The replacement changed after review. Choose it again and review a fresh copy.',
 'media-relink-expected-identity-required':'This reference has no retained fingerprint. Capture it while the declared media is available.',
 'media-relink-destination-exists':'A file already uses that copy name. Review a different destination; no existing file was replaced.',
 'media-relink-review-stale':'The reviewed plan changed. Review the current copy before creating it.',
 'media-relink-import-already-issued':'This one-use command already started or finished. Read its result; quit Resolve and retire it before preparing another.',
 'media-relink-import-editor-running':'Quit Resolve before retiring this import. Its derived project and evidence will be retained.',
 'media-relink-import-frame-rate-unsupported':'Automated import currently supports whole-frame-rate timelines. The verified FCPXML copy remains available.',
 'media-relink-import-proxy-pair-ambiguous':'These aliases assign different proxies to the same original. The verified copy remains available for manual review.',
 'media-relink-import-retired':'This import attempt is retired and cannot be admitted again.',
 'media-relink-existing-native-project-open':'Resolve still has a saved Project.db open. Close that project and enter the empty workspace before admitting creation.'
};
function createDesktopMediaRelink({directory,getSelection,selectCandidate,selectDestination,reveal=async()=>{},canStart=()=>true,onChange=()=>{},service:provided,importOptions={},importer:providedImporter}={}){
 need(path.isAbsolute(directory||'')&&[getSelection,selectCandidate,selectDestination,reveal,canStart,onChange].every(f=>typeof f==='function'),'desktop-config');
 const service=provided||createMediaRelinkService({directory});let importer=providedImporter,current=null,initialized=false,busy=false,errorCode=null;const intents=new Map();
 const native=()=>importer||(importer=require('./media-relink-import').createMediaRelinkImport(importOptions));
 const install=r=>{intents.set(r.intentId,r);current=r.intentId;return r;};
 function publicIntent(r){return r?{intentId:r.intentId,state:r.state,sourceHash:r.sourceHash,sourceName:label(r.sourcePath),profile:r.profile,clipCount:r.scan.clips.length,references:r.references.map(ref=>{const selected=r.choices.find(c=>c.referenceId===ref.referenceId);return{referenceId:ref.referenceId,assetClass:ref.assetClass,name:label(ref.sourcePath),assetCount:ref.assetIds.length,aliasCount:ref.aliases.length,expectedVerified:!!ref.expected,size:ref.expected?.size??null,contentHash:ref.expected?.sha256||null,candidateName:selected?label(selected.candidatePath):null,selected:!!selected};}),plan:r.plan?{planId:r.plan.planId,sourceHash:r.plan.sourceHash,candidateHash:r.plan.candidateHash,changedReferences:r.plan.choices.length,changedAttributes:r.plan.proof.authorizedAttributeCount,allOtherBytesPreserved:true}:null,copy:r.copy?{name:label(r.copy.name),sha256:r.copy.sha256}:null,importCheck:r.importCheck?{menuName:r.importCheck.prepared.menuName,projectName:r.importCheck.prepared.projectName,libraryName:label(r.importCheck.prepared.request.library.name),status:r.importCheck.status||'prepared',verified:r.state==='import-validated'}:null,createdAt:r.createdAt,updatedAt:r.updatedAt}:null;}
 function getState(){return{initialized,busy,errorCode,error:errorCode?(ERRORS[errorCode]||'The media relink could not be verified. Keep the retained copy and review the source, media identity and recovery state.'):null,reviewLocked:isReviewLocked(),intent:publicIntent(intents.get(current)),intents:[...intents.values()].map(r=>({intentId:r.intentId,state:r.state,sourceName:label(r.sourcePath),createdAt:r.createdAt}))};}
 function isReviewLocked(){return busy||[...intents.values()].some(r=>['capturing','reviewing','prepared','publishing','recovery-required','import-prepared','imported'].includes(r.state));}
 function changed(){try{Promise.resolve(onChange(getState())).catch(()=>{});}catch{}return getState();}
 async function selected(id){need(ID.test(id||''),'intent-id');const r=await service.read(id);need(r.state!=='cancelled','intent-cancelled');return r;}
 async function action(name,...args){if(busy)return getState();busy=true;errorCode=null;changed();try{
  need(['initialize','capture','choose','prepare','publish','recover','reveal','prepare-import','read-import','validate-import','retire-import','cancel','select'].includes(name),'action-invalid');
  if(['initialize','capture'].includes(name))need(args.length===0,'action-invalid');else if(name==='choose')need(args.length===2&&ID.test(args[0]||'')&&HASH.test(args[1]||''),'action-invalid');else if(name==='publish')need(args.length===2&&ID.test(args[0]||'')&&HASH.test(args[1]||''),'action-invalid');else need(args.length===1&&ID.test(args[0]||''),'action-invalid');
  if(['capture','choose','prepare','publish','prepare-import','read-import','validate-import','retire-import'].includes(name)){need(canStart()===true,'another-review-active');need(![...intents.values()].some(r=>r.intentId!==args[0]&&['capturing','reviewing','prepared','publishing','recovery-required','import-prepared','imported'].includes(r.state)),'review-active');}
  if(name==='initialize'){for(const r of await service.list())install(r);initialized=true;}
  else if(name==='capture'){need(![...intents.values()].some(r=>['capturing','reviewing','prepared','publishing','recovery-required','import-prepared','imported'].includes(r.state)),'review-active');const selection=await getSelection();need(selection?.sourcePath&&HASH.test(selection.sourceHash||''),'selection-required');install(await service.capture(selection));}
  else if(name==='choose'){const r=await selected(args[0]),ref=r.references.find(v=>v.referenceId===args[1]);need(ref,'reference-changed');const filename=await selectCandidate({assetClass:ref.assetClass,name:label(ref.sourcePath),expectedSize:ref.expected?.size??null});if(filename)install(await service.choose(r.intentId,ref.referenceId,filename));}
  else if(name==='prepare'){const r=await selected(args[0]),destination=await selectDestination({preferredFilename:path.basename(r.sourcePath,'.fcpxml')+' Relinked.fcpxml'});if(destination)install(await service.prepare(r.intentId,destination));}
  else if(name==='publish'){const r=await selected(args[0]);need(r.plan?.planId===args[1],'review-stale');install(await service.publish(r.intentId));}
  else if(name==='recover')install(await service.recover(args[0]));
  else if(name==='cancel')install(await service.cancel(args[0]));
  else if(name==='select')install(await service.read(args[0]));
  else if(name==='reveal'){const r=await service.verify(args[0]);need(r.state!=='cancelled','intent-cancelled');await reveal(r.copy.path);install(r);}
  else if(name==='prepare-import'){const r=await service.verify(args[0]);need(['validated','import-prepared','import-retired'].includes(r.state),'import-not-ready');if(r.importCheck&&!r.importCheck.retired){const result=await native().read({record:r,admit:false});need(result.status==='pending'&&!result.started,'import-already-issued');install(r);}else{const prepared=await native().prepare({record:r,directory:path.join(service.folder(r.intentId),'import-'+require('node:crypto').randomUUID())});install(await service.append(r,{state:'import-prepared',importCheck:{prepared,status:'prepared'},importRetirements:[...(r.importRetirements||[]),...(r.importCheck?.retired?[r.importCheck]:[])]}));}}
  else if(name==='retire-import'){const r=await selected(args[0]);need(r.state==='import-prepared'&&r.importCheck,'import-not-ready');const retirement=await native().retire({record:r});install(await service.append(r,{state:'import-retired',importCheck:{...r.importCheck,status:'retired',retired:true,retirement}}));}
  else if(name==='read-import'){const r=await selected(args[0]);need(r.importCheck&&['import-prepared','imported'].includes(r.state),'import-not-ready');await service.verify(r.intentId);const result=await native().read({record:r,admit:true});install(await service.append(r,{state:result.status==='imported'?'imported':r.state,importCheck:{...r.importCheck,status:result.status}}));}
  else if(name==='validate-import'){const r=await selected(args[0]);need(r.state==='imported','import-not-ready');await service.verify(r.intentId);const proof=await native().verify({record:r});install(await service.append(r,{state:'import-validated',importProof:proof,importCheck:{...r.importCheck,status:'verified'}}));}
 }catch(e){errorCode=typeof e.code==='string'&&/^media-relink-[a-z0-9-]{1,80}$/.test(e.code)?e.code:'media-relink-action-failed';if(args[0]&&ID.test(args[0]))try{install(await service.read(args[0]));}catch{}else if(name==='capture')try{for(const record of await service.list())install(record);}catch{}}
 finally{busy=false;}return changed();}
 return{action,getState,isBusy:()=>busy,isReviewLocked};
}
module.exports={createDesktopMediaRelink};
