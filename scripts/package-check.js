const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
if (manifest.main !== 'src/main.js' || !manifest.private || !manifest.version) throw new Error('Package manifest is not release-ready');
const requiredFiles = ['src/main.js', 'src/preload.js', 'src/index.html', 'src/styles.css',
  'src/frame-timecode.js', 'src/resolve-change-context.js', 'src/resolve-review-risk-policy.js', 'src/resolve-comparison-renderer.js',
  'src/resolve-deletion-policy.js', 'src/resolve-placement-policy.js', 'src/resolve-review-guidance.js', 'src/resolve-policy-renderer.js',
  'src/first-run.js', 'src/desktop-onboarding.js', 'src/diagnostics-report.js', 'src/desktop-diagnostics.js', 'src/setup-support-renderer.js',
  'src/shared-storage-protocol.js', 'src/shared-storage-volume.js', 'src/shared-storage-store.js',
  'src/asset-lifecycle-protocol.js', 'src/service-asset-lifecycle.js', 'src/asset-lifecycle-cli.js',
  'src/desktop-asset-lifecycle.js', 'src/asset-lifecycle-intents.js', 'src/asset-lifecycle-renderer.js',
  'src/asset-jobs-protocol.js', 'src/service-asset-jobs.js', 'src/asset-verification-worker.js', 'src/asset-jobs-cli.js',
  'src/desktop-shared-storage.js', 'src/shared-storage-renderer.js',
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
  'src/desktop-resolve-service-sync.js', 'src/desktop-resolve-comments.js',
  'src/service-review-comments.js', 'src/review-comments-protocol.js',
  'src/service-branch-protection.js', 'src/branch-review-protocol.js', 'src/desktop-branch-review.js',
  'src/service-share-links.js', 'src/share-links-protocol.js', 'src/desktop-share-links.js',
  'src/share-viewer.js', 'src/share-viewer.html', 'src/share-viewer-client.js', 'src/share-viewer.css',
  'src/service-notifications.js', 'src/notification-protocol.js', 'src/desktop-account-updates.js',
  'src/notification-worker.js', 'src/smtp-notification-sender.js',
  'src/service-project-presets.js', 'src/project-presets-protocol.js', 'src/desktop-project-presets.js', 'src/project-preset-intents.js',
  'src/unsubscribe-viewer.js', 'src/unsubscribe-viewer.html', 'src/unsubscribe-viewer-client.js',
  'src/service-host.js', 'src/service-host-config.js', 'src/service-host-cli.js',
  'src/service-admin.js', 'src/service-admin-cli.js',
  'src/durable-asset-service.js', 'src/asset-http-transport.js', 'src/asset-http-client.js',
  'src/asset-file-transfer.js', 'src/desktop-asset-transfers.js',
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
