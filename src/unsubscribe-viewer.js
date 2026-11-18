'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { API_VERSION } = require('./project-api-contracts');
const { CSP } = require('./share-viewer');
const isUnsubscribeViewerRequest = req => typeof req.url === 'string' && /^\/unsubscribe(?:[/?]|$)/.test(req.url);
function createUnsubscribeViewerHandler() {
  const assets = new Map([['/unsubscribe', ['unsubscribe-viewer.html', 'text/html; charset=utf-8']],
    ['/unsubscribe/viewer.js', ['unsubscribe-viewer-client.js', 'text/javascript; charset=utf-8']]]);
  return async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
    let status = 200, bytes, type = 'text/plain; charset=utf-8';
    if (!req.socket?.encrypted) { status = 426; bytes = Buffer.from('Secure connection required.'); }
    else if (req.method !== 'GET') { status = 405; headers.Allow = 'GET'; bytes = Buffer.from('Method unavailable.'); }
    else if (!assets.has(req.url)) { status = 404; bytes = Buffer.from('Page unavailable.'); }
    else { const [filename, contentType] = assets.get(req.url); type = contentType;
      try { bytes = await fs.readFile(path.join(__dirname, filename)); if (filename.endsWith('.html')) bytes = Buffer.from(bytes.toString('utf8').replace('__API_VERSION__', API_VERSION)); }
      catch { status = 503; type = 'text/plain; charset=utf-8'; bytes = Buffer.from('Page unavailable.'); }
    }
    res.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': bytes.length }); res.end(bytes);
  };
}
module.exports = { createUnsubscribeViewerHandler, isUnsubscribeViewerRequest };
