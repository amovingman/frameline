(() => {
  const element = id => document.getElementById(id);
  const desktop = window.desktop;
  let onboarding = null, setupBusy = false, reviewed = null, diagnosticsBusy = false;
  function renderSetup(state) {
    if (!state) return;
    const nameChanged = !onboarding || state.workspaceName !== onboarding.workspaceName;
    onboarding = state;
    element('first-run').hidden = state.completed === true;
    if (nameChanged) element('first-run-workspace').value = state.workspaceName;
    element('first-run-directory').textContent = state.workspaceDirectory;
    document.querySelector('.project-context div > span').textContent = state.workspaceName;
    document.querySelector('.project-context div > span').title = state.workspaceDirectory;
    element('first-run-choose-directory').disabled = setupBusy || state.storageLocked;
    element('first-run-default-directory').disabled = setupBusy || state.storageLocked;
  }
  function setupControls(busy) {
    setupBusy = busy;
    element('first-run-form').setAttribute('aria-busy', String(busy));
    for (const input of element('first-run-form').querySelectorAll('input, select, button')) input.disabled = busy;
    if (onboarding) renderSetup(onboarding);
  }
  const setupError = code => code === 'workspace-locked' || code === 'workspace-busy'
    ? 'A project has already opened. Keep this storage location and choose your project again.'
    : code === 'first-run-invalid' ? 'Enter a workspace name of up to 60 characters without slashes.'
      : 'Could not use this workspace. Reconnect the folder or choose another writable location.';
  async function refreshSetup() {
    try { renderSetup(await desktop?.getFirstRun?.()); }
    catch { element('first-run').hidden = false; element('first-run-status').textContent = 'Could not read workspace settings. Reopen Frameline and try again.'; }
  }
  for (const [id, method] of [['first-run-choose-directory', 'chooseWorkspaceDirectory'], ['first-run-default-directory', 'useDefaultWorkspaceDirectory']]) {
    element(id).addEventListener('click', async () => {
      setupControls(true);
      try {
        const result = await desktop[method]();
        if (result.error) element('first-run-status').textContent = setupError(result.error);
        else { renderSetup(result.state); element('first-run-status').textContent = 'Storage choice ready. Choose your project to finish setup.'; }
      } catch { element('first-run-status').textContent = setupError(); }
      finally { setupControls(false); }
    });
  }
  element('first-run-form').addEventListener('submit', async event => {
    event.preventDefault();
    const selection = { editor: element('first-run-editor').value, workspaceName: element('first-run-workspace').value };
    setupControls(true);
    try {
      const result = await desktop.saveFirstRun(selection);
      if (result.error) { element('first-run-status').textContent = setupError(result.error); return; }
      renderSetup(result.state);
      element('first-run-status').textContent = 'Choose an FCPXML 1.10 export. Cancelling keeps your workspace choices.';
      await chooseFile();
      await refreshSetup();
    } catch { element('first-run-status').textContent = setupError(); }
    finally { setupControls(false); }
  });
  element('first-run-skip').addEventListener('click', () => { element('first-run').hidden = true; });
  window.addEventListener('frameline:project-chosen', async event => {
    await refreshSetup();
    if (event.detail?.onboardingError) element('first-run-status').textContent = 'Project opened, but setup could not be saved. Choose the project again to retry.';
  });
  refreshSetup();

  const privacyOptions = () => ({ includeProject: element('diagnostics-project').checked, includeAdapter: element('diagnostics-adapter').checked });
  function invalidateReview() {
    reviewed = null;
    element('diagnostics-confirm').checked = false;
    element('diagnostics-export').disabled = true;
    element('diagnostics-preview').hidden = true;
  }
  function diagnosticsControls(busy) {
    diagnosticsBusy = busy;
    element('diagnostics-panel').setAttribute('aria-busy', String(busy));
    for (const id of ['diagnostics-review', 'diagnostics-project', 'diagnostics-adapter', 'diagnostics-confirm']) element(id).disabled = busy;
    element('diagnostics-export').disabled = busy || !reviewed || !element('diagnostics-confirm').checked;
  }
  for (const id of ['diagnostics-project', 'diagnostics-adapter']) element(id).addEventListener('change', () => {
    invalidateReview(); element('diagnostics-status').textContent = 'Details changed. Review the updated report before exporting.';
  });
  element('diagnostics-confirm').addEventListener('change', () => diagnosticsControls(diagnosticsBusy));
  element('diagnostics-review').addEventListener('click', async () => {
    invalidateReview(); diagnosticsControls(true);
    try {
      reviewed = await desktop.previewDiagnostics(privacyOptions());
      element('diagnostics-content').textContent = `${JSON.stringify(reviewed.report, null, 2)}\n`;
      element('diagnostics-hash').textContent = `SHA-256: ${reviewed.sha256}`;
      element('diagnostics-preview').hidden = false;
      element('diagnostics-status').textContent = 'Review the exact report, then approve saving it.';
      element('diagnostics-content').focus();
    } catch { element('diagnostics-status').textContent = 'Diagnostics are unavailable. Review the report again after the app starts.'; }
    finally { diagnosticsControls(false); }
  });
  element('diagnostics-export').addEventListener('click', async () => {
    if (!reviewed || !element('diagnostics-confirm').checked || diagnosticsBusy) return;
    diagnosticsControls(true);
    try {
      const result = await desktop.exportDiagnostics({ reviewId: reviewed.reviewId, sha256: reviewed.sha256, confirmed: true });
      if (result.saved) { invalidateReview(); element('diagnostics-status').textContent = `Reviewed diagnostics saved (${result.byteLength} bytes). Share the file only if you choose to.`; }
      else if (result.cancelled) element('diagnostics-status').textContent = 'Export cancelled. Your reviewed report is still available.';
      else if (['diagnostics-changed', 'diagnostics-review-required'].includes(result.error)) {
        invalidateReview(); element('diagnostics-status').textContent = 'App state changed. Review the report again before exporting.';
      } else element('diagnostics-status').textContent = 'Could not save diagnostics. Choose a new filename and try again.';
    } catch { element('diagnostics-status').textContent = 'Could not save diagnostics. Try again.'; }
    finally { diagnosticsControls(false); }
  });
})();
