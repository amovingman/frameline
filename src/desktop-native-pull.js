'use strict';
// Renderer requests identify retained intentions. Trusted checkpoint history and
// the execution adapter own every filesystem path and proof used by this UI.
const path = require('node:path');
const {createNativePullSession} = require('./native-pull-session');
const {createNativePullExecution} = require('./native-pull-execution');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const METHODS = new Set(['initialize','prepare','choose','refresh','apply','recover','validate','rollback','cancel','select','inspect','prepare-check','read-check','reveal']);
const MESSAGES = {
 'native-pull-invalid-action': 'The pull action is invalid.',
 'native-pull-busy': 'A native pull action is already running.',
 'native-pull-review-locked': 'Finish the other native review or Apply before continuing.',
 'native-pull-roles-required': 'Choose a retained common base and incoming checkpoint.',
 'native-pull-intent-terminal': 'This pull was cancelled. Its retained records are read only.',
 'native-pull-transaction-required': 'Apply this reviewed plan before checking it in Resolve.',
 'native-pull-check-unavailable': 'Prepare the retained Resolve check before revealing it.',
 'native-pull-review-stale': 'The local project changed. Review the refreshed comparison and choose again.',
 'native-pull-plan-not-ready': 'Resolve every conflict and blocked field before applying.',
 'native-pull-refresh-not-ready': 'This pull has a retained transaction. Inspect recovery before changing the plan.',
 'native-pull-choice-not-ready': 'This pull has a retained transaction. Inspect recovery before changing choices.',
 'native-pull-cancel-not-ready': 'This pull has already started. Inspect recovery before continuing.',
 'native-pull-execution-already-started': 'The retained transaction already started. Inspect recovery before continuing.',
 'closed-project-resolve-running': 'Quit Resolve before capturing, applying or checking the closed project.',
 'closed-project-source-hash-stale': 'The local project changed. Refresh and review the comparison again.',
 'native-pull-action-failed': 'The pull action could not be verified. Retain its records and inspect recovery before continuing.'
};
const fail = code => Object.assign(Error(code),{code});
const need = (condition,code) => {if(!condition)throw fail(code);};
const text = value => typeof value === 'string' && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f\x7f/\\]/.test(value) ? value : null;
const copy = value => JSON.parse(JSON.stringify(value));
function createDesktopNativePull({directory,store,getRoles,canStart=()=>true,reveal=async()=>{},onChange=()=>{},session:providedSession,execution:providedExecution,sessionOptions={},executionOptions={}}={}) {
 need(path.isAbsolute(directory||'') && [getRoles,canStart,reveal,onChange].every(f=>typeof f==='function'),'native-pull-invalid-action');
 let busy=false,errorCode=null,editorCheck=null,session;
 const execution=providedExecution||createNativePullExecution({...executionOptions,directory:path.join(directory,'execution'),store,getIntent:id=>session.readIntent(id)});
 session=providedSession||createNativePullSession({...sessionOptions,directory:path.join(directory,'session'),store,executionService:execution,onChange:()=>changed()});
 need(session && ['initialize','prepare','choose','refresh','apply','recover','validate','rollback','cancel','select','getState','readIntent'].every(k=>typeof session[k]==='function'),'native-pull-invalid-action');
 function getState(){const state=session.getState();return{...copy(state),busy:busy||state.busy===true,error:errorCode?MESSAGES[errorCode]:state.error?MESSAGES[state.error]||MESSAGES['native-pull-action-failed']:null,errorCode:errorCode||state.error||null,editorCheck:editorCheck?copy(editorCheck):null};}
 function changed(){const state=getState();try{Promise.resolve(onChange(copy(state))).catch(()=>{});}catch{}return state;}
 function checkedId(args){need(args.length===1&&ID.test(args[0]||''),'native-pull-invalid-action');return args[0];}
 async function transaction(id){const intent=await session.readIntent(id);need(intent.state!=='cancelled'&&!intent.retirement,'native-pull-intent-terminal');need(ID.test(intent.transactionId||''),'native-pull-transaction-required');return intent.transactionId;}
 function showCheck(id,result){editorCheck={intentId:id,menuName:text(result?.menuName),status:text(result?.status)||'unknown'};}
 async function action(name,...args){
  if(busy||session.isBusy?.())return{...getState(),errorCode:'native-pull-busy',error:MESSAGES['native-pull-busy']};
  busy=true;errorCode=null;changed();
  try{
   need(METHODS.has(name),'native-pull-invalid-action');
   if(name==='initialize'||name==='prepare')need(args.length===0,'native-pull-invalid-action');
   else if(name==='choose')need(args.length===3&&ID.test(args[0]||'')&&HASH.test(args[1]||'')&&['keep-local','take-incoming'].includes(args[2]),'native-pull-invalid-action');
   else checkedId(args);
   if(['prepare','choose','apply','refresh','rollback','prepare-check'].includes(name))need(canStart()===true,'native-pull-review-locked');
   if(name==='prepare'){
    const roles=await getRoles();need(ID.test(roles?.baseCheckpointId||'')&&ID.test(roles?.incomingCheckpointId||''),'native-pull-roles-required');
    await session.prepare({baseCheckpointId:roles.baseCheckpointId,incomingCheckpointId:roles.incomingCheckpointId});editorCheck=null;
   }else if(name==='prepare-check'){
    const id=args[0],tx=await transaction(id);showCheck(id,await execution.prepareEditorCheck(tx));
   }else if(name==='read-check'){
    const id=args[0],tx=await transaction(id);showCheck(id,await execution.readEditorCheck(tx,{admit:true}));
   }else if(name==='reveal'){
    const tx=await transaction(args[0]);need(typeof execution.getEditorCheckPath==='function','native-pull-check-unavailable');
    const filename=await execution.getEditorCheckPath(tx);need(path.isAbsolute(filename||''),'native-pull-check-unavailable');await reveal(filename);
   }else{
    if(name!=='initialize'||session.getState().initialized!==true)await session[name==='inspect'?'select':name](...args);
    if(['choose','refresh','apply','rollback','cancel'].includes(name))editorCheck=null;
   }
  }catch(failure){const code=failure.code||failure.message;errorCode=Object.hasOwn(MESSAGES,code)?code:'native-pull-action-failed';}
  finally{busy=false;}
  return changed();
 }
 return{action,getState,isBusy:()=>busy||session.isBusy?.()===true,isReviewLocked:()=>busy||session.isReviewLocked?.()===true,
  // Trusted main-process history readers. No preload exposes these records.
  readRetainedIntent:id=>session.readIntent(id),listRetainedIntents:()=>session.list(),
  readRetainedTransaction:id=>execution.inspect(id)};
}
module.exports={createDesktopNativePull};
