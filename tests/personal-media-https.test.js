'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { startServiceHost } = require('../src/service-host');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const clientSource = String.raw`
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const {createHash}=require('node:crypto');
const root=process.argv[1];
const {createRevisionHttpClient}=require(path.join(root,'src/revision-http-client'));
const {createAssetHttpClient}=require(path.join(root,'src/asset-http-client'));
const {createRevisionMediaWorkflow}=require(path.join(root,'src/revision-media-workflow'));
const engine=require(path.join(root,'src/asset-file-transfer'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>text+=chunk);
process.stdin.on('end',async()=>{try{
 const input=JSON.parse(text), auth=createRevisionHttpClient({origin:input.origin,getAccessToken:()=>null});
 const session=await auth.signIn(input.email,input.password);
 const revisions=createRevisionHttpClient({origin:input.origin,getAccessToken:()=>session.accessToken});
 const assets=createAssetHttpClient({origin:input.origin,getAccessToken:()=>session.accessToken});
 const fetched=[]; const tracked={...assets,readChunk:async(...args)=>{fetched.push(args[1]);return assets.readChunk(...args);}};
 const workflow=createRevisionMediaWorkflow({origin:input.origin,revisionClient:revisions,assetClient:tracked});
 const [projectA,projectB,projectC]=input.projects;
 const page={afterAssetId:null,limit:100};
 const publish=async(projectId,exportPath,key,expectedHead=null,uploadMedia=true)=>{const request={projectId,exportPath,branch:'main',expectedHead,message:'Small canonical media revision',idempotencyKey:key,uploadMedia};const review=await workflow.inspect(request);return workflow.publish({...request,reviewHash:review.reviewHash});};
 const report=pid=>assets.getOwnerAssetReport(pid,page);
 const plan=async(pid,aid)=>{const current=await report(pid);return assets.planGarbageCollection(pid,{assetIds:[aid],expectedStateHash:current.stateHash});};
 const gcInput=(plan,key)=>({assetIds:plan.items.map(item=>item.assetId),expectedStateHash:plan.stateHash,planId:plan.planId,idempotencyKey:key});
 let receipt;
 if(input.phase===1){
  for(const projectId of input.projects){const p=await workflow.getPolicy({projectId});await workflow.setPolicy({projectId,input:{expectedVersion:p.version,syncClasses:['original']}});}
  const a=await publish(projectA,input.exportA,'first-a'),b=await publish(projectB,input.exportA,'first-b');
  assert.equal(a.coverage,'complete');assert.equal(a.references,2);assert.equal(a.uniqueAssets,1);assert.equal(a.uploaded.length,1);
  assert.deepEqual(a.uploaded,b.uploaded);
  await new Promise((resolve,reject)=>{process.once('message',message=>message.kind==='dedup-ok'?resolve():reject(Error('dedup-check-failed')));process.send({kind:'dedup-check',assetId:a.uploaded[0]});});
  const shared=a.uploaded[0], remote=await workflow.availability({projectId:projectA,revisionId:a.revisionId});
  assert.equal(remote.items[0].state,'cloud-present');assert.equal(remote.ready,true);
  const extra=await engine.inspectAssetFile(input.extra,{assetClass:'original'});await engine.uploadAssetFile({client:assets,projectId:projectA,filename:input.extra,identity:extra.identity});
  const downloaded=await workflow.download({projectId:projectA,revisionId:a.revisionId,destinationDirectory:input.download,workDirectory:input.work});
  assert.equal(downloaded.complete,true);assert.equal(downloaded.results.length,1);assert.equal(downloaded.results[0].contentId,shared);
  assert.deepEqual(await fs.readdir(input.download),[shared.slice(7)]);assert.equal(hash(await fs.readFile(path.join(input.download,shared.slice(7)))),shared.slice(7));
  assert.ok(fetched.length>0&&fetched.every(id=>id===shared));
  const c=await publish(projectC,input.exportA,'local-observation',null,false);
  const missing=await workflow.availability({projectId:projectC,revisionId:c.revisionId});assert.equal(missing.items[0].state,'missing');
  assert.equal(missing.scope,'checked-locations');assert.equal(missing.collaboratorEvidence,'none');
  const local=await workflow.availability({projectId:projectC,revisionId:c.revisionId,localFiles:[input.shared]});assert.equal(local.items[0].state,'local-only');assert.equal(local.items[0].localVerified,true);
  const stored=await revisions.getManifest(projectC,c.manifestId),identity=stored.document.mediaDependencies.assets[0].identity,at=Date.now();
  const observation={schemaVersion:1,source:'owner-attested-collaborator',projectId:projectC,revisionId:c.revisionId,manifestId:c.manifestId,observedAt:at,expiresAt:at+60000,assets:[identity]};
  const collaborator=await workflow.availability({projectId:projectC,revisionId:c.revisionId,collaboratorObservation:observation});
  assert.equal(collaborator.items[0].state,'collaborator-only');assert.equal(collaborator.collaboratorEvidence,'owner-attested-report');assert.equal(collaborator.ready,false);
  await assert.rejects(workflow.availability({projectId:projectC,revisionId:c.revisionId,collaboratorObservation:{...observation,expiresAt:at-1}}),{code:'revision-media-observation-invalid'});
  await assert.rejects(workflow.download({projectId:projectC,revisionId:c.revisionId,destinationDirectory:input.blockedDownload,workDirectory:input.blockedWork}),{code:'revision-media-download-blocked'});
  assert.deepEqual(await fs.readdir(input.blockedDownload),[]);
  await assets.setArchived(projectA,shared,{expectedArchived:false,archived:true});
  assert.equal((await workflow.availability({projectId:projectA,revisionId:a.revisionId})).items[0].state,'archived');
  await assets.setArchived(projectA,shared,{expectedArchived:true,archived:false});
  let policy=await workflow.getPolicy({projectId:projectA});await workflow.setPolicy({projectId:projectA,input:{expectedVersion:policy.version,syncClasses:[]}});
  assert.equal((await workflow.availability({projectId:projectA,revisionId:a.revisionId})).items[0].state,'excluded');
  policy=await workflow.getPolicy({projectId:projectA});await workflow.setPolicy({projectId:projectA,input:{expectedVersion:policy.version,syncClasses:['original']}});
  const retention=await assets.getRetentionPolicy(projectA);await assets.setRetentionPolicy(projectA,{expectedVersion:retention.version,minimumArchiveAgeMs:0,idempotencyKey:'zero-retention'});
  await assets.setArchived(projectA,shared,{expectedArchived:false,archived:true});
  const retained=await plan(projectA,shared);assert.equal(retained.ready,false);assert.ok(retained.items[0].blockers.includes('retained-revision'));
  await assert.rejects(assets.garbageCollect(projectA,gcInput(retained,'retained-refused')),{code:'asset-gc-blocked'});
  await assets.setArchived(projectA,shared,{expectedArchived:true,archived:false});
  await assets.setArchived(projectA,extra.identity.contentId,{expectedArchived:false,archived:true});
  const stale=await plan(projectA,extra.identity.contentId);assert.equal(stale.ready,true);
  await assets.setArchived(projectA,extra.identity.contentId,{expectedArchived:true,archived:false});
  const a2=await publish(projectA,input.exportExtra,'second-a',a.revisionId);
  await assert.rejects(assets.garbageCollect(projectA,gcInput(stale,'stale-plan-refused')),{code:'asset-lifecycle-plan-stale'});
  const heldReport=await report(projectA);assert.ok(heldReport.items.find(item=>item.assetId===extra.identity.contentId).retainedBy.includes(a2.revisionId));
  const garbage=await engine.inspectAssetFile(input.garbage,{assetClass:'original'});await engine.uploadAssetFile({client:assets,projectId:projectA,filename:input.garbage,identity:garbage.identity});
  await assets.setArchived(projectA,garbage.identity.contentId,{expectedArchived:false,archived:true});
  const clean=await plan(projectA,garbage.identity.contentId);assert.equal(clean.ready,true);assert.equal(clean.physicalBytesReclaimable,garbage.identity.size);
  const deletionInput=gcInput(clean,'delete-unreferenced'),deletion=await assets.garbageCollect(projectA,deletionInput);
  assert.equal(deletion.deletionPerformed,true);assert.equal(deletion.logicalBytesReleased,garbage.identity.size);
  const after=await report(projectA);assert.equal(after.deletionPerformed,false);assert.equal(after.referenceCoverage,'complete');assert.equal(after.totalAssets,2);assert.equal(after.pendingPhysicalBytes,0);
  assert.equal((await assets.getAvailability(projectA,garbage.identity.contentId)).cloudPresent,false);
  receipt={a,b,c,a2,shared,extra:extra.identity.contentId,garbage:garbage.identity.contentId,deletionInput,deletion,
    states:['cloud-present','local-only','collaborator-only','missing','excluded','archived'],requiredOnly:true,retainedProtected:true,stalePlanRefused:true,ownerReportVerified:true};
 }else{
  receipt=input.receipt;
  const repeated=await publish(projectA,input.exportA,'first-a');assert.equal(repeated.revisionId,receipt.a.revisionId);
  assert.equal((await revisions.getBranch(projectA,'main')).revisionId,receipt.a2.revisionId);
  assert.deepEqual(await assets.garbageCollect(projectA,receipt.deletionInput),receipt.deletion);
  const current=await report(projectA);assert.equal(current.revisionCount,2);assert.equal(current.totalAssets,2);assert.equal(current.pendingPhysicalBytes,0);
  assert.ok(current.items.find(item=>item.assetId===receipt.shared).retainedBy.includes(receipt.a.revisionId));
  assert.ok(current.items.find(item=>item.assetId===receipt.extra).retainedBy.includes(receipt.a2.revisionId));
  const required=await workflow.download({projectId:projectB,revisionId:receipt.b.revisionId,destinationDirectory:input.restartDownload,workDirectory:input.restartWork});
  assert.equal(required.complete,true);assert.deepEqual(await fs.readdir(input.restartDownload),[receipt.shared.slice(7)]);
  const metadataOnly=await report(projectC);assert.ok(metadataOnly.missingRetainedAssets.includes(receipt.shared));
  receipt={...receipt,restartDurable:true,publishRetryIdempotent:true,deletionRetryIdempotent:true};
 }
 assert.ok(!JSON.stringify(receipt).includes(input.fixtureRoot));
 await auth.signOut(session.refreshToken);
 process.send({kind:'result',ok:true,receipt},()=>process.disconnect());
}catch(error){process.send({kind:'result',ok:false,code:error.code||'assertion-failed',detail:String(error.message).slice(0,180)},()=>process.disconnect());process.exitCode=1;}});
`;

test('personal media workflow binds real HTTPS revisions to content, deduplicates owner bytes, and preserves retained assets through GC and restart', { timeout: 60000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'personal-media-https-')));
  const children = []; let host;
  t.after(async () => {
    for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
    await Promise.all(children.map(item => item.finished)); await host?.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  const shared = path.join(directory, 'shared.bin'), alias = path.join(directory, 'alias.bin'), extra = path.join(directory, 'extra.bin'), garbage = path.join(directory, 'garbage.bin');
  const bytes = Buffer.from('shared original fixture bytes');
  await fs.writeFile(shared, bytes); await fs.writeFile(alias, bytes); await fs.writeFile(extra, 'second retained source'); await fs.writeFile(garbage, 'unreferenced disposable source');
  const exportA = path.join(directory, 'selected.fcpxml'), exportExtra = path.join(directory, 'later.fcpxml');
  async function writeExport(filename, media) {
    const assets = media.map((source, index) => `<asset id="a${index}" name="source-${index}.bin"><media-rep kind="original-media" src="${pathToFileURL(source).href}"/></asset>`).join('');
    const clips = Array.from({ length: 50 }, (_, index) => `<asset-clip name="Small clip ${index + 1}" ref="a${index % media.length}" offset="${index}s" start="0s" duration="1s"/>`).join('');
    await fs.writeFile(filename, `<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/>${assets}</resources><library><event><project name="Small personal fixture"><sequence format="f" duration="50s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`);
  }
  await writeExport(exportA, [shared, alias]); await writeExport(exportExtra, [extra]);
  const sourceHashes = await Promise.all([exportA, exportExtra].map(async filename => sha(await fs.readFile(filename))));
  const folders = {};
  for (const name of ['download', 'work', 'blockedDownload', 'blockedWork', 'restartDownload', 'restartWork']) {
    folders[name] = path.join(directory, name); await fs.mkdir(folders[name]);
  }
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture'), collaboration = path.join(directory, 'collaboration');
  const runtime = await createDurableCollaborationService({ directory: collaboration, keyring, initialize: true, assetPolicyDefaultsEnabled: true });
  const email = 'owner@personal-media.example.test', password = 'Disposable personal media proof password';
  await runtime.identity.createAccount(email, password);
  const context = { accessToken: (await runtime.identity.signIn(email, password)).accessToken }, team = await runtime.teams.create(context, 'Personal owner');
  const projects = ['personal-media-a', 'personal-media-b', 'personal-media-c'];
  for (const projectId of projects) await runtime.projects.create(context, { projectId, name: projectId, teamId: team.id });
  await runtime.close();
  const tls = path.join(__dirname, 'fixtures/network-tls'), assetsDirectory = path.join(directory, 'assets');
  const config = { directory: collaboration, keyring, host: '127.0.0.1', port: 0,
    tls: { cert: await fs.readFile(path.join(tls, 'server.pem')), key: await fs.readFile(path.join(tls, 'server-key.pem')) },
    assets: { directory: assetsDirectory, signingKey: randomBytes(32), ownerBoundaryDeduplication: true } };
  let receipt, dedupChecked = false;
  for (const phase of [1, 2]) {
    host = await startServiceHost({ config, initialize: phase === 1, allowEphemeralPort: true });
    const child = spawn(process.execPath, ['-e', clientSource, path.resolve(__dirname, '..')], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tls, 'ca.pem') }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; }); child.stdin.on('error', () => {});
    const finished = new Promise(resolve => child.once('close', resolve)); children.push({ child, finished });
    let timer;
    const response = new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('personal-media-client-timeout')); }, 25000);
      child.once('error', reject); child.on('message', async message => {
        if (message.kind === 'dedup-check') {
          try {
            const index = keyring.decrypt(JSON.parse(await fs.readFile(path.join(assetsDirectory, 'assets.enc.json'), 'utf8')).record);
            assert.equal(index.schemaVersion, 5); assert.equal(index.blobs.length, 1); assert.equal(index.assets.length, 2);
            assert.equal(new Set(index.uploads.map(upload => upload.blobId)).size, 1);
            const physical = await fs.readdir(path.join(assetsDirectory, 'uploads')); assert.deepEqual(physical, [index.blobs[0].id]);
            for (const name of await fs.readdir(path.join(assetsDirectory, 'uploads', physical[0]))) {
              const filename = path.join(assetsDirectory, 'uploads', physical[0], name), stored = await fs.readFile(filename, 'utf8');
              assert.ok(!stored.includes(bytes.toString())); assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
            }
            dedupChecked = true; child.send({ kind: 'dedup-ok' });
          } catch (error) { reject(error); child.kill('SIGKILL'); }
        } else if (message.kind === 'result') resolve(message);
      });
      finished.then(() => reject(new Error('personal-media-client-exited-before-result')));
    });
    child.stdin.end(JSON.stringify({ phase, email, password, projects, exportA, exportExtra, shared, extra, garbage, ...folders,
      fixtureRoot: directory, origin: `https://127.0.0.1:${host.address.port}`, receipt }));
    try { const result = await response; assert.equal(result.ok, true, JSON.stringify(result)); receipt = result.receipt; }
    finally { clearTimeout(timer); }
    assert.equal(await finished, 0); assert.equal(output, ''); await host.close(); host = null;
  }
  assert.equal(dedupChecked, true); assert.equal(receipt.restartDurable, true);
  assert.deepEqual(await Promise.all([exportA, exportExtra].map(async filename => sha(await fs.readFile(filename)))), sourceHashes);
  const stored = keyring.decrypt(JSON.parse(await fs.readFile(path.join(assetsDirectory, 'assets.enc.json'), 'utf8')).record);
  assert.equal(stored.blobs.length, 2); assert.equal((await fs.readdir(path.join(assetsDirectory, 'uploads'))).length, 2);
  if (process.env.FRAMELINE_PERSONAL_MEDIA_EVIDENCE) {
    const filename = process.env.FRAMELINE_PERSONAL_MEDIA_EVIDENCE; await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `${JSON.stringify({ schemaVersion: 1, scope: 'Small disposable 50-clip FCPXML and real loopback HTTPS host with separate Node clients; personal owner, synthetic byte files only',
      deduplication: { ownerProjects: 2, uniqueCiphertextBlobs: 1 }, sourceExportsUnchanged: true,
      requiredOnlyDownload: receipt.requiredOnly, availabilityStates: receipt.states, collaboratorEvidence: 'explicit owner-attested bounded report',
      retainedRevisionProtected: receipt.retainedProtected, stalePlanRefused: receipt.stalePlanRefused, ownerReportVerified: receipt.ownerReportVerified,
      restartDurable: receipt.restartDurable, publishRetryIdempotent: receipt.publishRetryIdempotent, deletionRetryIdempotent: receipt.deletionRetryIdempotent }, null, 2)}\n`);
  }
});
