(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrameTimecode = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const SUPPORTED_RATES = Object.freeze(['24', '24000/1001', '25', '30', '30000/1001', '50', '60', '60000/1001']);
  const nominal = { '24': 24, '24000/1001': 24, '25': 25, '30': 30, '30000/1001': 30, '50': 50, '60': 60, '60000/1001': 60 };
  function formatFrameTimecode(frame, options = {}) {
    if (!Number.isSafeInteger(frame)) return 'Frame not observed; timecode unavailable';
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['rate', 'originFrame'].includes(key))) return `Frame ${frame}; timecode unavailable (invalid display settings)`;
    const rate = options.rate ?? null, origin = Object.hasOwn(options, 'originFrame') ? options.originFrame : 0;
    if (!Number.isSafeInteger(origin)) return `Frame ${frame}; timecode unavailable (origin not observed)`;
    const relative = BigInt(frame) - BigInt(origin);
    const coordinate = `Frame ${frame} · timeline ${relative >= 0n ? '+' : ''}${relative}f`;
    if (rate === null || rate === '') return `${coordinate}; SMPTE unavailable (frame rate not captured)`;
    if (!SUPPORTED_RATES.includes(rate)) return `${coordinate}; timecode unavailable (unsupported display rate)`;
    const sign = relative < 0n ? '-' : '', frames = relative < 0n ? -relative : relative;
    const fps = BigInt(nominal[rate]), seconds = frames / fps;
    const pad = value => String(value).padStart(2, '0');
    const label = `${sign}${pad(seconds / 3600n)}:${pad(seconds / 60n % 60n)}:${pad(seconds % 60n)}:${pad(frames % fps)}`;
    return `${coordinate} · timeline-relative ${label} NDF (${rate} fps, user-selected display rate)`;
  }
  return Object.freeze({ formatFrameTimecode, SUPPORTED_RATES });
});
