#!/usr/bin/env node

/**
 * merge2fly - iOS App Store Deployment & Release Sync
 *
 * Combined script that:
 * 1. Monitors TestFlight builds and submits them to App Store review (deploy)
 * 2. Tags releases when they go live in the App Store (release sync)
 *
 * Usage:
 *   node index.js                    # Run both operations
 *   node index.js deploy             # Run only deployment check
 *   node index.js sync               # Run only release sync
 *   DRY_RUN=true node index.js       # Dry run mode
 *
 * Required environment variables:
 *   APP_STORE_CONNECT_API_KEY_ID      - App Store Connect API Key ID
 *   APP_STORE_CONNECT_ISSUER_ID       - App Store Connect Issuer ID
 *   APP_STORE_CONNECT_API_KEY_CONTENT - API private key (base64 encoded)
 *   GH_TOKEN                          - GitHub token for PR comments (used by gh CLI)
 *   APP_BUNDLE_ID                     - Your app's bundle identifier
 *   APP_NAME                          - App name (must match App Store Connect)
 *   GITHUB_REPO_OWNER                 - GitHub org/user
 *   GITHUB_REPO_NAME                  - GitHub repo name
 *
 * Optional environment variables:
 *   APP_ID                            - App Store Connect app ID (if bundle ID matches multiple apps)
 *   XCODE_WORKFLOW_ID                 - Xcode Cloud workflow ID to filter builds
 *   IOS_REPO_PATH                     - Path to iOS git repo (only needed for release sync tagging)
 *   DRY_RUN=true                      - Run without making changes
 */

// Suppress dotenv logging
process.env.DOTENV_CONFIG_QUIET = 'true';

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });

// Import modules
import { CONFIG, log } from './lib/config.js';
import { AppStoreConnectAPI } from './lib/app-store-connect.js';
import { GitHubAPI } from './lib/github.js';
import { GitOperations } from './lib/git.js';
import { acquireLock, releaseLock } from './lib/lock.js';
import { runDeployCheck } from './lib/deploy.js';
import { runReleaseSync } from './lib/sync.js';

async function main() {
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const args = process.argv.slice(2);
  const mode = args[0] || 'all'; // 'deploy', 'sync', or 'all'

  // Acquire lock
  if (!acquireLock()) {
    log('Another instance is already running, exiting');
    process.exit(0);
  }

  // Ensure lock is released on exit
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  log('=== merge2fly ===');
  log(`Mode: ${mode}`);
  if (DRY_RUN) {
    log('DRY RUN MODE - No actual changes will be made');
  }

  // Validate required environment variables
  const requiredVars = [
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
    'APP_BUNDLE_ID',
    'APP_NAME',
    'GITHUB_REPO_OWNER',
    'GITHUB_REPO_NAME',
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      log(`ERROR: Missing required environment variable: ${varName}`);
      process.exit(1);
    }
  }

  // IOS_REPO_PATH is only required for sync mode
  if (mode === 'sync' || mode === 'all') {
    if (!process.env.IOS_REPO_PATH) {
      log('Warning: IOS_REPO_PATH not set - release sync will be skipped');
    }
  }

  // Initialize clients
  const asc = new AppStoreConnectAPI(
    process.env.APP_STORE_CONNECT_API_KEY_ID,
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    process.env.APP_STORE_CONNECT_API_KEY_CONTENT
  );

  const github = new GitHubAPI(CONFIG.iosRepoOwner, CONFIG.iosRepoName);
  const git = CONFIG.iosRepoPath ? new GitOperations(CONFIG.iosRepoPath) : null;

  try {
    // Run deploy check
    if (mode === 'deploy' || mode === 'all') {
      await runDeployCheck(asc, github, DRY_RUN);
    }

    // Run release sync
    if (mode === 'sync' || mode === 'all') {
      if (git) {
        await runReleaseSync(asc, git, github, DRY_RUN);
      }
    }

    log('=== Done ===');

  } catch (error) {
    log(`ERROR: ${error.message}`);
    if (error.stack) {
      log(`Stack: ${error.stack.split('\n').slice(1, 4).join('\n')}`);
    }
    process.exit(1);
  }
}

main();
