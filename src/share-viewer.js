'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { API_VERSION } = require('./project-api-contracts');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const assets = new Map([
  ['/share', ['share-viewer.html', 'text/html; charset=utf-8']],
  ['/share/viewer.js', ['share-viewer-client.js', 'text/javascript; charset=utf-8']],
  ['/share/viewer.css', ['share-viewer.css', 'text/css; charset=utf-8']],
  ...[400, 500, 600].map(weight => [`/share/fonts/${weight}.woff2`, [`assets/fonts/ibm-plex-sans-latin-${weight}-normal.woff2`, 'font/woff2']])
]);
const isShareViewerRequest = req => typeof req.url === 'string' && /^\/share(?:[/?]|$)/.test(req.url);
function createShareViewerHandler() {
  return async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
    let status = 200, bytes, contentType = 'text/plain; charset=utf-8';
    if (!req.socket?.encrypted) { status = 426; bytes = Buffer.from('Secure connection required.'); }
    else if (req.method !== 'GET') { status = 405; headers.Allow = 'GET'; bytes = Buffer.from('Method unavailable.'); }
    else if (!assets.has(req.url)) { status = 404; bytes = Buffer.from('Page unavailable.'); }
    else {
      const [filename, type] = assets.get(req.url); contentType = type;
      try { bytes = await fs.readFile(path.join(__dirname, filename));
        if (filename === 'share-viewer.html') bytes = Buffer.from(bytes.toString('utf8').replace('__API_VERSION__', API_VERSION));
      } catch { status = 503; contentType = 'text/plain; charset=utf-8'; bytes = Buffer.from('Viewer unavailable.'); }
    }
    res.writeHead(status, { ...headers, 'Content-Type': contentType, 'Content-Length': bytes.length }); res.end(bytes);
  };
}
module.exports = { createShareViewerHandler, isShareViewerRequest, CSP };
