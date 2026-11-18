const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
if (manifest.main !== 'src/main.js' || !manifest.private || !manifest.version) throw new Error('Package manifest is not release-ready');
const requiredFiles = ['src/main.js', 'src/preload.js', 'src/index.html', 'src/styles.css',
  'src/companion/resolve-internal.py', 'src/companion/resolve_snapshot.py',
  'src/companion/resolve-internal.lua', 'src/resolve-menu-companion.js',
  'src/companion/resolve-effects.lua', 'src/resolve-effect-observation.js', 'src/resolve-effect-console.js',
  'src/resolve-property-observation.js', 'src/resolve-property-contract.json',
  'src/resolve-observation-values.js', 'src/resolve-observation-three-way.js',
  'src/resolve-preview-source.js', 'src/resolve-capture-file.js',
  'src/media-audit-jobs.js', 'src/media-job-queue.js', 'src/media-audit-view.js',
  'src/revision-http-client.js', 'src/revision-http-transport.js', 'src/revision-sync-async.js',
  'src/durable-collaboration-service.js', 'src/identity-service.js', 'src/access-control.js',
  'src/desktop-service-connection.js', 'src/desktop-revision-sync.js', 'src/credential-vault.js',
  'src/resolve-trial-discovery.js', 'src/resolve-trial-session.js', 'src/resolve-rename-trial.js', 'src/resolve-trial-history.js',
  'src/resolve-portable-trial-audit.js', 'src/resolve-audit-history.js',
  'src/resolve-history-transfer.js',
  'src/assets/fonts/ibm-plex-sans-latin-400-normal.woff2', 'src/assets/visuals/mountain-alps.jpg'];
for (const file of requiredFiles) {
  if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing packaged file: ${file}`);
}
if (!fs.existsSync(require('electron'))) throw new Error('Electron binary is unavailable');
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-pack-cache-'));
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache }
  }))[0];
  const files = new Set(result.files.map(item => item.path));
  if (!files.has('package.json') || requiredFiles.some(file => !files.has(file))
    || [...files].some(file => !file.startsWith('src/') && !['package.json', 'README.md', 'LICENSE'].includes(file))) {
    throw new Error('Unexpected package contents');
  }
} finally { fs.rmSync(cache, { recursive: true, force: true }); }
console.log('Package inputs and archive contents verified. Installer signing remains a separate gate.');
