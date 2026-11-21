'use strict';
(() => {
  const api = window.desktop, node = id => document.getElementById(`native-pull-${id}`);
  let state = null, busy = false, rolesReady = false, offset = 0, acknowledgedPlan = null;
  const editable = new Set(['needs-review', 'ready', 'blocked', 'no-op', 'preparing']);
  const text = (tag, value) => { const n = document.createElement(tag); n.textContent = value; return n; };
  const value = v => !v?.present ? 'Absent' : v.type === 'null' ? 'NULL' : v.display ?? `${v.type || 'Stored value'} · ${v.sha256?.slice(0, 12) || 'unavailable'}`;
  const notice = n => ({
    'closed-owner-controlled-workflow-required': 'Apply requires a closed project in its owner-controlled local disk library.',
    'editor-readback-and-post-close-validation-required': 'After Apply, check the exact project in Resolve, then quit Resolve for final field validation.',
    'conflict-choice-required': 'Choose how to resolve this conflict.',
    'unsupported-accepted-change': 'An accepted incoming change has no proven write rule. Keep a conflicting local value or prepare a narrower incoming checkpoint.',
    'one-video-name-operation-required': 'This writer supports one existing video clip Name per plan.',
    'physical-storage-difference-not-applied': 'Physical database storage differs. The local container is preserved.',
    'existing-media-missing': `${n.count || 0} observed media references are missing. This Name change keeps their current state.`,
    'existing-media-unknown': `${n.count || 0} observed media references could not be verified.`,
    'opaque-media-preserved-portability-unverified': 'Opaque media records are preserved. Media has not been collected or relinked.'
  }[n.code] || 'The native target or field could not be verified for this writer. Recalculate or cancel this preparation.');
  function render(s) {
    state = s; const intent = s?.intent, plan = intent?.plan, running = Boolean(busy || s?.busy);
    if (acknowledgedPlan !== plan?.planId) { node('ack').checked = false; acknowledgedPlan = plan?.planId; }
    window.nativePullBusy = running;
    const locked = Boolean(running || s?.reviewLocked);
    if (window.nativePullLocked !== locked) {
      window.nativePullLocked = locked;
      document.dispatchEvent(new CustomEvent('native-pull-state', { detail: { locked } }));
    }
    node('prepare').disabled = Boolean(running || !s?.initialized || s?.reviewLocked || !rolesReady || window.closedApplyLocked || window.nativeCopyLocked || window.nativeCheckpointBusy || window.mediaRelinkLocked);
    node('status').textContent = s?.error || (running ? 'Verifying and retaining this action…' : intent?.stale ? 'The project or media condition changed. Earlier choices were cleared; review this recalculated plan.' : intent ? `Retained plan: ${intent.state.replaceAll('-', ' ')}${intent.resultingRevision ? ' · validated revision recorded' : ''}.` : 'Choose related native checkpoints above, then prepare a pull plan.');
    const retained = node('retained'); retained.replaceChildren(text('option', 'Choose a retained plan')); retained.firstChild.value = '';
    for (const r of s?.retained || []) { const o = text('option', `${r.intentId.slice(0, 8)} · ${r.state.replaceAll('-', ' ')}`); o.value = r.intentId; retained.append(o); }
    retained.value = intent?.intentId || ''; retained.disabled = running || !(s?.retained?.length);
    node('review').hidden = !intent;
    if (!intent) return;
    node('bindings').textContent = `Base ${intent.baseSha256?.slice(0, 12) || 'pending'} · Local ${intent.sourceSha256?.slice(0, 12) || 'pending'} · Incoming ${intent.incomingSha256?.slice(0, 12) || 'pending'} · Plan ${plan?.planId?.slice(0, 12) || 'pending'}`;
    const summary = intent.reportSummary;
    node('summary').textContent = summary ? `${summary['incoming-only']} incoming only · ${summary['local-only']} local only · ${summary['already-applied']} already applied · ${summary.conflicting} conflicting. Local-only values are preserved; already-applied values need no write.` : 'Preparation needs a fresh closed project capture.';
    for (const kind of ['warnings', 'blockers']) { node(kind).replaceChildren(); for (const n of plan?.[kind] || []) node(kind).append(text('li', notice(n))); }
    const changes = intent.changes || [], choices = new Map((intent.choices || []).map(c => [c.changeId, c.choice]));
    offset = Math.min(offset, Math.max(0, Math.floor((changes.length - 1) / 20) * 20)); node('changes').replaceChildren();
    for (const c of changes.slice(offset, offset + 20)) {
      const article = text('article', ''); article.className = 'native-checkpoint-change';
      article.append(text('h3', `${c.table} · ${c.column} · ${c.status.replaceAll('-', ' ')}`));
      const dl = document.createElement('dl'); dl.className = 'native-checkpoint-values';
      for (const role of ['base', 'local', 'incoming']) dl.append(text('dt', role === 'base' ? 'Common base' : role === 'local' ? 'Current local' : 'Incoming checkpoint'), text('dd', value(c.values?.[role])));
      article.append(dl);
      if (c.status === 'conflicting' && !['physical-container', 'schema-object-storage', 'rowid-storage'].includes(c.scope)) {
        const fieldset = document.createElement('fieldset'); fieldset.className = 'native-pull-choices'; fieldset.append(text('legend', 'Resolve this field conflict'));
        for (const [choice, label] of [['keep-local', 'Keep current local value'], ['take-incoming', 'Use incoming value (requires a proven write rule)']]) {
          const l = text('label', ''), input = document.createElement('input'); input.type = 'radio'; input.name = `native-choice-${c.id}`; input.value = choice; input.dataset.changeId = c.id; input.checked = choices.get(c.id) === choice; input.disabled = running || !editable.has(intent.state);
          input.addEventListener('change', () => run('choose', c.id, choice)); l.append(input, document.createTextNode(label)); fieldset.append(l);
        }
        article.append(fieldset);
      }
      node('changes').append(article);
    }
    node('range').textContent = `${changes.length ? offset + 1 : 0}–${Math.min(offset + 20, changes.length)} of ${changes.length}`;
    node('previous').disabled = running || offset === 0; node('next').disabled = running || offset + 20 >= changes.length;
    node('edit').textContent = plan?.edit ? `Name: “${plan.edit.oldName}” → “${plan.edit.newName}”. A verified backup is retained before publication.` : plan?.status === 'no-op' ? 'This plan needs no project write.' : 'No executable Name change is ready.';
    const cancelled = intent.state === 'cancelled' || Boolean(intent.retirement);
    const canEdit = editable.has(intent.state) && !cancelled;
    node('ack').disabled = running || !plan?.ready || !['ready', 'transaction-prepared'].includes(intent.state);
    node('apply').disabled = running || !node('ack').checked || !plan?.ready || !['ready', 'transaction-prepared'].includes(intent.state);
    node('refresh').disabled = running || !canEdit;
    node('cancel').disabled = running || !(intent.canCancel === true || canEdit || ['preparing-transaction', 'transaction-prepared'].includes(intent.state));
    node('recover').disabled = running || cancelled || !intent.transactionId && !['preparing-transaction', 'recovery-required'].includes(intent.state);
    const pending = !cancelled && ['pending-editor-validation', 'pending-rollback-editor-validation', 'recovery-required'].includes(intent.state);
    node('prepare-check').disabled = node('read-check').disabled = node('validate').disabled = running || !pending;
    node('rollback').disabled = running || cancelled || !intent.transactionId || ['rolled-back', 'transaction-prepared'].includes(intent.state);
    node('reveal').disabled = running || cancelled || !intent.transactionId;
    const currentCheck = !cancelled && s?.editorCheck?.intentId === intent.intentId ? s.editorCheck : null;
    node('editor').textContent = currentCheck?.menuName ? `Open this project in its matching Resolve library and run Workspace → Scripts → ${currentCheck.menuName}. Check status: ${currentCheck.status || 'prepared'}. Read the check here, then quit Resolve and finish validation.` : pending ? 'Select the project’s library, quit Resolve, then prepare a source-bound editor check. Validation requires the exact native project and a closed-project field comparison.' : '';
  }
  async function run(action, ...args) {
    if (busy) return; busy = true; render(state);
    try {
      let reply;
      if (action === 'prepare') reply = await api.prepareNativePull();
      else if (action === 'choose') reply = await api.chooseNativePull(state.intent.intentId, ...args);
      else { const method = ({'prepare-check': 'prepareNativePullEditorCheck', 'read-check': 'readNativePullEditorCheck', reveal: 'revealNativePullEditorCheck'})[action] || `${action}NativePull`; reply = await api[method](action === 'select' ? args[0] : state.intent.intentId); }
      render(reply);
    } catch { render({ ...state, error: 'This action could not be verified. Keep the retained plan and inspect recovery before continuing.' }); }
    finally { busy = false; render(state); }
  }
  for (const action of ['prepare','refresh','apply','recover','validate','rollback','cancel','prepare-check','read-check','reveal']) node(action).addEventListener('click', () => run(action));
  node('ack').addEventListener('change', () => render(state)); node('retained').addEventListener('change', () => { if (node('retained').value) { offset = 0; run('select', node('retained').value); } });
  node('previous').addEventListener('click', () => { offset = Math.max(0, offset - 20); render(state); }); node('next').addEventListener('click', () => { offset += 20; render(state); });
  document.addEventListener('native-checkpoint-state', e => { rolesReady = e.detail?.rolesReady === true; render(state); });
  for (const event of ['closed-apply-state', 'native-copy-state', 'media-relink-state']) document.addEventListener(event, () => render(state));
  api?.onNativePullState?.(render); api?.getNativePullState?.().then(render).catch(() => render({ error: 'Retained pull plans could not be read.' }));
})();
