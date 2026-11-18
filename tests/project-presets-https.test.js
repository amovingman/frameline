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
const { createDurableAssetService } = require('../src/durable-asset-service');
const tls = path.resolve(__dirname, 'fixtures/network-tls');
const hostCli = path.resolve(__dirname, '../src/service-host-cli.js');
const clientSource = String.raw`
const assert=require('node:assert/strict'),{createRevisionHttpClient}=require(process.argv[1]),{createAssetHttpClient}=require(process.argv[2]);
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);process.stdin.on('end',async()=>{try{
 const input=JSON.parse(text),{phase,origin,teamId,otherTeamId}=input;let calls=0;
 assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
 const send=(...args)=>{calls++;return fetch(...args);}, connect=token=>createRevisionHttpClient({origin,getAccessToken:()=>token,fetch:send});
 let sessions=input.sessions;if(!sessions){sessions={};for(const role of ['owner','coowner','editor','viewer','outsider'])sessions[role]=await connect(null).signIn(role+'@presets.example.test',input.password);}
 const owner=connect(sessions.owner.accessToken),coowner=connect(sessions.coowner.accessToken),editor=connect(sessions.editor.accessToken),viewer=connect(sessions.viewer.accessToken),outsider=connect(sessions.outsider.accessToken);
 const assets=createAssetHttpClient({origin,getAccessToken:()=>sessions.owner.accessToken,fetch:send});let receipt=input.receipt;
 if(phase===1){
  const teams=await owner.listPresetTeams();assert.equal(teams.mediaAvailable,true);assert.equal(teams.teams.find(t=>t.id===teamId).role,'owner');
  for(const [member,role]of[[editor,'editor'],[viewer,'viewer']])assert.equal((await member.listPresetTeams()).teams.find(t=>t.id===teamId).role,role);
  assert.equal((await outsider.listPresetTeams()).teams.length,0);assert.deepEqual(await owner.listProjectPresets(teamId),{teamId,items:[]});
  const save={teamId,presetId:null,expectedVersion:0,name:'Documentary Équipe',branches:['edit','review'],syncClasses:['audio','proxy'],idempotencyKey:'save-documentary'};
  let lostSave,lostCreate;
  const lossy=createRevisionHttpClient({origin,getAccessToken:()=>sessions.owner.accessToken,fetch:async(url,options)=>{calls++;const r=await fetch(url,options);if(r.ok&&options.method==='PUT'&&!lostSave&&new URL(url).pathname.endsWith('/project-presets')){lostSave=JSON.parse(await r.text()).data;throw Error('Discard successful preset save acknowledgment');}if(r.ok&&options.method==='POST'&&!lostCreate&&new URL(url).pathname.endsWith('/projects')){lostCreate=JSON.parse(await r.text()).data;throw Error('Discard successful project acknowledgment');}return r;}});
  await assert.rejects(lossy.saveProjectPreset(save),{code:'sync-network-unavailable'});const template=await owner.saveProjectPreset(save);assert.deepEqual(template,lostSave);
  assert.equal((await owner.listProjectPresets(teamId)).items.length,1);assert.equal((await editor.listProjectPresets(teamId)).items[0].id,template.id);assert.equal((await viewer.listProjectPresets(teamId)).items[0].id,template.id);
  const previewInput={teamId,presetId:template.id,expectedVersion:1,projectName:'First disposable preset project'},preview=await owner.previewProjectFromPreset(previewInput);
  assert.deepEqual(preview.branches,['main','edit','review']);assert.deepEqual(preview.syncClasses,['audio','proxy']);assert.equal(preview.mediaAvailable,true);
  const intent={...previewInput,planId:preview.planId,idempotencyKey:'create-first-project'};
  for(const member of [editor,viewer,outsider]){await assert.rejects(member.saveProjectPreset({...save,idempotencyKey:'denied-save'}),{code:'preset-forbidden'});await assert.rejects(member.previewProjectFromPreset(previewInput),{code:'preset-forbidden'});await assert.rejects(member.createProjectFromPreset({...intent,idempotencyKey:'denied-create'}),{code:'preset-forbidden'});}
  await assert.rejects(outsider.listProjectPresets(teamId),{code:'preset-forbidden'});
  await assert.rejects(owner.previewProjectFromPreset({...previewInput,teamId:otherTeamId}),{code:'preset-not-found'});
  await assert.rejects(coowner.createProjectFromPreset({...intent,idempotencyKey:'different-actor-plan'}),{code:'preset-plan-stale'});
  await assert.rejects(owner.createProjectFromPreset({...intent,projectName:'Changed plan name',idempotencyKey:'changed-name-plan'}),{code:'preset-plan-stale'});
  assert.equal((await owner.listProjects()).projects.length,0);
  await assert.rejects(lossy.createProjectFromPreset(intent),{code:'sync-network-unavailable'});const created=await owner.createProjectFromPreset(intent);assert.deepEqual(created,lostCreate);
  assert.equal((await owner.listProjects()).projects.length,1);assert.equal((await editor.listProjects()).projects.length,0);
  for(const branch of created.branches)assert.equal((await owner.getBranch(created.projectId,branch)).revisionId,null);
  assert.deepEqual(await assets.getPolicy(created.projectId),{projectId:created.projectId,version:1,syncClasses:['audio','proxy']});
  await assets.setPolicy(created.projectId,{expectedVersion:1,syncClasses:['original']});
  const update={...save,presetId:template.id,expectedVersion:1,name:'Updated documentary',branches:['finish'],syncClasses:['graphics'],idempotencyKey:'update-template'};
  const changed=await owner.saveProjectPreset(update);assert.equal(changed.version,2);
  assert.deepEqual(await owner.saveProjectPreset(save),template);assert.deepEqual(await owner.createProjectFromPreset(intent),created);
  await assert.rejects(owner.saveProjectPreset({...save,name:'Changed duplicate key'}),{code:'preset-idempotency-conflict'});
  await assert.rejects(owner.createProjectFromPreset({...intent,projectName:'Changed duplicate project'}),{code:'preset-idempotency-conflict'});
  await assert.rejects(owner.createProjectFromPreset({...intent,idempotencyKey:'new-stale-plan'}),{code:'preset-version-conflict'});
  assert.deepEqual((await assets.getPolicy(created.projectId)).syncClasses,['original']);
  receipt={save,template,intent,created,update,changed};
 }else if(phase===2){
  const items=(await owner.listProjectPresets(teamId)).items;assert.equal(items.length,1);assert.equal(items[0].version,2);
  assert.deepEqual(await owner.saveProjectPreset(receipt.save),receipt.template);assert.deepEqual(await owner.createProjectFromPreset(receipt.intent),receipt.created);
  assert.equal((await owner.listProjects()).projects.length,1);assert.deepEqual(await assets.getPolicy(receipt.created.projectId),{projectId:receipt.created.projectId,version:2,syncClasses:['original']});
  const unchanged=await owner.saveProjectPreset({...receipt.update,expectedVersion:2,idempotencyKey:'same-values'});assert.equal(unchanged.version,2);
  const secondInput={teamId,presetId:receipt.template.id,expectedVersion:2,projectName:'Second disposable preset project'},secondPlan=await owner.previewProjectFromPreset(secondInput);
  const second=await owner.createProjectFromPreset({...secondInput,planId:secondPlan.planId,idempotencyKey:'create-second-project'});assert.deepEqual(second.syncClasses,['graphics']);
  assert.deepEqual(await assets.getPolicy(second.projectId),{projectId:second.projectId,version:1,syncClasses:['graphics']});
  assert.deepEqual((await assets.getPolicy(receipt.created.projectId)).syncClasses,['original']);
  await owner.signOut(sessions.coowner.refreshToken);receipt.second=second;
 }else{
  assert.equal((await owner.listPresetTeams()).mediaAvailable,false);
  await assert.rejects(coowner.listPresetTeams(),{code:'access-token-invalid'});await assert.rejects(viewer.listPresetTeams(),{code:'access-token-invalid'});
  const previewInput={teamId,presetId:receipt.template.id,expectedVersion:2,projectName:'Unavailable media preset'},preview=await owner.previewProjectFromPreset(previewInput);assert.equal(preview.mediaAvailable,false);assert.deepEqual(preview.syncClasses,['graphics']);
  await assert.rejects(owner.createProjectFromPreset({...previewInput,planId:preview.planId,idempotencyKey:'media-unavailable'}),{code:'preset-media-unavailable'});
  const empty=await owner.saveProjectPreset({teamId,presetId:null,expectedVersion:0,name:'Metadata only',branches:[],syncClasses:[],idempotencyKey:'empty-preset'});
  const emptyInput={teamId,presetId:empty.id,expectedVersion:1,projectName:'Metadata-only project'},emptyPlan=await owner.previewProjectFromPreset(emptyInput);
  assert.deepEqual(emptyPlan.branches,['main']);assert.deepEqual(emptyPlan.syncClasses,[]);assert.equal(emptyPlan.mediaAvailable,false);
  const emptyProject=await owner.createProjectFromPreset({...emptyInput,planId:emptyPlan.planId,idempotencyKey:'empty-project'});
  assert.deepEqual(await owner.createProjectFromPreset(receipt.intent),receipt.created);
  const projects=(await owner.listProjects()).projects;assert.equal(projects.length,3);assert.equal(projects.find(p=>p.id===receipt.created.projectId).name,receipt.created.projectName);assert.deepEqual(projects.find(p=>p.id===receipt.created.projectId).branches,['main','edit','review']);
  assert.equal((await owner.listProjectPresets(teamId)).items.length,2);assert.deepEqual((await owner.listProjectPresets(otherTeamId)).items,[]);receipt.emptyProject=emptyProject;
 }
 process.send({kind:'done',data:{sessions,receipt,calls}},()=>process.disconnect());
}catch(e){const line=/\[eval\]:(\d+)/.exec(e.stack||'')?.[1];process.send({kind:'failed',code:/^[a-z-]{1,80}$/.test(e.code||'')?e.code:'assertion-failed',line:line?Number(line):null},()=>process.disconnect());process.exitCode=1;}});
`;

