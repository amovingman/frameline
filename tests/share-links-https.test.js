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
const assert=require('node:assert/strict'),{createRevisionHttpClient}=require(process.argv[1]),{API_VERSION}=require(process.argv[2]);
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);process.stdin.on('end',async()=>{try{
 const input=JSON.parse(text),{phase,origin}=input,pid='shared-film';let calls=0;
 assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
 const send=(...args)=>{calls++;return fetch(...args);}, connect=token=>createRevisionHttpClient({origin,getAccessToken:()=>token,fetch:send});
 let sessions=input.sessions;if(!sessions){sessions={};for(const role of ['owner','editor','viewer','outsider'])sessions[role]=await connect(null).signIn(role+'@share.example.test',input.password);}
 if(phase===3)sessions.owner=await connect(null).signIn('owner@share.example.test',input.password);
 const owner=connect(sessions.owner.accessToken),editor=connect(sessions.editor.accessToken),viewer=connect(sessions.viewer.accessToken),outsider=connect(sessions.outsider.accessToken),guest=createRevisionHttpClient({origin,getAccessToken:()=>{throw Error('Anonymous bearer accessor must not run');},fetch:send});
 let receipt=input.receipt;
 if(phase===1){
  const manifest={schemaVersion:2,adapter:'fcpxml',readOnly:true,identityStatus:'unresolved',sourceHash:'e'.repeat(64),sequence:{name:'Shared "Été 夜" cut',frameDuration:'1/24s',durationFrames:0},clips:[],media:[],warnings:[]};
  const stored=await owner.putManifest(pid,manifest),root=await owner.createRevision({projectId:pid,manifestId:stored.id,parentRevisionId:null,sourceRevisionId:'shared-root',message:'Pinned shared cut',idempotencyKey:'shared-root'});
  await owner.compareAndSwapBranch({projectId:pid,branch:'main',revisionId:root.id,expectedRevisionId:null,idempotencyKey:'shared-root-head'});
  const create={projectId:pid,branch:'main',expectedHead:root.id,ttlMs:3600000,idempotencyKey:'share-hour'};
  const expiring=await owner.createShareLink(create),revocable=await owner.createShareLink({...create,ttlMs:2592000000,idempotencyKey:'share-revoke'});
  let discarded;const lossy=createRevisionHttpClient({origin,getAccessToken:()=>sessions.owner.accessToken,fetch:async(url,options)=>{calls++;const r=await fetch(url,options);if(!discarded&&options.method==='POST'&&new URL(url).pathname.endsWith('/share-links')&&r.ok){discarded=JSON.parse(await r.text()).data;throw Error('Discard successful share acknowledgment');}return r;}});
  const lostInput={...create,ttlMs:2592000000,idempotencyKey:'share-lost-ack'};await assert.rejects(lossy.createShareLink(lostInput),{code:'sync-network-unavailable'});const retained=await owner.createShareLink(lostInput);assert.deepEqual(retained,discarded);
  assert.equal((await owner.getShareReview(pid,'main')).links.total,3);
  for(const member of [editor,viewer,outsider]){await assert.rejects(member.getShareReview(pid,'main'),{code:'forbidden'});await assert.rejects(member.createShareLink({...create,idempotencyKey:'member-denied'}),{code:'forbidden'});await assert.rejects(member.revokeShareLink(pid,revocable.link.id),{code:'forbidden'});}
  const shared=await guest.redeemShareLink({token:retained.token});assert.equal(shared.permission,'read');assert.deepEqual(shared.manifest,manifest);assert.equal(shared.revision.id,root.id);assert.deepEqual(Object.keys(shared.revision).sort(),['createdAt','id','manifestId','message']);
  assert(!('authorId'in shared)&&!('members'in shared)&&!('comments'in shared));
  const list=await owner.getShareReview(pid,'main',{limit:1});assert(list.links.nextCursor);assert.equal((await owner.getShareReview(pid,'main',{limit:1,cursor:list.links.nextCursor})).links.items.length,1);
  const next=await owner.createRevision({projectId:pid,manifestId:stored.id,parentRevisionId:root.id,sourceRevisionId:'shared-new-head',message:'Later current head',idempotencyKey:'shared-next'});await owner.compareAndSwapBranch({projectId:pid,branch:'main',expectedRevisionId:root.id,revisionId:next.id,idempotencyKey:'shared-next-head'});
  assert.equal((await guest.redeemShareLink({token:retained.token})).revision.id,root.id);assert.deepEqual(await owner.createShareLink(lostInput),retained);
  await assert.rejects(owner.getShareReview(pid,'main',{limit:1,cursor:list.links.nextCursor}),{code:'share-cursor-invalid'});
  await assert.rejects(owner.createShareLink({...lostInput,ttlMs:3600000}),{code:'share-idempotency-conflict'});
  await assert.rejects(owner.createShareLink({...create,idempotencyKey:'stale-new-link'}),{code:'share-head-stale'});
  const others={};for(const projectId of ['shared-delete','shared-transfer']){const m=await owner.putManifest(projectId,manifest),r=await owner.createRevision({projectId,manifestId:m.id,parentRevisionId:null,sourceRevisionId:projectId+'-root',message:'Other pinned cut',idempotencyKey:projectId+'-root'});await owner.compareAndSwapBranch({projectId,branch:'main',expectedRevisionId:null,revisionId:r.id,idempotencyKey:projectId+'-head'});const intent={projectId,branch:'main',expectedHead:r.id,ttlMs:2592000000,idempotencyKey:projectId+'-share'};others[projectId]={...(await owner.createShareLink(intent)),intent};}
  const html=await send(origin+'/share#'+retained.token,{headers:{accept:'text/html'}});assert.equal(html.status,200);const document=await html.text();assert(!document.includes(retained.token));assert.match(html.headers.get('content-security-policy'),/default-src 'none'/);assert.equal(html.headers.get('referrer-policy'),'no-referrer');assert.equal(html.headers.get('cache-control'),'no-store');
  receipt={expiring,revocable,retained,create,lostInput,others,rootId:root.id,manifestId:stored.id};
 }else if(phase===2){
  assert.equal((await guest.redeemShareLink({token:receipt.retained.token})).revision.id,receipt.rootId);
  const revoked=await owner.revokeShareLink(pid,receipt.revocable.link.id);assert.equal(revoked.status,'revoked');assert.deepEqual(await owner.revokeShareLink(pid,receipt.revocable.link.id),revoked);
  await assert.rejects(guest.redeemShareLink({token:receipt.revocable.token}),{code:'share-link-unavailable'});
  const tokenOnly=connect(receipt.retained.token);await assert.rejects(tokenOnly.getAccount(),{code:'access-token-invalid'});await assert.rejects(tokenOnly.getManifest(pid,receipt.manifestId),{code:'access-token-invalid'});
  await assert.rejects(tokenOnly.getShareReview(pid,'main'),{code:'access-token-invalid'});
  const raw=async(route,body,authorization)=>{const r=await send(origin+route,{method:'POST',headers:{'x-api-version':API_VERSION,'x-request-id':'share-negative','content-type':'application/json',...(authorization?{authorization:'Bearer '+authorization}:{})},body:JSON.stringify(body)});return{status:r.status,body:await r.text()};};
  const malformed=await raw('/shares/redeem',{token:'bad'});assert.equal(malformed.status,404);assert.equal(JSON.parse(malformed.body).error.code,'share-link-unavailable');
  const unknown=await raw('/shares/redeem',{token:Buffer.alloc(32,9).toString('base64url')});assert.equal(unknown.status,404);assert.equal(JSON.parse(unknown.body).error.code,'share-link-unavailable');
  for(const route of ['/projects/'+pid+'/revisions/'+receipt.rootId+'/comments','/projects/'+pid+'/assets/uploads']){const denied=await raw(route,{},receipt.retained.token);assert(denied.status>=400);assert(!denied.body.includes(receipt.retained.token));}
  const list=await owner.getShareReview(pid,'main');assert.equal(list.links.total,3);assert.equal(list.links.items.filter(v=>v.status==='revoked').length,1);
 }else{
  await assert.rejects(guest.redeemShareLink({token:receipt.expiring.token}),{code:'share-link-unavailable'});
  await assert.rejects(guest.redeemShareLink({token:receipt.revocable.token}),{code:'share-link-unavailable'});
  for(const name of ['shared-delete','shared-transfer'])await assert.rejects(guest.redeemShareLink({token:receipt.others[name].token}),{code:'share-link-unavailable'});
  assert.equal((await guest.redeemShareLink({token:receipt.retained.token})).revision.id,receipt.rootId);
  const expiredRetry=await owner.createShareLink(receipt.create);assert.equal(expiredRetry.token,receipt.expiring.token);assert.equal(expiredRetry.link.status,'expired');
  await assert.rejects(owner.createShareLink(receipt.others['shared-transfer'].intent),{code:'forbidden'});
  const list=await owner.getShareReview(pid,'main');assert.equal(list.links.total,3);assert.equal(list.links.items.filter(v=>v.status==='expired').length,1);
  const activity=await owner.listActivity(pid,{limit:100});assert.equal(activity.items.filter(v=>v.type==='share.created').length,3);assert.equal(activity.items.filter(v=>v.type==='share.revoked').length,1);
 }
 process.send({kind:'done',data:{sessions,receipt,calls}},()=>process.disconnect());
}catch(e){const line=/\[eval\]:(\d+)/.exec(e.stack||'')?.[1];process.send({kind:'failed',code:/^[a-z-]{1,80}$/.test(e.code||'')?e.code:'assertion-failed',line:line?Number(line):null},()=>process.disconnect());process.exitCode=1;}});

