'use strict';
// Bind hashed typed cells to a complete declared SQLite UUID/FK namespace.
// This does not infer persistent API identity or authorize a write.
const {createHash}=require('node:crypto');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v,json=v=>JSON.stringify(canonical(v));
const sha=b=>createHash('sha256').update(b).digest('hex'),H=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,need=(v,c)=>{if(!v)throw new Error('projected-name-target-'+c);};
const text=value=>({type:'text',base64:Buffer.from(value).toString('base64')}),typedHash=value=>sha(json(value));
function bindProjectedNameTarget(projection,ids){
 for(const k of ['projectId','timelineId','sequenceId','trackId','itemId'])need(UUID.test(ids?.[k]||''),'uuid-namespace');need(['video','audio'].includes(ids.kind),'item-kind');need(H.test(projection?.sourceLogicalSha256||''),'logical-source');
 function table(name){const matches=projection.tables.filter(t=>t.tableNameSha256===sha(name));need(matches.length===1,'unique-table');const t=matches[0];need(new Set(t.columns).size===t.columns.length,'unique-columns');return t;}
 function index(t,name){const indexes=t.columns.flatMap((h,i)=>h===sha(name)?[i]:[]);need(indexes.length===1,'unique-column');return indexes[0];}
 function cell(t,row,name){const c=row.cells[index(t,name)];need(c&&H.test(c.sha256)&&['text','blob','integer','real','null'].includes(c.type),'typed-cell');return c;}
 function equal(t,row,name,expected){const c=cell(t,row,name);need(c.type===expected.type&&c.sha256===typedHash(expected),'field-'+name);}
 function row(t,column,id){const expected=typedHash(text(id)),matches=t.rows.filter(r=>cell(t,r,column).type==='text'&&cell(t,r,column).sha256===expected);need(matches.length===1,'unique-id-row');const r=matches[0];need(r.primaryKeySha256===typedHash([text(id)])&&H.test(r.identitySha256),'primary-key-namespace');return r;}
 const projects=table('SM_Project');need(projects.rows.length===1,'single-project');const project=row(projects,'SM_Project_id',ids.projectId);equal(projects,project,'DbType',text('SM_Project'));const projectName=cell(projects,project,'ProjectName');need(projectName.type==='text'&&(!ids.projectNameValueSha256||projectName.sha256===ids.projectNameValueSha256),'project-name');
 const timelines=table('Sm2Timeline'),timeline=row(timelines,'Sm2Timeline_id',ids.timelineId);equal(timelines,timeline,'DbType',text('Sm2Timeline'));equal(timelines,timeline,'Sequence',text(ids.sequenceId));const projectFk=cell(timelines,timeline,'SM_Project_id');need(projectFk.type==='null'&&projectFk.sha256===typedHash({type:'null'})||projectFk.type==='text'&&projectFk.sha256===typedHash(text(ids.projectId)),'timeline-project-namespace');
 const sequences=table('Sm2Sequence'),sequence=row(sequences,'Sm2Sequence_id',ids.sequenceId);equal(sequences,sequence,'DbType',text('Sm2Sequence'));equal(sequences,sequence,'Parent',text(ids.timelineId));
 const tracks=table('Sm2TiTrack'),track=row(tracks,'Sm2TiTrack_id',ids.trackId);equal(tracks,track,'DbType',text('Sm2TiTrack'));equal(tracks,track,'Sequence',text(ids.sequenceId));equal(tracks,track,'Type',{type:'integer',decimal:ids.kind==='video'?'0':'1'});
 const items=table('Sm2TiItem'),item=row(items,'Sm2TiItem_id',ids.itemId);equal(items,item,'DbType',text(ids.kind==='video'?'Sm2TiVideoClip':'Sm2TiAudioClip'));equal(items,item,'Sm2TiTrack_id',text(ids.trackId));const name=cell(items,item,'Name');need(name.type==='text','name-storage-class');
 return{projectId:ids.projectId,timelineId:ids.timelineId,sequenceId:ids.sequenceId,trackId:ids.trackId,itemId:ids.itemId,kind:ids.kind,projectNameValueSha256:projectName.sha256,sourceLogicalSha256:projection.sourceLogicalSha256,tableNameSha256:items.tableNameSha256,rowIdentitySha256:item.identitySha256,primaryKeySha256:item.primaryKeySha256,columnIndex:index(items,'Name'),columnNameSha256:sha('Name'),storedNameValueSha256:name.sha256,completeDeclaredUuidAndForeignKeyChainBound:true,unknownCellsInterpreted:false,persistentApiIdentityProvenByThisFunction:false,writeAuthorized:false};
}
module.exports={bindProjectedNameTarget,typedHash,text};
