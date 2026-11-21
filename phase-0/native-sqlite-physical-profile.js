'use strict';
// SQLite's documented container header, not a semantic interpretation of fields.
// https://sqlite.org/fileformat.html#the_database_header
const {createHash}=require('node:crypto');
const MAX_DATABASE_BYTES=128*1024*1024;
function assessNativeSqlitePhysicalProfile(bytes){
 if(!Buffer.isBuffer(bytes))throw new TypeError('native-sqlite-physical-buffer-required');
 const reasons=[],need=(value,reason)=>{if(!value)reasons.push(reason);};
 need(bytes.length>=100&&bytes.length<=MAX_DATABASE_BYTES,'unsupported-database-size');
 let facts=null;
 if(bytes.length>=100){
  const encodedPageSize=bytes.readUInt16BE(16),pageSize=encodedPageSize===1?65536:encodedPageSize,pageCount=bytes.readUInt32BE(28),changeCounter=bytes.readUInt32BE(24),versionValidFor=bytes.readUInt32BE(92);
  facts={pageSize,pageCount,fileBytes:bytes.length,writeVersion:bytes[18],readVersion:bytes[19],reservedBytesPerPage:bytes[20],payloadFractions:[...bytes.subarray(21,24)],schemaFormat:bytes.readUInt32BE(44),textEncoding:bytes.readUInt32BE(56),fileChangeCounter:changeCounter,versionValidFor,sqliteLibraryVersion:bytes.readUInt32BE(96),reservedHeaderExpansionZero:bytes.subarray(72,92).every(n=>n===0)};
  need(bytes.subarray(0,16).equals(Buffer.from('SQLite format 3\0')),'unsupported-database-signature');
  need(pageSize>=512&&pageSize<=65536&&(pageSize&(pageSize-1))===0,'unsupported-page-size');
  need(bytes[18]===1&&bytes[19]===1,'unsupported-journal-header');
  need(bytes[20]===0,'unsupported-reserved-page-extension');
  need(bytes[21]===64&&bytes[22]===32&&bytes[23]===32,'unsupported-payload-fractions');
  need(facts.schemaFormat===4,'unsupported-schema-format');
  need(facts.textEncoding===1,'unsupported-text-encoding');
  need(facts.reservedHeaderExpansionZero,'unsupported-reserved-header-extension');
  need(changeCounter===versionValidFor,'invalid-header-page-count-counter');
  need(pageCount>0&&pageSize*pageCount===bytes.length,'unaccounted-database-bytes-or-page-count');
 }
 return{schemaVersion:1,operation:'assess-native-sqlite-physical-profile',profile:'sqlite-format3-utf8-schema4-rollback-no-reserved-extension-v1',supported:reasons.length===0,reasons,facts,sha256:createHash('sha256').update(bytes).digest('hex'),allSuppliedBytesLengthAccountedFor:reasons.length===0,standardContainerHeaderOnly:true,journalSidecarAbsenceMustBeVerifiedSeparately:true,wholeDatabaseIntegrityChecked:false,applicationValuesCompared:false,opaqueApplicationValuesInterpreted:false,applicationFieldExemptions:[],losslessValidated:false,ordinaryApplySupported:false,safeToApply:false};
}
function requireNativeSqlitePhysicalProfile(bytes){const result=assessNativeSqlitePhysicalProfile(bytes);if(!result.supported)throw new Error('native-sqlite-physical-'+result.reasons.join(','));return result;}
module.exports={assessNativeSqlitePhysicalProfile,requireNativeSqlitePhysicalProfile,MAX_DATABASE_BYTES};
