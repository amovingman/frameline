const { scanFcpXml, verifyFcpXmlSource } = require('./fcpxml-adapter');

class AdapterUnavailableError extends Error {
  constructor(operation) {
    super(`${operation} is unavailable for this adapter`);
    this.code = 'adapter-operation-unavailable';
  }
}

const unavailable = operation => async () => { throw new AdapterUnavailableError(operation); };

const fcpxmlProjectAdapter = Object.freeze({
  id: 'fcpxml',
  capabilities: Object.freeze({ readOnly: true, stableIds: false, apply: false, editorValidation: false }),
  scan: scanFcpXml,
  verifySource: verifyFcpXmlSource,
  mapStableIds: unavailable('Stable ID mapping'),
  apply: unavailable('Apply'),
  save: unavailable('Save'),
  validate: unavailable('Editor validation')
});

function requireProjectAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.capabilities
    || ['scan', 'verifySource', 'mapStableIds', 'apply', 'save', 'validate'].some(method => typeof adapter[method] !== 'function')) {
    throw new TypeError('Invalid project adapter');
  }
  return adapter;
}

module.exports = { AdapterUnavailableError, fcpxmlProjectAdapter, requireProjectAdapter };
