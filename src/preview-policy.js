function fail(code) { const error = new Error(code); error.code = code; return error; }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

// Preview permissions are separate from canonical revision and asset records.
// A project must explicitly opt in before any rendering job is enqueued.
function createPreviewPolicy({ authorize, initialState = null } = {}) {
  if (typeof authorize !== 'function') throw fail('preview-policy-invalid');
  const state = initialState ? structuredClone(initialState) : { version: 1, enabledProjects: [] };
  if (state.version !== 1 || !Array.isArray(state.enabledProjects)
    || state.enabledProjects.some(id => !ID.test(id)) || new Set(state.enabledProjects).size !== state.enabledProjects.length) throw fail('preview-policy-invalid');
  function enabled(projectId) {
    if (!ID.test(projectId) || authorize(projectId, 'read') !== true) throw fail('preview-policy-forbidden');
    return state.enabledProjects.includes(projectId);
  }
  function setEnabled(projectId, value) {
    if (!ID.test(projectId) || authorize(projectId, 'write') !== true) throw fail('preview-policy-forbidden');
    if (typeof value !== 'boolean') throw fail('preview-policy-invalid');
    state.enabledProjects = state.enabledProjects.filter(id => id !== projectId);
    if (value) state.enabledProjects.push(projectId);
    return { projectId, enabled: value };
  }
  async function enqueue(queue, job) {
    if (!queue || typeof queue.enqueue !== 'function' || !job
      || !['thumbnail', 'timeline-preview'].includes(job.kind)) throw fail('preview-job-invalid');
    if (!enabled(job.projectId)) throw fail('preview-disabled');
    if (job.options?.rightsConfirmed !== true) throw fail('preview-rights-required');
    return queue.enqueue(job);
  }
  return { enabled, setEnabled, enqueue, snapshot: () => structuredClone(state) };
}

module.exports = { createPreviewPolicy };
