'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const ARCHIVE = 'phase-0/evidence-sources/local-metadata-schema4.json.gz';
const ARCHIVE_SHA = '4b3183fe0be7a2f333cb7a658ce07c71128794ed21935e85286f0e1c2669ff80';
const COMMIT = '71219f13e7b94c916b07ef400591b5fca9968171';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (value, code) => { if (!value) throw Error('local-migration-' + code); };
const canonical = value => JSON.stringify(value, (_key, item) => item && Object.getPrototypeOf(item) === Object.prototype
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function within(root, name) {
  need(typeof name === 'string' && name && !path.isAbsolute(name) && path.normalize(name) === name
    && !name.split(path.sep).includes('..'), 'relative-path');
  return path.join(root, name);
}
async function read(file, limit = 32 * 1024 * 1024) {
  need(await fs.realpath(file) === file, 'file-alias');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    need(before.isFile() && before.nlink === 1n && Number(before.uid) === process.getuid()
      && !(Number(before.mode) & 0o077) && before.size > 0n && before.size <= BigInt(limit), 'private-file');
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await fs.lstat(file, { bigint: true });
    need(bytes.length === Number(before.size) && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].every(key => before[key] === after[key] && before[key] === named[key]), 'file-changed');
    return bytes;
  } finally { await handle.close(); }
}
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
async function archive(root = ROOT) {
  const bytes = await fs.readFile(path.join(root, ARCHIVE)); need(sha(bytes) === ARCHIVE_SHA, 'historical-archive');
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 1024 * 1024 }));
  need(value.schemaVersion === 1 && value.commit === COMMIT && value.entry === 'src/local-metadata.js'
    && value.maximumSchema === 4 && Object.keys(value.files).length === 9, 'historical-reader');
  for (const [name, file] of Object.entries(value.files)) {
    within(root, name); need(name.startsWith('src/') && name.endsWith('.js') && sha(Buffer.from(file.bytesBase64, 'base64')) === file.sha256, 'historical-source');
  }
  return value;
}
async function extract(root, target) {
  const value = await archive(root);
  for (const [name, file] of Object.entries(value.files)) await write(within(target, name), Buffer.from(file.bytesBase64, 'base64'));
  return value;
}
async function tree(directory, prefix = '') {
  const stat = await fs.lstat(directory);
  need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077)
    && await fs.realpath(directory) === directory, 'private-directory');
  const files = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const filename = path.join(directory, name), relative = prefix + name, entry = await fs.lstat(filename);
    if (entry.isDirectory()) Object.assign(files, await tree(filename, relative + '/'));
    else files[relative] = sha(await read(filename));
  }
  return files;
}
async function canonicalTree(directory) {
  const files = await tree(directory);
  return Object.fromEntries(Object.entries(files).filter(([name]) => name === 'metadata.json' || name === 'metadata.json.bak' || name.startsWith('revisions/')));
}
async function copy(source, destination) {
  await fs.mkdir(destination, { mode: 0o700 });
  for (const name of Object.keys(await tree(source))) await write(within(destination, name), await read(within(source, name)));
}
async function metadata(directory) { return JSON.parse(await read(path.join(directory, 'metadata.json'))); }
async function graph(directory) {
  const index = await metadata(directory), projects = [];
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  need([4, 5].includes(index.schemaVersion) && index.projects && Object.getPrototypeOf(index.projects) === Object.prototype
    && Object.keys(index.projects).length <= 100 && Object.keys(index.projects).every(key => /^[a-f0-9]{64}$/.test(key)), 'metadata-shape');
  for (const project of Object.values(index.projects)) {
    need(project && uuid(project.id) && Array.isArray(project.revisions) && project.revisions.length <= 1000
      && project.revisions.every(record => record && uuid(record.id) && record.projectId === project.id
        && (record.parentRevisionId === null || uuid(record.parentRevisionId))), 'record-path');
    const records = [];
    for (const summary of project.revisions || []) {
      const bytes = await read(path.join(directory, 'revisions', project.id, summary.id + '.json'));
      require('../src/revision-transfer').verifyRecord(summary, bytes.toString('utf8'));
      records.push({ id: summary.id, hash: sha(bytes) });
    }
    const bundle = { format: 'frameline-revisions', version: project.sourceKind === 'resolve-api' ? 2 : 1,
      projectId: project.id, branches: project.branches, records: (project.revisions || []).map((summary, i) => ({ summary,
        bytes: null, index: i })) };
    for (const record of bundle.records) { record.bytes = (await read(path.join(directory, 'revisions', project.id, record.summary.id + '.json'))).toString('utf8'); delete record.index; }
    require('../src/revision-transfer').validateTransferBundle(bundle);
    projects.push({ id: project.id, currentBranch: project.currentBranch, branches: project.branches,
      syncBases: project.syncBases, records, bundleSha256: sha(canonical(bundle)) });
  }
  return { schemaVersion: index.schemaVersion, projects };
}
const SOURCES = ['src/local-metadata.js', 'src/metadata-lock.js', 'src/revision-transfer.js', 'src/revision-manifest.js',
  'src/scan-manifest.js', 'src/fcpxml-adapter.js', 'src/fcpxml-scan-core.js', 'src/fcpxml-scan-controller.js',
  'src/fcpxml-scan-worker.js', 'scripts/local-migration-common.cjs', 'scripts/verify-local-migrations.cjs', 'scripts/audit-local-migrations.cjs'];
async function codeHashes(root = ROOT) {
  const sources = new Set(SOURCES);
  async function visit(file) {
    const bytes = await fs.readFile(within(root, file));
    for (const match of bytes.toString('utf8').matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let name = path.normalize(path.join(path.dirname(file), match[1]));
      if (!path.extname(name)) name += '.js';
      need(name.startsWith('src/') || name.startsWith('scripts/'), 'source-dependency');
      if (!sources.has(name)) { sources.add(name); await visit(name); }
    }
  }
  await visit('src/local-metadata.js'); await visit('src/revision-transfer.js');
  for (const name of Object.keys((await archive(root)).files)) if (!sources.has(name)) { sources.add(name); await visit(name); }
  return Object.fromEntries(await Promise.all([...sources].sort().map(async file => [file, sha(await fs.readFile(within(root, file)))])));
}
module.exports = { ROOT, ARCHIVE, ARCHIVE_SHA, COMMIT, SOURCES, sha, need, canonical, within, read, write, archive, extract, tree, canonicalTree, copy, metadata, graph, codeHashes };
