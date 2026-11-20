'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { startServiceHost } = require('../src/service-host');
const { createServiceBackup, verifyServiceBackup, restoreServiceBackup } = require('../src/service-backup');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// The child uses Node's actual HTTPS fetch and the repository's fixture CA.
// Session material travels only over private IPC and is never evidence output.
const clientSource = String.raw`
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto'),root=process.argv[1],hash=b=>createHash('sha256').update(b).digest('hex');
const {createRevisionHttpClient}=require(path.join(root,'src/revision-http-client'));
const {createAssetHttpClient}=require(path.join(root,'src/asset-http-client'));
const {captureMediaBoundScanManifest}=require(path.join(root,'src/media-revision-manifest'));
const engine=require(path.join(root,'src/asset-file-transfer'));
process.once('message',async input=>{try{
 const auth=createRevisionHttpClient({origin:input.origin,getAccessToken:()=>null});
 const session=input.seed?await auth.signIn(input.email,input.password):input.receipt.session;
 const history=createRevisionHttpClient({origin:input.origin,getAccessToken:()=>session.accessToken});
 const assets=createAssetHttpClient({origin:input.origin,getAccessToken:()=>session.accessToken});
 const page={afterAssetId:null,limit:100};let result;
 if(input.seed){
  const owner=await history.getAccount();assert.equal(owner.email,input.email);
  const p=await assets.getPolicy('film');await assets.setPolicy('film',{expectedVersion:p.version,syncClasses:['original']});
  const {identity}=await engine.inspectAssetFile(input.media,{assetClass:'original'});
  await engine.uploadAssetFile({client:assets,projectId:'film',filename:input.media,identity});
  const manifest=await captureMediaBoundScanManifest({exportPath:input.source});assert.equal(manifest.mediaDependencies.coverage,'complete');
  const stored=await history.putManifest('film',manifest),revision=await history.createRevision({projectId:'film',manifestId:stored.id,message:'Backup retained revision',sourceRevisionId:'backup-local-source',idempotencyKey:'backup-revision',requireMedia:true});
  await history.compareAndSwapBranch({projectId:'film',branch:'main',expectedRevisionId:null,revisionId:revision.id,idempotencyKey:'backup-main'});
  const retention=await assets.getRetentionPolicy('film');await assets.setRetentionPolicy('film',{expectedVersion:retention.version,minimumArchiveAgeMs:0,idempotencyKey:'backup-age'});
  await assets.setArchived('film',identity.contentId,{expectedArchived:false,archived:true});
  const partialBytes=Buffer.alloc(5*1024*1024+7,93),partialIdentity=require(path.join(root,'src/media-asset-identity')).createMediaAssetIdentity({size:partialBytes.length,sha256:hash(partialBytes)},{assetClass:'original'});
  const partial=await assets.beginUpload('film',partialIdentity);assert.ok(partial.chunks>1);
  const chunk=partialBytes.subarray(0,partial.chunkSize);await assets.putChunk('film',partial.uploadId,0,chunk,hash(chunk));
  result={session,ownerId:owner.id,identity,revisionId:revision.id,manifestId:stored.id,partial,partialIdentity,sourceHash:manifest.sourceHash};
 }else{
  const r=input.receipt,owner=await history.getAccount();assert.equal(owner.id,r.ownerId);
  const projects=await history.listProjects();assert.equal(projects.projects.find(p=>p.id==='film').role,'owner');
  assert.equal((await history.getBranch('film','main')).revisionId,r.revisionId);
  const revision=await history.getRevision('film',r.revisionId);assert.equal(revision.manifestId,r.manifestId);
  const manifest=await history.getManifest('film',r.manifestId);assert.equal(manifest.document.sourceHash,r.sourceHash);
  assert.deepEqual(manifest.document.mediaDependencies.assets[0].identity,r.identity);
  const report=await assets.getOwnerAssetReport('film',page);assert.equal(report.referenceCoverage,'complete');
  assert.ok(report.items.find(a=>a.assetId===r.identity.contentId).retainedBy.includes(r.revisionId));
  const blocked=await assets.planGarbageCollection('film',{assetIds:[r.identity.contentId],expectedStateHash:report.stateHash});
  assert.equal(blocked.ready,false);assert.ok(blocked.items[0].blockers.includes('retained-revision'));
  await assert.rejects(assets.garbageCollect('film',{assetIds:[r.identity.contentId],expectedStateHash:report.stateHash,planId:blocked.planId,idempotencyKey:'restored-retained-refusal'}),{code:'asset-gc-blocked'});
  await assets.setArchived('film',r.identity.contentId,{expectedArchived:true,archived:false});
  const destination=path.join(input.download,'retained.bin');await engine.downloadAssetFile({client:assets,projectId:'film',assetId:r.identity.contentId,destination,workDirectory:input.work});
  assert.equal(hash(await fs.readFile(destination)),r.identity.contentId.slice(7));
  const partial=await assets.uploadStatus('film',r.partial.uploadId);assert.equal(partial.received[0],true);assert.equal(partial.complete,false);
  const bytes=Buffer.alloc(r.partialIdentity.size,93);for(let index=1;index<partial.chunks;index++){const chunk=bytes.subarray(index*partial.chunkSize,Math.min(bytes.length,(index+1)*partial.chunkSize));await assets.putChunk('film',partial.uploadId,index,chunk,hash(chunk));}
  await assets.completeUpload('film',partial.uploadId);assert.equal((await assets.getAvailability('film',r.partialIdentity.contentId)).cloudPresent,true);
  const refreshed=await auth.refreshSession(session.refreshToken);assert.ok(refreshed.accessToken);
  await auth.signOut(refreshed.refreshToken);
  result={oldAccessSessionRestored:true,oldRefreshSessionRestored:true,ownerRoleRestored:true,canonicalHistoryRestored:true,retainedReferenceGcProtection:true,exactMediaDownloaded:true,partialUploadResumed:true};
 }
 process.send({ok:true,result},()=>process.disconnect());
}catch(error){process.send({ok:false,code:error.code||'assertion-failed',detail:String(error.message).slice(0,250)},()=>process.disconnect());process.exitCode=1;}});
`;

