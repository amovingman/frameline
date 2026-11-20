'use strict';
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { scanXml } = require('../src/fcpxml-adapter');
const { readInput } = require('./integration-input');
const catalog = require('./integration-corpus.json');
const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readCorpusEntry(entry, read = readInput) {
  if (!catalog.entries.includes(entry)) throw new Error('unknown-corpus-entry');
  const stored = read(path.join(root, entry.file));
  if (stored.length > 20 * 1024 * 1024 || hash(stored) !== entry.storedSha256) throw new Error('corpus-storage-changed');
  const bytes = entry.compression === 'gzip' ? gunzipSync(stored, { maxOutputLength: 20 * 1024 * 1024 }) : stored;
  if (bytes.length !== entry.sourceBytes || hash(bytes) !== entry.sourceSha256) throw new Error('corpus-source-changed');
  const scan = scanXml(bytes.toString('utf8'));
  if (!same({ clips: scan.clips.length, media: scan.media.length, durationFrames: scan.sequence.durationFrames, warnings: scan.warnings }, entry.expected)) {
    throw new Error('corpus-scan-changed');
  }
  if (!same(entry.editor, catalog.target)) throw new Error('corpus-target-mismatch');
  return { bytes, scan };
}

function inspectCorpus(read = readInput) {
  return { schemaVersion: 1, readOnly: true, safeToApply: false, target: catalog.target,
    releaseSupportRange: catalog.releaseSupportRange, releaseVersionCoverageProven: false,
    entries: catalog.entries.map(entry => {
      readCorpusEntry(entry, read);
      const provenance = read(path.join(root, entry.provenance));
      return { file: entry.file, storedSha256: entry.storedSha256, sourceSha256: entry.sourceSha256,
        sourceBytes: entry.sourceBytes, expected: entry.expected, provenance: entry.provenance,
        provenanceSha256: hash(provenance), editor: entry.editor };
    }),
    limitations: ['These synthetic exports cover one experimental installed build.',
      'A saved project archive is not included for every export; exports are not native restore points.',
      'No release support range is declared; an empty range is not complete coverage.'] };
}

module.exports = { inspectCorpus, readCorpusEntry, catalog };
