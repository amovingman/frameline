'use strict';
// A controlled-fixture admission barrier. The host checks all bytes; Lua never
// claims a binary string reader, an atomic Load, or protection from concurrent writers.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path');
const{owned,json,sha}=require('./prepare-preservation-session');
const{binarySentinel}=require('./prepare-preservation-minimal-name');
const q=JSON.stringify,H=/^[a-f0-9]{64}$/;
const need=(v,c)=>{if(!v)throw new Error('preservation-handshake-'+c);};
function prepareHandshake(r){
 const d=r.directory;
 const manifest={schemaVersion:1,probeId:r.probeId,projectId:r.projectId,projectName:r.projectName,target:r.plan.target,oldName:r.plan.oldName,newName:r.plan.newName,snapshotRecordSha256:r.snapshotRecordSha256,snapshotSha256:r.snapshot.snapshot.sha256,snapshotBytes:r.snapshot.snapshot.size,liveSourcePath:r.liveSourcePath,placeholderSha256:sha(json(r.placeholderObservation)),sentinelSha256:sha(binarySentinel())};
 r.handshake={schemaVersion:1,recipe:'host-admitted-native-passthrough',manifest,planSha256:sha(json(manifest)),timeoutSeconds:240,maxPolls:4800,pollSeconds:0.05,paths:Object.fromEntries(['bindings','nativeCopy','sentinelCopy','ready','readyComplete','ticket','admission','claim'].map(k=>[k,path.join(d,'handshake-'+k+(k==='nativeCopy'?'.db':k==='sentinelCopy'?'.bin':['ready','admission'].includes(k)?'.json':'.txt'))]))};
 return r.handshake;
}
function expectedHandshake(r){const copy={...r};prepareHandshake(copy);need(json(copy.handshake)===json(r.handshake),'plan-differs');return r.handshake;}
function binding(r,preparationSha256){need(H.test(r.sourceSha256)&&H.test(preparationSha256),'identity-hash');return['FRAMELINE_HANDSHAKE_V1',r.probeId,r.handshake.planSha256,r.sourceSha256,preparationSha256].join('|');}
function ticket(r,b){return b+'|ADMIT|'+r.snapshot.snapshot.sha256+'|'+r.snapshot.snapshot.size;}
async function finalizeHandshake(preparation){const raw=await owned(preparation),r=JSON.parse(raw);expectedHandshake(r);need(sha(await owned(r.sourcePath))===r.sourceSha256,'issued-source');const bytes=Buffer.from(binding(r,sha(raw)));await fs.writeFile(r.handshake.paths.bindings,bytes,{flag:'wx',mode:0o600});return{bindingsSha256:sha(bytes),preparationSha256:sha(raw),sourceSha256:r.sourceSha256};}
function renderPreloadBarrier(r){const h=expectedHandshake(r),p=h.paths;return`
-- The held MemBlock is only passed to IOClass.Write; it is never cast or compared.
local handshake_ticket,handshake_binding=nil,nil
local function handshake_ascii(file,limit)
 local f=fusion:OpenFile(file,1);if not f then return nil end
 local ok,value=pcall(function()local size=f:GetFileSize();assert(type(size)=='number'and size>=1 and size<=limit,'Admission text size');local parts,n={},0;while n<size do local s=f:ReadLine();assert(type(s)=='string'and #s>0 and n+#s<=size and not s:find('[^ -~]'),'Admission text encoding');n=n+#s;parts[#parts+1]=s end;assert(f:ReadLine()==nil,'Admission text EOF');return table.concat(parts)end);local closed=pcall(function()f:Close()end);assert(ok and closed,'Admission text read');return value
end
local function handshake_copy(file,destination,size)
 absent(destination);local f=assert(fusion:OpenFile(file,1),'Passthrough source absent')
 local ok,buffer=pcall(function()assert(f:GetFileSize()==size and f:GetFilePos()==0,'Passthrough source size');local value,count=f:Read(size);assert((type(value)=='userdata'or type(value)=='string')and count==size and f:GetFilePos()==size,'Passthrough source count');local eof,n=f:Read(1);assert(eof==nil and n==0 and f:GetFilePos()==size,'Passthrough EOF');return value end)
 if not ok then pcall(function()f:Close()end);error(buffer)end
 local w=nil;local copied,copy_error=pcall(function()w=assert(fusion:OpenFile(destination,2),'Passthrough output absent');w:Write(buffer,size);assert(w:Flush()==true,'Passthrough flush');w:Close();w=nil end)
 if not copied then if w then pcall(function()w:Close()end)end;pcall(function()f:Close()end);error(copy_error)end
 return f,buffer
end
local held=nil
local admitted,admission_error=pcall(function()
 assert(type(os)=='table'and type(os.time)=='function'and type(bmd)=='table'and type(bmd.wait)=='function','Bounded admission clock/wait unavailable')
 for _,file in ipairs({${['nativeCopy','sentinelCopy','ready','readyComplete','ticket','admission'].map(k=>q(p[k])).join(',')}})do absent(file)end
 handshake_binding=assert(handshake_ascii(${q(p.bindings)},512),'Host bindings absent')
 assert(handshake_binding:match(${q('^FRAMELINE_HANDSHAKE_V1|'+r.probeId+'|'+h.planSha256+'|[a-f0-9]+|[a-f0-9]+$')}),'Host binding identity')
 local source_hash,prep_hash=handshake_binding:match('|([a-f0-9]+)|([a-f0-9]+)$');assert(#source_hash==64 and #prep_hash==64,'Host binding hash width')
 stage='native-passthrough-sentinel';local sf,sb=handshake_copy(${q(r.sentinelPath)},${q(p.sentinelCopy)},${binarySentinel().length});sf:Close()
 stage='native-passthrough-closed-database';local buffer;held,buffer=handshake_copy(${q(r.liveSourcePath)},${q(p.nativeCopy)},${r.snapshot.snapshot.size});placeholder_source()
 stage='waiting-host-admission';write_exact(${q(p.ready)},encode({schemaVersion=1,operation='preservation-host-admission-ready',probeId=${q(r.probeId)},planSha256=${q(h.planSha256)},sourceSha256=source_hash,preparationSha256=prep_hash,snapshotSha256=${q(r.snapshot.snapshot.sha256)},snapshotBytes=${r.snapshot.snapshot.size},nativeCopyBytes=${r.snapshot.snapshot.size},sentinelBytes=${binarySentinel().length},heldSourceAtEof=true,binaryStringReaderProven=false}))
 write_exact(${q(p.readyComplete)},${q('FRAMELINE_HANDSHAKE_READY:'+r.probeId)})
 local before=os.time();assert(type(before)=='number'and before==math.floor(before),'Admission clock invalid');local previous=before
 local wanted=handshake_binding..${q('|ADMIT|'+r.snapshot.snapshot.sha256+'|'+r.snapshot.snapshot.size)}
 for poll=1,${h.maxPolls} do
  local now=os.time();assert(type(now)=='number'and now>=previous and now-before<=${h.timeoutSeconds},'Host admission deadline');previous=now
  local value=handshake_ascii(${q(p.ticket)},1024);if value then assert(value==wanted,'Host admission ticket differs');handshake_ticket=value;break end
  bmd.wait(${h.pollSeconds})
 end
 assert(handshake_ticket,'Host admission poll bound');assert(held:GetFileSize()==${r.snapshot.snapshot.size} and held:GetFilePos()==${r.snapshot.snapshot.size},'Held source position/size changed');local eof,n=held:Read(1);assert(eof==nil and n==0 and held:GetFileSize()==${r.snapshot.snapshot.size},'Held source EOF changed');placeholder_source()
 held:Close();held=nil
end)
if held then pcall(function()held:Close()end)end
assert(admitted,admission_error)
`;}
async function identity(preparation){const raw=await owned(preparation),r=JSON.parse(raw);expectedHandshake(r);need(sha(await owned(r.sourcePath))===r.sourceSha256,'source-changed');const b=binding(r,sha(raw));need((await owned(r.handshake.paths.bindings)).toString()===b,'bindings-changed');return{r,raw,b};}
function readyExpected(r,b,prepHash){return{schemaVersion:1,operation:'preservation-host-admission-ready',probeId:r.probeId,planSha256:r.handshake.planSha256,sourceSha256:r.sourceSha256,preparationSha256:prepHash,snapshotSha256:r.snapshot.snapshot.sha256,snapshotBytes:r.snapshot.snapshot.size,nativeCopyBytes:r.snapshot.snapshot.size,sentinelBytes:binarySentinel().length,heldSourceAtEof:true,binaryStringReaderProven:false};}
async function hostAdmit(preparation,{validate,verifyLiveSource,waitMs=180000}={}){
 need(typeof validate==='function'&&typeof verifyLiveSource==='function','producer-validators-required');need(Number.isInteger(waitMs)&&waitMs>=0&&waitMs<=300000,'wait-bound');
 await validate(preparation);const {r,raw,b}=await identity(preparation),p=r.handshake.paths;
 await fs.writeFile(p.claim,'FRAMELINE_HOST_ADMISSION_CLAIM:'+r.probeId,{flag:'wx',mode:0o600});
 const deadline=Date.now()+waitMs;let readyBytes;
 while(true){let complete=false;try{complete=(await owned(p.readyComplete,true)).toString()===`FRAMELINE_HANDSHAKE_READY:${r.probeId}\n`;}catch(e){if(e.code!=='ENOENT'&&e.message!=='preservation-file-changed')throw e;}if(complete){readyBytes=await owned(p.ready,true);break;}need(Date.now()<deadline,'ready-timeout');await new Promise(resolve=>setTimeout(resolve,100));}
 need(json(JSON.parse(readyBytes))===json(readyExpected(r,b,sha(raw))),'ready-differs');await validate(preparation);await identity(preparation);
 for(const file of[p.ticket,p.admission]){try{await fs.lstat(file);throw new Error('preservation-handshake-output-exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const baseline=await owned(r.snapshotPath),copy=await owned(p.nativeCopy,true),sentinel=await owned(p.sentinelCopy,true);
 need(baseline.length===r.snapshot.snapshot.size&&sha(baseline)===r.snapshot.snapshot.sha256&&copy.equals(baseline)&&sentinel.equals(binarySentinel()),'full-byte-comparison');
 const live=await verifyLiveSource(r);need(live.sha256===r.snapshot.snapshot.sha256&&live.size===baseline.length,'live-source-differs');
 const liveHandle=await fs.open(r.liveSourcePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=await liveHandle.stat(),liveBytes=await liveHandle.readFile(),after=await liveHandle.stat(),named=await fs.lstat(r.liveSourcePath);need(before.isFile()&&before.nlink===1&&before.uid===process.getuid()&&before.dev===live.device&&before.ino===live.inode&&before.mtimeMs===live.mtimeMs&&before.ctimeMs===live.ctimeMs&&before.size===live.size&&liveBytes.equals(baseline)&&['dev','ino','size','mtimeMs','ctimeMs'].every(k=>before[k]===after[k]&&before[k]===named[k]),'live-full-byte-comparison');}finally{await liveHandle.close();}
 const finalLive=await verifyLiveSource(r);need(json(finalLive)===json(live),'live-final-stat-differs');
 const admission={schemaVersion:1,operation:'preservation-host-admission',probeId:r.probeId,planSha256:r.handshake.planSha256,sourceSha256:r.sourceSha256,preparationSha256:sha(raw),bindingsSha256:sha(b),readySha256:sha(readyBytes),nativeCopySha256:sha(copy),nativeCopyBytes:copy.length,sentinelCopySha256:sha(sentinel),fullNativeCopyAndBaselineBytesEqual:true,closedLiveSource:live,closedLiveSourceAndBaselineBytesEqual:true,ticketSha256:sha(ticket(r,b)),recipe:r.handshake.recipe,binaryStringReaderProven:false,atomicLoadBytesVerified:false,concurrentWriterResistanceProven:false};
 await fs.writeFile(p.admission,JSON.stringify(admission,null,2)+'\n',{flag:'wx',mode:0o600});await publishExclusive(p.ticket,Buffer.from(ticket(r,b)));return admission;
}
async function publishExclusive(destination,bytes){const stage=destination+'.publish';const f=await fs.open(stage,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}await fs.link(stage,destination);await fs.unlink(stage);const directory=await fs.open(path.dirname(destination),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
async function readHandshake(preparation){const {r,raw,b}=await identity(preparation),p=r.handshake.paths,ready=await owned(p.ready,true),copy=await owned(p.nativeCopy,true),sentinel=await owned(p.sentinelCopy,true),admissionBytes=await owned(p.admission),admission=JSON.parse(admissionBytes),ticketBytes=await owned(p.ticket);need((await owned(p.readyComplete,true)).toString()===`FRAMELINE_HANDSHAKE_READY:${r.probeId}\n`&&json(JSON.parse(ready))===json(readyExpected(r,b,sha(raw)))&&copy.length===r.snapshot.snapshot.size&&sha(copy)===r.snapshot.snapshot.sha256&&(await owned(r.snapshotPath)).equals(copy)&&sentinel.equals(binarySentinel())&&ticketBytes.toString()===ticket(r,b),'retained-native-inputs');need(admission.schemaVersion===1&&admission.operation==='preservation-host-admission'&&admission.probeId===r.probeId&&admission.planSha256===r.handshake.planSha256&&admission.sourceSha256===r.sourceSha256&&admission.preparationSha256===sha(raw)&&admission.bindingsSha256===sha(b)&&admission.readySha256===sha(ready)&&admission.nativeCopySha256===sha(copy)&&admission.nativeCopyBytes===copy.length&&admission.sentinelCopySha256===sha(sentinel)&&admission.fullNativeCopyAndBaselineBytesEqual===true&&admission.closedLiveSourceAndBaselineBytesEqual===true&&admission.closedLiveSource.sha256===r.snapshot.snapshot.sha256&&admission.closedLiveSource.size===copy.length&&admission.ticketSha256===sha(ticketBytes)&&admission.recipe===r.handshake.recipe&&admission.binaryStringReaderProven===false&&admission.atomicLoadBytesVerified===false&&admission.concurrentWriterResistanceProven===false,'retained-admission');return{...admission,admissionSha256:sha(admissionBytes),ticket:ticketBytes.toString(),controlledFixtureHostAdmissionVerified:true,currentLiveDatabaseRecheckedByThisReader:false};}
module.exports={prepareHandshake,finalizeHandshake,renderPreloadBarrier,hostAdmit,readHandshake,expectedHandshake,binding,ticket,readyExpected,publishExclusive};
