const { parentPort, workerData } = require('node:worker_threads');
const { fingerprintFile } = require('./local-media-readiness');
fingerprintFile(workerData.filename, { onProgress: value => parentPort.postMessage({ progress: value }) })
  .then(result => parentPort.postMessage({ result }))
  .catch(error => parentPort.postMessage({ error: error.code || 'read-failed' }));
