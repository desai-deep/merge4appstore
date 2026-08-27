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
 *   node index.js expire             # Expire builds from closed PRs targeting BETA_BRANCH
 *   node index.js trigger            # Trigger a configured build purpose
 *   node index.js notes              # Refresh TestFlight notes after a PR body edit
 *   node index.js --config profiles/my-app.env
 *   node index.js --profile profiles/my-repository.yml
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
 *   PRODUCTION_BRANCH                 - Branch whose workflow builds ship (default: main)
 *   BETA_BRANCH                       - Branch to trigger after a release (default: develop)
 *   INSTANCE_NAME                     - Unique lock/log name for this app
 *   EXPIRE_MERGED_BUILDS=true         - Run closed-PR expiry during the default mode
 *   DRY_RUN=true                      - Run without making changes
 */

// Suppress dotenv logging
process.env.DOTENV_CONFIG_QUIET = 'true';

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parseCliArgs } from './lib/cli.js';
import {
  applyAutomationProfile,
  applyBuildPurposeProfile,
  applyRepositoryProfile,
  loadRepositoryProfile,
} from './lib/profile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cli;
try {
  cli = parseCliArgs(process.argv.slice(2), __dirname);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}

const dotenvResult = dotenv.config({ path: cli.configPath });
const missingOptionalProfileEnv = cli.profilePath && dotenvResult.error?.code === 'ENOENT';
if (dotenvResult.error && !missingOptionalProfileEnv) {
  console.error(`ERROR: Could not load config file ${cli.configPath}: ${dotenvResult.error.message}`);
  process.exit(1);
}

let repositoryProfile = null;
if (cli.profilePath) {
  try {
    repositoryProfile = loadRepositoryProfile(cli.profilePath);
    applyRepositoryProfile(repositoryProfile);
  } catch (error) {
    console.error(`ERROR: Could not load repository profile ${cli.profilePath}: ${error.message}`);
    process.exit(1);
  }
}

// Import modules
import { CONFIG, log } from './lib/config.js';
import { AppStoreConnectAPI } from './lib/app-store-connect.js';
import { GitHubAPI } from './lib/github.js';
import { GitHubTags } from './lib/git.js';
import { acquireLock, releaseLock } from './lib/lock.js';
import { runDeployCheck } from './lib/deploy.js';
import { runReleaseSync } from './lib/sync.js';
import { runClosedPRBuildExpiry } from './lib/expire.js';
import { XcodeCloudBuildProvider } from './lib/build-provider.js';
import { buildIntentFromEnvironment, runManagedBuildTrigger, waitForBuildCompletion } from './lib/trigger.js';
import { refreshTestFlightNotes } from './lib/refresh-notes.js';

async function main() {
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const { mode } = cli;

  // Acquire lock
  if (!acquireLock()) {
    log('Another instance is already running, exiting');
    process.exit(0);
  }

  // Ensure lock is released on exit
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  log('=== merge4appstore ===');
  log(`Mode: ${mode}`);
  log(`Config: ${cli.configPath}`);
  if (cli.profilePath) log(`Profile: ${cli.profilePath}`);
  if (DRY_RUN) {
    log('DRY RUN MODE - No actual changes will be made');
  }

  // Validate required environment variables
  const requiredSharedVars = [
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
    'GITHUB_REPO_OWNER',
    'GITHUB_REPO_NAME',
  ];

  if (!repositoryProfile) requiredSharedVars.push('APP_BUNDLE_ID', 'APP_NAME');

  for (const varName of requiredSharedVars) {
    if (!process.env[varName]) {
      log(`ERROR: Missing required environment variable: ${varName}`);
      process.exit(1);
    }
  }

  const createClients = () => ({
    asc: new AppStoreConnectAPI(
      process.env.APP_STORE_CONNECT_API_KEY_ID,
      process.env.APP_STORE_CONNECT_ISSUER_ID,
      process.env.APP_STORE_CONNECT_API_KEY_CONTENT
    ),
    github: new GitHubAPI(CONFIG.repoOwner, CONFIG.repoName, CONFIG.productionBranch),
    tags: new GitHubTags(CONFIG.repoOwner, CONFIG.repoName),
  });

  const selectAutomation = name => {
    if (!repositoryProfile) return { enabled: true, appRole: 'legacy' };
    const automation = applyAutomationProfile(repositoryProfile, name);
    if (!automation.enabled) log(`Skipping disabled ${name} automation`);
    else log(`${name}: using ${automation.appRole} app (${automation.appName}, ${automation.appId})`);
    return automation;
  };

  try {
    if (mode === 'notes') {
      if (!repositoryProfile) throw new Error('notes mode requires --profile');
      for (const name of ['BUILD_COMMIT_SHA', 'BUILD_BRANCH']) {
        if (!process.env[name]) throw new Error(`notes mode requires ${name}`);
      }
      const purpose = process.env.BUILD_PURPOSE || 'pull_request';
      const build = applyBuildPurposeProfile(repositoryProfile, purpose);
      const { asc, github } = createClients();
      await refreshTestFlightNotes(asc, github, build, {
        commit: process.env.BUILD_COMMIT_SHA,
        branch: process.env.BUILD_BRANCH,
        pull_request: process.env.BUILD_PULL_REQUEST || null,
      }, DRY_RUN);
    }

    if (mode === 'trigger') {
      if (!repositoryProfile) {
        throw new Error('trigger mode requires --profile');
      }
      if (!process.env.BUILD_PURPOSE) throw new Error('trigger mode requires BUILD_PURPOSE');
      const purpose = process.env.BUILD_PURPOSE;
      const build = applyBuildPurposeProfile(repositoryProfile, purpose);
      log(`trigger: using ${build.provider}/${build.appRole} (${build.appName}, ${build.workflowId})`);
      const { asc, github } = createClients();
      const provider = new XcodeCloudBuildProvider(asc);
      const intent = buildIntentFromEnvironment(build);
      const result = await runManagedBuildTrigger(provider, github, intent, DRY_RUN);
      if (!DRY_RUN && process.env.BUILD_WAIT_FOR_COMPLETION === 'true' && result.runId) {
        const completed = await waitForBuildCompletion(provider, result.runId);
        if (completed.completionStatus !== 'SUCCEEDED') {
          throw new Error(`Build #${completed.number || completed.runId} completed with ${completed.completionStatus}`);
        }
      }
    }

    // Run deploy check
    if (mode === 'deploy' || mode === 'all') {
      const automation = selectAutomation('deploy');
      if (automation.enabled) {
        const { asc, github } = createClients();
        await runDeployCheck(asc, github, DRY_RUN);
      }
    }

    // Run release sync
    if (mode === 'sync' || mode === 'all') {
      const automation = selectAutomation('sync');
      if (automation.enabled) {
        const { asc, tags, github } = createClients();
        await runReleaseSync(asc, tags, github, DRY_RUN);
      }
    }

    const shouldRunExpiration = mode === 'expire'
      || (mode === 'all' && (repositoryProfile || CONFIG.expireMergedBuilds));
    if (shouldRunExpiration) {
      const automation = selectAutomation('expire');
      if (automation.enabled) {
        const { asc, github } = createClients();
        await runClosedPRBuildExpiry(asc, github, DRY_RUN);
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
