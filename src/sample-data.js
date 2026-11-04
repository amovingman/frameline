window.FRAME_SAMPLE = Object.freeze({
  project: { name: 'Launch film', branch: 'main', frameRate: 24, durationSeconds: 40, localRevision: 'v0.3', incomingRevision: 'v0.4' },
  clips: [
    { id: 'opening', code: 'A01', name: 'Alpine ridge', start: 0, duration: 12, track: 'V1' },
    { id: 'detail', code: 'A02', name: 'Frozen peaks', start: 12, duration: 13, track: 'V1', changeId: 'trim' },
    { id: 'closing', code: 'A03', name: 'Snowy summit', start: 25, duration: 15, track: 'V1', changeId: 'color' }
  ],
  changes: [
    {
      id: 'trim', clipId: 'detail', code: 'A02', title: 'Frozen peaks', kind: 'Trim · Out point', track: 'V1', status: 'Conflict',
      description: 'Both cuts changed the same out point. A trim decision is needed before this change can be applied.',
      base: '00:22:16', local: '00:23:12', incoming: '00:24:08',
      explanation: 'Local and incoming differ from their common base. Neither trim can be chosen automatically.'
    },
    {
      id: 'color', clipId: 'closing', code: 'A03', title: 'Snowy summit', kind: 'Color · Grade', track: 'V1', status: 'Ready',
      description: 'The incoming cut gives the snowy summit a warmer grade. Your cut did not change this property.',
      base: 'Neutral', local: 'Neutral', incoming: 'Warm',
      explanation: 'Only the incoming grade changed. This edit is ready to apply when project integration exists.'
    },
    {
      id: 'audio', clipId: 'music', code: 'A1', title: 'Music bed', kind: 'Audio · Level', track: 'A1', status: 'Ready',
      description: 'The incoming cut lowers the music bed. Your cut kept the level from the common base.',
      base: '−12 dB', local: '−12 dB', incoming: '−16 dB',
      explanation: 'Only the incoming level changed. This edit is ready to apply when project integration exists.'
    }
  ],
  revisions: [
    { id: 'v0.4', title: 'Product cut refinements', detail: 'Trim, grade, and music level changed', time: 'Incoming sample', state: 'Incoming' },
    { id: 'v0.3', title: 'First review cut', detail: 'Timeline assembled', time: 'Current sample', state: 'Current' },
    { id: 'v0.2', title: 'Rough assembly', detail: 'Media linked and opening added', time: 'Earlier sample', state: '' },
    { id: 'v0.1', title: 'Project created', detail: 'Sequence settings established', time: 'First sample', state: '' }
  ],
  media: [
    { name: 'alpine-ridge.mov', track: 'V1', format: '4K video', availability: 'Sample only' },
    { name: 'frozen-peaks.mov', track: 'V1', format: '4K video', availability: 'Sample only' },
    { name: 'snowy-summit.mov', track: 'V1', format: '4K video', availability: 'Sample only' },
    { name: 'music-bed.wav', track: 'A1', format: 'WAV audio', availability: 'Sample only' }
  ]
});

console.assert(window.FRAME_SAMPLE.clips.reduce((total, clip) => total + clip.duration, 0) === window.FRAME_SAMPLE.project.durationSeconds, 'Sample clip lengths must match sequence duration');
console.assert(window.FRAME_SAMPLE.changes.filter(change => change.status === 'Conflict').length === 1, 'Sample conflict count must match the workspace finding');
