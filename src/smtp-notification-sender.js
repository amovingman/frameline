'use strict';
const tls = require('node:tls');
const { isIP } = require('node:net');
const { TYPES } = require('./project-activity');
const { validateNotificationConfig } = require('./service-host-config');

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, SHA = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const fail = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });
function mailbox(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[\x21-\x7e]+$/.test(value)) return false;
  const parts = value.split('@');
  return parts.length === 2 && parts[0].length <= 64 && !!parts[0]
    && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(parts[0]) && !/^\.|\.$|\.\./.test(parts[0])
    && parts[1].split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
function prepared(value) {
  if (!exact(value, ['jobId', 'messageId', 'to', 'projectName', 'eventCount', 'permissionLossCount', 'unsubscribeToken', 'kind', 'counts', 'throughAt'])
    || !ID.test(value.jobId || '') || !SHA.test(value.messageId || '') || !mailbox(value.to)
    || value.projectName !== null && (typeof value.projectName !== 'string' || !value.projectName.trim()
      || value.projectName.length > 120 || /[\x00-\x1f\x7f]/.test(value.projectName))
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 1 || value.eventCount > 100_000
    || !Number.isSafeInteger(value.permissionLossCount) || value.permissionLossCount < 0 || value.permissionLossCount > value.eventCount
    || !TOKEN.test(value.unsubscribeToken || '') || Buffer.from(value.unsubscribeToken, 'base64url').toString('base64url') !== value.unsubscribeToken
    || !['immediate', 'daily'].includes(value.kind) || !value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)
    || Object.keys(value.counts).length > TYPES.size || Object.entries(value.counts).some(([type, count]) => !TYPES.has(type)
      || !Number.isSafeInteger(count) || count < 1 || count > value.eventCount)
    || Object.values(value.counts).reduce((sum, count) => sum + count, 0) !== value.eventCount
    || !Number.isSafeInteger(value.throughAt) || value.throughAt < 0 || value.throughAt > 8_640_000_000_000_000) throw fail('smtp-message-invalid');
  return structuredClone(value);
}
const LABELS = Object.freeze({ 'revision.created': 'New revisions', 'branch.changed': 'Branch updates', 'pull.completed': 'Completed pulls',
  'branch.protection-changed': 'Branch policy changes', 'approval.requested': 'Review requests', 'approval.recorded': 'Recorded approvals',
  'approval.applied': 'Approved publications', 'share.created': 'Created share links', 'share.revoked': 'Revoked share links',
  'member.invited': 'Project invitations', 'member.joined': 'New project members', 'member.role-changed': 'Role changes',
  'member.removed': 'Access changes', 'owner.transferred': 'Ownership changes', 'project.deleted': 'Project access changes' });
