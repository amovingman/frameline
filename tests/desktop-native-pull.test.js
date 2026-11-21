'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createDesktopNativePull}=require('../src/desktop-native-pull');
const id=randomUUID(),base=randomUUID(),incoming=randomUUID(),tx=randomUUID(),hash='a'.repeat(64);
function fixture(options={}){
 const calls=[];let sessionBusy=false;
 const state={initialized:true,busy:false,error:null,reviewLocked:true,intent:{intentId:id,state:'pending-editor-validation',transactionId:tx},retained:[]};
 const session={getState:()=>state,isBusy:()=>sessionBusy,isReviewLocked:()=>true,async readIntent(value){calls.push(['readIntent',value]);assert.equal(value,id);return{intentId:id,transactionId:tx};}};
 for(const name of ['initialize','prepare','choose','refresh','apply','recover','validate','rollback','cancel','select'])session[name]=async(...args)=>calls.push([name,...args]);
 const execution={async prepareEditorCheck(value){calls.push(['prepareEditorCheck',value]);return{menuName:'Codex retained check',status:'ready',scriptPath:'/private/host/script.py'};},async readEditorCheck(value,opts){calls.push(['readEditorCheck',value,opts]);return{menuName:'Codex retained check',status:'verified-open',sourceBinding:{path:'/private/source.db'},secret:'/private/proof'};},async getEditorCheckPath(value){calls.push(['getEditorCheckPath',value]);return'/private/host/script.py';}};
 const wrapper=createDesktopNativePull({directory:'/private/host/pulls',session,execution,getRoles:()=>({baseCheckpointId:base,incomingCheckpointId:incoming}),reveal:async value=>calls.push(['reveal',value]),...options});
 return{wrapper,session,execution,calls,state,setBusy:v=>sessionBusy=v};
}
test('renderer prepare accepts no paths or proof arguments and obtains retained roles from host',async()=>{
 const f=fixture();await f.wrapper.action('prepare','/private/source.db');assert.equal(f.calls.length,0);assert.equal(f.wrapper.getState().errorCode,'native-pull-invalid-action');
 const result=await f.wrapper.action('prepare');assert.deepEqual(f.calls,[['prepare',{baseCheckpointId:base,incomingCheckpointId:incoming}]]);assert.equal(result.error,null);
 await f.wrapper.action('choose',id,hash,'take-incoming');assert.deepEqual(f.calls.at(-1),['choose',id,hash,'take-incoming']);
 for(const args of [['choose',id,hash,'take-incoming','/private/proof'],['apply','../escape'],['read-check',id,{}],['unknown',id]]){const count=f.calls.length;const output=await f.wrapper.action(...args);assert.equal(output.errorCode,'native-pull-invalid-action');assert.equal(f.calls.length,count);}
});
test('editor checks and reveal resolve only the authenticated retained transaction and hide all helper paths',async()=>{
 const f=fixture();let result=await f.wrapper.action('prepare-check',id);assert.deepEqual(result.editorCheck,{intentId:id,menuName:'Codex retained check',status:'ready'});assert.equal(JSON.stringify(result).includes('/private/'),false);
 result=await f.wrapper.action('read-check',id);assert.equal(result.editorCheck.status,'verified-open');assert.deepEqual(f.calls.at(-1),['readEditorCheck',tx,{admit:true}]);assert.equal(JSON.stringify(result).includes('/private/'),false);
 await f.wrapper.action('reveal',id);assert.deepEqual(f.calls.slice(-3),[['readIntent',id],['getEditorCheckPath',tx],['reveal','/private/host/script.py']]);
 f.execution.readEditorCheck=async()=>({menuName:'/private/leaked.py',status:'verified-open'});result=await f.wrapper.action('read-check',id);assert.equal(result.editorCheck.menuName,null);
});
test('start guards block source-affecting actions while recovery and readback remain available',async()=>{
 const f=fixture({canStart:()=>false});for(const name of ['prepare','apply','refresh','rollback','prepare-check']){const result=await f.wrapper.action(name,...(name==='prepare'?[]:[id]));assert.equal(result.errorCode,'native-pull-review-locked');}assert.equal(f.calls.length,0);
 await f.wrapper.action('recover',id);assert.deepEqual(f.calls.at(-1),['recover',id]);await f.wrapper.action('read-check',id);assert.deepEqual(f.calls.at(-1),['readEditorCheck',tx,{admit:true}]);
});
test('the host lock also covers slow check helpers and every failure uses fixed safe messages',async()=>{
 const f=fixture();let release;f.execution.readEditorCheck=()=>new Promise(resolve=>release=resolve);const running=f.wrapper.action('read-check',id);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.wrapper.isBusy(),true);const blocked=await f.wrapper.action('apply',id);assert.equal(blocked.errorCode,'native-pull-busy');assert.equal(f.calls.some(c=>c[0]==='apply'),false);release({status:'pending',menuName:'Retained check'});await running;assert.equal(f.wrapper.isBusy(),false);
 f.session.apply=async()=>{throw Object.assign(Error('/private/project.db: native failure'),{code:'/private/unsafe-code'});};const failed=await f.wrapper.action('apply',id);assert.equal(failed.errorCode,'native-pull-action-failed');assert.equal(JSON.stringify(failed).includes('/private/'),false);
 f.setBusy(true);assert.equal((await f.wrapper.action('recover',id)).errorCode,'native-pull-busy');
});
test('missing roles, missing transaction and unavailable check path cannot turn into writes or renderer paths',async()=>{
 const f=fixture({getRoles:()=>({baseCheckpointId:base,incomingCheckpointId:null})});assert.equal((await f.wrapper.action('prepare')).errorCode,'native-pull-roles-required');assert.equal(f.calls.length,0);
 f.session.readIntent=async()=>({intentId:id});assert.equal((await f.wrapper.action('reveal',id)).errorCode,'native-pull-transaction-required');
 f.session.readIntent=async()=>({intentId:id,transactionId:tx});delete f.execution.getEditorCheckPath;assert.equal((await f.wrapper.action('reveal',id)).errorCode,'native-pull-check-unavailable');assert.equal(f.calls.some(c=>c[0]==='reveal'),false);
});
test('cancelled or retired intentions cannot prepare, admit or reveal native check commands',async()=>{
 const f=fixture();for(const retained of [{intentId:id,transactionId:tx,state:'cancelled'},{intentId:id,transactionId:tx,state:'recovery-required',retirement:{transactionId:tx}}]){f.session.readIntent=async()=>retained;for(const action of ['prepare-check','read-check','reveal']){const result=await f.wrapper.action(action,id);assert.equal(result.errorCode,'native-pull-intent-terminal');assert.match(result.error,/cancelled/);}}assert.deepEqual(f.calls,[]);
});
