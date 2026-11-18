'use strict';
const https = require('node:https');
const { createSecureContext } = require('node:tls');
const { isIP } = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { API_VERSION } = require('./project-api-contracts');
const { createDurableCollaborationService } = require('./durable-collaboration-service');
const { createRevisionHttpHandler } = require('./revision-http-transport');

function fail(code) { return Object.assign(new Error(code), { code }); }

async function startServiceHost({ config, initialize = false, allowEphemeralPort = false, shutdownTimeoutMs = 10_000 } = {}) {
  if (!config || !path.isAbsolute(config.directory || '') || typeof config.host !== 'string' || !isIP(config.host)
    || config.host.includes('%') || !Number.isSafeInteger(config.port) || config.port < (allowEphemeralPort ? 0 : 1) || config.port > 65535
    || typeof initialize !== 'boolean' || typeof allowEphemeralPort !== 'boolean'
    || !Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100 || shutdownTimeoutMs > 30_000
    || !Buffer.isBuffer(config.tls?.cert) || !Buffer.isBuffer(config.tls?.key)
    || config.tls.cert.length < 1 || config.tls.cert.length > 1024 * 1024 || config.tls.key.length < 1 || config.tls.key.length > 64 * 1024) throw fail('service-host-invalid');
  const tls = { cert: config.tls.cert, key: config.tls.key, minVersion: 'TLSv1.2', handshakeTimeout: 5000 };
  try { createSecureContext(tls); } catch { throw fail('service-host-tls-unavailable'); }
  const runtime = await createDurableCollaborationService({ directory: config.directory, keyring: config.keyring, initialize });
  const handler = createRevisionHttpHandler({ service: runtime.service, identity: runtime.identity,
    listProjects: context => runtime.projects.list(context) });
  const sockets = new Set(), handlers = new Set(); let closing = false, closePromise = null;
  const server = https.createServer({ ...tls, maxHeaderSize: 16 * 1024, headersTimeout: 10_000,
    requestTimeout: 30_000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }, (req, res) => {
    if (closing || handlers.size >= 256) {
      const requestedId = req.headers['x-request-id'];
      const requestId = typeof requestedId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(requestedId) ? requestedId : randomUUID();
      const bytes = Buffer.from(JSON.stringify({ apiVersion: API_VERSION, requestId, error: { code: 'service-unavailable' } }));
      res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      req.resume(); res.end(bytes); return;
    }
    const pending = Promise.resolve().then(() => handler(req, res)).catch(() => { res.destroy(); }).finally(() => handlers.delete(pending));
    handlers.add(pending);
  });
  server.maxConnections = 128; server.maxHeadersCount = 100; server.maxRequestsPerSocket = 100;
  server.setTimeout(30_000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', (_error, socket) => { socket?.destroy(); });
  // Error text can contain certificate paths and client-supplied bytes.
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      const failed = () => { server.off('listening', ready); reject(fail('service-host-listen-unavailable')); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready); server.listen(config.port, config.host);
    });
  } catch (error) { for (const socket of sockets) socket.destroy(); await runtime.close(); throw error; }
  server.on('error', () => {});
  const address = server.address();
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      let forceTimer, deadlineTimer;
      const networkClosed = new Promise((resolve, reject) => server.close(error => error ? reject(fail('service-host-shutdown-failed')) : resolve()));
      server.closeIdleConnections();
      const destroyConnections = () => { server.closeAllConnections(); for (const socket of sockets) socket.destroy(); };
      forceTimer = setTimeout(destroyConnections, Math.min(1000, Math.floor(shutdownTimeoutMs / 2)));
      const drained = (async () => {
        await networkClosed;
        while (handlers.size) await Promise.allSettled([...handlers]);
        await runtime.close();
      })();
      try {
        await Promise.race([drained, new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => { destroyConnections(); reject(fail('service-host-shutdown-timeout')); }, shutdownTimeoutMs);
        })]);
      } finally { clearTimeout(forceTimer); clearTimeout(deadlineTimer); }
    })();
    return closePromise;
  }
  return { address: { address: address.address, family: address.family, port: address.port }, close,
    getStatus: () => closing ? Promise.reject(fail('service-host-closed')) : runtime.getStatus() };
}

module.exports = { startServiceHost };
