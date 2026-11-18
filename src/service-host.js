'use strict';
const https = require('node:https');
const { createSecureContext } = require('node:tls');
const { isIP } = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { API_VERSION } = require('./project-api-contracts');
const { createDurableCollaborationService } = require('./durable-collaboration-service');
const { createRevisionHttpHandler } = require('./revision-http-transport');
const { createDurableAssetService } = require('./durable-asset-service');
const { createAssetHttpHandler, isAssetRequest } = require('./asset-http-transport');
const { createShareViewerHandler, isShareViewerRequest } = require('./share-viewer');
const { createUnsubscribeViewerHandler, isUnsubscribeViewerRequest } = require('./unsubscribe-viewer');
const { validateNotificationConfig } = require('./service-host-config');
const { createSmtpNotificationSender } = require('./smtp-notification-sender');
const { createNotificationWorker } = require('./notification-worker');

function fail(code) { return Object.assign(new Error(code), { code }); }
function nested(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function startServiceHost({ config, initialize = false, allowEphemeralPort = false, shutdownTimeoutMs = 10_000,
  onNotificationStatus = () => {} } = {}) {
  if (!config || !path.isAbsolute(config.directory || '') || typeof config.host !== 'string' || !isIP(config.host)
    || config.host.includes('%') || !Number.isSafeInteger(config.port) || config.port < (allowEphemeralPort ? 0 : 1) || config.port > 65535
    || typeof initialize !== 'boolean' || typeof allowEphemeralPort !== 'boolean' || typeof onNotificationStatus !== 'function'
    || !Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100 || shutdownTimeoutMs > 30_000
    || !Buffer.isBuffer(config.tls?.cert) || !Buffer.isBuffer(config.tls?.key)
    || config.tls.cert.length < 1 || config.tls.cert.length > 1024 * 1024 || config.tls.key.length < 1 || config.tls.key.length > 64 * 1024
    || config.assets !== undefined && (!path.isAbsolute(config.assets?.directory || '')
      || !Buffer.isBuffer(config.assets.signingKey) || config.assets.signingKey.length !== 32
      || nested(config.directory, config.assets.directory) || nested(config.assets.directory, config.directory))) throw fail('service-host-invalid');
  const notificationConfig = config.notifications === undefined ? null : validateNotificationConfig(config.notifications);
  const tls = { cert: config.tls.cert, key: config.tls.key, minVersion: 'TLSv1.2', handshakeTimeout: 5000 };
  try { createSecureContext(tls); } catch { throw fail('service-host-tls-unavailable'); }
  const runtime = await createDurableCollaborationService({ directory: config.directory, keyring: config.keyring, initialize,
    notificationDeliveryAvailable: notificationConfig !== null });
  const handler = createRevisionHttpHandler({ service: runtime.service, identity: runtime.identity,
    listProjects: context => runtime.projects.list(context) });
  const shareViewer = createShareViewerHandler();
  const unsubscribeViewer = createUnsubscribeViewerHandler();
  let assets = null, assetHandler = null, notificationWorker = null;
  try {
    if (config.assets) {
      const authorize = (context, projectId, action) => runtime.service.authorizeAsset(context, projectId, action);
      const authorizePolicy = (context, projectId, action) => runtime.service.authorizeAssetPolicy(context, projectId, action);
      assets = await createDurableAssetService({ directory: config.assets.directory, keyring: config.keyring, authorize, authorizePolicy, initialize });
      assetHandler = createAssetHttpHandler({ assets, authorize, authorizePolicy, signingKey: config.assets.signingKey });
    }
    if (notificationConfig) notificationWorker = createNotificationWorker({ notifications: runtime.notifications,
      sender: createSmtpNotificationSender({ config: notificationConfig }), onChange: onNotificationStatus });
  } catch (error) { await notificationWorker?.stop(); await assets?.close(); await runtime.close(); throw error; }
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
    const pending = Promise.resolve().then(() => (isUnsubscribeViewerRequest(req) ? unsubscribeViewer
      : isShareViewerRequest(req) ? shareViewer : assetHandler && isAssetRequest(req) ? assetHandler : handler)(req, res))
      .catch(() => { res.destroy(); }).finally(() => handlers.delete(pending));
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
  } catch (error) { for (const socket of sockets) socket.destroy(); await notificationWorker?.stop(); await assets?.close(); await runtime.close(); throw error; }
  server.on('error', () => {});
  const address = server.address();
  notificationWorker?.start();
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      let forceTimer, deadlineTimer;
      // Verification outlives its initiating HTTP request. Retire admission and
      // stop those jobs before draining accepted requests and closing storage.
      const assetShutdown = assetHandler ? assetHandler.close().then(() => null, () => fail('service-host-shutdown-failed')) : Promise.resolve(null);
      const notificationShutdown = notificationWorker ? notificationWorker.stop().then(() => null, () => fail('service-host-shutdown-failed')) : Promise.resolve(null);
      const networkClosed = new Promise((resolve, reject) => server.close(error => error ? reject(fail('service-host-shutdown-failed')) : resolve()));
      server.closeIdleConnections();
      const destroyConnections = () => { server.closeAllConnections(); for (const socket of sockets) socket.destroy(); };
      forceTimer = setTimeout(destroyConnections, Math.min(1000, Math.floor(shutdownTimeoutMs / 2)));
      const drained = (async () => {
        await networkClosed;
        while (handlers.size) await Promise.allSettled([...handlers]);
        const assetError = await assetShutdown; if (assetError) throw assetError;
        const notificationError = await notificationShutdown; if (notificationError) throw notificationError;
        await assets?.close();
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
    runNotificationDelivery: () => closing ? Promise.reject(fail('service-host-closed')) : notificationWorker?.tick() ?? Promise.resolve(null),
    getNotificationStatus: () => notificationWorker?.getState() ?? null,
    getStatus: () => closing ? Promise.reject(fail('service-host-closed')) : runtime.getStatus() };
}

module.exports = { startServiceHost };
