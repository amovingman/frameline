'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const tls = path.resolve(__dirname, 'fixtures/network-tls');
const hostCli = path.resolve(__dirname, '../src/service-host-cli.js');

const clientSource = String.raw`
const assert=require('node:assert/strict'),{createRevisionHttpClient}=require(process.argv[1]);
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);
process.stdin.on('end',async()=>{try{
 const input=JSON.parse(text),{phase,origin}=input,pid='protected-film';let calls=0;
 assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
 const send=(...args)=>{calls++;return fetch(...args);};
 const connect=token=>createRevisionHttpClient({origin,getAccessToken:()=>token,fetch:send});
 let sessions=input.sessions;if(!sessions){sessions={};for(const role of ['owner','publisher','reviewer','viewer','outsider'])sessions[role]=await connect(null).signIn(role+'@protected.example.test',input.password);}
 const owner=connect(sessions.owner.accessToken),publisher=connect(sessions.publisher.accessToken),reviewer=connect(sessions.reviewer.accessToken),viewer=connect(sessions.viewer.accessToken),outsider=connect(sessions.outsider.accessToken);
 let receipt=input.receipt;
 if(phase===1){
  const manifest={schemaVersion:2,adapter:'fcpxml',readOnly:true,identityStatus:'unresolved',sourceHash:'b'.repeat(64),sequence:{name:'Protected disposable cut',frameDuration:'1/24s',durationFrames:0},clips:[],media:[],warnings:[]};
  const stored=await owner.putManifest(pid,manifest),root=await owner.createRevision({projectId:pid,manifestId:stored.id,parentRevisionId:null,sourceRevisionId:'protected-root',message:'Unprotected root',idempotencyKey:'protected-root'});
  await owner.compareAndSwapBranch({projectId:pid,branch:'main',revisionId:root.id,expectedRevisionId:null,idempotencyKey:'unprotected-root-head'});
  assert.equal((await viewer.getBranchReview(pid,'main')).policy.requiredApprovals,0);
  await assert.rejects(publisher.setBranchProtection({projectId:pid,branch:'main',expectedVersion:0,requiredApprovals:1,idempotencyKey:'editor-policy'}),{code:'forbidden'});
  await assert.rejects(viewer.setBranchProtection({projectId:pid,branch:'main',expectedVersion:0,requiredApprovals:1,idempotencyKey:'viewer-policy'}),{code:'forbidden'});
  await assert.rejects(outsider.getBranchReview(pid,'main'),{code:'forbidden'});
  const policyInput={projectId:pid,branch:'main',expectedVersion:0,requiredApprovals:1,idempotencyKey:'policy-one'};
  const policy=await owner.setBranchProtection(policyInput);assert.equal(policy.version,1);assert.deepEqual(await owner.setBranchProtection(policyInput),policy);
  const candidate=await publisher.createRevision({projectId:pid,manifestId:stored.id,parentRevisionId:root.id,sourceRevisionId:'publisher-staged',message:'Staged publisher change',idempotencyKey:'publisher-staged'});
  const other=await owner.createRevision({projectId:pid,manifestId:stored.id,parentRevisionId:root.id,sourceRevisionId:'other-staged',message:'Competing direct child',idempotencyKey:'other-staged'});
  const publish={projectId:pid,branch:'main',expectedRevisionId:root.id,revisionId:candidate.id,idempotencyKey:'protected-ack-loss'};
  await assert.rejects(publisher.compareAndSwapBranch(publish),{code:'branch-approval-required'});
  const proposal={projectId:pid,branch:'main',expectedHead:root.id,revisionId:candidate.id,policyVersion:1,idempotencyKey:'publisher-request'};
  const request=await publisher.requestBranchApproval(proposal);assert.deepEqual(await publisher.requestBranchApproval(proposal),request);
  await assert.rejects(publisher.requestBranchApproval({...proposal,expectedHead:null}),{code:'branch-review-idempotency-conflict'});
  const ownerRequest=await owner.requestBranchApproval({...proposal,idempotencyKey:'owner-request'});
  await assert.rejects(publisher.approveBranchRequest(pid,'main',request.id),{code:'approval-forbidden'});
  await assert.rejects(owner.approveBranchRequest(pid,'main',ownerRequest.id),{code:'approval-forbidden'});
  await assert.rejects(publisher.approveBranchRequest(pid,'main',ownerRequest.id),{code:'approval-forbidden'});
  await assert.rejects(viewer.approveBranchRequest(pid,'main',request.id),{code:'forbidden'});
  await reviewer.approveBranchRequest(pid,'main',ownerRequest.id);
  const approved=await reviewer.approveBranchRequest(pid,'main',request.id);assert.equal(approved.activeApprovals,1);assert.equal(approved.status,'approved');
  assert.deepEqual(await reviewer.approveBranchRequest(pid,'main',request.id),approved);
  const page=await publisher.getBranchReview(pid,'main',{limit:1});assert(page.candidates.nextCursor);assert(page.requests.nextCursor);
  const older=await publisher.getBranchReview(pid,'main',{limit:1,candidateCursor:page.candidates.nextCursor,requestCursor:page.requests.nextCursor});
  assert.notEqual(older.candidates.items[0].revisionId,page.candidates.items[0].revisionId);assert.notEqual(older.requests.items[0].id,page.requests.items[0].id);
  await assert.rejects(owner.getBranchReview(pid,'main',{limit:1,candidateCursor:page.candidates.nextCursor}),{code:'branch-review-cursor-invalid'});
  await assert.rejects(publisher.getBranchReview(pid,'main',{limit:1,requestCursor:page.candidates.nextCursor}),{code:'branch-review-cursor-invalid'});
  await assert.rejects(publisher.requestBranchApproval({...proposal,idempotencyKey:'bad-head',expectedHead:null}),{code:'approval-head-stale'});
  await assert.rejects(publisher.requestBranchApproval({...proposal,idempotencyKey:'bad-policy',policyVersion:0}),{code:'approval-policy-stale'});
  await assert.rejects(publisher.requestBranchApproval({...proposal,idempotencyKey:'bad-candidate',revisionId:root.id}),{code:'approval-candidate-invalid'});
  await assert.rejects(owner.setBranchProtection({...policyInput,idempotencyKey:'stale-policy'}),{code:'branch-policy-version-conflict'});
  assert.equal((await owner.setBranchProtection({...policyInput,expectedVersion:1,idempotencyKey:'noop-policy'})).version,1);
  let dropped=false;const lossy=createRevisionHttpClient({origin,getAccessToken:()=>sessions.publisher.accessToken,fetch:async(url,options)=>{calls++;const response=await fetch(url,options);if(!dropped&&options.method==='PUT'&&new URL(url).pathname.endsWith('/branches/main')&&response.ok){dropped=true;await response.arrayBuffer();throw Error('Discard acknowledged fixture CAS');}return response;}});
  await assert.rejects(lossy.compareAndSwapBranch(publish),{code:'sync-network-unavailable'});assert(dropped);
  assert.equal((await owner.getBranch(pid,'main')).revisionId,candidate.id);
  const applied=(await owner.getBranchReview(pid,'main')).requests.items.find(v=>v.id===request.id);assert.equal(applied.status,'applied');
  receipt={publish,rootId:root.id,candidateId:candidate.id,manifestId:stored.id,requestId:request.id,oldCursor:page.candidates.nextCursor};
 }else if(phase===2){
  const page=await owner.getBranchReview(pid,'main');assert.equal(page.policy.version,2);assert.equal(page.policy.requiredApprovals,2);
  const applied=page.requests.items.find(v=>v.id===receipt.requestId);assert.equal(applied.status,'applied');assert.equal(applied.activeApprovals,0);
  const before=await owner.listActivity(pid,{limit:100});
  const ack=await publisher.compareAndSwapBranch(receipt.publish);assert.deepEqual(ack,{projectId:pid,branch:'main',revisionId:receipt.candidateId});assert.deepEqual(await publisher.compareAndSwapBranch(receipt.publish),ack);
  assert.deepEqual(await owner.listActivity(pid,{limit:100}),before);
  await assert.rejects(publisher.getBranchReview(pid,'main',{limit:1,candidateCursor:receipt.oldCursor}),{code:'branch-review-cursor-invalid'});
  await assert.rejects(reviewer.getBranchReview(pid,'main'),{code:'forbidden'});
  const next=await publisher.createRevision({projectId:pid,manifestId:receipt.manifestId,parentRevisionId:receipt.candidateId,sourceRevisionId:'new-protected-staged',message:'New write still requires current approvals',idempotencyKey:'new-protected-staged'});
  const nextPublish={projectId:pid,branch:'main',expectedRevisionId:receipt.candidateId,revisionId:next.id,idempotencyKey:'new-protected-head'};
  await assert.rejects(publisher.compareAndSwapBranch(nextPublish),{code:'branch-approval-required'});
  const requested=await publisher.requestBranchApproval({projectId:pid,branch:'main',expectedHead:receipt.candidateId,revisionId:next.id,policyVersion:2,idempotencyKey:'new-protected-request'});
  assert.equal((await owner.approveBranchRequest(pid,'main',requested.id)).activeApprovals,1);
  await assert.rejects(reviewer.approveBranchRequest(pid,'main',requested.id),{code:'forbidden'});
  await assert.rejects(publisher.compareAndSwapBranch(nextPublish),{code:'branch-approval-required'});
  receipt.noDuplicateEvents=true;receipt.newWriteBlockedAfterMembershipLoss=true;
 }else{
  await assert.rejects(publisher.compareAndSwapBranch(receipt.publish),{code:'forbidden'});
  await assert.rejects(viewer.getBranchReview(pid,'main'),{code:'access-token-invalid'});
  await assert.rejects(outsider.getBranchReview(pid,'main'),{code:'forbidden'});
  const page=await owner.getBranchReview(pid,'main');assert.equal(page.headRevisionId,receipt.candidateId);assert.equal(page.policy.version,2);
  assert.equal(page.requests.items.find(v=>v.id===receipt.requestId).status,'applied');
  const activity=await owner.listActivity(pid,{limit:100});assert.equal(activity.items.filter(v=>v.type==='branch.changed').length,2);assert.equal(activity.items.filter(v=>v.type==='approval.applied').length,1);assert.equal(activity.items.filter(v=>v.type==='revision.created').length,4);
 }
 process.send({kind:'done',data:{sessions,receipt,calls}},()=>process.disconnect());
}catch(error){const line=/\[eval\]:(\d+)/.exec(error.stack||'')?.[1];process.send({kind:'failed',code:/^[a-z-]{1,80}$/.test(error.code||'')?error.code:'assertion-failed',line:line?Number(line):null},()=>process.disconnect());process.exitCode=1;}});
`;

