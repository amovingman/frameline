'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNetworkSyncProof } = require('../scripts/network-sync-proof');
test('two authorized accounts exchange metadata over real HTTP and recover offline work without overwriting a branch race', async () => {
  const receipt = await runNetworkSyncProof();
  assert.equal(receipt.fetchedRevisionCount, 2);
  assert.equal(receipt.concurrentBranchWriterPreserved, true);
  assert.equal(receipt.mediaFetched, false);
});
