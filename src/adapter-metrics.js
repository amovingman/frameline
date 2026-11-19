const KNOWN_ERRORS = new Set(['scan-cancelled', 'unsupported-format', 'file-unavailable', 'file-access-denied',
  'file-busy', 'file-too-large', 'malformed-xml', 'unsupported-structure', 'unsupported-fcpxml-version',
  'unsupported-timing']);

// Session-local aggregate only. No source paths, media names, or network sink.
function createAdapterMetrics({ now = () => Date.now() } = {}) {
  let attempts = 0, succeeded = 0, failed = 0, cancelled = 0, totalDurationMs = 0;
  const recentDurations = [];
  const errorCodes = {};
  function wrapScan(scan) {
    if (typeof scan !== 'function') throw new TypeError('A scan function is required');
    return async (filePath, options) => {
      attempts++;
      const start = now();
      try {
        const result = await scan(filePath, options);
        succeeded++;
        return result;
      } catch (error) {
        const code = KNOWN_ERRORS.has(error?.code) ? error.code : 'scan-failed';
        if (code === 'scan-cancelled') cancelled++;
        else { failed++; errorCodes[code] = (errorCodes[code] || 0) + 1; }
        throw error;
      } finally {
        const duration = Math.max(0, now() - start);
        totalDurationMs += duration;
        recentDurations.push(duration);
        if (recentDurations.length > 128) recentDurations.shift();
      }
    };
  }
  function snapshot() {
    const sorted = [...recentDurations].sort((a, b) => a - b);
    const percentile = fraction => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]) : null;
    return { attempts, succeeded, failed, cancelled,
      averageDurationMs: attempts ? Math.round(totalDurationMs / attempts) : null,
      recentSampleCount: sorted.length, recentP50Ms: percentile(0.5), recentP95Ms: percentile(0.95),
      errorCodes: { ...errorCodes } };
  }
  return { wrapScan, snapshot };
}

module.exports = { createAdapterMetrics, KNOWN_ERRORS };
