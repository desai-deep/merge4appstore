#!/usr/bin/env node

/**
 * merge4appstore - iOS App Store Deployment & Release Sync
 *
 * Combined script that:
 * 1. Monitors TestFlight builds on Xcode Cloud and submits them to App Store review (deploy)
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

import { log } from './lib/config.js';
import { runMode } from './lib/runner.js';

async function main() {
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const args = process.argv.slice(2);
  const mode = args[0] || 'all'; // 'deploy', 'sync', or 'all'

  try {
    await runMode(mode, { dryRun: DRY_RUN });
  } catch (error) {
    log(`ERROR: ${error.message}`);
    if (error.stack) {
      log(`Stack: ${error.stack.split('\n').slice(1, 4).join('\n')}`);
    }
    process.exit(1);
  }
}

main();
