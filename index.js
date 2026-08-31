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
 *   node index.js release-pr         # Create or update the beta-to-production release PR
 *   node index.js rebase-prs         # Rebase open PRs after the beta branch advances
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
  resolveAutoRebasePullRequests,
  resolveReleasePullRequest,
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
import { releaseLock, waitForLock } from './lib/lock.js';
import { runDeployCheck } from './lib/deploy.js';
import { runReleaseSync } from './lib/sync.js';
import { runClosedPRBuildExpiry } from './lib/expire.js';
import { XcodeCloudBuildProvider } from './lib/build-provider.js';
import {
  buildIntentFromEnvironment,
  effectiveTriggerDryRun,
  runManagedBuildTrigger,
  waitForBuildCompletion,
} from './lib/trigger.js';
import {
  publishTestFlightNotesForRun,
  refreshTestFlightNotes,
} from './lib/refresh-notes.js';
import { reconcileReleasePullRequest } from './lib/release-pr.js';
import { rebaseOpenPullRequests } from './lib/rebase-prs.js';
import { FileBuildStatusStore, reportXcodeBuildStatus } from './lib/build-status.js';

async function main() {
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const { mode } = cli;

  // Acquire lock
  if (!await waitForLock()) {
    log('ERROR: Timed out waiting for another instance; this job was not completed');
    process.exit(75);
  }

  // An interrupted job is incomplete. Release the kernel lock cleanly, but
  // preserve a nonzero exit status so the durable webhook receipt is retried
  // instead of advancing past work that may have stopped mid-mutation.
  let terminating = false;
  const terminate = async (signal, exitCode) => {
    if (terminating) return;
    terminating = true;
    log(`Interrupted by ${signal}; leaving the current job incomplete`);
    await releaseLock();
    process.exit(exitCode);
  };
  process.once('SIGINT', () => terminate('SIGINT', 130));
  process.once('SIGTERM', () => terminate('SIGTERM', 143));

  log('=== merge4appstore ===');
  log(`Mode: ${mode}`);
  log(`Config: ${cli.configPath}`);
  if (cli.profilePath) log(`Profile: ${cli.profilePath}`);
  if (DRY_RUN) {
    log('DRY RUN MODE - No actual changes will be made');
  }

  // Validate required environment variables
  const requiredSharedVars = ['GH_TOKEN', 'GITHUB_REPO_OWNER', 'GITHUB_REPO_NAME'];
  if (!['release-pr', 'rebase-prs', 'build-status'].includes(mode)) requiredSharedVars.push(
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
  );

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
    if (mode === 'build-status') {
      if (!repositoryProfile) throw new Error('build-status mode requires --profile');
      const github = new GitHubAPI(CONFIG.repoOwner, CONFIG.repoName, CONFIG.productionBranch);
      await reportXcodeBuildStatus(github, {
        status: process.env.BUILD_STATUS,
        workflowId: process.env.BUILD_WORKFLOW_ID,
        runId: process.env.BUILD_RUN_ID,
        purpose: process.env.BUILD_PURPOSE || 'production',
        buildNumber: process.env.BUILD_NUMBER || null,
        commitSha: process.env.BUILD_COMMIT_SHA || null,
        completedAt: process.env.BUILD_COMPLETED_AT || null,
      }, new FileBuildStatusStore());
    }

    if (mode === 'rebase-prs') {
      if (!repositoryProfile) throw new Error('rebase-prs mode requires --profile');
      const policy = resolveAutoRebasePullRequests(repositoryProfile);
      if (!policy.enabled) throw new Error('automatic pull request rebasing is disabled');
      const github = new GitHubAPI(CONFIG.repoOwner, CONFIG.repoName, CONFIG.productionBranch);
      rebaseOpenPullRequests(github, policy.baseBranch, DRY_RUN, log);
    }

    if (mode === 'release-pr') {
      if (!repositoryProfile) throw new Error('release-pr mode requires --profile');
      const policy = resolveReleasePullRequest(repositoryProfile);
      if (!policy.enabled) throw new Error('release pull request automation is disabled');
      const github = new GitHubAPI(CONFIG.repoOwner, CONFIG.repoName, CONFIG.productionBranch);
      reconcileReleasePullRequest(github, policy, DRY_RUN);
    }

    if (mode === 'notes') {
      if (!repositoryProfile) throw new Error('notes mode requires --profile');
      const purpose = process.env.BUILD_PURPOSE || 'pull_request';
      const build = applyBuildPurposeProfile(repositoryProfile, purpose);
      const { asc, github } = createClients();
      if (process.env.BUILD_RUN_ID) {
        await publishTestFlightNotesForRun(
          asc,
          github,
          repositoryProfile,
          build,
          process.env.BUILD_RUN_ID,
          DRY_RUN,
        );
      } else {
        for (const name of ['BUILD_COMMIT_SHA', 'BUILD_BRANCH', 'BUILD_PULL_REQUEST']) {
          if (!process.env[name]) throw new Error(`notes mode requires ${name}`);
        }
        await refreshTestFlightNotes(asc, github, build, {
          commit: process.env.BUILD_COMMIT_SHA,
          branch: process.env.BUILD_BRANCH,
          pull_request: process.env.BUILD_PULL_REQUEST,
        }, DRY_RUN);
      }
    }

    if (mode === 'trigger') {
      if (!repositoryProfile) {
        throw new Error('trigger mode requires --profile');
      }
      if (!process.env.BUILD_PURPOSE) throw new Error('trigger mode requires BUILD_PURPOSE');
      const purpose = process.env.BUILD_PURPOSE;
      const build = applyBuildPurposeProfile(repositoryProfile, purpose);
      log(`trigger: using ${build.provider}/${build.appRole} (${build.appName}, ${build.workflowId})`);
      const triggerDryRun = effectiveTriggerDryRun(build.triggerMode, DRY_RUN);
      const { asc, github } = createClients();
      const provider = new XcodeCloudBuildProvider(asc);
      const intent = buildIntentFromEnvironment(build);
      const result = await runManagedBuildTrigger(provider, github, intent, triggerDryRun);
      if (!triggerDryRun && process.env.BUILD_WAIT_FOR_COMPLETION === 'true' && result.runId) {
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
        await runDeployCheck(asc, github, DRY_RUN, {
          metadataPath: automation.metadataPath,
          reconcileMetadata: process.env.RECONCILE_METADATA === 'true',
        });
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
    process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

main();