`;

test('read-only share capabilities survive real HTTPS process restarts and reject revoked, expired and unavailable issuers', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'share-links-https-'));
  const configPath = path.join(root, 'config.json'), directory = path.join(root, 'data'), key = randomBytes(32), keyring = createKeyring({ fixture: key }, 'fixture');
  const certFile = path.join(root, 'server.pem'), keyFile = path.join(root, 'server-key.pem');
  await fs.copyFile(path.join(tls, 'server.pem'), certFile); await fs.copyFile(path.join(tls, 'server-key.pem'), keyFile); await fs.chmod(certFile, 0o600); await fs.chmod(keyFile, 0o600);
  const password = 'Disposable share link password', children = [], hosts = [], users = {};
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
    let timer; try { await Promise.race([record.closed, new Promise((_, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('share-proof-process-timeout')); }, 20000); })]); }
    finally { clearTimeout(timer); }
    for (const secret of [root, password, key.toString('base64'), key.toString('hex')]) assert(!(record.stdout + record.stderr).includes(secret));
    assert.equal(record.code, 0);
  }
  t.after(async () => { for (const record of children) if (!record.terminal) record.child.kill('SIGKILL'); await Promise.all(children.map(record => record.closed)); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await createDurableCollaborationService({ directory, keyring, initialize: true });
  const sessions = {};
  for (const role of ['owner', 'editor', 'viewer', 'outsider', 'successor']) { users[role] = await runtime.identity.createAccount(`${role}@share.example.test`, password); sessions[role] = await runtime.identity.signIn(users[role].email, password); }
  const context = { accessToken: sessions.owner.accessToken, requestId: 'share-proof-provision' }, team = await runtime.teams.create(context, 'Disposable share members');
  for (const projectId of ['shared-film', 'shared-delete', 'shared-transfer']) {
    await runtime.projects.create(context, { projectId, name: projectId, teamId: team.id });
    for (const role of ['editor', 'viewer', 'successor']) { const invitation = await runtime.members.invite(context, projectId, users[role].email, role === 'viewer' ? 'viewer' : 'editor'); await runtime.members.accept({ accessToken: sessions[role].accessToken }, invitation.token); }
  }
  for (const value of Object.values(sessions)) await runtime.identity.signOut(value.refreshToken); await runtime.close();
  async function launch(clock = null) {
    assert(children.every(record => record.terminal));
    const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); }); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, directory, host: '127.0.0.1', port, tls: { certFile, keyFile }, keyring: { activeKeyId: 'fixture', keys: { fixture: key.toString('base64') } } }), { mode: 0o600 });
    const args = clock === null ? [hostCli, 'serve', '--config', configPath] : ['-e', 'Date.now=()=>Number(process.argv[2]);require(process.argv[1]).main(["serve","--config",process.argv[3]]).catch(()=>{console.error("share-proof-host-failed");process.exitCode=1;});', hostCli, String(clock), configPath];
    const record = spawnOwned(args); hosts.push(record); record.child.stdin.end();
    await new Promise((resolve, reject) => { let interval; const finish = error => { clearTimeout(deadline); clearInterval(interval); error ? reject(error) : resolve(); };
      const deadline = setTimeout(() => finish(Error('share-proof-host-not-ready')), 10000); interval = setInterval(() => {
        if (record.stdout.includes('"event":"service-ready"')) finish();
        else if (record.terminal) finish(Error('share-proof-host-failed'));
      }, 10); });
    return { origin: `https://127.0.0.1:${port}`, stop: async () => { record.child.kill('SIGTERM'); await terminal(record); } };
  }
  async function client(input) {
    const record = spawnOwned(['-e', clientSource, path.resolve(__dirname, '../src/revision-http-client.js'), path.resolve(__dirname, '../src/project-api-contracts.js')], true);
    let timer;
    const result = new Promise((resolve, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('share-proof-client-timeout')); }, 20000);
      record.child.on('message', message => {
        if (message.kind === 'done') resolve(message.data); else reject(Error(`share-proof-${message.code}-line-${message.line}`));
      }); record.child.on('error', reject); record.closed.then(() => { if (record.code !== 0) reject(Error('share-proof-client-exit')); }); });
    record.child.stdin.end(JSON.stringify(input)); let value;
    try { value = await result; } finally { clearTimeout(timer); }
    await terminal(record); assert.equal(record.stdout, ''); return value;
  }
  const first = await launch(), initial = await client({ phase: 1, origin: first.origin, password }); await first.stop();
  const second = await launch(), reopened = await client({ phase: 2, origin: second.origin, sessions: initial.sessions, receipt: initial.receipt }); await second.stop();
  const change = await createDurableCollaborationService({ directory, keyring }), ownerContext = { accessToken: initial.sessions.owner.accessToken };
  await change.projects.delete(ownerContext, 'shared-delete');
  await change.members.transferOwnership(ownerContext, 'shared-transfer', users.successor.id); await change.close();
  const advancedClock = initial.receipt.expiring.link.expiresAt + 1000;
  const third = await launch(advancedClock), final = await client({ phase: 3, origin: third.origin, password, sessions: initial.sessions, receipt: initial.receipt }); await third.stop();
  assert.equal(hosts.length, 3); assert(children.every(record => record.terminal));
  const bytes = await fs.readFile(path.join(directory, 'collaboration.enc.json'), 'utf8');
  for (const secret of [password, ...Object.values(initial.sessions).flatMap(v => [v.accessToken, v.refreshToken]), initial.receipt.retained.token, key.toString('base64')]) assert(!bytes.includes(secret));
  assert.equal((await fs.stat(path.join(directory, 'collaboration.enc.json'))).mode & 0o777, 0o600);
  t.diagnostic(JSON.stringify({ hostProcesses: 3, clientProcesses: 3, networkRequests: initial.calls + reopened.calls + final.calls,
    exactCreateRetryRestoredSameCapability: true, pinnedRevisionSurvivedHeadAdvance: true, revocationPersisted: true,
    expiryCheckedWithAdvancedServerClock: true, deletedProjectAndFormerOwnerDenied: true, tokenAloneDeniedProtectedApis: true }));
});
