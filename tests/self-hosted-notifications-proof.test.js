'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const nodeTls = require('node:tls');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const tls = path.resolve(__dirname, 'fixtures/network-tls');
const hostCli = path.resolve(__dirname, '../src/service-host-cli.js');

const clientSource = String.raw`
const assert=require('node:assert/strict'),{createRevisionHttpClient}=require(process.argv[1]),{API_VERSION}=require(process.argv[2]);
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);process.stdin.on('end',async()=>{try{
 const input=JSON.parse(text),{phase,origin}=input;let calls=0;assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
 const send=(...args)=>{calls++;return fetch(...args);},connect=token=>createRevisionHttpClient({origin,getAccessToken:()=>token,fetch:send});
 let sessions=input.sessions;if(!sessions){sessions={};for(const role of ['owner','recipient','other','outsider'])sessions[role]=await connect(null).signIn(role+'@notifications.example.test',input.password);}
 const owner=connect(sessions.owner.accessToken),recipient=connect(sessions.recipient.accessToken),outsider=connect(sessions.outsider.accessToken),guest=createRevisionHttpClient({origin,getAccessToken:()=>{throw Error('Anonymous unsubscribe cannot read identity');},fetch:send});
 let receipt=input.receipt;
 if(phase===1){
  const before=await recipient.getNotificationPreferences('mail-film');assert.equal(before.mode,'off');assert.equal(before.version,0);assert.equal(before.deliveryAvailable,true);assert.equal(before.accountEmail,'recipient@notifications.example.test');
  const intent={projectId:'mail-film',expectedVersion:0,mode:'immediate',digestHourUtc:9,idempotencyKey:'mail-pref-lost-ack'};
  let dropped;const lossy=createRevisionHttpClient({origin,getAccessToken:()=>sessions.recipient.accessToken,fetch:async(url,options)=>{calls++;const r=await fetch(url,options);if(!dropped&&options.method==='PUT'&&url.endsWith('/notification-preferences')&&r.ok){dropped=JSON.parse(await r.text()).data;throw Error('Discard accepted preference acknowledgment');}return r;}});
  await assert.rejects(lossy.setNotificationPreferences(intent),{code:'sync-network-unavailable'});assert.deepEqual(await recipient.setNotificationPreferences(intent),dropped);
  await assert.rejects(recipient.setNotificationPreferences({...intent,mode:'daily'}),{code:'notification-idempotency-conflict'});
  for(const projectId of ['mail-removed','mail-deleted'])assert.equal((await recipient.setNotificationPreferences({projectId,expectedVersion:0,mode:'daily',digestHourUtc:9,idempotencyKey:projectId+'-daily'})).version,1);
  await assert.rejects(outsider.getNotificationPreferences('mail-film'),{code:'forbidden'});
  const manifest={schemaVersion:2,adapter:'fcpxml',readOnly:true,identityStatus:'unresolved',sourceHash:'d'.repeat(64),sequence:{name:'Background notification fixture',frameDuration:'1/24s',durationFrames:0},clips:[],media:[],warnings:[]};
  const m=await owner.putManifest('mail-film',manifest),r=await owner.createRevision({projectId:'mail-film',manifestId:m.id,parentRevisionId:null,sourceRevisionId:'mail-root',message:'New unread revision',idempotencyKey:'mail-root'});await owner.compareAndSwapBranch({projectId:'mail-film',branch:'main',expectedRevisionId:null,revisionId:r.id,idempotencyKey:'mail-root-head'});
  const page=await recipient.getAccountNotifications({limit:1});assert(page.nextCursor);assert.equal(page.items[0].type,'branch.changed');const read=await recipient.markAccountNotificationRead(page.items[0].id);assert.deepEqual(read,{eventId:page.items[0].id,read:true});assert.deepEqual(await recipient.markAccountNotificationRead(page.items[0].id),read);
  const unread=await recipient.getAccountNotifications({filter:'unread'});assert(unread.items.every(v=>!v.read));assert.equal(unread.unreadCount,page.unreadCount-1);
  await assert.rejects(owner.markAccountNotificationRead(page.items[0].id),{code:'notification-not-found'});await assert.rejects(owner.getAccountNotifications({limit:1,cursor:page.nextCursor}),{code:'notification-cursor-invalid'});
  const older=await recipient.getAccountNotifications({limit:20,cursor:page.nextCursor});assert(older.items.length>0);
  receipt={readEventId:page.items[0].id,unreadCount:unread.unreadCount,preferenceIntent:intent};
 }else if(phase===2){
  const page=await recipient.getAccountNotifications();assert.equal(page.items.find(v=>v.id===receipt.readEventId).read,true);assert.equal(page.unreadCount,receipt.unreadCount);
  assert.equal((await recipient.getNotificationPreferences('mail-film')).version,1);assert.equal((await recipient.getNotificationPreferences('mail-removed')).mode,'daily');
  assert.deepEqual(await guest.unsubscribeNotifications({token:input.unsubscribeToken}),{unsubscribed:true});assert.equal((await recipient.getNotificationPreferences('mail-film')).mode,'off');
  await recipient.setNotificationPreferences({projectId:'mail-film',expectedVersion:2,mode:'immediate',digestHourUtc:9,idempotencyKey:'new-consent'});
  assert.deepEqual(await guest.unsubscribeNotifications({token:input.unsubscribeToken}),{unsubscribed:true});assert.equal((await recipient.getNotificationPreferences('mail-film')).mode,'immediate');
  await recipient.disableNotificationDelivery();assert.equal((await recipient.getNotificationPreferences('mail-film')).mode,'off');
  await recipient.setNotificationPreferences({projectId:'mail-removed',expectedVersion:2,mode:'immediate',digestHourUtc:9,idempotencyKey:'enable-before-removal'});
  await recipient.setNotificationPreferences({projectId:'mail-deleted',expectedVersion:2,mode:'daily',digestHourUtc:9,idempotencyKey:'enable-before-deletion'});
  const html=await send(origin+'/unsubscribe#'+input.unsubscribeToken,{});assert.equal(html.status,200);assert.equal(html.headers.get('referrer-policy'),'no-referrer');assert.match(html.headers.get('content-security-policy'),/default-src 'none'/);assert(!(await html.text()).includes(input.unsubscribeToken));
  const wrong=await send(origin+'/notifications/unsubscribe',{method:'POST',headers:{'x-api-version':API_VERSION,'x-request-id':'generic-unsubscribe','content-type':'application/json'},body:JSON.stringify({token:'unknown'})});assert.equal(wrong.status,200);assert.deepEqual((await wrong.json()).data,{unsubscribed:true});
  const tokenOnly=connect(input.unsubscribeToken);await assert.rejects(tokenOnly.getAccount(),{code:'access-token-invalid'});await assert.rejects(tokenOnly.getAccountNotifications(),{code:'access-token-invalid'});
 }else{
  const page=await recipient.getAccountNotifications(),loss=page.items.filter(v=>v.accessLost);assert(loss.some(v=>v.type==='member.removed'));assert(loss.some(v=>v.type==='project.deleted'));
  for(const item of loss)assert.deepEqual([item.projectId,item.projectName,item.actorId,item.subjectId],[null,null,null,null]);
  assert(!page.items.some(v=>['mail-removed','mail-deleted'].includes(v.projectId)));
  await assert.rejects(recipient.getNotificationPreferences('mail-removed'),{code:'forbidden'});await assert.rejects(recipient.getNotificationPreferences('mail-deleted'),{code:'forbidden'});
  assert.deepEqual(await recipient.markAccountNotificationRead(loss[0].id),{eventId:loss[0].id,read:true});assert.deepEqual(await recipient.disableNotificationDelivery(),{disabled:true});
  const empty=await outsider.getAccountNotifications();assert.equal(empty.items.length,0);await assert.rejects(outsider.markAccountNotificationRead(loss[0].id),{code:'notification-not-found'});
 }
 process.send({kind:'done',data:{sessions,receipt,calls}},()=>process.disconnect());
}catch(e){const line=/\[eval\]:(\d+)/.exec(e.stack||'')?.[1];process.send({kind:'failed',code:/^[a-z-]{1,80}$/.test(e.code||'')?e.code:'assertion-failed',line:line?Number(line):null},()=>process.disconnect());process.exitCode=1;}});

`;

