'use strict';

const ID = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_CHUNKS = 2561;
const MAX_BYTES = 20 * 1024 * 1024;
const CHUNK_MARKER = 'FRAMELINE_CAPTURE_CHUNK_V1:';
const RESULT_MARKER = 'FRAMELINE_CAPTURE_RESULT_V1:';

function invalid() {
  const error = new Error('resolve-console-transfer-invalid');
  error.code = 'resolve-console-transfer-invalid';
  throw error;
}

function createNextChunkCommand({ requestId, requestSha256, index } = {}) {
  if (!ID.test(requestId || '') || !SHA.test(requestSha256 || '')
    || !Number.isSafeInteger(index) || index < 2 || index > MAX_CHUNKS) invalid();
  return `local b=FRAMELINE_CAPTURE_BUFFER_V1; if not b or b.request_id~=${JSON.stringify(requestId)} or b.request_sha~=${JSON.stringify(requestSha256)} or (os and os.time and os.time()*1000>b.expires_at) or not b.chunks[${index}] then print('FRAMELINE_CAPTURE_ERROR_V1:Capture buffer unavailable or expired') else print('${CHUNK_MARKER}${requestId}:${index}:'..#b.chunks..':'..b.chunks[${index}]) end`;
}

function acceptConsoleOutput({ output, requestId, requestSha256, transfer = null } = {}) {
  if (typeof output !== 'string' || !ID.test(requestId || '') || !SHA.test(requestSha256 || '')) invalid();
  const lines = output.split(/\r?\n/);
  const line = lines.findLast(entry => entry.startsWith(CHUNK_MARKER)
    || entry.startsWith(RESULT_MARKER) || entry.startsWith('FRAMELINE_CAPTURE_ERROR_V1:'));
  if (!line || line.startsWith('FRAMELINE_CAPTURE_ERROR_V1:')) invalid();
  if (line.startsWith(RESULT_MARKER)) {
    if (transfer) invalid();
    return { complete: true, responseText: line.slice(RESULT_MARKER.length) };
  }
  const match = /^FRAMELINE_CAPTURE_CHUNK_V1:([a-f0-9]{32}):(\d+):(\d+):([\s\S]*)$/.exec(line);
  if (!match || match[1] !== requestId) invalid();
  const index = Number(match[2]);
  const total = Number(match[3]);
  const chunk = match[4];
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 2
    || total > MAX_CHUNKS || index < 1 || index > total || !chunk
    || Buffer.byteLength(chunk) > 8192) invalid();
  const previous = transfer || { total, chunks: [], bytes: 0 };
  if (previous.total !== total || previous.chunks.length + 1 !== index) invalid();
  const bytes = previous.bytes + Buffer.byteLength(chunk);
  if (bytes > MAX_BYTES) invalid();
  const next = { total, chunks: [...previous.chunks, chunk], bytes };
  if (index === total) return { complete: true, responseText: next.chunks.join('') };
  return { complete: false, transfer: next,
    nextIndex: index + 1,
    command: createNextChunkCommand({ requestId, requestSha256, index: index + 1 }) };
}

module.exports = { acceptConsoleOutput, createNextChunkCommand };
