const SECRET_FIELD = /(password|token|secret|credential|authorization|email|path|filename)/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:\\|\\\\)/;

function redact(value, field = '') {
  if (SECRET_FIELD.test(field)) return '[REDACTED]';
  if (typeof value === 'string') return ABSOLUTE_PATH.test(value) ? '[LOCAL_PATH]' : value;
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
  }
  return value;
}

function write(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redact(fields)
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.info(output);
}

module.exports = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  redact
};
