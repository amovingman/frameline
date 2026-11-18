'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { createKeyring } = require('../src/security-controls');
const { createDurableCollaborationService } = require('../src/durable-collaboration-service');
const { runServiceAdmin } = require('../src/service-admin');
const { readAdminRequest, runServiceAdminCli, MAX_ADMIN_REQUEST_BYTES } = require('../src/service-admin-cli');

const ownerEmail = 'owner@disposable.example.test', memberEmail = 'member@disposable.example.test';
const ownerPassword = 'disposable owner password', memberPassword = 'disposable member password';
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-admin-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const key = randomBytes(32), keyring = createKeyring({ fixture: key }, 'fixture'), directory = path.join(parent, 'data');
  const initial = await createDurableCollaborationService({ directory, keyring, initialize: true }); await initial.close();
  const config = { directory, keyring }, filename = path.join(directory, 'collaboration.enc.json');
  const configPath = path.join(parent, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, directory, port: 44321,
    tls: { certFile: path.join(parent, 'cert.pem'), keyFile: path.join(parent, 'key.pem') },
    keyring: { activeKeyId: 'fixture', keys: { fixture: key.toString('base64') } } }), { mode: 0o600 });
  return { config, configPath, filename, parent,
    state: async () => keyring.decrypt(JSON.parse(await fs.readFile(filename, 'utf8')).record),
    run: request => runServiceAdmin({ config, request }) };
}
const createOwner = f => f.run({ action: 'account-create', email: ownerEmail, password: ownerPassword });
const createMember = f => f.run({ action: 'account-create', email: memberEmail, password: memberPassword });
const createProject = f => f.run({ action: 'project-create', email: ownerEmail, password: ownerPassword,
  projectId: 'film', name: 'Film', teamName: 'Film team' });
const addMember = (f, overrides = {}) => f.run({ action: 'member-add', ownerEmail, ownerPassword, memberEmail, memberPassword,
  projectId: 'film', role: 'viewer', ...overrides });
function assertRevoked(state) { assert(state.identity.sessions.length > 0); assert(state.identity.sessions.every(session => session.revokedAt !== null)); }
async function cli(configPath, input, extraArgs = []) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/service-admin-cli.js'), '--config', configPath, ...extraArgs],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  child.stdin.on('error', () => {}); child.stdin.end(input); return done;
}

test('local operator provisions accounts, project and viewer through runtime APIs with no secret result', async t => {
  const f = await fixture(t), owner = await createOwner(f), member = await createMember(f);
  assert.deepEqual(owner, { id: owner.id, email: ownerEmail, status: 'active' });
  const project = await createProject(f); assert.deepEqual(Object.keys(project).sort(), ['projectId', 'teamId', 'name', 'ownerId'].sort());
  assert.equal(project.ownerId, owner.id);
  const added = await addMember(f); assert.deepEqual(added, { projectId: 'film', userId: member.id, role: 'viewer' });
  const state = await f.state(); assert.equal(state.access.projects[0].roles.find(item => item.userId === member.id).role, 'viewer');
  assertRevoked(state);
  const text = JSON.stringify([owner, project, added]);
  for (const secret of [ownerPassword, memberPassword, 'accessToken', 'refreshToken', 'tokenHash', 'digest', '/private/']) assert(!text.includes(secret));
  const bytes = await fs.readFile(f.filename, 'utf8'); assert(!bytes.includes(ownerPassword)); assert(!bytes.includes(ownerEmail));
});

test('invalid action shapes are rejected before any state open or mutation', async t => {
  const f = await fixture(t), before = await fs.readFile(f.filename);
  for (const request of [null, { action: 'unknown' }, { action: 'account-create', email: ownerEmail, password: ownerPassword, token: 'private' },
    { action: 'project-create', email: ownerEmail, password: ownerPassword, projectId: 'film', name: '/private/source', teamName: 'Team' },
    { action: 'member-add', ownerEmail, ownerPassword, memberEmail: ownerEmail, memberPassword, projectId: 'film', role: 'editor' },
    { action: 'member-add', ownerEmail, ownerPassword, memberEmail, memberPassword, projectId: 'film', role: 'owner' }]) {
    await assert.rejects(f.run(request), { code: 'service-admin-input-invalid', message: 'service-admin-input-invalid' });
  }
  assert.deepEqual(await fs.readFile(f.filename), before);
  await assert.rejects(runServiceAdmin({ config: {}, request: { action: 'unknown' } }), { code: 'service-admin-input-invalid' });
});

