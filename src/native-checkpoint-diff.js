'use strict';
// Exact read-only comparison of complete, trusted native SQLite censuses.
// A stored primary key identifies a database record; unkeyed rows remain an
// atomic multiset. Neither rowids nor display names become editor identities.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BYTES=64*1024*1024,MAX_ROWS=200000,MAX_COORDINATES=250000;
const MISSING=Object.freeze({missing:true});
function fail(code){throw Object.assign(new Error(`native-diff-${code}`),{code:`native-diff-${code}`});}
const need=(v,c)=>{if(!v)fail(c);};
function canonical(v){
 if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v&&Object.getPrototypeOf(v)===Object.prototype)return '{'+Object.keys(v).sort().map(k=>canonical(k)+':'+canonical(v[k])).join(',')+'}';
 fail('json-required');
}
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const equal=(a,b)=>isDeepStrictEqual(a,b);
const clone=v=>JSON.parse(JSON.stringify(v));
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function typed(v){
 need(v&&typeof v==='object','typed-cell-required');
 if(v.type==='null'){need(exact(v,['type']),'typed-null');return;}
 if(v.type==='integer'){need(exact(v,['type','decimal'])&&typeof v.decimal==='string'&&/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(v.decimal),'typed-integer');const n=BigInt(v.decimal);need(n>=-(1n<<63n)&&n<(1n<<63n),'typed-integer-range');return;}
 if(v.type==='real'){need(exact(v,['type','ieee754BigEndianHex'])&&/^[a-f0-9]{16}$/.test(v.ieee754BigEndianHex||''),'typed-real');return;}
 need(['text','blob'].includes(v.type)&&exact(v,['type','base64'])&&typeof v.base64==='string'&&Buffer.from(v.base64,'base64').toString('base64')===v.base64,'typed-bytes');
}
function text(v){typed(v);need(v.type==='text','identifier-text');const b=Buffer.from(v.base64,'base64'),s=b.toString('utf8');need(Buffer.from(s).equals(b)&&s.length>0&&!s.includes('\0'),'identifier-utf8');return s;}
function validateNativeCensus(c){
 const bytes=canonical(c);need(Buffer.byteLength(bytes)<=MAX_BYTES,'census-size');
 need(exact(c,['schemaVersion','operation','readOnly','snapshot','projectContext','sqliteVersion','encoding','journalMode','integrityCheck','applicationPragmas','physicalContainerPragmas','schemaObjects','tables','counts','allPersistentTablesCovered','allSchemaObjectsCovered','hiddenColumnsIncluded','rowidsIncludedWhereAccessible','duplicateRowsRetained','excludedApplicationColumns','opaqueValuesInterpreted','closedCheckpointProvenByThisTool','losslessValidated','ordinaryApplySupported','safeToApply','logicalSha256']),'census-shape');
 need(c.schemaVersion===1&&c.operation==='native-sqlite-all-cell-census'&&c.readOnly===true&&c.encoding==='UTF-8'&&c.journalMode==='delete'&&c.integrityCheck==='ok','census-profile');
 for(const k of ['allPersistentTablesCovered','allSchemaObjectsCovered','hiddenColumnsIncluded','rowidsIncludedWhereAccessible','duplicateRowsRetained'])need(c[k]===true,'census-incomplete');
 for(const k of ['opaqueValuesInterpreted','closedCheckpointProvenByThisTool','losslessValidated','ordinaryApplySupported','safeToApply'])need(c[k]===false,'census-authority');
 need(Array.isArray(c.excludedApplicationColumns)&&c.excludedApplicationColumns.length===0,'census-exclusions');
 need(exact(c.snapshot,['sha256','size'])&&SHA.test(c.snapshot.sha256)&&Number.isSafeInteger(c.snapshot.size)&&c.snapshot.size>0&&c.snapshot.size<=128*1024*1024,'snapshot-binding');
 need(exact(c.projectContext,['projectId','projectName'])&&UUID.test(c.projectContext.projectId)&&typeof c.projectContext.projectName==='string','project-context');
 need(typeof c.sqliteVersion==='string','sqlite-version');
 for(const [name,keys]of [['applicationPragmas',['application_id','user_version','schema_version']],['physicalContainerPragmas',['page_size','page_count','freelist_count','auto_vacuum']]]){need(exact(c[name],keys),'pragma-shape');for(const v of Object.values(c[name])){typed(v);need(v.type==='integer','pragma-type');}}
 need(Array.isArray(c.schemaObjects)&&Array.isArray(c.tables)&&c.tables.length>0&&c.tables.length<=2048,'census-collections');
 const schemaIds=new Set(),schemaRowids=new Set(),schemaTables=new Set();
 for(const o of c.schemaObjects){need(exact(o,['rowid','type','name','tableName','rootPage','sql']),'schema-object');Object.values(o).forEach(typed);need(o.rowid.type==='integer'&&o.rootPage.type==='integer'&&['text','null'].includes(o.sql.type),'schema-cell-type');const kind=text(o.type),name=text(o.name),table=text(o.tableName);need(['table','index','view','trigger'].includes(kind),'schema-kind');const id=canonical([kind,name,table]),row=canonical(o.rowid);need(!schemaIds.has(id)&&!schemaRowids.has(row),'schema-collision');schemaIds.add(id);schemaRowids.add(row);if(kind==='table'){need(!schemaTables.has(name),'table-collision');schemaTables.add(name);}}
 const tableNames=new Set();let rows=0,cells=0;
 for(const t of c.tables){need(exact(t,['name','nameSha256','tableXInfo','columns','withoutRowid','strict','rowidAlias','primaryKeyColumns','rows','rowCount','cellCount']),'table-shape');need(typeof t.name==='string'&&t.name.length&&!t.name.includes('\0')&&!tableNames.has(t.name)&&t.nameSha256===createHash('sha256').update(t.name).digest('hex'),'table-name');tableNames.add(t.name);
  need(Array.isArray(t.columns)&&t.columns.length>0&&new Set(t.columns).size===t.columns.length&&t.columns.every(v=>typeof v==='string'&&v.length&&!v.includes('\0'))&&typeof t.withoutRowid==='boolean'&&typeof t.strict==='boolean','table-columns');
  need(Array.isArray(t.tableXInfo)&&t.tableXInfo.length===t.columns.length&&Array.isArray(t.primaryKeyColumns),'table-xinfo');const pk=[];
  t.tableXInfo.forEach((v,index)=>{need(Array.isArray(v)&&v.length===7,'table-xinfo');v.forEach(typed);need(equal(v[0],{type:'integer',decimal:String(index)})&&text(v[1])===t.columns[index]&&v[5].type==='integer','table-xinfo-binding');const position=Number(v[5].decimal);need(Number.isSafeInteger(position)&&position>=0&&position<=t.columns.length,'primary-key-position');if(position>0)pk.push({position,index,name:t.columns[index]});});pk.sort((a,b)=>a.position-b.position);need(equal(pk,t.primaryKeyColumns)&&new Set(pk.map(p=>p.position)).size===pk.length,'primary-key-metadata');
  need(t.withoutRowid?t.rowidAlias===null&&pk.length>0:['rowid','_rowid_','oid'].includes(t.rowidAlias)&&!t.columns.some(n=>n.toLowerCase()===t.rowidAlias),'rowid-alias');
  need(Array.isArray(t.rows)&&t.rowCount===t.rows.length&&t.cellCount===t.rows.length*(t.columns.length+(t.withoutRowid?0:1)),'row-count');const seen=new Set();
  for(const r of t.rows){need(exact(r,['rowid','cells','primaryKey'])&&Array.isArray(r.cells)&&r.cells.length===t.columns.length,'row-shape');r.cells.forEach(typed);need(equal(r.primaryKey,pk.map(p=>r.cells[p.index])),'row-primary-key');if(t.withoutRowid)need(r.rowid===null,'without-rowid');else{typed(r.rowid);need(r.rowid.type==='integer','rowid-type');}const id=canonical(t.withoutRowid?r.primaryKey:r.rowid);need(!seen.has(id),'rowid-collision');seen.add(id);}rows+=t.rows.length;cells+=t.cellCount;
 }
 need(rows<=MAX_ROWS&&equal([...tableNames].sort(),[...schemaTables].sort())&&equal(c.counts,{schemaObjects:c.schemaObjects.length,tables:c.tables.length,rows,cellsIncludingRowid:cells}),'census-counts');
 need(c.logicalSha256===hash({projectContext:c.projectContext,applicationPragmas:c.applicationPragmas,schemaObjects:c.schemaObjects,tables:c.tables}),'census-logical-digest');const project=c.tables.find(t=>t.name==='SM_Project');need(project&&project.rows.length===1&&project.primaryKeyColumns.length===1&&project.primaryKeyColumns[0].name==='SM_Project_id','project-table');const row=project.rows[0],id=project.columns.indexOf('SM_Project_id'),name=project.columns.indexOf('ProjectName');need(id>=0&&name>=0&&text(row.cells[id])===c.projectContext.projectId&&text(row.cells[name])===c.projectContext.projectName,'project-row-binding');return c;
}
function multiset(values){const result=new Map();for(const value of values){const key=canonical(value);result.set(key,(result.get(key)||0)+1);}return [...result.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([value,count])=>({value:JSON.parse(value),count}));}
function keyed(t){if(!t.primaryKeyColumns.length)return false;const seen=new Set();for(const r of t.rows){if(r.primaryKey.some(c=>c.type==='null'))return false;const id=canonical(r.primaryKey);if(seen.has(id))return false;seen.add(id);}return true;}
function flatten(c,atomicTables){const out=new Map(),put=(coords,value,matching)=>{const key=canonical(coords);need(!out.has(key),'comparison-coordinate-collision');need(out.size<MAX_COORDINATES,'comparison-limit');out.set(key,{coords,value,matching});};
 for(const [name,value]of Object.entries(c.applicationPragmas))put({scope:'application-pragma',pragma:name},value,'exact-stored-value');
 for(const [name,value]of Object.entries(c.physicalContainerPragmas))put({scope:'physical-container',pragma:name},value,'physical-storage-only');
 for(const o of c.schemaObjects){const coords={scope:'schema-object',kind:text(o.type),name:text(o.name),table:text(o.tableName)};put(coords,{type:o.type,name:o.name,tableName:o.tableName,sql:o.sql},'schema-object-name');put({...coords,scope:'schema-object-storage'},{rowid:o.rowid,rootPage:o.rootPage},'physical-storage-only');}
 for(const t of c.tables){put({scope:'table-metadata',table:t.name},{columns:t.columns,tableXInfo:t.tableXInfo,withoutRowid:t.withoutRowid,strict:t.strict,rowidAlias:t.rowidAlias,primaryKeyColumns:t.primaryKeyColumns},'table-name');
  if(atomicTables.has(t.name)){put({scope:'unkeyed-table',table:t.name},multiset(t.rows.map(r=>Object.fromEntries(t.columns.map((name,i)=>[name,r.cells[i]])))),'atomic-unkeyed-multiset');put({scope:'rowid-storage',table:t.name},multiset(t.rows.map(r=>({rowid:r.rowid,cells:r.cells}))),'physical-storage-only');continue;}
  for(const r of t.rows){const primaryKeySha256=hash(r.primaryKey),identity=r.primaryKey.length===1&&r.primaryKey[0].type==='text'&&UUID.test(Buffer.from(r.primaryKey[0].base64,'base64').toString('utf8'))?'primary-key-uuid':'primary-key';put({scope:'keyed-entity',table:t.name,primaryKeySha256},{present:true},identity);out.get(canonical({scope:'keyed-entity',table:t.name,primaryKeySha256})).rowFingerprint=hash(Object.fromEntries(t.columns.map((column,index)=>[column,r.cells[index]])));
   t.columns.forEach((column,index)=>put({scope:'keyed-field',table:t.name,primaryKeySha256,column},r.cells[index],identity));put({scope:'rowid-storage',table:t.name,primaryKeySha256},r.rowid,'physical-storage-only');
  }
 }
 return out;
}
function descriptor(value,coords){if(value===MISSING)return{present:false};const result={present:true,sha256:hash(value)};
 if(value&&['null','integer','real','text','blob'].includes(value.type)){result.type=value.type;if(value.type==='text'||value.type==='blob'){const bytes=Buffer.from(value.base64,'base64');result.bytes=bytes.length;if(value.type==='text'&&coords.scope==='keyed-field'&&coords.table==='Sm2TiItem'&&coords.column==='Name'&&bytes.length<=256){const display=bytes.toString('utf8');if(Buffer.from(display).equals(bytes)&&!/[\x00-\x1f\x7f/\\]/.test(display))result.display=display;}}else if(value.type==='integer')result.display=value.decimal;else if(value.type==='real')result.ieee754BigEndianHex=value.ieee754BigEndianHex;}
 else{result.type='atomic-structure';result.bytes=Buffer.byteLength(canonical(value));if(Array.isArray(value))result.groups=value.length;}return result;
}
function classification(base,local,incoming){if(equal(local,incoming))return equal(base,local)?'unchanged':'already-applied';if(equal(base,local))return'incoming-only';if(equal(base,incoming))return'local-only';return'conflicting';}
function compare({base,local,incoming,namespace,mode}){
 need(typeof namespace==='string'&&SHA.test(namespace),'verified-namespace-required');for(const c of [base,local,incoming])validateNativeCensus(c);
 need(base.projectContext.projectId===local.projectContext.projectId&&base.projectContext.projectId===incoming.projectContext.projectId,'project-mismatch');
 const censuses=[base,local,incoming],allTables=new Map();for(const c of censuses)for(const t of c.tables){if(!allTables.has(t.name))allTables.set(t.name,[]);allTables.get(t.name).push(t);}
 const atomicTables=new Set();for(const [name,tables]of allTables){const keys=tables.map(t=>canonical(t.primaryKeyColumns));if(tables.some(t=>!keyed(t))||new Set(keys).size>1)atomicTables.add(name);}
 const maps=censuses.map(c=>flatten(c,atomicTables)),keys=[...new Set(maps.flatMap(m=>[...m.keys()]))].sort();
 const summary={unchanged:0,'incoming-only':0,'local-only':0,'already-applied':0,conflicting:0,totalCompared:keys.length,changed:0};const changes=[];
 for(const key of keys){const entries=maps.map(m=>m.get(key)),values=entries.map(e=>e?e.value:MISSING),initialStatus=classification(...values);let status=initialStatus;const coords=(entries.find(Boolean)).coords;if(coords.scope==='keyed-entity'){const [b,l,i]=entries;if(b&&(!l&&i&&b.rowFingerprint!==i.rowFingerprint||!i&&l&&b.rowFingerprint!==l.rowFingerprint)||!b&&l&&i&&l.rowFingerprint!==i.rowFingerprint)status='conflicting';}summary[status]++;if(status==='unchanged')continue;summary.changed++;const e=entries.find(Boolean);const changeKind=values[0]===MISSING?'added':values[1]===MISSING&&values[2]===MISSING||mode==='two-way'&&values[2]===MISSING?'removed':values[1]===MISSING||values[2]===MISSING?'removed-on-one-side':'modified';
  changes.push({id:hash({namespace,coords}),...coords,matching:e.matching,status,changeKind,values:{base:descriptor(values[0],coords),local:descriptor(values[1],coords),incoming:descriptor(values[2],coords)},editorIdentityProven:false,executable:false});
 }
 changes.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const bindings=Object.fromEntries(['base','local','incoming'].map((role,index)=>[role,{snapshotSha256:censuses[index].snapshot.sha256,censusSha256:hash(censuses[index]),logicalSha256:censuses[index].logicalSha256}]));
 const record={schemaVersion:1,operation:mode==='two-way'?'native-checkpoint-diff':'native-checkpoint-three-way-diff',namespace,projectId:base.projectContext.projectId,bindings,summary,changes,coverage:{allPersistentTablesCompared:true,allSchemaObjectsCompared:true,allApplicationPragmasCompared:true,physicalStorageComparedSeparately:true,noApplicationColumnsExcluded:true,opaqueValuesComparedAsAtomicCells:true,unkeyedRowsMatchedAsEntities:false,atomicTableCount:atomicTables.size},safeToApply:false};
 return{...record,reportId:hash(record)};
}
function compareNativeCheckpoints({before,after,namespace}={}){return compare({base:before,local:before,incoming:after,namespace,mode:'two-way'});}
function compareNativeThreeWay({base,local,incoming,namespace}={}){return compare({base,local,incoming,namespace,mode:'three-way'});}
function pageNativeChanges(report,{offset=0,limit=40,statuses=null,table=null}={}){need(report&&report.schemaVersion===1&&Array.isArray(report.changes)&&SHA.test(report.reportId||''),'report-required');const {reportId,...body}=report;need(hash(body)===reportId,'report-changed');need(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'page-invalid');need(statuses===null||Array.isArray(statuses)&&statuses.length>0&&new Set(statuses).size===statuses.length&&statuses.every(s=>['incoming-only','local-only','already-applied','conflicting'].includes(s)),'filter-invalid');need(table===null||typeof table==='string'&&table.length>0,'filter-invalid');const rows=report.changes.filter(r=>(statuses===null||statuses.includes(r.status))&&(table===null||r.table===table));return{reportId,offset,limit,total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,items:clone(rows.slice(offset,offset+limit))};}
module.exports={validateNativeCensus,compareNativeCheckpoints,compareNativeThreeWay,pageNativeChanges,compareNativeCensuses:compareNativeThreeWay,pageNativeReport:pageNativeChanges};