function message(value, config, at) {
  const unsubscribe = `${config.publicOrigin}/unsubscribe#${value.unsubscribeToken}`;
  const host = new URL(config.publicOrigin).hostname;
  const messageDomain = host.includes(':') ? 'frameline.invalid' : host;
  const body = ['Frameline updates', '', ...(value.projectName === null
    ? ['Your project access changed. Project details are unavailable.'] : [`Project: ${value.projectName}`]),
  `Delivery: ${value.kind === 'daily' ? 'Daily digest (UTC)' : 'Immediate updates'}`,
  `Updates through: ${new Date(value.throughAt).toISOString()}`, '',
  ...Object.entries(value.counts).sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => `${LABELS[type] || 'Other updates'}: ${count}`), '',
  'Open Frameline and refresh Account updates to read details.',
  'This email contains activity counts, not media files or clip properties.', '',
  'Turn off email for this project:', unsubscribe, ''].join('\r\n');
  const encoded = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  const bytes = Buffer.from([`From: ${config.from}`, `To: ${value.to}`, `Date: ${new Date(at).toUTCString()}`,
    `Message-ID: <${value.messageId}@${messageDomain}>`, `Subject: Frameline ${value.kind === 'daily' ? 'daily digest' : 'project updates'}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    `List-Unsubscribe: <${unsubscribe}>`, '', encoded, ''].join('\r\n'), 'utf8');
  if (bytes.length > 32 * 1024) throw fail('smtp-message-invalid');
  return bytes;
}

// Deliberately limited to submission over implicit TLS. No plaintext fallback,
// redirects, provider response text, attachments, or arbitrary recipients enter
// the public app surface. The host owns this private configuration.
function createSmtpNotificationSender({ config, timeoutMs = 20_000, now = Date.now } = {}) {
  try { config = validateNotificationConfig(config); } catch { throw fail('smtp-config-invalid'); }
  if (!mailbox(config.from) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 || typeof now !== 'function') throw fail('smtp-config-invalid');
  const sockets = new Set(); let closed = false;
  async function send(input, { signal = null, beforeData = null } = {}) {
    let value = prepared(input);
    if (signal !== null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function') || beforeData !== null && typeof beforeData !== 'function') throw fail('smtp-message-invalid');
    if (closed || signal?.aborted) throw fail('smtp-cancelled', true);
    let socket, accepted = false, dataIssued = false, secure = false, fault = null, pending = null, buffer = '', total = 0, code = null, lines = [];
    const replies = [];
    const reject = error => { if (!fault) fault = error; if (pending) { const waiter = pending; pending = null; waiter.reject(fault); } };
    const abort = () => { reject(fail('smtp-cancelled', true)); socket?.destroy(); };
    const timer = setTimeout(() => { reject(fail(dataIssued ? 'smtp-delivery-uncertain' : 'smtp-timeout', true)); socket?.destroy(); }, timeoutMs);
    timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
    function reply() {
      if (fault) return Promise.reject(fault);
      if (replies.length) return Promise.resolve(replies.shift());
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    }
    function parse(chunk) {
      total += Buffer.byteLength(chunk);
      if (total > 64 * 1024) { reject(fail('smtp-protocol-invalid')); socket.destroy(); return; }
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const match = /^([2-5][0-9]{2})(?:([- ])(.*))?$/.exec(line);
        if (line.length > 510 || !match || code !== null && code !== Number(match[1]) || lines.length >= 64) {
          reject(fail('smtp-protocol-invalid')); socket.destroy(); return;
        }
        code = Number(match[1]); lines.push(match[3] || '');
        if (match[2] !== '-') {
          const result = { code, lines }; code = null; lines = [];
          if (pending) { const waiter = pending; pending = null; waiter.resolve(result); }
          else { replies.push(result); if (replies.length > 8) { reject(fail('smtp-protocol-invalid')); socket.destroy(); return; } }
        }
      }
      if (buffer.length > 510 || /(^|[^\r])\n/.test(buffer)) { reject(fail('smtp-protocol-invalid')); socket.destroy(); }
    }
    async function expect(expected, stage) {
      const result = await reply();
      if (result.code !== expected) {
        if (result.code >= 400 && result.code < 500) throw fail('smtp-transient-failure', true);
        throw fail(stage === 'auth' ? 'smtp-auth-failed' : result.code >= 500 ? 'smtp-rejected' : 'smtp-protocol-invalid');
      }
      return result;
    }
    function write(text) { if (fault) throw fault; if (signal?.aborted || closed) throw fail('smtp-cancelled', true); socket.write(text); }
    try {
      socket = tls.connect({ host: config.smtp.host, port: config.smtp.port, minVersion: 'TLSv1.2', rejectUnauthorized: true,
        ...(isIP(config.smtp.host) ? {} : { servername: config.smtp.host }) });
      sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setEncoding('utf8');
      socket.on('data', parse); socket.on('error', () => reject(fail(!secure ? 'smtp-tls-unavailable'
        : dataIssued ? 'smtp-delivery-uncertain' : 'smtp-network-unavailable', true)));
      socket.on('end', () => reject(fail(dataIssued ? 'smtp-delivery-uncertain' : 'smtp-network-unavailable', true)));
      socket.on('close', () => reject(fail(dataIssued ? 'smtp-delivery-uncertain' : 'smtp-network-unavailable', true)));
      await new Promise((resolve, rejectConnection) => {
        const ready = () => { cleanup(); secure = true; resolve(); };
        const error = () => { cleanup(); rejectConnection(fault || fail('smtp-tls-unavailable', true)); };
        const cleanup = () => { socket.off('secureConnect', ready); socket.off('error', error); socket.off('close', error); };
        socket.once('secureConnect', ready); socket.once('error', error); socket.once('close', error);
      });
      await expect(220, 'greeting'); write('EHLO frameline.local\r\n'); const capabilities = await expect(250, 'ehlo');
      if (config.smtp.username !== null) {
        if (!capabilities.lines.some(line => /^AUTH(?:=|\s).*\bPLAIN\b/i.test(line))) throw fail('smtp-auth-unavailable');
        const credentials = Buffer.from(`\0${config.smtp.username}\0${config.smtp.password}`, 'utf8').toString('base64');
        write(`AUTH PLAIN ${credentials}\r\n`); await expect(235, 'auth');
      }
      write(`MAIL FROM:<${config.from}>\r\n`); await expect(250, 'mail');
      write(`RCPT TO:<${value.to}>\r\n`); await expect(250, 'recipient');
      if (beforeData) {
        let fresh;
        try { fresh = await beforeData(); } catch { throw fail('smtp-preparation-unavailable', true); }
        if (fresh === null) return null;
        const checked = prepared(fresh);
        if (checked.to !== value.to || checked.jobId !== value.jobId || checked.messageId !== value.messageId) throw fail('smtp-message-invalid');
        value = checked;
      }
      const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw fail('smtp-message-invalid');
      const bytes = message(value, config, at);
      write('DATA\r\n'); await expect(354, 'data'); dataIssued = true;
      // The generated MIME body is base64; its lines cannot begin with a dot.
      write(Buffer.concat([bytes, Buffer.from('.\r\n')])); await expect(250, 'acceptance'); accepted = true;
      socket.end('QUIT\r\n'); return { accepted: true };
    } catch (error) {
      if (accepted) return { accepted: true };
      if (/^smtp-[a-z-]+$/.test(error?.code || '')) throw error;
      throw fail(dataIssued ? 'smtp-delivery-uncertain' : 'smtp-network-unavailable', true);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (accepted) { const retire = setTimeout(() => socket?.destroy(), 1000); retire.unref?.(); socket.once('close', () => clearTimeout(retire)); }
      else socket?.destroy();
    }
  }
  function close() { closed = true; for (const socket of sockets) socket.destroy(); }
  return { send, close };
}
module.exports = { createSmtpNotificationSender };