test('failed second sign-in revokes the owner session and creates no invitation', async t => {
  const f = await fixture(t); await createOwner(f); await createMember(f); await createProject(f);
  await assert.rejects(addMember(f, { memberPassword: 'incorrect disposable password' }), { code: 'credentials-invalid', message: 'credentials-invalid' });
  const state = await f.state(); assertRevoked(state); assert.equal(state.access.invitations.length, 0);
});

test('multi-step project creation exposes the intentional empty-team partial boundary and revokes its session', async t => {
  const f = await fixture(t); await createOwner(f); await createProject(f); const before = await f.state();
  await assert.rejects(createProject(f), { code: 'project-exists' });
  const state = await f.state(); assert.equal(state.access.teams.length, before.access.teams.length + 1);
  assert.equal(Object.keys(state.history.projects).length, 1); assertRevoked(state);
});

test('admin never initializes a missing encrypted store', async t => {
  const f = await fixture(t), directory = path.join(f.parent, 'missing');
  await assert.rejects(runServiceAdmin({ config: { ...f.config, directory }, request: { action: 'account-create', email: ownerEmail, password: ownerPassword } }),
    { code: 'collaboration-storage-unavailable' });
  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});

test('stdin parsing bounds bytes, rejects malformed UTF-8 and requires an exact action', async () => {
  for (const bytes of [Buffer.from('{'), Buffer.from([0x7b, 0xff, 0x7d]), Buffer.alloc(MAX_ADMIN_REQUEST_BYTES + 1, 0x20),
    Buffer.from(JSON.stringify({ action: 'unknown', password: ownerPassword }))]) {
    await assert.rejects(readAdminRequest(Readable.from([bytes])), { code: 'service-admin-input-invalid' });
  }
  const input = { action: 'account-create', email: ownerEmail, password: ownerPassword };
  assert.deepEqual(await readAdminRequest(Readable.from([Buffer.from(JSON.stringify(input))])), input);
});

test('CLI validates stdin before opening config and emits only a fixed safe error code', async () => {
  let stdout = '', stderr = '';
  const result = await runServiceAdminCli({ argv: ['--config', '/private/missing-config.json'], input: Readable.from([Buffer.from('{private password')]),
    output: { write: value => { stdout += value; } }, errorOutput: { write: value => { stderr += value; } } });
  assert.equal(result, 1); assert.equal(stdout, ''); assert.equal(stderr, 'service-admin-input-invalid\n');
});

test('actual CLI accepts secrets only on stdin and returns safe provisioning results', async t => {
  const f = await fixture(t);
  const created = await cli(f.configPath, JSON.stringify({ action: 'account-create', email: ownerEmail, password: ownerPassword }));
  assert.equal(created.code, 0); assert.equal(created.stderr, ''); assert.equal(JSON.parse(created.stdout).email, ownerEmail);
  const made = await cli(f.configPath, JSON.stringify({ action: 'project-create', email: ownerEmail, password: ownerPassword,
    projectId: 'film', name: 'Film', teamName: 'Team' }));
  assert.equal(made.code, 0); assert.equal(made.stderr, ''); assert.equal(JSON.parse(made.stdout).projectId, 'film');
  assert.doesNotMatch(created.stdout + made.stdout, /password|accessToken|refreshToken|Bearer |\/private\//);
  const before = await fs.readFile(f.filename);
  const rejected = await cli(f.configPath, '{}', ['--unexpected', 'non-secret-fixture-value']);
  assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.equal(rejected.stderr, 'service-admin-input-invalid\n');
  assert.deepEqual(await fs.readFile(f.filename), before); assertRevoked(await f.state());
});
