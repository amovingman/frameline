'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { exportRenameTrialAudit } = require('../src/resolve-rename-trial');
const { createPortableTrialAuditBundle, validatePortableTrialAuditBundle, MAX_AUDIT_BYTES } = require('../src/resolve-portable-trial-audit');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { importPortableTrialAudit } = require('../src/resolve-audit-history');

async function readBundle(filename) {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_AUDIT_BYTES + 1024) throw new Error('invalid-audit-input');
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('audit-input-changed');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    return validatePortableTrialAuditBundle(value);
  } finally { await handle.close(); }
}
function summary(bundle) {
  return { transactionId: bundle.audit.transactionId, status: bundle.audit.outcome.status,
    choiceCount: bundle.audit.review.choices.length, effectMetadataRecorded: bundle.audit.effects !== null,
    auditHash: bundle.auditHash, nativeBackupIncluded: false, readOnly: true, safeToApply: false };
}
async function writeBundle(filename, bundle) {
  const parent = path.dirname(filename), temporary = path.join(parent, `.frameline-audit-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(bundle)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    // Publish the complete file without replacing an existing destination.
    await fs.link(temporary, filename);
    const directory = await fs.open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}
(async () => {
  const [operation, ...args] = process.argv.slice(2); let result;
  if (operation === 'export' && args.length === 2) {
    const audit = await exportRenameTrialAudit(args[0]);
    if (!audit) throw new Error('reviewed-trial-required');
    const bundle = createPortableTrialAuditBundle(audit);
    await writeBundle(args[1], bundle);
    result = summary(bundle);
  } else if (operation === 'verify' && args.length === 1) result = summary(await readBundle(args[0]));
  else if (operation === 'import' && args.length === 2 && path.isAbsolute(args[0])) {
    result = await importPortableTrialAudit(createLocalMetadataStore(args[0]), await readBundle(args[1]));
  } else throw new Error('usage');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
})().catch(() => { process.stderr.write('portable-resolve-audit-failed\n'); process.exitCode = 1; });
