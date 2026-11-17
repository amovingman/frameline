const EXPERIMENTAL_TARGET = Object.freeze({
  editor: 'DaVinci Resolve', edition: 'Free', editorVersion: '21.1.2', editorBuild: '21.1.20010',
  os: 'darwin', format: 'FCPXML', formatVersion: '1.10',
  onboardingEditorId: 'resolve-free-21.1.2', maximumXmlBytes: 20 * 1024 * 1024
});

// This is a tested read-only boundary, never a release support declaration.
function assessCompatibility(input = {}) {
  const exact = ['editor', 'edition', 'editorVersion', 'editorBuild', 'os', 'format', 'formatVersion']
    .every(key => input[key] === EXPERIMENTAL_TARGET[key]);
  const operation = input.operation;
  return { exactTarget: exact, operation,
    experimentalReadOnly: exact && operation === 'scan',
    releaseSupported: false,
    writeSupported: false,
    reason: !exact ? 'outside-experimental-target' : operation === 'scan'
      ? 'read-only-experimental' : 'write-unproven' };
}

module.exports = { EXPERIMENTAL_TARGET, assessCompatibility };
