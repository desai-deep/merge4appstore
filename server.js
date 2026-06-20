/**
 * merge4appstore webhook server
 *
 * Long-running HTTP server that submits builds to App Store review in response
 * to Xcode Cloud "build completed" webhooks, instead of polling on a cron.
 *
 * Required environment variables: same App Store Connect / GitHub / app vars as
 * index.js, plus:
 *   XCODE_WEBHOOK_SECRET  - shared secret authenticating Xcode Cloud webhooks
 *
 * Optional:
 *   WEBHOOK_PORT          - port to listen on (default 8090, bound to 127.0.0.1)
 *   WEBHOOK_RETRY_INTERVAL_MS - delay between deploy retries (default 180000)
 *   WEBHOOK_RETRY_MAX_ATTEMPTS - max deploy attempts per trigger (default 20)
 *   DRY_RUN=true          - run without making changes
 */

process.env.DOTENV_CONFIG_QUIET = 'true';

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

import { CONFIG, log } from './lib/config.js';
import { AppStoreConnectAPI } from './lib/app-store-connect.js';
import { GitHubAPI } from './lib/github.js';
import { acquireLock, releaseLock } from './lib/lock.js';
import { runDeployCheck } from './lib/deploy.js';
import { DeployRunner } from './lib/runner.js';
import { createWebhookServer } from './lib/server.js';

const DRY_RUN = process.env.DRY_RUN === 'true';

const requiredVars = [
  'APP_STORE_CONNECT_API_KEY_ID',
  'APP_STORE_CONNECT_ISSUER_ID',
  'APP_STORE_CONNECT_API_KEY_CONTENT',
  'APP_BUNDLE_ID',
  'APP_NAME',
  'GITHUB_REPO_OWNER',
  'GITHUB_REPO_NAME',
  'XCODE_WEBHOOK_SECRET',
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    log(`ERROR: Missing required environment variable: ${varName}`);
    process.exit(1);
  }
}

// Parse a positive-integer env var, falling back to the default (with a warning)
// when it's unset or not a valid number, so a typo can't crash startup.
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    log(`WARNING: ${name}="${raw}" is not a valid positive number - using default ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

const port = intFromEnv('WEBHOOK_PORT', 8090);
const intervalMs = intFromEnv('WEBHOOK_RETRY_INTERVAL_MS', 180000);
const maxAttempts = intFromEnv('WEBHOOK_RETRY_MAX_ATTEMPTS', 20);

const asc = new AppStoreConnectAPI(
  process.env.APP_STORE_CONNECT_API_KEY_ID,
  process.env.APP_STORE_CONNECT_ISSUER_ID,
  process.env.APP_STORE_CONNECT_API_KEY_CONTENT
);
const github = new GitHubAPI(CONFIG.repoOwner, CONFIG.repoName);

// One deploy attempt, guarded by the same on-disk lock the cron used so a manual
// `node index.js` run can't collide with a webhook-triggered run.
async function runOnce() {
  if (!acquireLock()) {
    log('Another run holds the lock - will retry shortly');
    return { status: 'busy' };
  }
  try {
    return await runDeployCheck(asc, github, DRY_RUN);
  } finally {
    releaseLock();
  }
}

const runner = new DeployRunner({ runOnce, intervalMs, maxAttempts, log });

const server = createWebhookServer({
  secret: process.env.XCODE_WEBHOOK_SECRET,
  onXcodeCloud: () => runner.trigger('xcode-cloud'),
  log,
});

server.listen(port, '127.0.0.1', () => {
  log(`=== merge4appstore webhook server ===`);
  log(`Listening on 127.0.0.1:${port}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log(`Retry policy: up to ${maxAttempts} attempts every ${Math.round(intervalMs / 1000)}s`);
});

function shutdown(signal) {
  log(`Received ${signal} - shutting down`);
  runner.stop();
  server.close(() => process.exit(0));
  // Don't hang forever if connections linger.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