test('account notifications and explicit mail consent survive actual HTTPS host restarts and background loopback TLS delivery', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'notification-delivery-https-'));
  const configPath = path.join(root, 'config.json'), directory = path.join(root, 'data'), key = randomBytes(32), keyring = createKeyring({ fixture: key }, 'fixture');
  const certFile = path.join(root, 'server.pem'), keyFile = path.join(root, 'server-key.pem');
  await fs.copyFile(path.join(tls, 'server.pem'), certFile); await fs.copyFile(path.join(tls, 'server-key.pem'), keyFile); await fs.chmod(certFile, 0o600); await fs.chmod(keyFile, 0o600);
  const password = 'Disposable notification password', children = [], hosts = [], users = {};
  const environment = trusted => {
    const env = { ...process.env };
    for (const name of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY']) delete env[name];
    if (trusted) env.NODE_EXTRA_CA_CERTS = path.join(tls, 'ca.pem'); return env;
  };
  function spawnOwned(args, ipc = false) {
    const child = spawn(process.execPath, args, { env: environment(true), stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    const record = { child, stdout: '', stderr: '', terminal: false }; children.push(record);
    child.stdout.on('data', bytes => { record.stdout += bytes; }); child.stderr.on('data', bytes => { record.stderr += bytes; }); child.stdin.on('error', () => {});
    record.closed = new Promise(resolve => child.once('close', (code, signal) => { record.terminal = true; record.code = code; record.signal = signal; resolve(); }));
    return record;
  }
  async function terminal(record) {
    let timer; try { await Promise.race([record.closed, new Promise((_, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('notification-proof-process-timeout')); }, 20000); })]); }
    finally { clearTimeout(timer); }
    for (const secret of [root, password, key.toString('base64'), key.toString('hex')]) assert(!(record.stdout + record.stderr).includes(secret));
    assert.equal(record.code, 0);
  }
  t.after(async () => { for (const record of children) if (!record.terminal) record.child.kill('SIGKILL'); await Promise.all(children.map(record => record.closed)); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await createDurableCollaborationService({ directory, keyring, initialize: true });
  const sessions = {};
  for (const role of ['owner', 'recipient', 'other', 'outsider']) { users[role] = await runtime.identity.createAccount(`${role}@notifications.example.test`, password); sessions[role] = await runtime.identity.signIn(users[role].email, password); }
  const context = { accessToken: sessions.owner.accessToken, requestId: 'notification-proof-provision' }, team = await runtime.teams.create(context, 'Disposable notification members');
  for (const projectId of ['mail-film', 'mail-removed', 'mail-deleted']) {
    await runtime.projects.create(context, { projectId, name: projectId, teamId: team.id });
    for (const role of ['recipient', 'other']) { const invitation = await runtime.members.invite(context, projectId, users[role].email, role === 'recipient' ? 'viewer' : 'editor'); await runtime.members.accept({ accessToken: sessions[role].accessToken }, invitation.token); }
  }
  for (const value of Object.values(sessions)) await runtime.identity.signOut(value.refreshToken); await runtime.close();
  let servicePort;
  async function launch(clock = null) {
    assert(children.every(record => record.terminal));
    if (!servicePort) { const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); }); servicePort = probe.address().port; await new Promise(resolve => probe.close(resolve)); }
    const port = servicePort;
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, directory, host: '127.0.0.1', port, tls: { certFile, keyFile }, keyring: { activeKeyId: 'fixture', keys: { fixture: key.toString('base64') } },
      notifications: { publicOrigin: `https://127.0.0.1:${port}`, from: 'updates@notifications.example.test', smtp: { host: '127.0.0.1', port: smtp.address().port, username: null, password: null } } }), { mode: 0o600 });
    const args = clock === null ? [hostCli, 'serve', '--config', configPath] : ['-e', 'Date.now=()=>Number(process.argv[2]);require(process.argv[1]).main(["serve","--config",process.argv[3]]).catch(()=>{console.error("notification-proof-host-failed");process.exitCode=1;});', hostCli, String(clock), configPath];
    const record = spawnOwned(args); hosts.push(record); record.child.stdin.end();
    await new Promise((resolve, reject) => { let interval; const finish = error => { clearTimeout(deadline); clearInterval(interval); error ? reject(error) : resolve(); };
      const deadline = setTimeout(() => finish(Error('notification-proof-host-not-ready')), 10000); interval = setInterval(() => {
        if (record.stdout.includes('"event":"service-ready"')) finish();
        else if (record.terminal) finish(Error('notification-proof-host-failed'));
      }, 10); });
    return { origin: `https://127.0.0.1:${port}`, stop: async () => { record.child.kill('SIGTERM'); await terminal(record); } };
  }
  async function client(input) {
    const record = spawnOwned(['-e', clientSource, path.resolve(__dirname, '../src/revision-http-client.js'), path.resolve(__dirname, '../src/project-api-contracts.js')], true);
    let timer;
    const result = new Promise((resolve, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('notification-proof-client-timeout')); }, 20000);
      record.child.on('message', message => {
        if (message.kind === 'done') resolve(message.data); else reject(Error(`notification-proof-${message.code}-line-${message.line}`));
      }); record.child.on('error', reject); record.closed.then(() => { if (record.code !== 0) reject(Error('notification-proof-client-exit')); }); });
    record.child.stdin.end(JSON.stringify(input)); let value;
    try { value = await result; } finally { clearTimeout(timer); }
    await terminal(record); assert.equal(record.stdout, ''); return value;
  }
  const messages = [], smtpSockets = new Set();
  const smtp = nodeTls.createServer({ cert: await fs.readFile(certFile), key: await fs.readFile(keyFile), minVersion: 'TLSv1.2' }, socket => {
    assert.equal(socket.encrypted, true); let buffer = '', data = null, recipient = null, received = 0;
    socket.setEncoding('utf8'); socket.write('220 fixture.local ESMTP\r\n');
    socket.on('data', chunk => { received += Buffer.byteLength(chunk); if (received > 512 * 1024) { socket.destroy(); return; } buffer += chunk;
      let end; while ((end = buffer.indexOf('\r\n')) !== -1) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data !== null) { if (line === '.') { messages.push({ recipient, mime: data.join('\r\n') }); data = null; socket.write('250 fixture accepted\r\n'); } else data.push(line); }
        else if (line.startsWith('EHLO ')) socket.write('250-fixture.local\r\n250 SIZE 262144\r\n');
        else if (line.startsWith('MAIL FROM:')) socket.write('250 sender accepted\r\n');
        else if (line.startsWith('RCPT TO:')) { recipient = line.slice(8); socket.write('250 recipient accepted\r\n'); }
        else if (line === 'DATA') { data = []; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 closing\r\n'); else socket.write('500 unexpected fixture command\r\n');
      }
    }); socket.on('error', () => {});
  });
  smtp.on('connection', socket => { smtpSockets.add(socket); socket.once('close', () => smtpSockets.delete(socket)); }); smtp.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of smtpSockets) socket.destroy(); await new Promise(resolve => smtp.close(resolve)); });
  const first = await launch(), initial = await client({ phase: 1, origin: first.origin, password }); await first.stop();
  const pending = await createDurableCollaborationService({ directory, keyring, notificationDeliveryAvailable: true });
  await pending.notifications.schedule({ limit: 100 }); await pending.close();
  const second = await launch();
  async function waitFor(predicate) { const deadline = Date.now() + 10000; while (!(await predicate())) { if (Date.now() > deadline) throw Error('notification-proof-delivery-timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } }
  await waitFor(() => messages.length >= 1);
  const state = async () => keyring.decrypt(JSON.parse(await fs.readFile(path.join(directory, 'collaboration.enc.json'), 'utf8')).record);
  await waitFor(async () => (await state()).notifications.jobs.some(job => job.status === 'delivered'));
  const mail = messages.find(value => value.recipient?.includes('recipient@notifications.example.test')); assert(mail);
  const unsubscribeToken = /List-Unsubscribe: <https:\/\/[^>]+\/unsubscribe#([A-Za-z0-9_-]{43})>/.exec(mail.mime)?.[1]; assert(unsubscribeToken);
  const body = Buffer.from(mail.mime.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8');
  assert(body.includes('mail-film')); assert(!body.includes('New unread revision')); assert(!body.includes('sourceHash')); assert(!body.includes('Bearer '));
  const restored = await client({ phase: 2, origin: second.origin, sessions: initial.sessions, receipt: initial.receipt, unsubscribeToken }); await second.stop();
  const change = await createDurableCollaborationService({ directory, keyring, notificationDeliveryAvailable: true }), ownerContext = { accessToken: initial.sessions.owner.accessToken };
  await change.members.remove(ownerContext, 'mail-removed', users.recipient.id); await change.projects.delete(ownerContext, 'mail-deleted'); await change.close();
  const third = await launch(), final = await client({ phase: 3, origin: third.origin, sessions: initial.sessions, receipt: initial.receipt }); await third.stop();
  assert.equal(hosts.length, 3); assert(children.every(record => record.terminal));
  const finalState = await state(); assert(finalState.notifications.preferences.filter(value => value.userId === users.recipient.id).every(value => value.mode === 'off'));
  const bytes = await fs.readFile(path.join(directory, 'collaboration.enc.json'), 'utf8');
  for (const secret of [password, ...Object.values(initial.sessions).flatMap(v => [v.accessToken, v.refreshToken]), unsubscribeToken, key.toString('base64')]) assert(!bytes.includes(secret));
  assert.equal((await fs.stat(path.join(directory, 'collaboration.enc.json'))).mode & 0o777, 0o600);
  t.diagnostic(JSON.stringify({ hostProcesses: 3, clientProcesses: 3, networkRequests: initial.calls + restored.calls + final.calls,
    durableBackgroundMessageAcceptedOverTls: true, privateFakeMtaOnly: true, exactPreferenceRetry: true,
    readReceiptPersisted: true, projectUnsubscribeAndConsentEpochVerified: true, permissionLossRedacted: true, globalDisableAfterAccessLoss: true }));
});
