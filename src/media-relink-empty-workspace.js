'use strict';
// Fresh observation, not OS-level exclusion: permit creation only while the
// pinned Resolve process and known IO helper have no open Project.db at all.
const {execFile:nodeExecFile}=require('node:child_process'),{promisify}=require('node:util'),fs=require('node:fs/promises');
const {isDeepStrictEqual}=require('node:util');
const {parseProcessList}=require('./closed-project-apply-offline-guard');
const {parseResolveOpenFiles}=require('./closed-project-apply-source-binding');
const RESOLVE='/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve',IO='/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/XPCServices/IOXPC.xpc/Contents/MacOS/IOXPC';
const need=(v,c)=>{if(!v)throw Object.assign(Error('media-relink-'+c),{code:'media-relink-'+c});};
function createEmptyWorkspaceObserver({execFile=promisify(nodeExecFile)}={}){
 async function command(file,args){const r=await execFile(file,args,{encoding:'utf8',timeout:10000,maxBuffer:16*1024*1024,env:{...process.env,LC_ALL:'C',LANG:'C'}});need(typeof r.stdout==='string'&&r.stderr==='','empty-workspace-observer-unavailable');return r.stdout;}
 async function processes(){const rows=parseProcessList(await command('/bin/ps',['-axo','pid=,lstart=,comm=','-ww']));need(rows.filter(r=>r.command===RESOLVE).length===1&&rows.every(r=>[RESOLVE,IO].includes(r.command)),'empty-workspace-process-ambiguous');return rows;}
 async function files(rows){const observations=[];for(const row of rows){const output=await command('/usr/sbin/lsof',['-nP','-a','-p',String(row.pid),'-F','pftDin']),databases=parseResolveOpenFiles(output,row.pid);need(databases.length===0,'existing-native-project-open');observations.push({pid:row.pid,openProjectDatabases:0});}return observations;}
 return async function observe({request}){need(request?.library?.configBytesBase64&&request.nativePath,'empty-workspace-binding');const expected=Buffer.from(request.library.configBytesBase64,'base64'),beforeConfig=await fs.readFile(request.library.configPath);need(beforeConfig.equals(expected),'import-library-changed');try{await fs.lstat(require('node:path').dirname(request.nativePath));need(false,'import-project-exists');}catch(e){if(e.code!=='ENOENT')throw e;}const before=await processes(),first=await files(before),second=await files(before),after=await processes();need(isDeepStrictEqual(before,after)&&(await fs.readFile(request.library.configPath)).equals(expected),'empty-workspace-changed');return{schemaVersion:1,operation:'resolve-no-open-project-database',processes:after,before:first,after:second,noOpenProjectDatabaseVerified:true,configSha256:request.library.configSha256,concurrentWriterResistanceProven:false,checkedAt:new Date().toISOString()};};
}
module.exports={createEmptyWorkspaceObserver};
