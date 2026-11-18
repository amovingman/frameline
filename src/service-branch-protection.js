'use strict';
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, SHA=/^[a-f0-9]{64}$/;
const MAX_POLICIES=10_000,MAX_REQUESTS=10_000,MAX_RECEIPTS=20_000,MAX_APPROVALS=100,MAX_BYTES=16*1024*1024,TTL=7*24*60*60*1000;
const fail=code=>Object.assign(new Error(code),{code});
const id=value=>typeof value==='string'&&ID.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')&&d.enumerable;});
const iso=value=>typeof value==='string'&&value.length<=35&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const policyDTO=value=>value?Object.fromEntries(['version','requiredApprovals','updatedAt','updatedBy'].map(key=>[key,value[key]])):{version:0,requiredApprovals:0,updatedAt:null,updatedBy:null};
const validPolicy=value=>exact(value,['version','requiredApprovals','updatedAt','updatedBy'])&&integer(value.version)&&integer(value.requiredApprovals,0,5)&&(value.version===0?value.requiredApprovals===0&&value.updatedAt===null&&value.updatedBy===null:iso(value.updatedAt)&&id(value.updatedBy));
const proposal=revision=>({revisionId:revision.id,parentRevisionId:revision.parentRevisionId,authorId:revision.authorId,message:revision.message,manifestId:revision.manifestId,createdAt:revision.createdAt});
const requestFields=['id','projectId','branch','requesterId','revisionId','expectedHead','policyVersion','requiredApprovals','createdAt','expiresAt','approvals','applied'];
function validateServiceBranchProtectionState(value){
 const invalid=()=>{throw fail('branch-review-state-invalid');};
 if(value?.version>1)throw fail('branch-review-state-newer-version');
 if(!exact(value,['version','policies','requests','idempotency'])||value.version!==1||!['policies','requests','idempotency'].every(key=>Array.isArray(value[key]))||value.policies.length>MAX_POLICIES||value.requests.length>MAX_REQUESTS||value.idempotency.length>MAX_RECEIPTS)invalid();
 const ids=new Set(),versions=new Map(),policyVersions=new Map(),requests=new Map();
 for(const item of value.policies){
  if(!exact(item,['id','projectId','branch','version','requiredApprovals','updatedAt','updatedBy'])||!['id','projectId','branch','updatedBy'].every(key=>id(item[key]))||ids.has(item.id)||!integer(item.version,1)||!integer(item.requiredApprovals,0,5)||!iso(item.updatedAt))invalid();
  const key=JSON.stringify([item.projectId,item.branch]),previous=versions.get(key);if(item.version!==(previous?.version||0)+1)invalid();versions.set(key,item);policyVersions.set(JSON.stringify([item.projectId,item.branch,item.version]),item);ids.add(item.id);
 }
 for(const item of value.requests){
  if(!exact(item,requestFields)||!['id','projectId','branch','requesterId','revisionId'].every(key=>id(item[key]))||ids.has(item.id)||item.expectedHead!==null&&!id(item.expectedHead)||!integer(item.policyVersion,1)||!integer(item.requiredApprovals,1,5)||!iso(item.createdAt)||!iso(item.expiresAt)||Date.parse(item.expiresAt)-Date.parse(item.createdAt)!==TTL||!Array.isArray(item.approvals)||item.approvals.length>MAX_APPROVALS)invalid();
  const policy=policyVersions.get(JSON.stringify([item.projectId,item.branch,item.policyVersion]));if(!policy||policy.requiredApprovals!==item.requiredApprovals)invalid();
  const approvers=new Set();for(const approval of item.approvals){if(!exact(approval,['actorId','at'])||!id(approval.actorId)||approval.actorId===item.requesterId||approvers.has(approval.actorId)||!iso(approval.at)||Date.parse(approval.at)<Date.parse(item.createdAt)||Date.parse(approval.at)>=Date.parse(item.expiresAt))invalid();approvers.add(approval.actorId);}
  if(item.applied!==null&&(!exact(item.applied,['actorId','at','revisionId'])||item.applied.actorId!==item.requesterId||item.applied.revisionId!==item.revisionId||!iso(item.applied.at)||Date.parse(item.applied.at)<Date.parse(item.createdAt)||Date.parse(item.applied.at)>=Date.parse(item.expiresAt)||item.approvals.length<item.requiredApprovals))invalid();
  ids.add(item.id);requests.set(item.id,item);
 }
 const keys=new Set(),requestReceipts=new Set(),policyReceipts=new Set();
 for(const item of value.idempotency){
  if(!exact(item,['kind','actorId','projectId','branch','keyHash','requestHash','input','result'])||!['policy','request'].includes(item.kind)||!['actorId','projectId','branch'].every(key=>id(item[key]))||typeof item.keyHash!=='string'||!SHA.test(item.keyHash)||keys.has(item.keyHash)||item.requestHash!==fingerprint({kind:item.kind,actorId:item.actorId,projectId:item.projectId,branch:item.branch,input:item.input}))invalid();
  if(item.kind==='policy'){
   if(!exact(item.input,['expectedVersion','requiredApprovals'])||!integer(item.input.expectedVersion)||!integer(item.input.requiredApprovals,0,5)||!validPolicy(item.result)||![item.input.expectedVersion,item.input.expectedVersion+1].includes(item.result.version)||item.result.requiredApprovals!==item.input.requiredApprovals)invalid();
   const match=policyVersions.get(JSON.stringify([item.projectId,item.branch,item.result.version]));if(item.result.version>0&&(!match||!same(policyDTO(match),item.result)))invalid();
   if(item.result.version===item.input.expectedVersion+1){if(item.result.updatedBy!==item.actorId)invalid();policyReceipts.add(match.id);}
  }else{
   if(!exact(item.input,['expectedHead','revisionId','policyVersion'])||item.input.expectedHead!==null&&!id(item.input.expectedHead)||!id(item.input.revisionId)||!integer(item.input.policyVersion,1)||!exact(item.result,['requestId']))invalid();
   const request=requests.get(item.result.requestId);if(!request||requestReceipts.has(request.id)||request.projectId!==item.projectId||request.branch!==item.branch||request.requesterId!==item.actorId||request.expectedHead!==item.input.expectedHead||request.revisionId!==item.input.revisionId||request.policyVersion!==item.input.policyVersion)invalid();requestReceipts.add(request.id);
  }keys.add(item.keyHash);
 }
 if(requestReceipts.size!==requests.size||value.policies.some(item=>!policyReceipts.has(item.id)))invalid();
 if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES)invalid();return structuredClone(value);
}
function createServiceBranchProtection({history,access,activity=null,initialState=null,paginationKey,now=Date.now}={}){
 if(!history||typeof history.getBranch!=='function'||typeof history.getRevision!=='function'||typeof history.snapshot!=='function'||!access||typeof access.authorize!=='function'||typeof access.roleFor!=='function'||typeof paginationKey!=='string'||paginationKey.length<32||paginationKey.length>256||typeof now!=='function')throw fail('branch-review-invalid');
 let state=initialState==null?{version:1,policies:[],requests:[],idempotency:[]}:validateServiceBranchProtectionState(initialState);
 const clock=()=>{const at=now();if(!integer(at,0,8_640_000_000_000_000-TTL))throw fail('branch-review-invalid');return at;};
 const authorize=(actorId,projectId,resource,action)=>{if(!id(actorId)||!id(projectId))throw fail('branch-review-invalid');access.authorize(actorId,{projectId,resource,action});};
 function head(projectId,branch){if(!id(branch))throw fail('branch-review-invalid');return history.getBranch(projectId,branch).revisionId;}
 const currentPolicy=(projectId,branch)=>state.policies.findLast(item=>item.projectId===projectId&&item.branch===branch)||null;
 function revisionFor(projectId,revisionId,expectedHead){if(!id(revisionId))throw fail('approval-candidate-invalid');const value=history.getRevision(projectId,revisionId);if(value.parentRevisionId!==expectedHead)throw fail('approval-candidate-invalid');return value;}
 const writer=(actorId,projectId)=>['owner','editor'].includes(access.roleFor(actorId,projectId));
 function requestDTO(value,actorId,currentHead=head(value.projectId,value.branch),policy=policyDTO(currentPolicy(value.projectId,value.branch)),at=clock()){
  const revision=history.getRevision(value.projectId,value.revisionId),approvals=value.approvals.map(approval=>({...approval,active:approval.actorId!==value.requesterId&&approval.actorId!==revision.authorId&&writer(approval.actorId,value.projectId)})),activeApprovals=approvals.filter(item=>item.active).length;
  const status=value.applied?'applied':at>=Date.parse(value.expiresAt)?'expired':currentHead!==value.expectedHead||policy.version!==value.policyVersion||!writer(value.requesterId,value.projectId)?'stale':activeApprovals>=value.requiredApprovals?'approved':'pending';
  return {...structuredClone(value),proposal:proposal(revision),approvals,recordedApprovals:approvals.length,activeApprovals,status,canApprove:['pending','approved'].includes(status)&&writer(actorId,value.projectId)&&actorId!==value.requesterId&&actorId!==revision.authorId&&!value.approvals.some(item=>item.actorId===actorId)};
 }
 function commit(next,event=null){if(next.policies.length>MAX_POLICIES||next.requests.length>MAX_REQUESTS||next.idempotency.length>MAX_RECEIPTS||Buffer.byteLength(JSON.stringify(next))>MAX_BYTES)throw fail('branch-review-capacity');if(event)activity?.record({...event,recipientIds:access.listProjectMembers(event.actorId,event.projectId).map(item=>item.userId)});state=next;}
 function receipt(actorId,projectId,branch,kind,idempotencyKey,input){if(!id(idempotencyKey))throw fail('branch-review-invalid');const keyHash=fingerprint({actorId,projectId,branch,kind,idempotencyKey}),requestHash=fingerprint({kind,actorId,projectId,branch,input}),existing=state.idempotency.find(item=>item.keyHash===keyHash);if(existing&&existing.requestHash!==requestHash)throw fail('branch-review-idempotency-conflict');return {existing,value:{kind,actorId,projectId,branch,keyHash,requestHash,input}};}
 function setPolicy(actorId,input){
  if(!exact(input,['projectId','branch','expectedVersion','requiredApprovals','idempotencyKey'])||!integer(input.expectedVersion)||!integer(input.requiredApprovals,0,5))throw fail('branch-review-invalid');
  authorize(actorId,input.projectId,'branch-policy','write');head(input.projectId,input.branch);
  const r=receipt(actorId,input.projectId,input.branch,'policy',input.idempotencyKey,{expectedVersion:input.expectedVersion,requiredApprovals:input.requiredApprovals});if(r.existing)return structuredClone(r.existing.result);
  const previous=policyDTO(currentPolicy(input.projectId,input.branch));if(previous.version!==input.expectedVersion)throw fail('branch-policy-version-conflict');
  let result=previous,policies=state.policies,event=null;
  if(previous.requiredApprovals!==input.requiredApprovals){if(previous.version===Number.MAX_SAFE_INTEGER)throw fail('branch-review-capacity');const value={id:randomUUID(),projectId:input.projectId,branch:input.branch,version:previous.version+1,requiredApprovals:input.requiredApprovals,updatedAt:new Date(clock()).toISOString(),updatedBy:actorId};policies=[...policies,value];result=policyDTO(value);event={projectId:input.projectId,actorId,type:'branch.protection-changed',subjectId:input.branch};}
  commit({...state,policies,idempotency:[...state.idempotency,{...r.value,result}]},event);return structuredClone(result);
 }
 function request(actorId,input){
  if(!exact(input,['projectId','branch','expectedHead','revisionId','policyVersion','idempotencyKey'])||input.expectedHead!==null&&!id(input.expectedHead)||!integer(input.policyVersion))throw fail('approval-request-invalid');
  authorize(actorId,input.projectId,'approval','write');const currentHead=head(input.projectId,input.branch);
  const r=receipt(actorId,input.projectId,input.branch,'request',input.idempotencyKey,{expectedHead:input.expectedHead,revisionId:input.revisionId,policyVersion:input.policyVersion});if(r.existing)return requestDTO(state.requests.find(item=>item.id===r.existing.result.requestId),actorId);
  const policy=policyDTO(currentPolicy(input.projectId,input.branch));if(!policy.requiredApprovals)throw fail('branch-not-protected');if(policy.version!==input.policyVersion)throw fail('approval-policy-stale');if(currentHead!==input.expectedHead)throw fail('approval-head-stale');revisionFor(input.projectId,input.revisionId,input.expectedHead);
  const at=clock(),value={id:randomUUID(),projectId:input.projectId,branch:input.branch,requesterId:actorId,revisionId:input.revisionId,expectedHead:input.expectedHead,policyVersion:policy.version,requiredApprovals:policy.requiredApprovals,createdAt:new Date(at).toISOString(),expiresAt:new Date(at+TTL).toISOString(),approvals:[],applied:null};
  commit({...state,requests:[...state.requests,value],idempotency:[...state.idempotency,{...r.value,result:{requestId:value.id}}]},{projectId:input.projectId,actorId,type:'approval.requested',subjectId:value.id});return requestDTO(value,actorId);
 }
 function approve(actorId,input){
  if(!exact(input,['projectId','branch','requestId'])||!id(input.requestId))throw fail('approval-request-invalid');authorize(actorId,input.projectId,'approval','write');const currentHead=head(input.projectId,input.branch),value=state.requests.find(item=>item.id===input.requestId&&item.projectId===input.projectId&&item.branch===input.branch);if(!value)throw fail('approval-request-unavailable');const revision=revisionFor(value.projectId,value.revisionId,value.expectedHead);if(actorId===value.requesterId||actorId===revision.authorId)throw fail('approval-forbidden');const dto=requestDTO(value,actorId,currentHead);if(dto.status==='expired'||dto.status==='applied')throw fail('approval-request-unavailable');if(dto.status==='stale')throw fail(currentHead!==value.expectedHead?'approval-head-stale':'approval-policy-stale');
  if(!value.approvals.some(item=>item.actorId===actorId)){if(value.approvals.length>=MAX_APPROVALS)throw fail('branch-review-capacity');const at=new Date(Math.max(clock(),Date.parse(value.createdAt))).toISOString(),next={...value,approvals:[...value.approvals,{actorId,at}]};commit({...state,requests:state.requests.map(item=>item===value?next:item)},{projectId:input.projectId,actorId,type:'approval.recorded',subjectId:value.id});return requestDTO(next,actorId);}return dto;
 }
 function assertCanAdvance({actorId,projectId,branch,expectedHead=null,revisionId}){
  authorize(actorId,projectId,'branch','write');const currentHead=head(projectId,branch),policy=policyDTO(currentPolicy(projectId,branch));if(!policy.requiredApprovals)return {protected:false};if(currentHead!==expectedHead)throw fail('approval-head-stale');revisionFor(projectId,revisionId,expectedHead);
  const at=clock(),value=state.requests.findLast(item=>item.requesterId===actorId&&item.projectId===projectId&&item.branch===branch&&item.expectedHead===expectedHead&&item.revisionId===revisionId&&item.policyVersion===policy.version&&!item.applied&&requestDTO(item,actorId,currentHead,policy,at).status==='approved');if(!value)throw fail('branch-approval-required');return {protected:true,requestId:value.id};
 }
 function consumeAdvance(gate,{actorId,projectId,branch,revisionId}){if(!gate?.protected)return;const value=state.requests.find(item=>item.id===gate.requestId);if(!value||value.applied||value.projectId!==projectId||value.branch!==branch||value.requesterId!==actorId||value.revisionId!==revisionId||head(projectId,branch)!==revisionId)throw fail('approval-request-unavailable');const at=new Date(Math.max(clock(),Date.parse(value.createdAt))).toISOString();if(Date.parse(at)>=Date.parse(value.expiresAt))throw fail('branch-approval-required');commit({...state,requests:state.requests.map(item=>item===value?{...item,applied:{actorId,at,revisionId}}:item)},{projectId,actorId,type:'approval.applied',subjectId:value.id});}
 function sign(value){const payload=Buffer.from(JSON.stringify(value)).toString('base64url');return `${payload}.${createHmac('sha256',paginationKey).update(payload).digest('base64url')}`;}
 function page(items,kind,actorId,projectId,branch,currentHead,policyVersion,limit,cursor,convert){
  let anchor=items.length-1,before=items.length;const expected={v:1,kind,actorId,projectId,branch,head:currentHead,policyVersion};
  if(cursor!==null){if(typeof cursor!=='string'||cursor.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('branch-review-cursor-invalid');const [payload,signature]=cursor.split('.'),hmac=createHmac('sha256',paginationKey).update(payload).digest('base64url');if(!timingSafeEqual(Buffer.from(signature),Buffer.from(hmac)))throw fail('branch-review-cursor-invalid');let value;try{const bytes=Buffer.from(payload,'base64url');if(bytes.toString('base64url')!==payload)throw Error();value=JSON.parse(bytes.toString('utf8'));}catch{throw fail('branch-review-cursor-invalid');}if(!exact(value,[...Object.keys(expected),'anchor','before'])||Object.keys(expected).some(key=>value[key]!==expected[key]))throw fail('branch-review-cursor-invalid');anchor=items.findIndex(item=>item.id===value.anchor);before=items.findIndex(item=>item.id===value.before);if(anchor<0||before<0||before>anchor)throw fail('branch-review-cursor-invalid');}
  const remaining=items.slice(0,Math.min(anchor+1,before)).reverse(),selected=remaining.slice(0,limit);return {items:selected.map(convert),total:items.length,nextCursor:remaining.length>limit?sign({...expected,anchor:items[anchor].id,before:selected.at(-1).id}):null};
 }
 function getReview(actorId,projectId,branch,options={}){
  authorize(actorId,projectId,'approval','read');const currentHead=head(projectId,branch),policy=policyDTO(currentPolicy(projectId,branch));if(!options||typeof options!=='object'||Array.isArray(options)||Reflect.ownKeys(options).some(key=>!['limit','requestCursor','candidateCursor'].includes(key))||!exact(options,Object.keys(options)))throw fail('branch-review-invalid');const {limit=20,requestCursor=null,candidateCursor=null}=options;if(!integer(limit,1,100))throw fail('branch-review-invalid');const at=clock();
  const candidates=Object.values(history.snapshot().revisions).filter(item=>item.projectId===projectId&&item.parentRevisionId===currentHead),requests=state.requests.filter(item=>item.projectId===projectId&&item.branch===branch);
  return {projectId,branch,headRevisionId:currentHead,policy,candidates:page(candidates,'candidates',actorId,projectId,branch,currentHead,policy.version,limit,candidateCursor,item=>({...proposal(item),canRequest:writer(actorId,projectId)&&policy.requiredApprovals>0})),requests:page(requests,'requests',actorId,projectId,branch,currentHead,policy.version,limit,requestCursor,item=>requestDTO(item,actorId,currentHead,policy,at))};
 }
 return {setPolicy,request,approve,getReview,assertCanAdvance,consumeAdvance,snapshot:()=>structuredClone(state)};
}
module.exports={createServiceBranchProtection,validateServiceBranchProtectionState,MAX_POLICIES,MAX_REQUESTS,MAX_RECEIPTS,MAX_APPROVALS,MAX_BYTES,TTL};
