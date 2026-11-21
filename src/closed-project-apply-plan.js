'use strict';
// A reviewed intent bound to one authoritative stored source. This module does
// not establish current editor absence, authorize publication, or perform IO.
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {resolveReviewedRename}=require('./resolve-rename-review');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(canonical(v))).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const need=(v,c)=>{if(!v)throw new Error('closed-apply-plan-'+c);};
function createClosedProjectApplyPlan({sources,plan,audit,databaseBytes,censusBytes}={}){
 const review=resolveReviewedRename({sources,plan,audit});
 need(Buffer.isBuffer(databaseBytes)&&databaseBytes.length>=100&&databaseBytes.length<=128*1024*1024,'database-bytes');
 need(Buffer.isBuffer(censusBytes)&&censusBytes.length<=24*1024*1024,'census-bytes');
 const census=JSON.parse(censusBytes),before=JSON.parse(review.beforeBytes),after=JSON.parse(review.afterBytes);
 need(census.operation==='native-sqlite-all-cell-census'&&census.allPersistentTablesCovered===true&&census.allSchemaObjectsCovered===true&&census.integrityCheck==='ok'&&Array.isArray(census.excludedApplicationColumns)&&census.excludedApplicationColumns.length===0,'complete-census');
 need(census.snapshot.sha256===hash(databaseBytes)&&census.snapshot.size===databaseBytes.length,'database-census-binding');
 need(census.projectContext.projectId===before.project_id&&census.projectContext.projectName===before.project_name&&UUID.test(before.project_id),'project-binding');
 const changed=[];for(const t of before.timelines)for(const i of t.items){const next=after.timelines.find(x=>x.id===t.id)?.items.find(x=>x.id===i.id);if(next&&next.name!==i.name)changed.push({timelineId:t.id,itemId:i.id,oldName:i.name,newName:next.name,kind:i.type});}
 need(changed.length===1,'single-name');const edit=changed[0];need(edit.kind==='video'&&UUID.test(edit.timelineId)&&UUID.test(edit.itemId),'supported-target');
 need(typeof edit.newName==='string'&&Buffer.byteLength(edit.newName)>0&&Buffer.byteLength(edit.newName)<=256&&!/[\u0000-\u001f\u007f/\\]/.test(edit.newName),'new-name');
 function table(name){const a=census.tables.filter(t=>t.name===name);need(a.length===1,'unique-table');need(new Set(a[0].columns).size===a[0].columns.length,'columns');return a[0];}
 function cell(t,r,k){const n=t.columns.indexOf(k);need(n>=0,'column');return r.cells[n];}
 const text=v=>({type:'text',base64:Buffer.from(v).toString('base64')});
 function row(name,key,id){const t=table(name);need(t.primaryKeyColumns.length===1&&t.primaryKeyColumns[0].name===key,'primary-key');const a=t.rows.filter(r=>isDeepStrictEqual(cell(t,r,key),text(id)));need(a.length===1&&isDeepStrictEqual(a[0].primaryKey,[text(id)]),'unique-row');return {t,r:a[0]};}
 function exact(x,k,v){need(isDeepStrictEqual(cell(x.t,x.r,k),v),'stored-'+k);}
 function string(x,k){const c=cell(x.t,x.r,k);need(c.type==='text'&&typeof c.base64==='string','text');const b=Buffer.from(c.base64,'base64'),v=b.toString('utf8');need(b.toString('base64')===c.base64&&Buffer.from(v).equals(b),'text-encoding');return v;}
 const project=row('SM_Project','SM_Project_id',before.project_id);need(project.t.rows.length===1,'single-project');exact(project,'ProjectName',text(before.project_name));exact(project,'DbType',text('SM_Project'));
 const item=row('Sm2TiItem','Sm2TiItem_id',edit.itemId);exact(item,'Name',text(edit.oldName));exact(item,'DbType',text('Sm2TiVideoClip'));
 const trackId=string(item,'Sm2TiTrack_id');need(UUID.test(trackId),'track-id');const track=row('Sm2TiTrack','Sm2TiTrack_id',trackId);exact(track,'Type',{type:'integer',decimal:'0'});exact(track,'DbType',text('Sm2TiTrack'));
 const sequenceId=string(track,'Sequence');need(UUID.test(sequenceId),'sequence-id');const timeline=row('Sm2Timeline','Sm2Timeline_id',edit.timelineId),sequence=row('Sm2Sequence','Sm2Sequence_id',sequenceId);exact(timeline,'Sequence',text(sequenceId));exact(timeline,'DbType',text('Sm2Timeline'));exact(sequence,'Parent',text(edit.timelineId));exact(sequence,'DbType',text('Sm2Sequence'));
 const fk=cell(timeline.t,timeline.r,'SM_Project_id');need(isDeepStrictEqual(fk,{type:'null'})||isDeepStrictEqual(fk,text(before.project_id)),'timeline-project');
 const record={schemaVersion:1,operation:'closed-project-name-apply-plan',adapterProfile:'resolve-free-21.1.2-closed-name-v1',projectId:before.project_id,projectName:before.project_name,source:{sha256:hash(databaseBytes),bytes:databaseBytes.length,censusSha256:hash(censusBytes)},sourceBindings:review.sourceBindings,review:{planHash:review.planHash,auditHash:review.auditHash,choices:review.choices},edit:{...edit,trackId,sequenceId,field:'Name'},mediaPolicy:'unchanged-references',requires:{freshClosedSource:true,applicationSerializedPublication:true,fullCellComparison:true,editorReopen:true,postCloseValidation:true},planningOnly:true,safeToApply:false};
 return {...record,planId:hash(record)};
}
function verifyClosedProjectApplyPlan(record,inputs){const current=createClosedProjectApplyPlan(inputs);need(isDeepStrictEqual(current,record),'stale-or-tampered');return current;}
module.exports={createClosedProjectApplyPlan,verifyClosedProjectApplyPlan};
