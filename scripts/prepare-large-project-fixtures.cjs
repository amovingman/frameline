'use strict';
// Disposable synthetic corpus inputs. These are not observed customer projects.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
async function prepare(directory, { includeTypical = false, includeStress = false } = {}) {
  const definitions = [['small', 50, 48, 50]];
  if (includeTypical) definitions.push(['typical', 500, 48, 500]);
  if (includeStress) definitions.push(['large', 10000, 12, 1]);
  const mediaLimit = Math.max(...definitions.map(item => item[3]));
  await fs.mkdir(directory, { mode: 0o700 });
  const media = path.join(directory, 'media'); await fs.mkdir(media, { mode: 0o700 });
  const seed = path.join(media, 'asset-00001-still.png');
  await fs.copyFile(path.join(__dirname, '../phase-0/media-jobs-desktop/native-thumbnail.png'), seed);
  for (let index = 2; index <= mediaLimit; index++) await fs.link(seed, path.join(media, `asset-${String(index).padStart(5, '0')}-still.png`));
  const cases = [];
  for (const [name, count, duration, mediaCount] of definitions) {
    const assets = [], clips = [];
    for (let index = 0; index < mediaCount; index++) {
      const label = `asset-${String(index + 1).padStart(5, '0')}-still.png`;
      assets.push(`<asset id="a${index}" name="${label}" format="r2" start="0s" duration="2s" hasVideo="1" hasAudio="0"><media-rep kind="original-media" src="${pathToFileURL(path.join(media, label)).href}"/></asset>`);
    }
    for (let index = 0; index < count; index++) {
      clips.push(`<asset-clip name="${name} clip ${index + 1}" ref="a${index % mediaCount}" offset="${index * duration}/24s" start="0s" duration="${duration}/24s"/>`);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml><fcpxml version="1.10"><resources><format id="r1" name="FFVideoFormat1080p24" frameDuration="1/24s" width="1920" height="1080"/><format id="r2" name="FFVideoFormatRateUndefined" width="640" height="360"/>${assets.join('')}</resources><library><event name="Frameline disposable performance corpus"><project name="Frameline ${name} ${count} clips"><sequence format="r1" duration="${count * duration}/24s" tcStart="0s" tcFormat="NDF"><spine>${clips.join('')}</spine></sequence></project></event></library></fcpxml>`;
    const filename = path.join(directory, `${name}-input.fcpxml`); await fs.writeFile(filename, xml, { flag: 'wx', mode: 0o600 });
    cases.push({ name, count, mediaCount, durationFrames: count * duration, input: filename, inputSha256: createHash('sha256').update(xml).digest('hex'), output: path.join(directory, `${name}-editor.fcpxmld`) });
  }
  const tag = path.basename(directory).slice(-8);
  const result = { directory, projectName: `Frameline Large Scan Proof 20261119 ${tag}`, cases };
  await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
}
if (require.main === module) {
  const directory = process.argv[2];
  if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute, new disposable directory is required');
  prepare(directory, { includeTypical: process.argv.includes('--include-typical'), includeStress: process.argv.includes('--include-stress') }).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.code || 'fixture-prepare-failed'); process.exitCode = 1; });
}
module.exports = { prepare };