test('durable project presets use actual HTTPS actors, exact lost-ACK retries and atomic project defaults across three host processes', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'project-presets-https-'));
  const configPath = path.join(root, 'config.json'), directory = path.join(root, 'data'), assetDirectory = path.join(root, 'assets');
  const key = randomBytes(32), signingKey = randomBytes(32), keyring = createKeyring({ fixture: key }, 'fixture');
  const certFile = path.join(root, 'server.pem'), keyFile = path.join(root, 'server-key.pem');
  await fs.copyFile(path.join(tls, 'server.pem'), certFile); await fs.copyFile(path.join(tls, 'server-key.pem'), keyFile); await fs.chmod(certFile, 0o600); await fs.chmod(keyFile, 0o600);
  const password = 'Disposable preset proof password', children = [], hosts = [], users = {};
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
    let timer; try { await Promise.race([record.closed, new Promise((_, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('preset-proof-process-timeout')); }, 20000); })]); }
    finally { clearTimeout(timer); }
    for (const secret of [root, password, key.toString('base64'), signingKey.toString('base64')]) assert(!(record.stdout + record.stderr).includes(secret));
    assert.equal(record.code, 0);
  }
  t.after(async () => { for (const record of children) if (!record.terminal) record.child.kill('SIGKILL'); await Promise.all(children.map(record => record.closed)); await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await createDurableCollaborationService({ directory, keyring, initialize: true, assetPolicyDefaultsEnabled: true });
  const sessions = {};
  for (const role of ['owner', 'coowner', 'editor', 'viewer', 'outsider']) { users[role] = await runtime.identity.createAccount(`${role}@presets.example.test`, password); sessions[role] = await runtime.identity.signIn(users[role].email, password); }
  const context = { accessToken: sessions.owner.accessToken }, team = await runtime.teams.create(context, 'Editing / équipe'), otherTeam = await runtime.teams.create(context, 'Other isolated team');
  for (const role of ['coowner', 'editor', 'viewer']) { const invitation = await runtime.teams.invite(context, team.id, users[role].email, role === 'coowner' ? 'owner' : role); await runtime.members.accept({ accessToken: sessions[role].accessToken }, invitation.token); }
  for (const session of Object.values(sessions)) await runtime.identity.signOut(session.refreshToken); await runtime.close();
  const assets = await createDurableAssetService({ directory: assetDirectory, keyring, authorize: async () => ({ allowed: true }), initialize: true }); await assets.close();
  async function launch(mediaAvailable = true) {
    assert(children.every(record => record.terminal));
    const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); }); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, directory, host: '127.0.0.1', port, tls: { certFile, keyFile }, keyring: { activeKeyId: 'fixture', keys: { fixture: key.toString('base64') } },
      ...(mediaAvailable ? { assets: { directory: assetDirectory, signingKey: signingKey.toString('base64') } } : {}) }), { mode: 0o600 });
    const record = spawnOwned([hostCli, 'serve', '--config', configPath]); hosts.push(record); record.child.stdin.end();
    await new Promise((resolve, reject) => { let interval; const finish = error => { clearTimeout(deadline); clearInterval(interval); error ? reject(error) : resolve(); };
      const deadline = setTimeout(() => finish(Error('preset-proof-host-not-ready')), 10000); interval = setInterval(() => {
        if (record.stdout.includes('"event":"service-ready"')) finish(); else if (record.terminal) finish(Error('preset-proof-host-failed'));
      }, 10); });
    return { origin: `https://127.0.0.1:${port}`, stop: async () => { record.child.kill('SIGTERM'); await terminal(record); } };
  }
  async function client(input) {
    const record = spawnOwned(['-e', clientSource, path.resolve(__dirname, '../src/revision-http-client.js'), path.resolve(__dirname, '../src/asset-http-client.js')], true);
    let timer;
    const result = new Promise((resolve, reject) => { timer = setTimeout(() => { record.child.kill('SIGKILL'); reject(Error('preset-proof-client-timeout')); }, 20000);
      record.child.on('message', message => { if (message.kind === 'done') resolve(message.data); else reject(Error(`preset-proof-${message.code}-line-${message.line}`)); });
      record.child.on('error', reject); record.closed.then(() => { if (record.code !== 0) reject(Error('preset-proof-client-exit')); }); });
    record.child.stdin.end(JSON.stringify({ ...input, teamId: team.id, otherTeamId: otherTeam.id })); let value;
    try { value = await result; } finally { clearTimeout(timer); }
    await terminal(record); assert.equal(record.stdout, ''); return value;
  }
  const first = await launch(), initial = await client({ phase: 1, origin: first.origin, password }); await first.stop();
  const second = await launch(), reopened = await client({ phase: 2, origin: second.origin, sessions: initial.sessions, receipt: initial.receipt }); await second.stop();
  const change = await createDurableCollaborationService({ directory, keyring }); await change.identity.deleteAccount({ accessToken: initial.sessions.viewer.accessToken }, password); await change.close();
  const third = await launch(false), final = await client({ phase: 3, origin: third.origin, sessions: initial.sessions, receipt: reopened.receipt }); await third.stop();
  assert.equal(hosts.length, 3); assert(children.every(record => record.terminal));
  const reopenedStore = await createDurableCollaborationService({ directory, keyring });
  assert.equal((await reopenedStore.getStatus()).schemaVersion, 7);
  assert.deepEqual(await reopenedStore.projects.getInitialAssetPolicy({ accessToken: initial.sessions.owner.accessToken }, initial.receipt.created.projectId),
    { projectId: initial.receipt.created.projectId, version: 1, syncClasses: ['audio', 'proxy'] });
  assert.deepEqual(await reopenedStore.projects.getInitialAssetPolicy({ accessToken: initial.sessions.owner.accessToken }, final.receipt.emptyProject.projectId),
    { projectId: final.receipt.emptyProject.projectId, version: 1, syncClasses: [] }); await reopenedStore.close();
  const bytes = await fs.readFile(path.join(directory, 'collaboration.enc.json'), 'utf8');
  for (const secret of [password, ...Object.values(initial.sessions).flatMap(v => [v.accessToken, v.refreshToken]), key.toString('base64')]) assert(!bytes.includes(secret));
  assert.equal((await fs.stat(path.join(directory, 'collaboration.enc.json'))).mode & 0o777, 0o600);
  t.diagnostic(JSON.stringify({ hostProcesses: 3, clientProcesses: 3, networkRequests: initial.calls + reopened.calls + final.calls,
    exactSaveRetrySurvivedLostAcknowledgment: true, exactCreationRetrySurvivedTemplateChangeAndRestart: true,
    teamOwnerBoundaryVerified: true, actorAndNameBoundPlanVerified: true, projectBranchesCreatedEmptyAtomically: true,
    immutableInitialMediaDefaultsVerified: true, laterAssetPolicyAndTemplateEditsIndependent: true,
    mediaUnavailablePreviewAndCreationGateVerified: true, metadataOnlyPresetWorksWithoutAssetService: true,
    deletedMemberAndRevokedSessionDenied: true, allOwnedProcessesTerminal: true }));
});
