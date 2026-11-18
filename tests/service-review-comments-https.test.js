'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { createRevisionHttpHandler } = require('../src/revision-http-transport');
const { createResolveObservationManifest } = require('../src/resolve-revision-manifest');

const tls = path.join(__dirname, 'fixtures/network-tls');
const clientScript = String.raw`
  const assert = require('node:assert/strict');
  const { createRevisionHttpClient } = require(process.argv[1]);
  let bytes=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',v=>bytes+=v);
  process.stdin.on('end',async()=>{try {
    const input=JSON.parse(bytes), {origin,tokens,phase}=input;
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
    const client=token=>createRevisionHttpClient({origin,getAccessToken:()=>token});
    const owner=client(tokens.owner),editor=client(tokens.editor),viewer=client(tokens.viewer),outsider=client(tokens.outsider);
    const pid='review-film', other='review-other';
    if(phase===1) {
      const manifest=await owner.putManifest(pid,input.manifest);
      const revision=await owner.createRevision({projectId:pid,manifestId:manifest.id,message:'Immutable comment fixture',sourceRevisionId:'review-local',idempotencyKey:'review-root'});
      const secondManifest=await owner.putManifest(other,input.manifest);
      const second=await owner.createRevision({projectId:other,manifestId:secondManifest.id,message:'Other exact scope',sourceRevisionId:'review-other-local',idempotencyKey:'review-other-root'});
      const timeline=input.manifest.observation.snapshot.timelines[0],clip=timeline.items[0];
      const anchor={kind:'clip',timelineId:timeline.id,clipId:clip.id};
      const body='<b>Review "夜"</b>\n\tKeep this as plain text.';
      const add={projectId:pid,revisionId:revision.id,anchor,body,idempotencyKey:'lost-comment-ack'};
      let dropped=false;
      const lossy=createRevisionHttpClient({origin,getAccessToken:()=>tokens.editor,fetch:async(url,options)=>{
        const response=await fetch(url,options);
        if(!dropped&&options.method==='POST'&&new URL(url).pathname.endsWith('/comments')&&response.ok){dropped=true;await response.arrayBuffer();throw new Error('Discard acknowledged fixture response');}
        return response;
      }});
      await assert.rejects(lossy.addReviewComment(add),{code:'sync-network-unavailable'});
      const comment=await editor.addReviewComment(add); assert.equal(comment.authorId,input.ids.editor);assert.equal(comment.body,body);
      assert.equal((await owner.listReviewComments(pid,revision.id)).total,1);
      assert.deepEqual(await editor.addReviewComment(add),comment);
      await assert.rejects(editor.addReviewComment({...add,body:'Changed retry'}),{code:'comment-idempotency-conflict'});
      await assert.rejects(viewer.addReviewComment({...add,idempotencyKey:'viewer-denied'}),{code:'forbidden'});
      await assert.rejects(outsider.listReviewComments(pid,revision.id),{code:'forbidden'});
      await assert.rejects(editor.addReviewComment({...add,anchor:{...anchor,clipId:'not-present'},idempotencyKey:'bad-clip'}),{code:'comment-anchor-unverified'});
      await assert.rejects(editor.addReviewComment({...add,anchor:{kind:'range',timelineId:timeline.id,startFrame:timeline.start_frame,endFrame:999999999},idempotencyKey:'bad-range'}),{code:'comment-anchor-unverified'});
      const range={kind:'range',timelineId:timeline.id,startFrame:clip.start_frame,endFrame:clip.end_frame};
      const owned=await owner.addReviewComment({projectId:pid,revisionId:revision.id,anchor:range,body:'Owner range note',idempotencyKey:'owner-range'});
      await assert.rejects(editor.resolveReviewComment(pid,revision.id,owned.id),{code:'forbidden'});
      await assert.rejects(viewer.resolveReviewComment(pid,revision.id,owned.id),{code:'forbidden'});
      await assert.rejects(owner.resolveReviewComment(other,second.id,comment.id),{code:'comment-not-found'});
      const first=await viewer.listReviewComments(pid,revision.id,{limit:1});assert(first.nextCursor);assert.equal(first.items.length,1);
      const extra=await owner.addReviewComment({projectId:pid,revisionId:revision.id,anchor,body:'Appended after page anchor',idempotencyKey:'owner-extra'});
      const continuation=await viewer.listReviewComments(pid,revision.id,{limit:1,cursor:first.nextCursor});
      assert.equal(continuation.items.length,1);assert.notEqual(continuation.items[0].id,extra.id);assert.notEqual(continuation.items[0].id,first.items[0].id);
      await assert.rejects(owner.listReviewComments(pid,revision.id,{limit:1,cursor:first.nextCursor}),{code:'comment-cursor-invalid'});
      await assert.rejects(viewer.listReviewComments(other,second.id,{limit:1,cursor:first.nextCursor}),{code:'comment-cursor-invalid'});
      const resolved=await owner.resolveReviewComment(pid,revision.id,owned.id);assert.equal(resolved.status,'resolved');
      assert.deepEqual(await owner.resolveReviewComment(pid,revision.id,owned.id),resolved);
      const unsupported=await owner.putManifest(pid,{schemaVersion:2,adapter:'fcpxml',readOnly:true,identityStatus:'unresolved',sourceHash:'a'.repeat(64),
        sequence:{name:'Unsupported comment fixture',frameDuration:'1/24s',durationFrames:0},clips:[],media:[],warnings:[]});
      const unsupportedRevision=await owner.createRevision({projectId:pid,manifestId:unsupported.id,message:'No stable comment anchors',sourceRevisionId:'xml-source',idempotencyKey:'xml-root'});
      await assert.rejects(editor.addReviewComment({...add,revisionId:unsupportedRevision.id,idempotencyKey:'unsupported-denied'}),{code:'comment-revision-unsupported'});
      process.stdout.write(JSON.stringify({revisionId:revision.id,commentId:comment.id,ownerCommentId:owned.id,total:3,lostAckRetriedOnce:true,plainTextPreserved:true,paginationScoped:true}));
    } else if(phase===2) {
      const page=await viewer.listReviewComments(pid,input.receipt.revisionId);assert.equal(page.total,3);assert.equal(page.openCount,2);
      const own=page.items.find(v=>v.id===input.receipt.commentId);assert.equal(own.body,'<b>Review "夜"</b>\n\tKeep this as plain text.');
      const authorPage=await editor.listReviewComments(pid,input.receipt.revisionId);
      assert.equal(authorPage.items.find(v=>v.id===own.id).canResolve,true);
      await assert.rejects(editor.addReviewComment({projectId:pid,revisionId:input.receipt.revisionId,anchor:own.anchor,body:'Demoted',idempotencyKey:'demoted-denied'}),{code:'forbidden'});
      const resolved=await editor.resolveReviewComment(pid,input.receipt.revisionId,own.id);assert.equal(resolved.status,'resolved');assert.equal(resolved.resolvedBy,input.ids.editor);
      assert.deepEqual(await editor.resolveReviewComment(pid,input.receipt.revisionId,own.id),resolved);
      process.stdout.write(JSON.stringify({restartPreserved:true,downgradedAuthorResolved:true,total:3}));
    } else {
      const page=await owner.listReviewComments(pid,input.receipt.revisionId);assert.equal(page.total,3);assert.equal(page.openCount,1);
      assert.equal(page.items.filter(v=>v.status==='resolved').length,2);
      await assert.rejects(viewer.listReviewComments(pid,input.receipt.revisionId),{code:'forbidden'});
      await assert.rejects(editor.listReviewComments(pid,input.receipt.revisionId),{code:'access-token-invalid'});
      await assert.rejects(outsider.listReviewComments(pid,input.receipt.revisionId),{code:'forbidden'});
      process.stdout.write(JSON.stringify({restartPreserved:true,removedMemberDenied:true,revokedSessionDenied:true,total:3,openCount:1}));
    }
  } catch(error) {process.stderr.write(String(error.code||'comment-proof-failed'));process.exitCode=1;}});
`;

