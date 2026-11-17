'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createBoundResolveDiff } = require('../src/resolve-bound-diff');

function readBounded(selected) {
  const filename = path.extname(selected).toLowerCase() === '.fcpxmld'
    ? path.join(selected, 'Info.fcpxml') : selected;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw new Error('invalid-source');
  const bytes = fs.readFileSync(filename);
  if (bytes.length !== stat.size) throw new Error('source-changed');
  return bytes;
}

function compareFiles(beforeSnapshot, beforeExport, afterSnapshot, afterExport, timelineId) {
  return createBoundResolveDiff({ beforeSnapshotBytes: readBounded(beforeSnapshot),
    beforeExportBytes: readBounded(beforeExport),
    afterSnapshotBytes: readBounded(afterSnapshot),
    afterExportBytes: readBounded(afterExport), timelineId });
}

if (require.main === module) {
  try {
    if (process.argv.length !== 7) throw new Error('usage');
    process.stdout.write(`${JSON.stringify(compareFiles(...process.argv.slice(2)), null, 2)}\n`);
  } catch { process.stderr.write('invalid-bound-comparison\n'); process.exitCode = 1; }
}

module.exports = { compareFiles };
