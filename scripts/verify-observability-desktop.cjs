'use strict';
// Shipped Electron main/preload/review UI with an actual worker scan. Native
// workflow lifecycle states are explicit callback fixtures, not SDK observations.
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'phase-0/observability-desktop'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const proofFiles=['src/main.js','src/preload.js','src/index.html','src/setup-support-renderer.js','src/renderer.js','src/logger.js','src/observability-catalog.js','src/operation-health.js','src/diagnostics-report.js','src/desktop-diagnostics.js','src/adapter-metrics.js','scripts/verify-observability-desktop.cjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(proofFiles.map(async name=>[name,sha(await fs.readFile(path.join(root,name)))])));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
if(!process.versions.electron){
 (async()=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'frameline-observability-'))),run=require('node:util').promisify(require('node:child_process').execFile);
  try{
   const xml='<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="take-01.mov" src="file:///private/sensitive/take-01.mov"/></resources><library><event><project name="Private client"><sequence format="f" duration="2s"><spine><asset-clip name="Private clip" ref="a" offset="0s" start="0s" duration="1s"/><asset-clip name="Private second clip" ref="a" offset="1s" start="0s" duration="1s"/></spine></sequence></project></event></library></fcpxml>';
   await fs.writeFile(path.join(directory,'private-cut.fcpxml'),xml,{mode:0o600});await fs.mkdir(out,{recursive:true});
   const codeHashes=await hashes(),stages=[];
   for(const stage of ['scan-and-export','restart']){
    const env={...process.env,FRAMELINE_OBSERVABILITY_ROOT:directory,FRAMELINE_OBSERVABILITY_STAGE:stage};delete env.NODE_OPTIONS;
    const result=await run(require('electron'),[__filename],{cwd:root,env,timeout:90000,maxBuffer:1024*1024});
    for(const secret of [directory,'BearerOpaqueCredential-123','private-cut.fcpxml','take-01.mov','Private client'])assert.equal((result.stdout+result.stderr).includes(secret),false,'No fixture private data in process output');
    const line=result.stdout.trim().split('\n').findLast(value=>value.startsWith('{"stage"'));assert.ok(line);stages.push(JSON.parse(line));
   }
   assert.equal(sha(await fs.readFile(path.join(directory,'private-cut.fcpxml'))),sha(xml));assert.deepEqual(await hashes(),codeHashes);
   const receipt={schemaVersion:1,observedAt:new Date().toISOString(),scope:'Two actual shipped Electron main/preload/renderer processes, real worker FCPXML scan and authenticated scan-recovery journal, exact existing diagnostics review/consent/export flow. Native pull and media relink lifecycle states are callback fixtures only, with no native publication, editor admission, media transfer or telemetry claim.',codeHashes,
    checks:['current main observer callbacks feed reviewed diagnostics','actual worker scan metrics and retained scan health','native publication pending is not verified success','changed health revokes prior review before save dialog','session health option excludes all workflow details','explicit consent required before exact reviewed bytes export','private export mode and no paths names identities opaque credentials or raw logs','known event/error catalog and unknown-error fallback in process output','session metrics reset on another actual process','desktop and narrow layout without overflow','source export unchanged and zero renderer errors'],stages};
   await fs.writeFile(path.join(out,'verification.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
 })().catch(error=>{console.error(error);process.exitCode=1;});
}else{
 const {app,dialog}=require('electron'),directory=process.env.FRAMELINE_OBSERVABILITY_ROOT,stage=process.env.FRAMELINE_OBSERVABILITY_STAGE;
 if(!directory||!['scan-and-export','restart'].includes(stage)||!sync.existsSync(path.join(directory,'private-cut.fcpxml')))throw Error('Disposable observability fixture required');
 if(app.setActivationPolicy)app.setActivationPolicy('prohibited');app.setPath('userData',path.join(directory,'profile'));
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(directory,'private-cut.fcpxml')]});let saveCalls=0;
 dialog.showSaveDialog=async()=>{saveCalls++;return{canceled:false,filePath:path.join(directory,'reviewed-diagnostics.json')};};
 const callbacks={};
 for(const [name,filename,factory] of [['nativePull','desktop-native-pull','createDesktopNativePull'],['mediaRelink','desktop-media-relink','createDesktopMediaRelink']]){
  const module=require('../src/'+filename),original=module[factory];module[factory]=options=>{const controller=original(options);callbacks[name]={controller,emit:options.onChange};return controller;};
 }
 app.on('browser-window-created',(_event,win)=>{win.hide();const errors=[];win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});win.webContents.once('did-finish-load',()=>verify(win,errors).catch(error=>{console.error(error);app.exit(1);}));});require('../src/main');
 async function verify(win,errors){
  const js=code=>win.webContents.executeJavaScript(code),api=(name,...args)=>js(`window.desktop[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const wait=async expression=>{const deadline=Date.now()+20000;while(!await js(expression)){if(Date.now()>deadline)throw Error('Timed out observability fixture state');await pause(40);}};
  const click=async id=>{await wait(`!document.getElementById(${JSON.stringify(id)}).disabled`);await js(`document.getElementById(${JSON.stringify(id)}).click()`);};
  await wait("Boolean(window.desktop&&document.getElementById('diagnostics-review'))");await wait("window.desktop.getNativePullState().then(s=>!s.busy&&s.initialized)");await wait("window.desktop.getMediaRelinkState().then(s=>!s.busy&&s.initialized)");
  const before=await api('previewDiagnostics');assert.equal(before.report.schemaVersion,3);assert.equal(before.report.adapterUsage.attempts,0);
  if(stage==='scan-and-export'){
   await js("document.getElementById('first-run-form').requestSubmit()");await wait("currentAppState?.scanStatus==='ready'&&document.getElementById('first-run').hidden");
   const id='00000000-0000-4000-8000-000000000001';
   const emitNative=status=>callbacks.nativePull.emit({...callbacks.nativePull.controller.getState(),retained:[{intentId:id,state:status}]});
   emitNative('pending-editor-validation');callbacks.mediaRelink.emit({...callbacks.mediaRelink.controller.getState(),errorCode:'BearerOpaqueCredential-123',intents:[{intentId:id,state:'imported',sourceName:'Private client'}]});
   await js("showView('history')");await click('diagnostics-review');await wait("!document.getElementById('diagnostics-preview').hidden");
   let displayed=JSON.parse(await js("document.getElementById('diagnostics-content').textContent"));
   assert.equal(displayed.adapterUsage.succeeded,1);assert.equal(displayed.operationHealth.workflows.scanRecovery.statusCounts.verified,1);
   assert.equal(displayed.operationHealth.workflows.nativePull.statusCounts.pendingValidation,1);assert.equal(displayed.operationHealth.workflows.nativePull.statusCounts.verified,0);
   assert.equal(displayed.operationHealth.workflows.mediaRelink.errorCodes['unknown-error'],1);
   assert.equal(await js("document.getElementById('diagnostics-export').disabled"),true);
   emitNative('completed');await click('diagnostics-confirm');await click('diagnostics-export');await wait("document.getElementById('diagnostics-status').textContent.includes('App state changed')");assert.equal(saveCalls,0);
   await click('diagnostics-adapter');await click('diagnostics-review');await wait("!document.getElementById('diagnostics-preview').hidden");
   displayed=JSON.parse(await js("document.getElementById('diagnostics-content').textContent"));assert.equal(Object.hasOwn(displayed,'operationHealth'),false);assert.equal(Object.hasOwn(displayed,'adapterUsage'),false);
   await click('diagnostics-adapter');await click('diagnostics-review');await wait("!document.getElementById('diagnostics-preview').hidden");
   const bytes=await js("document.getElementById('diagnostics-content').textContent");displayed=JSON.parse(bytes);assert.equal(displayed.operationHealth.workflows.nativePull.statusCounts.verified,1);
   const layouts=[];for(const width of [1440,390]){win.setContentSize(width,1000);await js("document.getElementById('diagnostics-panel').scrollIntoView({block:'start'})");await pause(100);const layout=await js('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');assert.equal(layout.width,layout.scrollWidth);layouts.push(layout);await fs.writeFile(path.join(out,'diagnostics-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
   await click('diagnostics-confirm');await click('diagnostics-export');await wait("document.getElementById('diagnostics-status').textContent.includes('saved (')");
   const exported=await fs.readFile(path.join(directory,'reviewed-diagnostics.json'),'utf8');assert.equal(exported,bytes);
   assert.doesNotMatch(exported,/private-cut|take-01|Private client|BearerOpaque|\/private\/|\/Users\/|intentId|sourcePath|accessToken|refreshToken/);
   assert.equal((await fs.stat(path.join(directory,'reviewed-diagnostics.json'))).mode&0o777,0o600);
   require('../src/logger').warn('project.scan-failed',{code:'BearerOpaqueCredential-123',note:'take-01.mov'});
   assert.deepEqual(errors,[]);console.log(JSON.stringify({stage,actualWorkerScan:true,scanHealthVerified:true,nativePendingFixtureNotSuccess:true,changedReviewRefusedBeforeDialog:true,optionalHealthExcluded:true,exactReviewedBytesExported:true,privateMode:true,rendererErrors:errors.length,layouts}));
  }else{
   assert.equal(before.report.operationHealth.workflows.nativePull.statusCounts.verified,0);
   assert.deepEqual(errors,[]);console.log(JSON.stringify({stage,scanSessionAttempts:0,nativeFixtureNotPersisted:true,noAutomaticSourceReopen:true,rendererErrors:errors.length}));
  }
  app.quit();
 }
}
