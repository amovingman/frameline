'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { inspectReviewCopyMedia, verifyReviewCopyMediaPreserved, auditReviewCopyMedia } = require('../src/resolve-review-copy-media');
const projectId = '00000000-0000-4000-8000-000000000001', itemId = '00000000-0000-4000-8000-000000000002', mediaId = '00000000-0000-4000-8000-000000000003';
const text = value => ({ type: 'text', base64: Buffer.from(value).toString('base64') });
function fixture() {
 const table = (name, columns, rows) => ({ name, columns, primaryKeyColumns: [{ name: columns[0] }], rows: rows.map(cells => ({ primaryKey: [cells[0]], cells })) });
 return { operation: 'native-sqlite-all-cell-census', allPersistentTablesCovered: true, allSchemaObjectsCovered: true, integrityCheck: 'ok', excludedApplicationColumns: [], projectContext: { projectId }, snapshot: { sha256: 'a'.repeat(64) }, tables: [
 table('Sm2TiItem', ['Sm2TiItem_id', 'DbType', 'Name', 'MediaRef', 'MediaFilePath'], [[text(itemId), text('Sm2TiVideoClip'), text('Original'), text(mediaId), text('/private/tmp/media.mov')]]),
 table('Sm2MpMedia', ['Sm2MpMedia_id', 'FieldsBlob'], [[text(mediaId), { type: 'blob', base64: 'AP8=' }]]),
 table('BtVideoInfo', ['BtVideoInfo_id', 'Clip', 'Proxy'], [[text('00000000-0000-4000-8000-000000000004'), { type: 'blob', base64: 'AP8=' }, { type: 'blob', base64: 'AP8=' }]]),
 table('BtAudioInfo', ['BtAudioInfo_id', 'Clip'], []) ] };
}
test('unchanged typed references and opaque media survive a separate Name edit without a media-coverage claim', () => {
 const source = fixture(), copy = structuredClone(source); copy.snapshot.sha256 = 'b'.repeat(64); copy.tables[0].rows[0].cells[2] = text('Reviewed');
 const proof = verifyReviewCopyMediaPreserved(source, copy); assert.equal(proof.verified, true); assert.equal(proof.completeMediaEnumeration, false); assert.equal(proof.opaqueNativeMediaCells, 3); assert.equal(proof.mediaCollected, false);
 copy.tables[2].rows[0].cells[2].base64 = 'AP4='; assert.throws(() => verifyReviewCopyMediaPreserved(source, copy), /references-changed/);
});
test('changing a path or media FK refuses; missing referenced UUID, duplicate item and malformed UTF8 refuse', () => {
 for (const change of [c => c.tables[0].rows[0].cells[4] = text('/other.mov'), c => c.tables[0].rows[0].cells[3] = text(projectId)]) { const source = fixture(), changed = fixture(); change(changed); assert.throws(() => verifyReviewCopyMediaPreserved(source, changed)); }
 const duplicate = fixture(); duplicate.tables[0].rows.push(structuredClone(duplicate.tables[0].rows[0])); assert.throws(() => inspectReviewCopyMedia(duplicate), /item-identity/);
 const invalid = fixture(); invalid.tables[0].rows[0].cells[4] = { type: 'text', base64: '/w==' }; assert.throws(() => inspectReviewCopyMedia(invalid), /invalid-text/);
});
test('observed availability is path-free and never establishes portable or complete media readiness', async () => {
 const calls = [], source = fixture();
 const report = await auditReviewCopyMedia(source, { stat: async filename => { calls.push(filename); return { isFile: () => true }; } });
 assert.deepEqual(calls, ['/private/tmp/media.mov']); assert.equal(report.status, 'observed-references-available'); assert.equal(report.completeMediaEnumeration, false); assert.equal(report.counts.available, 1); assert.equal(report.collectionAction, 'collect-in-resolve-and-recapture'); assert.equal(JSON.stringify(report).includes('/private/'), false);
 const missing = await auditReviewCopyMedia(source, { stat: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } }); assert.equal(missing.status, 'observed-media-missing'); assert.match(missing.message, /Collect or relink media in Resolve/);
});
test('relative, null and invalid references remain unknown and are never probed or resolved against the copy directory', async () => {
 for (const value of [text('relative.mov'), { type: 'null' }, text('')]) { const source = fixture(); source.tables[0].rows[0].cells[4] = value; const report = await auditReviewCopyMedia(source, { stat: () => { throw Error('must not probe'); } }); assert.equal(report.counts.unknown, 1); }
});
test('partial census, missing native media table, changed project and cancellation refuse', async () => {
 const partial = fixture(); partial.allPersistentTablesCovered = false; assert.throws(() => inspectReviewCopyMedia(partial));
 const absent = fixture(); absent.tables.pop(); assert.throws(() => inspectReviewCopyMedia(absent));
 const other = fixture(); other.projectContext.projectId = itemId; assert.throws(() => verifyReviewCopyMediaPreserved(fixture(), other));
 await assert.rejects(auditReviewCopyMedia(fixture(), { signal: { aborted: true } }), /cancelled/);
});
test('host policy binds source and destination while availability is a fresh report rather than readiness authority', async () => {
 const source = fixture(), plan = { operation: 'closed-project-name-apply-plan', mediaPolicy: 'unchanged-references', projectId, projectName: 'Fixture', source: { sha256: source.snapshot.sha256 } }, options = { plan, sourcePath: '/local/Project.db', sourceBinding: { sourcePath: '/local/Project.db', projectName: 'Fixture' }, censusBytes: Buffer.from(JSON.stringify(source)), destinationLibraryRoot: '/review/library' };
 const make = require('../src/resolve-review-copy-media').createReviewCopyMediaPolicy;
 const present = await make({ stat: async () => ({ isFile: () => true }) })(options), missing = await make({ stat: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); } })(options);
 assert.equal(present.bindingSha256, missing.bindingSha256); assert.notEqual(present.mediaReadiness, missing.mediaReadiness); assert.equal(missing.preservesExistingAvailabilityConditionOnly, true); assert.equal(missing.portableCopyVerified, false);
 const moved = await make({ stat: async () => ({ isFile: () => true }) })({ ...options, destinationLibraryRoot: '/other/library' }); assert.notEqual(present.bindingSha256, moved.bindingSha256);
 await assert.rejects(make()( { ...options, plan: { ...plan, source: { sha256: 'b'.repeat(64) } } } ), /source-binding-changed/);
});
