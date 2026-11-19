(() => {
  const make = (tag, id) => { const node = document.createElement(tag); node.id = id; return node; };
  const section = make('section', 'product-truth'); section.className = 'product-truth'; section.setAttribute('aria-labelledby', 'product-truth-title');
  const title = make('h2', 'product-truth-title'), detail = make('p', 'product-truth-detail'), service = make('p', 'product-truth-service');
  section.append(title, detail, service);
  document.querySelector('.workspace-bar').after(section);
  function render() {
    const view = document.querySelector('.view.active')?.id.replace('view-', '') || 'workspace';
    const model = window.ProductTruth.describeProductTruth({ view,
      appState: typeof currentAppState === 'undefined' ? null : currentAppState,
      resolveState: typeof resolveState === 'undefined' ? null : resolveState,
      serviceState: typeof serviceState === 'undefined' ? null : serviceState });
    section.dataset.sourceKind = model.sourceKind; section.dataset.view = model.view;
    title.textContent = model.title; detail.textContent = model.detail;
    service.textContent = model.service.text; service.hidden = !['history', 'media', 'resolve'].includes(view);
    const sample = model.sourceKind === 'sample';
    const nav = document.querySelector('.nav-count');
    if (nav && !currentAppState?.selectedProject) nav.setAttribute('aria-label', `${nav.textContent || '0'} sample proposed edits`);
    const option = document.querySelector('#resolve-filter option[value="already-applied"]');
    if (option) option.textContent = 'Matching observations';
    const action = document.querySelector('.pull-action p');
    if (action) action.textContent = 'These sample destination choices do not run a pull. Applying project changes remains unavailable.';
    const fileNotice = document.getElementById('file-notice');
    if (view === 'resolve' && fileNotice && !fileNotice.hidden && fileNotice.textContent
      && !fileNotice.textContent.startsWith('FCPXML export: ')) fileNotice.textContent = `FCPXML export: ${fileNotice.textContent}`;
    // The source explanation sits next to content; sample demonstration controls
    // remain usable, while ordinary write actions stay explicitly unavailable.
    section.dataset.sample = String(sample);
  }
  window.FramelineProductTruth = { render };
  render();
})();
