const test = require('node:test');
const assert = require('node:assert/strict');
const { assessRelease, canOpenData, compareVersions } = require('../src/release-policy');
const { beginUpdate, advanceUpdate } = require('../src/update-recovery-policy');

test('release channels require increasing versions, notes, and an explicit data range', () => {
  const release = assessRelease({ currentVersion: '0.1.0', nextVersion: '0.2.0', channel: 'experimental',
    minimumDataSchema: 4, maximumDataSchema: 4, changeNotes: ['Read-only scan fixes'] });
  assert.equal(release.installerVerificationRequired, true);
  assert.equal(canOpenData(release, 4), true);
  assert.equal(canOpenData(release, 5), false);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.throws(() => assessRelease({ currentVersion: '0.2.0', nextVersion: '0.1.9', channel: 'stable',
    minimumDataSchema: 4, maximumDataSchema: 4, changeNotes: ['Older'] }), { code: 'release-downgrade-blocked' });
  assert.throws(() => assessRelease({ currentVersion: '0.1.0', nextVersion: '0.2.0', channel: 'stable',
    minimumDataSchema: 4, maximumDataSchema: 4, changeNotes: [] }), { code: 'release-notes-required' });
});

test('interrupted staging is discarded and interrupted activation requires rollback', () => {
  const plan = beginUpdate({ currentVersion: '0.1.0', targetVersion: '0.2.0',
    currentDataSchema: 4, targetCanOpenCurrentData: true });
  assert.equal(advanceUpdate(plan, 'interrupt').phase, 'discard-staging');
  const activated = advanceUpdate(advanceUpdate(plan, 'artifact-verified'), 'activate');
  assert.equal(activated.phase, 'health-check');
  const recovery = advanceUpdate(activated, 'interrupt');
  assert.equal(recovery.phase, 'rollback-required');
  assert.equal(advanceUpdate(recovery, 'restored').phase, 'rolled-back');
  assert.equal(advanceUpdate(activated, 'healthy').phase, 'complete');
  assert.throws(() => advanceUpdate(activated, 'activate'), { code: 'update-transition-invalid' });
  assert.throws(() => beginUpdate({ currentVersion: '0.2.0', targetVersion: '0.1.0',
    currentDataSchema: 4, targetCanOpenCurrentData: true }), { code: 'update-downgrade-blocked' });
  assert.throws(() => beginUpdate({ currentVersion: '0.1.0', targetVersion: '0.2.0',
    currentDataSchema: 4, targetCanOpenCurrentData: false }), { code: 'update-data-incompatible' });
});
