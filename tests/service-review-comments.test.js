const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceReviewComments, validateServiceReviewCommentsState, validateServiceReviewAnchor, MAX_COMMENTS } = require('../src/service-review-comments');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { fingerprint } = require('../src/project-api-contracts');
const snapshot = { schema_version: 3, resolve_version: '21.1.2.10', project_id: 'resolve-project', project_name: 'Film',
  timelines: [{ id: 'Timeline 你好:C', name: 'Cut', start_frame: 10, tracks: [{ type: 'video', index: 1, name: 'V1' }],
    items: [{ id: 'Clip 你好:C', track_type: 'video', track_index: 1, type: 'video', name: 'Original', start_frame: 10, end_frame: 50,
      source_start_frame: 0, source_end_frame: 40, media_pool_id: 'media', linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } }] }] };
const anchor = { kind: 'clip', timelineId: snapshot.timelines[0].id, clipId: snapshot.timelines[0].items[0].id };
function fixture(initialState = null) {
  const roles = { owner: 'owner', editor: 'editor', peer: 'editor', viewer: 'viewer' };
  const manifest = createResolveRevisionManifest(snapshot);
  const access = { roleFor: (actor, project) => project === 'server-film' ? roles[actor] : null,
    authorize(actor, {projectId, action}) { const role = this.roleFor(actor, projectId); if (!role || action === 'write' && role === 'viewer') throw Object.assign(new Error('forbidden'), {code:'forbidden'}); } };
  const history = { getRevision(pid, rid) { if (rid !== 'rev') throw Object.assign(new Error('revision-not-found'), {code:'revision-not-found'}); return { manifestId:'manifest' }; }, getManifest: () => ({document:manifest}) };
  const opts = {history,access,paginationKey:'x'.repeat(43),now:()=>1000};
  const comments = createServiceReviewComments({...opts,initialState});
  const input = key => ({projectId:'server-film',revisionId:'rev',anchor,body:'  Check <clip>\n\tkeep this plain text  ',idempotencyKey:key});
  return {comments,roles,manifest,opts,input};
}
test('comments use exact immutable Resolve clip/range anchors and canonical plain text, never service project as Resolve UUID', () => {
  const f = fixture(); const created = f.comments.add('editor',f.input('a'));
  assert.equal(created.authorId,'editor'); assert.equal(created.body,'Check <clip>\n\tkeep this plain text'); assert.equal(created.canResolve,true);
  assert.deepEqual(f.comments.add('editor',f.input('a')),created);
  assert.throws(()=>f.comments.add('editor',{...f.input('a'),body:'Different'}),{code:'comment-idempotency-conflict'});
  assert.throws(()=>f.comments.add('editor',{...f.input('b'),anchor:{...anchor,clipId:'guessed'}}),{code:'comment-anchor-unverified'});
  for (const range of [{startFrame:9,endFrame:30},{startFrame:10,endFrame:51},{startFrame:10,endFrame:10}]) assert.throws(()=>f.comments.add('editor',{...f.input('r'),anchor:{kind:'range',timelineId:anchor.timelineId,...range}}));
  const range = f.comments.add('owner',{...f.input('range'),anchor:{kind:'range',timelineId:anchor.timelineId,startFrame:10,endFrame:50}});
  assert.equal(range.anchor.endFrame,50);
  for (const body of ['\0bad','bad\rline','bad\x7f']) assert.throws(()=>f.comments.add('editor',{...f.input('bad'),body}),{code:'comments-invalid'});
  assert.throws(()=>f.comments.add('editor',{...f.input('extra'),authorId:'owner'}),{code:'comments-invalid'});
  assert.throws(()=>validateServiceReviewAnchor({kind:'clip',get timelineId(){throw Error('must not invoke')},clipId:'clip'}),{code:'comment-anchor-invalid'});
});
test('current membership gates every read/write/replay and only author or owner resolves, including downgraded authors', () => {
  const f=fixture(), first=f.comments.add('editor',f.input('a'));
  assert.equal(f.comments.list('viewer','server-film','rev').items[0].canResolve,false);
  assert.throws(()=>f.comments.add('viewer',f.input('v')),{code:'forbidden'});
  assert.throws(()=>f.comments.resolve('peer',{projectId:'server-film',revisionId:'rev',commentId:first.id}),{code:'forbidden'});
  f.roles.editor='viewer'; const resolved=f.comments.resolve('editor',{projectId:'server-film',revisionId:'rev',commentId:first.id});
  assert.equal(resolved.status,'resolved'); assert.equal(resolved.resolvedBy,'editor');
  assert.deepEqual(f.comments.resolve('owner',{projectId:'server-film',revisionId:'rev',commentId:first.id}),resolved);
  const second=f.comments.add('peer',f.input('peer')); const ownerResolved=f.comments.resolve('owner',{projectId:'server-film',revisionId:'rev',commentId:second.id});
  assert.equal(ownerResolved.resolvedBy,'owner'); assert.equal(ownerResolved.status,'resolved');
  delete f.roles.editor; assert.throws(()=>f.comments.list('editor','server-film','rev'),{code:'forbidden'});
  assert.throws(()=>f.comments.add('editor',f.input('a')),{code:'forbidden'});
});
test('signed append pagination survives identical timestamps and new rows without duplicates and binds recipient/project/revision',()=>{
  const f=fixture(); const created=['a','b','c','d'].map(key=>f.comments.add('editor',f.input(key)));
  const first=f.comments.list('viewer','server-film','rev',{limit:2}); f.comments.add('editor',f.input('new'));
  const restored=createServiceReviewComments({...f.opts,initialState:f.comments.snapshot()});
  const second=restored.list('viewer','server-film','rev',{limit:2,cursor:first.nextCursor});
  assert.deepEqual([...first.items,...second.items].map(item=>item.id),created.reverse().map(item=>item.id)); assert.equal(second.nextCursor,null); assert.equal(second.total,5);
  assert.throws(()=>restored.list('owner','server-film','rev',{cursor:first.nextCursor}),{code:'comment-cursor-invalid'});
  assert.throws(()=>restored.list('viewer','server-film','rev',{cursor:first.nextCursor+'x'}),{code:'comment-cursor-invalid'});
  const publicText=JSON.stringify(first); assert.doesNotMatch(publicText,/keyHash|requestHash|paginationKey|idempotencyKey/);
});
test('strict private state rejects tampered immutable records, duplicate receipts, future schema and unknown fields',()=>{
  const f=fixture(); f.comments.add('editor',f.input('a')); const state=f.comments.snapshot();
  for(const edit of [s=>s.comments[0].body='tamper',s=>s.comments[0].anchor.privatePath='/Users/private',s=>s.idempotency[0].commentId='missing',s=>s.comments[0].resolvedBy='owner',s=>s.version=2,s=>s.extra=true]) {
    const copy=structuredClone(state);edit(copy);assert.throws(()=>validateServiceReviewCommentsState(copy));
  }
  const clone=f.comments.snapshot();clone.comments[0].body='mutation';assert.equal(f.comments.snapshot().comments[0].body,state.comments[0].body);
});
test('bounded capacity rejects new comments atomically while existing idempotent retries remain readable',()=>{
  const f=fixture(); const seed=f.comments.add('editor',f.input('seed')); const state=f.comments.snapshot();
  for(let i=1;i<MAX_COMMENTS;i++){const item={...state.comments[0],id:`comment-${i}`};state.comments.push(item);state.idempotency.push({keyHash:fingerprint({i}),requestHash:fingerprint({projectId:item.projectId,revisionId:item.revisionId,authorId:item.authorId,anchor:item.anchor,body:item.body}),commentId:item.id});}
  const full=createServiceReviewComments({...f.opts,initialState:state});assert.throws(()=>full.add('editor',f.input('overflow')),{code:'comment-capacity'});assert.equal(full.snapshot().comments.length,MAX_COMMENTS);assert.deepEqual(full.add('editor',f.input('seed')),seed);
});
