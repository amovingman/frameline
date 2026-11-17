function fail(code) { const error = new Error(code); error.code = code; return error; }

function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw fail('release-version-invalid');
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw fail('release-version-invalid');
  return parts;
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

function assessRelease({ currentVersion, nextVersion, channel, minimumDataSchema, maximumDataSchema,
  changeNotes } = {}) {
  if (!['experimental', 'beta', 'stable'].includes(channel)) throw fail('release-channel-invalid');
  if (compareVersions(nextVersion, currentVersion) <= 0) throw fail('release-downgrade-blocked');
  if (!Number.isSafeInteger(minimumDataSchema) || minimumDataSchema < 1
    || !Number.isSafeInteger(maximumDataSchema) || maximumDataSchema < minimumDataSchema) throw fail('release-schema-range-invalid');
  if (!Array.isArray(changeNotes) || !changeNotes.length || changeNotes.length > 50
    || changeNotes.some(note => typeof note !== 'string' || !note.trim() || note.length > 240)) throw fail('release-notes-required');
  return { version: nextVersion, channel, minimumDataSchema, maximumDataSchema,
    notes: changeNotes.map(note => note.trim()), installerVerificationRequired: true };
}

function canOpenData(release, dataSchema) {
  if (!release || !Number.isSafeInteger(release.minimumDataSchema) || !Number.isSafeInteger(release.maximumDataSchema)
    || !Number.isSafeInteger(dataSchema)) throw fail('release-schema-range-invalid');
  return dataSchema >= release.minimumDataSchema && dataSchema <= release.maximumDataSchema;
}

module.exports = { parseVersion, compareVersions, assessRelease, canOpenData };
