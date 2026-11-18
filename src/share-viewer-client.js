'use strict';
(() => {
  // The fragment is never sent to the host. Clear it before parsing page data or
  // dispatching a request, and keep the capability only in this closure.
  let token = location.hash.slice(1); const hadQuery = !!location.search;
  try { history.replaceState(null, '', location.pathname); } catch { token = ''; }
  const validToken = value => /^[A-Za-z0-9_-]{43}$/.test(value) && (() => {
    try { const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
      return bytes.length === 32 && btoa(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') === value;
    } catch { return false; }
  })();
  if (!validToken(token) || hadQuery) token = '';
  const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
  const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  async function checked(value) {
    if (!exact(value, ['permission', 'projectId', 'projectName', 'revision', 'manifest', 'expiresAt']) || value.permission !== 'read'
      || !ID.test(value.projectId) || typeof value.projectName !== 'string' || !value.projectName.trim() || value.projectName.length > 120
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
      || !exact(value.revision, ['id', 'manifestId', 'message', 'createdAt']) || !ID.test(value.revision.id)
      || typeof value.revision.message !== 'string' || !value.revision.message.trim() || value.revision.message.length > 240
      || !Number.isFinite(Date.parse(value.revision.createdAt)) || !value.manifest || value.manifest.readOnly !== true
      || !(value.manifest.adapter === 'fcpxml' || value.manifest.format === 'resolve-api-observation')) throw Error('invalid');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value.manifest)));
    if (value.revision.manifestId !== `sha256:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`) throw Error('invalid');
    return value;
  }
  function initialize() {
    const button = document.getElementById('open-share'), status = document.getElementById('share-status'), article = document.getElementById('revision');
    let metadata = null, loading = false;
    button.disabled = !token;
    status.textContent = token ? 'Open the saved revision when you are ready. The link is kept only in this tab.' : 'This link is incomplete. Ask the project owner for a new share link.';
    const addText = (parent, tag, text, className) => { const element = document.createElement(tag); element.textContent = text;
      if (className) element.className = className; parent.append(element); return element; };
    const formatTime = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const count = value => value.toLocaleString();
    const quantity = (value, noun) => `${count(value)} ${noun}${value === 1 ? '' : 's'}`;
    function row(parent, label, value) { const item = addText(parent, 'div', '', 'summary-row'); addText(item, 'strong', label); addText(item, 'span', value); }
    function render(value) {
      document.getElementById('revision-title').textContent = value.projectName;
      document.getElementById('revision-message').textContent = value.revision.message;
      const facts = document.getElementById('revision-facts'); facts.replaceChildren();
      for (const [label, text] of [['Saved', formatTime(value.revision.createdAt)], ['Revision', value.revision.id], ['Link expires', formatTime(value.expiresAt)]]) {
        addText(facts, 'dt', label); addText(facts, 'dd', text);
      }
      const summary = document.getElementById('revision-summary'); summary.replaceChildren(); const manifest = value.manifest;
      if (manifest.format === 'resolve-api-observation') {
        const timelines = manifest.snapshot.timelines, items = timelines.reduce((total, timeline) => total + timeline.items.length, 0);
        row(summary, 'Resolve observation', `${quantity(timelines.length, 'timeline')} · ${quantity(items, 'timeline item')}`);
        for (const timeline of timelines.slice(0, 40)) row(summary, timeline.name || 'Unnamed timeline', `${quantity(timeline.items.length, 'item')} · ${quantity(timeline.tracks.length, 'track')}`);
        if (timelines.length > 40) addText(summary, 'p', 'The first 40 timelines are listed. Full metadata contains every captured timeline.', 'summary-note');
      } else {
        row(summary, manifest.sequence.name || 'Unnamed sequence', quantity(manifest.sequence.durationFrames, 'frame'));
        row(summary, 'Frame duration', manifest.sequence.frameDuration); row(summary, 'Clip inventory', quantity(manifest.clips.length, 'clip'));
        row(summary, 'Media references', quantity(manifest.media.length, 'reference'));
      }
      metadata = manifest; article.hidden = false; document.getElementById('revision-title').focus();
    }
    document.getElementById('metadata-details').addEventListener('toggle', event => {
      if (event.target.open && metadata && !document.getElementById('metadata-json').textContent) document.getElementById('metadata-json').textContent = JSON.stringify(metadata, null, 2);
    });
    button.addEventListener('click', async () => {
      if (loading || !token) return; loading = true; button.disabled = true; button.textContent = 'Opening revision…'; status.textContent = 'Checking this share link…';
      try {
        const requestId = crypto.randomUUID(), apiVersion = document.querySelector('meta[name="frameline-api-version"]').content;
        const response = await fetch('/shares/redeem', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-version': apiVersion, 'x-request-id': requestId },
          body: JSON.stringify({ token }), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) });
        if (response.status === 429 || response.status === 503) { status.textContent = 'This service is busy. Try opening the revision again shortly.'; button.textContent = 'Try again'; return; }
        if (!response.ok) { token = ''; throw Error('unavailable'); }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw Error('invalid');
        const declared = response.headers.get('content-length'); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8 * 1024 * 1024)) throw Error('invalid');
        const reader = response.body.getReader(), parts = []; let bytes = 0;
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
          if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw Error('invalid'); } parts.push(chunk.value); } } finally { reader.releaseLock(); }
        const joined = new Uint8Array(bytes); let offset = 0; for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
        const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
        if (!exact(envelope, ['apiVersion', 'requestId', 'data']) || envelope.apiVersion !== apiVersion || envelope.requestId !== requestId) throw Error('invalid');
        const value = await checked(envelope.data); render(value); token = ''; button.hidden = true; status.textContent = 'Opened a saved revision. No project or media was changed.';
      } catch (error) {
        if (error.message === 'unavailable') status.textContent = 'This share link is unavailable. Ask the project owner for a new link.';
        else if (error.message === 'invalid') { token = ''; status.textContent = 'The saved revision could not be verified. Ask the project owner for a new link.'; }
        else { status.textContent = 'The connection was interrupted. Try opening the revision again.'; button.textContent = 'Try again'; }
      } finally { loading = false; button.disabled = !token; if (!token && !button.hidden) button.textContent = 'Open shared revision'; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
