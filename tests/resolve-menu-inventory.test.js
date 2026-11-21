'use strict';
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { renderInventory, prepareInventory, readInventoryResult } = require('../phase-0/prepare-menu-inventory');
const { reference } = require('../phase-0/inspect-resolve-api');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');
const { gunzipSync } = require('node:zlib');
const template = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-menu-inventory.lua'), 'utf8');
const base = fs.readFileSync(path.join(__dirname, '../src/companion/resolve-internal.lua'), 'utf8');
const projectName = 'Frameline Large Scan Proof 20261119 corpus01';
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binding = { probeId: 'c'.repeat(32), resultPath: '/private/tmp/virtual-inventory/result.json', completePath: '/private/tmp/virtual-inventory/complete.txt' };

test('inventory source embeds the existing schema-3 capture without adding editor mutation calls', () => {
  const source = renderInventory(template, base, binding);
  assert(source.includes(base.replace('return { capture_request = capture_request }', 'return {capture=capture, encode=encode}')));
  assert(!source.includes('__BASE_CAPTURE_SOURCE__'));
  assert(!/:(SaveProject|LoadProject|CloseProject|SetName|SetCurrentTimeline|CreateProject)\(/.test(source));
  assert.throws(() => renderInventory(template, base, { ...binding, probeId: 'bad' }));
  assert.throws(() => renderInventory(template, 'return {}', binding));
});

test('vendor Lua full capture verifies two identical represented reads and refuses concurrent changes or failed readback',
  { skip: !fs.existsSync(library) && 'Vendor Lua library unavailable' }, () => {
    const source = renderInventory(template, base, binding);
    const prefix = `local files={};local fusion={};local calls=0;local changing=false;local corrupt=false
      function fusion:OpenFile(name,mode)
        if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]='' end
        local h={offset=1};function h:WriteLine(value)files[name]=value..'\\n';return #value+1 end
        function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name] end
        function h:ReadLine()if self.offset>#files[name] then return nil end;local value=files[name]:sub(self.offset);self.offset=#files[name]+1;if corrupt then return 'bad' end;return value end
        return h end
      local timelines={};for n=1,2 do local timeline={};timelines[n]=timeline
        function timeline:GetUniqueId()return 'timeline-'..n end;function timeline:GetName()return 'Timeline '..n end
        function timeline:GetStartFrame()return 0 end;function timeline:GetTrackCount(kind)return kind=='video' and 1 or 0 end
        function timeline:GetTrackName(kind,index)return 'Video 1' end
        local item={};function item:GetUniqueId()return 'item-'..n end
        function item:GetName()calls=calls+1;if changing and calls>2 then return 'Concurrent edit' end;return 'Clip '..n end
        function item:GetType()return 'video' end;function item:GetStart()return 0 end;function item:GetEnd()return 24 end
        function item:GetSourceStartFrame()return 0 end;function item:GetSourceEndFrame()return 23 end
        function item:GetMediaPoolItem()return nil end;function item:GetLinkedItems()return {} end;function item:GetEffects()return {__flags=0} end
        function timeline:GetItemListInTrack(kind,index)return {item} end
      end
      local project={};function project:GetName()return ${JSON.stringify(projectName)} end
      function project:GetUniqueId()return 'project-id' end;function project:GetTimelineCount()return #timelines end
      function project:GetTimelineByIndex(index)return timelines[index] end
      local manager={};function manager:GetCurrentProject()return project end
      resolve={};function resolve:GetVersionString()return '21.1.2.10' end;function resolve:GetProjectManager()return manager end
      function resolve:Fusion()return fusion end;`;
    const suffix = `print('MOCK_RESULT:'..(files[${JSON.stringify(binding.resultPath)}] or 'absent'));print('MOCK_COMPLETE:'..(files[${JSON.stringify(binding.completePath)}] or 'absent'));`;
    const run = script => runVendorLuaMock(script, {library: library, maxBuffer: 1024 * 1024});
    const good = run(`${prefix}\n${source}\n${source}\n${suffix}`);
    assert.equal(good.status, 0, good.stderr);
    assert(good.stdout.includes(`FRAMELINE_MENU_INVENTORY_OK_V1:${binding.probeId}`));
    assert(good.stdout.includes(`FRAMELINE_MENU_INVENTORY_FAILED_V1:${binding.probeId}`));
    const result = JSON.parse(good.stdout.split('\n').find(row => row.startsWith('MOCK_RESULT:')).slice('MOCK_RESULT:'.length));
    assert.equal(result.snapshot.timelines.length, 2); assert.equal(result.capturePasses, 2);
    assert.equal(result.representedStateUnchangedAcrossReads, true);
    for (const alteration of ['changing=true;', 'corrupt=true;', `function project:GetName()return 'Wrong project' end;`]) {
      const bad = run(`${prefix}\n${alteration}\n${source}\n${suffix}`);
      assert.equal(bad.status, 0, bad.stderr); assert(bad.stdout.includes('MOCK_COMPLETE:absent'));
      assert(bad.stdout.includes(`FRAMELINE_MENU_INVENTORY_FAILED_V1:${binding.probeId}`));
    }
  });

function snapshot() {
  return { schema_version: 3, resolve_version: '21.1.2.10', project_id: 'project-id', project_name: projectName,
    timelines: [{ id: 'timeline-1', name: 'Timeline 1', start_frame: 0, tracks: [{ type: 'video', index: 1, name: 'Video 1' }],
      items: [{ id: 'item-1', track_type: 'video', track_index: 1, type: 'video', name: 'Clip 1', start_frame: 0, end_frame: 24,
        source_start_frame: 0, source_end_frame: 23, media_pool_id: null, linked_item_ids: [], effect_counts: { fusion: 0, ofx: 0, audio: 0 } }] }] };
}

test('host inventory reader derives counts/hashes, tightens private outputs and rejects malformed or incomplete captures', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-menu-inventory-reader-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const probeId = 'd'.repeat(32);
  const record = { schemaVersion: 1, operation: 'prepare-resolve-menu-inventory', probeId, expectedProjectName: projectName, directory,
    preparedPath: path.join(directory, `Frameline Read Only Inventory ${probeId.slice(0,12)}.lua`),
    resultPath: path.join(directory, `inventory-${probeId}.json`), completePath: path.join(directory, `complete-${probeId}.txt`),
    templateSha256: sha(template), baseSourceSha256: sha(base), apiReferenceSha256: 'a'.repeat(64) };
  const source = renderInventory(template, base, record); record.sourceSha256 = sha(source);
  fs.writeFileSync(record.preparedPath, source, { flag: 'wx', mode: 0o600 });
  const preparation = path.join(directory, 'preparation.json');fs.writeFileSync(preparation, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  const output = { schemaVersion: 1, operation: 'resolve-menu-inventory', probeId, readOnly: true, safeToApply: false,
    snapshot: snapshot(), capturePasses: 2, representedStateUnchangedAcrossReads: true, cpuTimeStatus: 'captured', cpuMicros: 1234 };
  fs.writeFileSync(record.resultPath, JSON.stringify(output)+'\n', { flag: 'wx', mode: 0o600 });
  await assert.rejects(readInventoryResult(preparation));
  fs.writeFileSync(record.completePath, `FRAMELINE_MENU_INVENTORY_COMPLETE_V1:${probeId}\n`, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(record.resultPath,0o666);fs.chmodSync(record.completePath,0o666);
  const read = await readInventoryResult(preparation);
  assert.equal(read.summary.itemCount, 1);assert.equal(read.summary.timelineCount,1);assert.equal(read.summary.cpuMicros,1234);
  assert.equal(read.summary.timelines[0].itemTypes.video,1);assert.equal(read.summary.stableTrackIdentityProven,false);
  assert.equal(read.summary.completeEnumerationProven,false);assert.equal(read.summary.completionMarkerVerified,true);
  assert.equal(fs.statSync(record.resultPath).mode&0o777,0o600);
  for (const edit of [o=>{o.probeId='e'.repeat(32);},o=>{o.privatePath='/Users/private';},o=>{o.snapshot.project_name='Other';},
    o=>{o.snapshot.schema_version=4;},o=>{o.cpuTimeStatus='unavailable';},o=>{o.representedStateUnchangedAcrossReads=false;}]) {
    const bad=structuredClone(output);edit(bad);fs.writeFileSync(record.resultPath,JSON.stringify(bad));
    await assert.rejects(readInventoryResult(preparation));
  }
  fs.writeFileSync(record.resultPath,JSON.stringify(output));fs.chmodSync(directory,0o755);
  await assert.rejects(readInventoryResult(preparation),/unsafe-menu-inventory-directory/);fs.chmodSync(directory,0o700);
  const outside=path.join(os.tmpdir(),`frameline-inventory-outside-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(outside,'Unrelated file',{flag:'wx',mode:0o644});fs.chmodSync(outside,0o644);t.after(()=>fs.rmSync(outside,{force:true}));
  fs.unlinkSync(record.resultPath);fs.linkSync(outside,record.resultPath);
  await assert.rejects(readInventoryResult(preparation),/invalid-menu-inventory-file/);
  assert.equal(fs.statSync(outside).mode&0o777,0o644);
  fs.unlinkSync(record.resultPath);fs.writeFileSync(record.resultPath,JSON.stringify(output),{flag:'wx',mode:0o600});
  const altered=source+'\n-- changed source';fs.writeFileSync(record.preparedPath,altered);
  fs.writeFileSync(preparation,JSON.stringify({...record,sourceSha256:sha(altered)}));
  await assert.rejects(readInventoryResult(preparation),/menu-inventory-source-changed/);
});

test('inventory preparation binds the exact SDK and capture source without installing',
  { skip: !fs.existsSync(reference) && 'Installed SDK unavailable; reader tests use isolated fixtures' }, async t => {
    const record = await prepareInventory();t.after(()=>fs.rmSync(record.directory,{recursive:true,force:true}));
    assert.equal(record.installedPath,null);assert.equal(record.baseSourceSha256,sha(base));
    assert.equal(fs.statSync(record.directory).mode&0o777,0o700);
  });

test('pinned native inventory recomputes all 10550 IDs and counts from untouched compressed result bytes', () => {
  const root=path.join(__dirname,'..');
  const observed=JSON.parse(fs.readFileSync(path.join(root,'phase-0/resolve-menu-inventory-live-observation.json')));
  const compressed=fs.readFileSync(path.join(root,observed.resultFile));assert.equal(sha(compressed),observed.compressedSha256);
  const bytes=gunzipSync(compressed,{maxOutputLength:20*1024*1024});assert.equal(bytes.length,observed.uncompressedBytes);
  assert.equal(sha(bytes),observed.resultSha256);
  const envelope=JSON.parse(bytes);validateResolveSnapshot(envelope.snapshot);
  assert.equal(envelope.probeId,observed.probeId);assert.equal(envelope.capturePasses,2);assert.equal(envelope.representedStateUnchangedAcrossReads,true);
  assert.equal(envelope.snapshot.project_id,observed.projectId);assert.equal(envelope.snapshot.resolve_version,'21.1.2.10');
  assert.deepEqual(envelope.snapshot.timelines.map(t=>t.items.length),[50,500,10000]);
  assert.equal(envelope.snapshot.timelines.reduce((n,t)=>n+t.items.length,0),10550);
  for(const [index,timeline]of envelope.snapshot.timelines.entries()){
    assert.equal(new Set(timeline.items.map(item=>item.id)).size,timeline.items.length);
    assert(timeline.items.every(item=>item.type==='video'));assert.equal(timeline.id,observed.timelines[index].id);
    assert.deepEqual(timeline.tracks,observed.timelines[index].tracks);
    assert.equal(new Set(timeline.items.map(item=>item.media_pool_id).filter(Boolean)).size,observed.timelines[index].mediaPoolItemCount);
  }
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  assert.equal(sha(JSON.stringify(canonical(envelope.snapshot))),observed.snapshotCanonicalSha256);
  assert.equal(sha(template),observed.templateSha256);assert.equal(sha(base),observed.baseSourceSha256);
  assert.equal(sha(fs.readFileSync(path.join(root,observed.hostReaderSource))),observed.hostReaderSourceSha256);
  assert.equal(observed.apiReferenceSha256,require('../src/resolve-property-contract.json').referenceSha256);
  assert.equal(observed.projectMutationCalls,0);assert.equal(observed.installedTestScriptRemoved,true);
  assert.equal(observed.completeEnumerationProven,false);assert.equal(observed.stableTrackIdentityProven,false);assert.equal(observed.safeToApply,false);
  assert(observed.cpuTimeScope.includes('other editor threads'));assert.equal(envelope.cpuMicros,observed.cpuMicros);
  const diagnostic=JSON.parse(fs.readFileSync(path.join(root,'phase-0/resolve-menu-inventory-diagnostic-live-observation.json')));
  assert.equal(diagnostic.status,'complete');assert.equal(diagnostic.rawError,null);assert.equal(diagnostic.errorCode,'none');
  assert.equal(diagnostic.snapshotCanonicalSha256,observed.snapshotCanonicalSha256);assert.equal(diagnostic.itemCount,10550);
  assert.equal(diagnostic.installedTestScriptRemoved,true);
  assert.equal(sha(fs.readFileSync(path.join(root,diagnostic.diagnosticGeneratorSource))),diagnostic.diagnosticGeneratorSha256);
  assert(!JSON.stringify(observed).includes('/Users/'));assert(!JSON.stringify(diagnostic).includes('/var/folders/'));
});
