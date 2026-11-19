'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
function buildMediaRenderer({ output = path.resolve(__dirname, '../src/native/bin/media-renderer'), universal = false, ifMissing = false, ifSupported = false } = {}) {
  if (process.platform !== 'darwin') { if (ifSupported) return null; throw new Error('native-media-build-unavailable'); }
  if (!path.isAbsolute(output)) throw new Error('native-media-build-unavailable');
  const source = path.resolve(__dirname, '../src/native/media-renderer.swift');
  if (ifMissing) {
    try {
      const stat = fs.lstatSync(output);
      if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) && stat.mtimeMs >= fs.statSync(source).mtimeMs) {
        const ping = spawnSync(output, [], { input: JSON.stringify({ operation: 'ping' }), encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
        const value = JSON.parse(ping.stdout);
        if (ping.status === 0 && value.provider === 'apple-native' && value.version === 1 && value.canonical === false) return output;
      }
    } catch {}
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-native-build-'));
  try {
    const products = [];
    for (const architecture of universal ? ['arm64', 'x86_64'] : [process.arch === 'arm64' ? 'arm64' : 'x86_64']) {
      const binary = path.join(directory, architecture);
      const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(directory, 'modules'), '-swift-version', '5', '-O', '-target', `${architecture}-apple-macosx13.0`,
        source, '-o', binary], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`native-media-build-failed\n${result.stderr}`);
      products.push(binary);
    }
    const compiled = path.join(directory, 'renderer');
    if (products.length > 1) {
      const result = spawnSync('/usr/bin/xcrun', ['lipo', '-create', ...products, '-output', compiled], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('native-media-build-failed');
    } else fs.copyFileSync(products[0], compiled);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const temporary = `${output}.${randomUUID()}.tmp`; fs.copyFileSync(compiled, temporary); fs.chmodSync(temporary, 0o700); fs.renameSync(temporary, output);
    return output;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
if (require.main === module) {
  const args = process.argv.slice(2), index = args.indexOf('--output');
  try { console.log(buildMediaRenderer({ output: index < 0 ? undefined : path.resolve(args[index + 1]), universal: args.includes('--universal'),
    ifMissing: args.includes('--if-missing'), ifSupported: args.includes('--if-supported') }) || 'native-media-build-unavailable'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildMediaRenderer };
