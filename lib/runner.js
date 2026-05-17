import { CONFIG, log } from './config.js';
import { AppStoreConnectAPI } from './app-store-connect.js';
import { GitHubAPI } from './github.js';
import { GitHubTags } from './git.js';
import { acquireLock, releaseLock } from './lock.js';
import { runDeployCheck } from './deploy.js';
import { runReleaseSync } from './sync.js';

export function validateEnv(mode = 'all') {
  const requiredVars = [
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
    'APP_BUNDLE_ID',
    'APP_NAME',
    'GITHUB_REPO_OWNER',
    'GITHUB_REPO_NAME',
  ];

  if (mode === 'deploy' || mode === 'all') {
    requiredVars.push('GH_TOKEN');
  }

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }
}

export function createClients() {
  const asc = new AppStoreConnectAPI(
    process.env.APP_STORE_CONNECT_API_KEY_ID,
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    process.env.APP_STORE_CONNECT_API_KEY_CONTENT
  );

  const github = new GitHubAPI(CONFIG.repoOwner, CONFIG.repoName);
  const tags = new GitHubTags(CONFIG.repoOwner, CONFIG.repoName);

  return { asc, github, tags };
}

export async function runMode(mode = 'all', { dryRun = false } = {}) {
  validateEnv(mode);

  if (!acquireLock()) {
    log('Another job instance is already running, skipping');
    return false;
  }

  try {
    const { asc, github, tags } = createClients();

    log('=== merge4appstore ===');
    log(`Mode: ${mode}`);
    if (dryRun) {
      log('DRY RUN MODE - No actual changes will be made');
    }

    if (mode === 'deploy' || mode === 'all') {
      await runDeployCheck(asc, github, dryRun);
    }

    if (mode === 'sync' || mode === 'all') {
      await runReleaseSync(asc, tags, github, dryRun);
    }

    log('=== Done ===');
    return true;
  } finally {
    releaseLock();
  }
}
