'use strict';
const { safeErrorCode, safeLogFields, isKnownEvent } = require('./observability-catalog');
const SECRET_FIELD = /(password|token|secret|credential|authorization|email|path|filename|(?:media|clip|project)name)/i;
// Compatibility helper. Logging itself uses the stricter event-specific schema.
function redact(value, field = '') {
  if (SECRET_FIELD.test(field)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (/[/\\]/.test(value)) return '[LOCAL_PATH]';
    if (field === 'code') return safeErrorCode(value);
    return ['FCPXML', 'FCPXML bundle'].includes(value) ? value : '[REDACTED]';
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
  return value;
}
function write(level, event, fields = {}) {
  const entry = { timestamp: new Date().toISOString(), level,
    event: isKnownEvent(event) ? event : 'unknown-event', ...safeLogFields(event, fields) };
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](JSON.stringify(entry));
}
module.exports = { info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields), error: (event, fields) => write('error', event, fields), redact };
