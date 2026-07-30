import chokidar from 'chokidar';
import { execSync } from 'child_process';
import path from 'path';

const WORKSPACE = '/home/runner/workspace';
const SYNC_SCRIPT = path.join(WORKSPACE, 'source-code/sync.sh');

const watchPaths = [
  path.join(WORKSPACE, 'artifacts/api-server/src'),
  path.join(WORKSPACE, 'artifacts/api-server/public'),
  path.join(WORKSPACE, 'artifacts/dashboard/src'),
  path.join(WORKSPACE, 'lib/db/src'),
  path.join(WORKSPACE, 'addon'),
  path.join(WORKSPACE, 'doctrine-integration'),
  path.join(WORKSPACE, 'lib/api-spec/openapi.yaml'),
];

let syncTimeout = null;

function debouncedSync() {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    try {
      execSync(`bash ${SYNC_SCRIPT}`, { stdio: 'inherit' });
    } catch (e) {
      console.error('Sync failed:', e.message);
    }
  }, 1000);
}

console.log('Running initial sync...');
execSync(`bash ${SYNC_SCRIPT}`, { stdio: 'inherit' });

console.log('Watching for source code changes...');
const watcher = chokidar.watch(watchPaths, {
  ignored: /(node_modules|dist|\.tsbuildinfo|source-code)/,
  persistent: true,
  ignoreInitial: true,
});

watcher
  .on('change', (p) => { console.log(`Changed: ${p}`); debouncedSync(); })
  .on('add', (p) => { console.log(`Added: ${p}`); debouncedSync(); })
  .on('unlink', (p) => { console.log(`Removed: ${p}`); debouncedSync(); });
