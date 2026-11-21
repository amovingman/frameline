'use strict';
const fs=require('node:fs/promises');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {performance}=require('node:perf_hooks');
const run=promisify(execFile);
const expected='/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve';
async function queryRss(pid){
  const {stdout}=await run('/bin/ps',['-p',String(pid),'-o','pid=','-o','rss=','-o','comm='],{timeout:3000,maxBuffer:4096});
  const match=/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout);
  if(!match||Number(match[1])!==pid||match[3]!==expected)throw new Error('resolve-process-changed');
  const rssKiB=Number(match[2]);if(!Number.isSafeInteger(rssKiB)||rssKiB<0)throw new Error('invalid-rss-sample');return rssKiB;
}
async function sampleRss({pid,marker,timeoutMs=120000,intervalMs=100,query=queryRss,finished}={}){
  if(!Number.isSafeInteger(pid)||pid<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000
    ||!Number.isSafeInteger(intervalMs)||intervalMs<1||intervalMs>1000)throw new Error('invalid-rss-options');
  const isFinished=finished|| (async()=>{try{return(await fs.lstat(marker)).isFile();}catch(e){if(e.code==='ENOENT')return false;throw e;}});
  const start=performance.now(),samples=[];let complete=false;
  while(true){samples.push({elapsedMs:performance.now()-start,rssKiB:await query(pid)});if(await isFinished()){complete=true;break;}
    if(performance.now()-start>=timeoutMs)break;await new Promise(resolve=>setTimeout(resolve,intervalMs));}
  return{schemaVersion:1,readOnly:true,safeToApply:false,metric:'BSD-ps-rss-KiB',intervalMs,elapsedMs:performance.now()-start,
    status:complete?'completion-marker-observed':'timed-out',samples,firstKiB:samples[0].rssKiB,lastKiB:samples.at(-1).rssKiB,
    maximumObservedKiB:Math.max(...samples.map(s=>s.rssKiB)),limitations:['Sampled resident memory is not peak footprint or per-operation allocation.',
      'The editor was already running; shared caches and other editor work can affect these process-wide samples.',
      'Marker presence is only a sampling stop signal; the operation result must be independently verified.']};
}
if(require.main===module){const[pid,marker]=process.argv.slice(2);sampleRss({pid:Number(pid),marker}).then(r=>process.stdout.write(JSON.stringify(r,null,2)+'\n'))
  .catch(()=>{process.stderr.write('resolve-rss-sampling-failed\n');process.exitCode=1;});}
module.exports={sampleRss,queryRss};
