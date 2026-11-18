'use strict';
(() => {
  let token = location.hash.slice(1); const hadQuery = !!location.search;
  try { history.replaceState(null, '', location.pathname); } catch { token = ''; }
  const canonical = value => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    try { const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
      return bytes.length === 32 && btoa(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') === value;
    } catch { return false; }
  };
  if (hadQuery || !canonical(token)) token = '';
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
  function initialize() {
    const button = document.getElementById('unsubscribe'), status = document.getElementById('unsubscribe-status'); let pending = false;
    button.disabled = !token;
    status.textContent = token ? 'Choose Turn off email to submit your preference. The link stays only in this tab.' : 'Open the unsubscribe link from a notification email.';
    button.addEventListener('click', async () => {
      if (pending || !token) return; pending = true; button.disabled = true; button.textContent = 'Submitting preference…'; status.textContent = 'Processing your request…';
      try {
        const apiVersion = document.querySelector('meta[name="frameline-api-version"]').content, requestId = crypto.randomUUID();
        const response = await fetch('/notifications/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': apiVersion, 'x-request-id': requestId },
          body: JSON.stringify({ token }), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) });
        if (response.status === 429 || response.status === 503) { status.textContent = 'This service is busy. Try again shortly.'; return; }
        if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw Error('invalid');
        const declared = response.headers.get('content-length'); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw Error('invalid');
        const reader = response.body.getReader(), chunks = []; let bytes = 0;
        try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
          if (bytes > 4096) { await reader.cancel(); throw Error('invalid'); } chunks.push(next.value); } } finally { reader.releaseLock(); }
        const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
        if (!exact(envelope, ['apiVersion', 'requestId', 'data']) || envelope.apiVersion !== apiVersion || envelope.requestId !== requestId
          || !exact(envelope.data, ['unsubscribed']) || envelope.data.unsubscribed !== true) throw Error('invalid');
        token = ''; status.textContent = 'Your unsubscribe request has been processed. You can close this tab.';
      } catch (error) {
        if (error.message === 'invalid') { token = ''; status.textContent = 'Your request could not be verified. Open the link from your notification email again.'; }
        else status.textContent = 'The connection was interrupted. Try again.';
      } finally { pending = false; button.disabled = !token; button.textContent = token ? 'Try again' : 'Turn off email'; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