test('protected branch CAS and exact lost-ACK replay survive real HTTPS host process restarts and access changes', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'branch-review-https-'));
  const configPath = path.join(root, 'config.json'), directory = path.join(root, 'data'), key = randomBytes(32), keyring = createKeyring({ fixture: key }, 'fixture');
  const certFile = path.join(root, 'server.pem'), keyFile = path.join(root, 'server-key.pem');
  await fs.copyFile(path.join(tls, 'server.pem'), certFile); await fs.copyFile(path.join(tls, 'server-key.pem'), keyFile); await fs.chmod(certFile, 0o600); await fs.chmod(keyFile, 0o600);
  const password = 'Disposable protected branch password', children = [], hosts = [], users = {};
  const environment = trusted => {
    const env = { ...process.env };
    for (const name of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[name];
    if (trusted) env.NODE_EXTRA_CA_CERTS = path.join(tls, 'ca.pem'); return env;
  };
  function spawnOwned(args, ipc = false) {
    const child = spawn(process.execPath, args, { env: environment(ipc), stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    const record = { child, stdout: '', stderr: '', terminal: false }; children.push(record);
    child.stdout.on('data', bytes => { record.stdout += bytes; }); child.stderr.on('data', bytes => { record.stderr += bytes; }); child.stdin.on('error', () => {});
    record.closed = new Promise(resolve => child.once('close', (code, signal) => { record.terminal = true; record.code = code; record.signal = signal; resolve(); }));
    return record;
  }
  async function terminal(record) {
    let timer; try { await Promise.race([record.closed, new Promise((_, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('branch-proof-process-timeout')); }, 20000); })]); }
    finally { clearTimeout(timer); }
    for (const secret of [root, password, key.toString('base64'), key.toString('hex')]) assert(!(record.stdout + record.stderr).includes(secret));
    assert.equal(record.code, 0);
  }
  t.after(async () => { for (const record of children) if (!record.terminal) record.child.kill('SIGKILL'); await Promise.all(children.map(record => record.closed)); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await createDurableCollaborationService({ directory, keyring, initialize: true });
  const sessions = {};
  for (const role of ['owner', 'publisher', 'reviewer', 'viewer', 'outsider']) { users[role] = await runtime.identity.createAccount(`${role}@protected.example.test`, password); sessions[role] = await runtime.identity.signIn(users[role].email, password); }
  const context = { accessToken: sessions.owner.accessToken, requestId: 'branch-proof-provision' }, team = await runtime.teams.create(context, 'Disposable branch reviewers');
  await runtime.projects.create(context, { projectId: 'protected-film', name: 'Protected disposable film', teamId: team.id });
  for (const role of ['publisher', 'reviewer', 'viewer']) { const invitation = await runtime.members.invite(context, 'protected-film', users[role].email, role === 'viewer' ? 'viewer' : 'editor'); await runtime.members.accept({ accessToken: sessions[role].accessToken }, invitation.token); }
  for (const value of Object.values(sessions)) await runtime.identity.signOut(value.refreshToken); await runtime.close();
  async function launch() {
    assert(children.every(record => record.terminal));
    const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); }); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, directory, host: '127.0.0.1', port, tls: { certFile, keyFile }, keyring: { activeKeyId: 'fixture', keys: { fixture: key.toString('base64') } } }), { mode: 0o600 });
    const record = spawnOwned([hostCli, 'serve', '--config', configPath]); hosts.push(record); record.child.stdin.end();
    await new Promise((resolve, reject) => { let interval; const finish = error => { clearTimeout(deadline); clearInterval(interval); error ? reject(error) : resolve(); };
      const deadline = setTimeout(() => finish(Error('branch-proof-host-not-ready')), 10000); interval = setInterval(() => {
        if (record.stdout.includes('"event":"service-ready"')) finish();
        else if (record.terminal) finish(Error('branch-proof-host-failed'));
      }, 10); });
    return { origin: `https://127.0.0.1:${port}`, stop: async () => { record.child.kill('SIGTERM'); await terminal(record); } };
  }
  async function client(input) {
    const record = spawnOwned(['-e', clientSource, path.resolve(__dirname, '../src/revision-http-client.js')], true);
    let timer;
    const result = new Promise((resolve, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('branch-proof-client-timeout')); }, 20000);
      record.child.on('message', message => {
        if (message.kind === 'done') resolve(message.data); else reject(Error(`branch-proof-${message.code}-line-${message.line}`));
      }); record.child.on('error', reject); record.closed.then(() => { if (record.code !== 0) reject(Error('branch-proof-client-exit')); }); });
    record.child.stdin.end(JSON.stringify(input)); let value;
    try { value = await result; } finally { clearTimeout(timer); }
    await terminal(record); assert.equal(record.stdout, ''); return value;
  }
  const first = await launch(), initial = await client({ phase: 1, origin: first.origin, password }); await first.stop();
  const change = await createDurableCollaborationService({ directory, keyring }), ownerContext = { accessToken: initial.sessions.owner.accessToken };
  await change.service.setBranchProtection(ownerContext, { projectId: 'protected-film', branch: 'main', expectedVersion: 1, requiredApprovals: 2, idempotencyKey: 'after-ack-policy-change' });
  await change.members.remove(ownerContext, 'protected-film', users.reviewer.id); await change.close();
  const second = await launch(), retried = await client({ phase: 2, origin: second.origin, sessions: initial.sessions, receipt: initial.receipt }); await second.stop();
  const revoked = await createDurableCollaborationService({ directory, keyring }); await revoked.members.remove(ownerContext, 'protected-film', users.publisher.id); await revoked.identity.signOut(initial.sessions.viewer.refreshToken); await revoked.close();
  const third = await launch(), final = await client({ phase: 3, origin: third.origin, sessions: initial.sessions, receipt: retried.receipt }); await third.stop();
  assert.equal(hosts.length, 3); assert(children.every(record => record.terminal)); assert.equal(final.receipt.noDuplicateEvents, true); assert.equal(final.receipt.newWriteBlockedAfterMembershipLoss, true);
  assert.equal((await fs.stat(path.join(directory, 'collaboration.enc.json'))).mode & 0o777, 0o600);
  t.diagnostic(JSON.stringify({ hostProcesses: 3, clientProcesses: 3, networkRequests: initial.calls + retried.calls + final.calls,
    lostCommittedCasAckRetriedExactly: true, noDuplicateHistoryOrEvents: true, currentPublisherAccessRequired: true }));
});