test('reviewed encrypted backup restores actual HTTPS history, media, sessions and retained references into an explicitly activated fresh host', { timeout: 60000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backup-https-proof-'))), children = [];
  let host;
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await host?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture'), collaboration = path.join(directory, 'live-history'), assets = path.join(directory, 'live-assets');
  const runtime = await createDurableCollaborationService({ directory: collaboration, keyring, initialize: true, assetPolicyDefaultsEnabled: true });
  const email = 'owner@backup-drill.example.test', password = 'Disposable backup HTTPS owner password';
  await runtime.identity.createAccount(email, password); const context = { accessToken: (await runtime.identity.signIn(email, password)).accessToken };
  const team = await runtime.teams.create(context, 'Personal backup drill'); await runtime.projects.create(context, { projectId: 'film', name: 'Small backup fixture', teamId: team.id }); await runtime.close();
  const tls = path.join(__dirname, 'fixtures/network-tls'), signingKey = randomBytes(32);
  const config = { directory: collaboration, keyring, host: '127.0.0.1', port: 0,
    tls: { cert: await fs.readFile(path.join(tls, 'server.pem')), key: await fs.readFile(path.join(tls, 'server-key.pem')) }, assets: { directory: assets, signingKey, ownerBoundaryDeduplication: true } };
  async function client(input) {
    const child = spawn(process.execPath, ['-e', clientSource, path.resolve(__dirname, '..')], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tls, 'ca.pem') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('backup-https-client-timeout')); }, 45000);
      child.once('message', value => { clearTimeout(timer); resolve(value); }); child.once('error', reject); child.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(Error('backup-https-client-failed')); } });
      child.send({ ...input, origin: `https://127.0.0.1:${host.address.port}` }); });
    assert.equal(result.ok, true, `${result.code || ''}: ${result.detail || ''}`); return result.result;
  }
  const media = path.join(directory, 'original.bin'), source = path.join(directory, 'small.fcpxml'); await fs.writeFile(media, 'Small disposable encrypted backup media', { mode: 0o600 });
  const clips = Array.from({ length: 50 }, (_, index) => `<asset-clip ref="a" name="Small clip ${index + 1}" offset="${index}s" duration="1s"/>`).join('');
  await fs.writeFile(source, `<fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/><asset id="a" name="original.bin"><media-rep kind="original-media" src="${pathToFileURL(media).href}"/></asset></resources><library><event><project><sequence format="f" duration="50s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>`);
  host = await startServiceHost({ config, initialize: true, allowEphemeralPort: true });
  const receipt = await client({ seed: true, email, password, source, media });
  async function ciphertextHashes() {
    const output = {};
    async function walk(current, prefix) { for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name.endsWith('.lock') || entry.name.includes('.lock.')) continue;
      const filename = path.join(current, entry.name), key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(filename, key); else output[key] = sha(await fs.readFile(filename));
    } }
    await walk(collaboration, 'collaboration'); await walk(assets, 'assets'); return output;
  }
  const before = await ciphertextHashes(), backupDirectory = path.join(directory, 'snapshot');
  const summary = await createServiceBackup({ directory: collaboration, assetsDirectory: assets, keyring, destination: backupDirectory });
  assert.equal(summary.containsSessions, true); assert.equal(summary.requiresSeparateKeys, true); assert.equal(summary.assetsIncluded, true);
  assert.deepEqual(await verifyServiceBackup({ backupDirectory, keyring }), summary); assert.deepEqual(await ciphertextHashes(), before);
  const restored = path.join(directory, 'restored');
  assert.deepEqual(await restoreServiceBackup({ backupDirectory, keyring, destination: restored, expectedSha256: summary.sha256, confirmed: true }), summary);
  assert.deepEqual((await fs.readdir(restored)).sort(), ['assets', 'collaboration', 'restore.json']); assert.deepEqual(await ciphertextHashes(), before);
  await host.close(); host = null;
  host = await startServiceHost({ config: { ...config, directory: path.join(restored, 'collaboration'), assets: { ...config.assets, directory: path.join(restored, 'assets') } }, allowEphemeralPort: true });
  const download = path.join(directory, 'download'), work = path.join(directory, 'work'); await fs.mkdir(download, { mode: 0o700 }); await fs.mkdir(work, { mode: 0o700 });
  const observations = await client({ receipt, download, work });
  assert.equal(sha(await fs.readFile(source)), receipt.sourceHash);
  const evidence = { schemaVersion: 1, scope: 'Actual fixture-CA HTTPS, disposable owner, synthetic 50-clip FCPXML and small media. Backup from an idle running service; separate original keys retained privately. Restore did not start a listener or SMTP; test explicitly activated the fresh host.',
    summary, sourceCiphertextUnchanged: true, sourceExportUnchanged: true, isolatedRestoreRoots: true, ...observations,
    securityState: 'Historical access sessions, refresh sessions and owner roles were restored. This is recovery of old security state; no revocation or key rotation is claimed.' };
  assert.doesNotMatch(JSON.stringify(evidence), /\/private\/|\/Users\/|accessToken|refreshToken/);
  const evidenceFile = process.env.FRAMELINE_BACKUP_HTTPS_EVIDENCE;
  if (evidenceFile) { await fs.mkdir(path.dirname(evidenceFile), { recursive: true }); await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`); }
});