function runClient(input) {
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tls, 'ca.pem') };
  for (const key of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', clientScript, path.resolve(__dirname, '../src/revision-http-client.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), 20000); let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { error += value; });
    child.on('error', reject); child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`comment-proof-client-failed:${error}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('comment-proof-receipt-invalid')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}

test('real HTTPS revision comments survive durable reopen with exact retry, scoped pages and current permissions', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'review-comments-https-'));
  const keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture'), runtimes = [], servers = [];
  let requests = 0;
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const open = async initialize => {
    const runtime = await createDurableCollaborationService({ directory, keyring, initialize }); runtimes.push(runtime);
    const handler = createRevisionHttpHandler({ service: runtime.service, identity: runtime.identity, listProjects: runtime.projects.list });
    const server = https.createServer({ cert: syncFs.readFileSync(path.join(tls, 'server.pem')), key: syncFs.readFileSync(path.join(tls, 'server-key.pem')) }, (req, res) => { requests++; return handler(req, res); });
    server.headersTimeout = 5000; server.requestTimeout = 10000; servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { runtime, origin: `https://127.0.0.1:${server.address().port}`, close: async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await runtime.close();
    } };
  };
  const first = await open(true), password = 'Disposable HTTPS review password', ids = {}, sessions = {};
  for (const role of ['owner', 'editor', 'viewer', 'outsider']) {
    ids[role] = (await first.runtime.identity.createAccount(`${role}@review.example.test`, password)).id;
    sessions[role] = await first.runtime.identity.signIn(`${role}@review.example.test`, password);
  }
  const context = role => ({ accessToken: sessions[role].accessToken, requestId: 'review-proof' });
  const team = await first.runtime.teams.create(context('owner'), 'Disposable reviewers');
  for (const projectId of ['review-film', 'review-other']) {
    await first.runtime.projects.create(context('owner'), { projectId, name: projectId, teamId: team.id, idempotencyKey: `${projectId}-create` });
    for (const role of ['editor', 'viewer']) {
      const invitation = await first.runtime.members.invite(context('owner'), projectId, `${role}@review.example.test`, role);
      await first.runtime.members.accept(context(role), invitation.token);
    }
  }
  const observation = JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json'), 'utf8'));
  const manifest = createResolveObservationManifest(observation);
  const input = { tokens: Object.fromEntries(Object.entries(sessions).map(([role, value]) => [role, value.accessToken])), ids };
  const receipt = await runClient({ ...input, origin: first.origin, phase: 1, manifest });
  assert.equal(receipt.lostAckRetriedOnce, true); assert.equal(receipt.plainTextPreserved, true); assert.equal(receipt.paginationScoped, true);
  await first.runtime.members.setRole(context('owner'), 'review-film', ids.editor, 'viewer');
  await first.close();
  const second = await open(false), restored = await runClient({ ...input, origin: second.origin, phase: 2, receipt });
  assert.equal(restored.downgradedAuthorResolved, true);
  await second.runtime.members.remove(context('owner'), 'review-film', ids.viewer);
  await second.runtime.identity.signOut(sessions.editor.refreshToken); await second.close();
  const third = await open(false), revoked = await runClient({ ...input, origin: third.origin, phase: 3, receipt });
  assert.equal(revoked.removedMemberDenied, true); assert.equal(revoked.revokedSessionDenied, true);
  assert.equal(requests, 36); assert.equal((await fs.stat(path.join(directory, 'collaboration.enc.json'))).mode & 0o777, 0o600);
});
