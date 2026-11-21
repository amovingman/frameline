'use strict';
const path=require('node:path');
const {gunzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const {readInput}=require('./integration-input');
const {parseItemStateObservation,describeItemStateCoverage,compareItemStateReadings}=require('../src/resolve-item-state-observation');
const {auditItemEnabledEvidence}=require('./item-enabled-evidence');
const {parseEffectObservation}=require('../src/resolve-effect-observation');
const {validateDiagnostic}=require('./prepare-item-state-diagnostic');
const root=path.resolve(__dirname,'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(name=>[name,canonical(value[name])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const known={ordered:'1d051df28bb9b2260e24c48847710ea07958ef5c74a9b54b28736d7554f0772f',diagnostic:'676a1a6eefeb2f9dcb6a7ddb0e978331d81ec51c28e10304a1948e8a037c2626',rich:'e171ed4dd9ff1d346a80c0e566d810a947ec360292036d7e3fca0403e2d0f1af'};
function auditItemStateEvidence(read=readInput){
  const record=JSON.parse(read(path.join(root,'phase-0/item-state-evidence/receipt.json')));
  if(record.schemaVersion!==1||record.safeToApply!==false||record.readOnly!==false||record.readOnlyCaptureMutationApiCalls!==0||record.projectId!=='dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff'||record.failedAttempts.length!==2)throw new Error('invalid-item-state-evidence');
  function decode(entry,name,digest){if(entry.file!==`phase-0/item-state-evidence/${name}`)throw new Error('invalid-item-state-evidence-file');const stored=read(path.join(root,entry.file));if(sha(stored)!==entry.compressedSha256)throw new Error('item-state-evidence-compressed-changed');const raw=gunzipSync(stored,{maxOutputLength:2*1024*1024});if(raw.length!==entry.bytes||sha(raw)!==entry.sha256||entry.sha256!==digest)throw new Error('item-state-evidence-changed');return raw;}
  const ordered=parseItemStateObservation(decode(record.orderedBaseline,'ordered-baseline.json.gz',known.ordered));
  const rich=parseEffectObservation(decode(record.richBaseline,'baseline-rich.json.gz',known.rich));
  const diagnostic=validateDiagnostic(JSON.parse(decode(record.diagnostic,'divergent-diagnostic.json.gz',known.diagnostic)),record.diagnostic.requestId);
  const differences=compareItemStateReadings(diagnostic.first,diagnostic.second),coverage=describeItemStateCoverage(ordered);
  if(ordered.items.length!==50||!same(ordered.snapshot,rich.snapshot)||!same(diagnostic.richBefore,rich)||!same(diagnostic.richAfter,rich)
    ||differences.snapshotChanges.length||differences.capturePageChange!==null||differences.activeTimelineChange!==null||differences.itemStateChanges.length!==98)throw new Error('item-state-evidence-mismatch');
  const byField=Object.fromEntries(['outputBlanking','usesTimelineOutputBlanking'].map(field=>[field,differences.itemStateChanges.filter(change=>change.field===field).length]));
  if(byField.outputBlanking!==49||byField.usesTimelineOutputBlanking!==49||!same(byField,record.diagnostic.differencesByField)||!same(coverage,record.orderedBaseline.coverage))throw new Error('item-state-evidence-mismatch');
  const sourceKeys=['src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/companion/resolve-item-state.lua','phase-0/resolve-item-state-menu.lua'].sort().join(',');
  if(Object.keys(record.orderedBaseline.sourceHashes).sort().join(',')!==sourceKeys)throw new Error('item-state-source-evidence-changed');
  for(const [file,digest]of Object.entries(record.orderedBaseline.sourceHashes)){if(sha(read(path.join(root,file)))!==digest)throw new Error('item-state-source-evidence-changed');}
  for(const attempt of record.failedAttempts){
    const expected=`phase-0/item-state-evidence/${attempt.label}-failure.json`;if(!['initial','page-aware'].includes(attempt.label)||attempt.file!==expected)throw new Error('invalid-item-state-failure-evidence');
    const raw=read(path.join(root,attempt.file));if(raw.length>4096||sha(raw)!==attempt.sha256||!same(JSON.parse(raw),attempt.result)||attempt.result.safeToApply!==false||attempt.result.stage!=='capture')throw new Error('item-state-failure-evidence-changed');
    if(Object.keys(attempt.sourceHashes).sort().join(',')!==sourceKeys)throw new Error('item-state-history-source-changed');
    for(const [file,digest]of Object.entries(attempt.sourceHashes)){const allowed={
      'src/companion/resolve-internal.lua':'src/companion/resolve-internal.lua','src/companion/resolve-effects.lua':'src/companion/resolve-effects.lua',
      'src/companion/resolve-item-state.lua':attempt.label==='initial'?'phase-0/item-state-history/initial-before-page-guard.lua':'phase-0/item-state-history/page-aware-before-order.lua',
      'phase-0/resolve-item-state-menu.lua':attempt.label==='initial'?'phase-0/item-state-history/initial-menu-template.lua':'phase-0/resolve-item-state-menu.lua'};
      if(attempt.sourceBindings[file]!==allowed[file]||!allowed[file]||sha(read(path.join(root,allowed[file])))!==digest)throw new Error('item-state-history-source-changed');
    }
  }
  if(sha(read(path.join(root,'phase-0/item-state-history/page-aware-before-order.lua')))!==record.diagnostic.legacyItemStateSourceSha256)throw new Error('item-state-diagnostic-source-changed');
  return{schemaVersion:1,readOnly:true,safeToApply:false,projectId:record.projectId,failedCaptureCount:2,diagnosticAcceptedAsStable:false,
    diagnosticChanges:98,diagnosticChangesByField:byField,richBeforeAfterMatchesBaseline:true,orderedCaptureAccepted:true,
    orderedSourceSha256:known.ordered,coverage,enabledProof:auditItemEnabledEvidence(read),completeEditorStateObserved:false,losslessRoundTripProven:false,
    limitation:'This verifies an observed read recipe and typed field coverage, not opaque native preservation or ordinary apply.'};
}
if(require.main===module){try{process.stdout.write(JSON.stringify(auditItemStateEvidence(),null,2)+'\n');}catch{process.stderr.write('item-state-evidence-failed\n');process.exitCode=1;}}
module.exports={auditItemStateEvidence};
