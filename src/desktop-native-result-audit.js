'use strict';
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const need=(v,c)=>{if(!v)throw Object.assign(Error('native-result-audit-'+c),{code:'native-result-audit-'+c});};
const copy=v=>JSON.parse(JSON.stringify(v));
const messages={'native-result-audit-result-unavailable':'This intention has no validated resulting revision.','native-result-audit-busy':'The retained audit is being verified.','native-result-audit-invalid-action':'Choose a retained result and try again.','native-result-audit-export-too-large':'This audit is too large to export.','native-result-audit-failed':'The retained result could not be verified. Its records were left unchanged.'};
function createDesktopNativeResultAudit({service,saveAudit,onChange=()=>{}}={}){
 need(service&&['list','detail','exportAudit'].every(k=>typeof service[k]==='function')&&typeof saveAudit==='function'&&typeof onChange==='function','config');let busy=false,initialized=false,error=null,inventory={offset:0,limit:20,total:0,items:[],previousOffset:null,nextOffset:null},detail=null,exported=null;
 const getState=()=>({initialized,busy,error,inventory:copy(inventory),detail:detail?copy(detail):null,exported:exported?copy(exported):null,readOnly:true});
 const changed=()=>{const s=getState();try{Promise.resolve(onChange(s)).catch(()=>{});}catch{}return s;};
 async function action(name,input){if(busy)return{...getState(),error:messages['native-result-audit-busy']};busy=true;error=null;changed();try{
  if(name==='refresh'){need(input===undefined,'invalid-action');inventory=await service.list({offset:inventory.offset});initialized=true;if(detail)detail=await service.detail(detail.intentId,{direction:detail.direction});}
  else if(name==='list-page'){need(input&&Object.keys(input).join(',')==='offset'&&Number.isSafeInteger(input.offset)&&input.offset>=0,'invalid-action');inventory=await service.list(input);initialized=true;}
  else if(name==='select'){need(input&&Object.keys(input).every(k=>['intentId','direction'].includes(k))&&Object.hasOwn(input,'intentId')&&ID.test(input.intentId||'')&&[undefined,'apply','rollback'].includes(input.direction),'invalid-action');detail=await service.detail(input.intentId,{direction:input.direction});exported=null;}
  else if(name==='page'){need(detail&&input&&Object.keys(input).join(',')==='offset'&&Number.isSafeInteger(input.offset)&&input.offset>=0,'invalid-action');detail=await service.detail(detail.intentId,{direction:detail.direction,offset:input.offset});}
  else if(name==='export'){need(input===undefined&&detail?.available===true,'result-unavailable');const result=await service.exportAudit(detail.intentId,{direction:detail.direction});need(Buffer.isBuffer(result.bytes)&&result.bytes.length<=16*1024*1024,'export-too-large');const saved=await saveAudit(result);need(saved?.cancelled===true||saved?.saved===true,'export-failed');exported={...result.summary,saved:saved.saved===true,cancelled:saved.cancelled===true};}
  else need(false,'invalid-action');
 }catch(e){error=messages[e.code]||messages['native-result-audit-failed'];}finally{busy=false;}return changed();}
 return{action,getState};
}
module.exports={createDesktopNativeResultAudit};
