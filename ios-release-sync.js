#!/usr/bin/env node

/**
 * iOS Release Sync Script
 *
 * Monitors App Store Connect for builds that went live (READY_FOR_SALE)
 * and creates git tags for released versions.
 *
 * Usage:
 *   node ios-release-sync.js              # Normal mode
 *   DRY_RUN=true node ios-release-sync.js # Dry run mode
 *
 * Required environment variables:
 *   APP_STORE_CONNECT_API_KEY_ID      - App Store Connect API Key ID
 *   APP_STORE_CONNECT_ISSUER_ID       - App Store Connect Issuer ID
 *   APP_STORE_CONNECT_API_KEY_CONTENT - API private key (base64 encoded)
 *   IOS_REPO_PATH                     - Path to iOS git repository (for tagging)
 *
 * Optional environment variables:
 *   GH_TOKEN / GITHUB_TOKEN           - GitHub token for PR comments (used by gh CLI)
 *   DRY_RUN=true                      - Run without making changes
 *
 * App configuration (override defaults for other apps):
 *   APP_BUNDLE_ID                     - Bundle ID (default: com.deepdesai.runningorder)
 *   APP_NAME                          - App name for logging (default: Running Order)
 *   GITHUB_REPO_OWNER                 - GitHub org/user (default: desai-deep)
 *   GITHUB_REPO_NAME                  - GitHub repo name (default: runningorder-ios)
 */

// Suppress dotenv logging
process.env.DOTENV_CONFIG_QUIET = 'true';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });

// Lock file to prevent concurrent runs
const LOCK_FILE = path.join(__dirname, '.ios-release-sync.lock');
const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// Configuration - all values can be overridden via environment variables
const CONFIG = {
  // App Store Connect
  appIdentifier: process.env.APP_BUNDLE_ID || 'com.deepdesai.runningorder',
  appName: process.env.APP_NAME || 'Running Order',

  // GitHub repository for PR lookups
  iosRepoOwner: process.env.GITHUB_REPO_OWNER || 'desai-deep',
  iosRepoName: process.env.GITHUB_REPO_NAME || 'runningorder-ios',

  // iOS repo path for git operations
  iosRepoPath: process.env.IOS_REPO_PATH || '',

  // API (shouldn't need to change)
  apiBaseUrl: 'https://api.appstoreconnect.apple.com/v1',
};

// Logging
const LOG_FILE = path.join(__dirname, 'logs', 'ios-release-sync.log');

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `${timestamp} - ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // Ignore logging errors
  }
}

// App Store Connect API Client (same as ios-deploy.js)
class AppStoreConnectAPI {
  constructor(keyId, issuerId, privateKeyContent) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = Buffer.from(privateKeyContent, 'base64').toString('utf8');
    this.token = null;
    this.tokenExpiry = null;
    this.appId = null;
  }

  generateToken() {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 20 * 60; // 20 minutes

    if (this.token && this.tokenExpiry && now < this.tokenExpiry - 60) {
      return this.token;
    }

    const header = {
      alg: 'ES256',
      kid: this.keyId,
      typ: 'JWT'
    };

    const payload = {
      iss: this.issuerId,
      iat: now,
      exp: expiry,
      aud: 'appstoreconnect-v1'
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${headerB64}.${payloadB64}`;

    const sign = crypto.createSign('SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(this.privateKey);

    // Convert DER signature to raw r||s format for ES256
    const rawSignature = this.derToRaw(signature);
    const signatureB64 = rawSignature.toString('base64url');

    this.token = `${signatureInput}.${signatureB64}`;
    this.tokenExpiry = expiry;
    return this.token;
  }

  derToRaw(derSignature) {
    let offset = 0;
    if (derSignature[offset++] !== 0x30) throw new Error('Invalid DER signature');

    let length = derSignature[offset++];
    if (length & 0x80) offset += (length & 0x7f);

    if (derSignature[offset++] !== 0x02) throw new Error('Invalid DER signature');
    let rLength = derSignature[offset++];
    let r = derSignature.slice(offset, offset + rLength);
    offset += rLength;

    if (derSignature[offset++] !== 0x02) throw new Error('Invalid DER signature');
    let sLength = derSignature[offset++];
    let s = derSignature.slice(offset, offset + sLength);

    while (r.length > 32 && r[0] === 0) r = r.slice(1);
    while (s.length > 32 && s[0] === 0) s = s.slice(1);
    while (r.length < 32) r = Buffer.concat([Buffer.from([0]), r]);
    while (s.length < 32) s = Buffer.concat([Buffer.from([0]), s]);

    return Buffer.concat([r, s]);
  }

  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${CONFIG.apiBaseUrl}${endpoint}`;
    const token = this.generateToken();

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.status === 204) {
      return null;
    }

    const data = await response.json();

    if (!response.ok) {
      const errorDetail = data.errors?.[0]?.detail || JSON.stringify(data);
      throw new Error(`API Error ${response.status}: ${errorDetail}`);
    }

    return data;
  }

  async getAppId() {
    if (this.appId) return this.appId;

    const data = await this.request(`/apps?filter[bundleId]=${CONFIG.appIdentifier}`);
    if (!data.data?.[0]) {
      throw new Error(`App not found: ${CONFIG.appIdentifier}`);
    }
    this.appId = data.data[0].id;
    return this.appId;
  }

  // Get live production build (READY_FOR_SALE)
  async getLiveProductionBuild() {
    const appId = await this.getAppId();
    const data = await this.request(`/apps/${appId}/appStoreVersions?include=build`);

    for (const version of data.data || []) {
      if (version.attributes.appStoreState === 'READY_FOR_SALE') {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = '0';

        if (buildId && data.included) {
          const build = data.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || '0';
        }

        return {
          live: true,
          version: version.attributes.versionString,
          buildNumber,
        };
      }
    }

    return { live: false, buildNumber: '0' };
  }

  // Get CI products (Xcode Cloud)
  async getCIProducts() {
    const data = await this.request('/ciProducts');
    return data.data || [];
  }

  // Get workflows for a CI product
  async getWorkflows(productId) {
    const data = await this.request(`/ciProducts/${productId}/workflows`);
    return data.data || [];
  }

  // Get build runs for a workflow
  async getBuildRuns(workflowId, limit = 50) {
    const data = await this.request(
      `/ciWorkflows/${workflowId}/buildRuns?limit=${limit}&sort=-number&fields[ciBuildRuns]=number,sourceCommit,executionProgress,completionStatus`
    );
    return data;
  }

  // Get commit SHA for a build number from Xcode Cloud
  async getBuildCommitSHA(buildNumber) {
    const products = await this.getCIProducts();

    for (const product of products) {
      const workflows = await this.getWorkflows(product.id);

      for (const workflow of workflows) {
        const workflowName = workflow.attributes?.name;
        const runsData = await this.getBuildRuns(workflow.id, 200);

        for (const run of runsData.data || []) {
          if (run.attributes?.number?.toString() === buildNumber.toString()) {
            const sourceCommit = run.attributes?.sourceCommit;
            let commitSha = null;

            if (typeof sourceCommit === 'string') {
              commitSha = sourceCommit;
            } else if (sourceCommit && typeof sourceCommit === 'object') {
              commitSha = sourceCommit.commitSha || sourceCommit.hash || sourceCommit.canonicalHash || sourceCommit.id;
            }

            return {
              found: true,
              commitSha,
              workflowName,
            };
          }
        }
      }
    }

    return { found: false };
  }
}

// Git operations
class GitOperations {
  constructor(repoPath) {
    this.repoPath = repoPath;
  }

  exec(command) {
    return execSync(command, {
      cwd: this.repoPath,
      encoding: 'utf8',
      timeout: 60000,
    }).trim();
  }

  // Fetch latest from origin
  fetch() {
    this.exec('git fetch origin main develop --tags');
  }

  // Check if tag exists
  tagExists(tagName) {
    try {
      this.exec(`git rev-parse ${tagName}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Check if commit exists
  commitExists(commitSha) {
    try {
      this.exec(`git cat-file -e ${commitSha}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Resolve reference to commit SHA
  resolveRef(ref) {
    try {
      return this.exec(`git rev-parse ${ref}`);
    } catch (e) {
      try {
        return this.exec(`git rev-parse origin/${ref}`);
      } catch (e2) {
        return null;
      }
    }
  }

  // Get commit message
  getCommitMessage(commitSha) {
    try {
      return this.exec(`git log -1 --pretty=%s ${commitSha}`);
    } catch (e) {
      return '';
    }
  }

  // Check if commit is ancestor of main
  isAncestorOfMain(commitSha) {
    try {
      this.exec(`git merge-base --is-ancestor ${commitSha} origin/main`);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Create annotated tag
  createTag(tagName, commitSha, message) {
    this.exec(`git tag -a "${tagName}" ${commitSha} -m "${message.replace(/"/g, '\\"')}"`);
  }

  // Push tag to origin
  pushTag(tagName) {
    this.exec(`git push origin ${tagName}`);
  }
}

// GitHub integration
class GitHubAPI {
  constructor(repoOwner, repoName) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
  }

  // Find PR from merge commit using gh CLI
  findPRFromCommit(commitSha) {
    try {
      const result = execSync(
        `gh pr list --repo ${this.repoOwner}/${this.repoName} --state merged --base main --json number,mergeCommit --jq '.[] | select(.mergeCommit.oid == "${commitSha}") | .number'`,
        { encoding: 'utf8', timeout: 30000 }
      ).trim();

      if (result) {
        return result.split('\n')[0];
      }
    } catch (e) {
      // Ignore
    }

    return null;
  }

  // Add comment to PR
  addPRComment(prNumber, comment) {
    try {
      execSync(
        `gh pr comment ${prNumber} --repo ${this.repoOwner}/${this.repoName} --body "${comment.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', timeout: 30000 }
      );
      return true;
    } catch (e) {
      return false;
    }
  }
}

// Lock management
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stats = fs.statSync(LOCK_FILE);
      const age = Date.now() - stats.mtimeMs;

      if (age > LOCK_MAX_AGE_MS) {
        log(`Removing stale lock (age: ${Math.round(age / 1000)}s)`);
        fs.unlinkSync(LOCK_FILE);
      } else {
        return false;
      }
    }

    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    return true;
  } catch (e) {
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {
    log(`Warning: Failed to remove lock file: ${e.message}`);
  }
}

// Main execution
async function main() {
  const DRY_RUN = process.env.DRY_RUN === 'true';

  // Acquire lock
  if (!acquireLock()) {
    log('Another instance is already running, exiting');
    process.exit(0);
  }

  // Ensure lock is released on exit
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  log('Starting iOS release sync check...');
  if (DRY_RUN) {
    log('DRY RUN MODE - No actual changes will be made');
  }

  // Validate environment variables
  const requiredVars = [
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
    'IOS_REPO_PATH',
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      log(`ERROR: Missing required environment variable: ${varName}`);
      process.exit(1);
    }
  }

  // Initialize clients
  const asc = new AppStoreConnectAPI(
    process.env.APP_STORE_CONNECT_API_KEY_ID,
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    process.env.APP_STORE_CONNECT_API_KEY_CONTENT
  );

  const git = new GitOperations(process.env.IOS_REPO_PATH);
  const github = new GitHubAPI(CONFIG.iosRepoOwner, CONFIG.iosRepoName);

  try {
    // Step 1: Get live production build
    log('Checking for live production build...');
    const liveStatus = await asc.getLiveProductionBuild();

    if (!liveStatus.live || liveStatus.buildNumber === '0') {
      log('No live production build found (app may not be released yet)');
      return;
    }

    log(`Live production build: #${liveStatus.buildNumber} (v${liveStatus.version})`);

    // Validate version format
    if (!/^\d+\.\d+(\.\d+)?$/.test(liveStatus.version)) {
      log(`ERROR: Invalid version format: ${liveStatus.version}`);
      process.exit(1);
    }

    // Step 2: Check if tag already exists
    const tagName = `v${liveStatus.version}-${liveStatus.buildNumber}`;
    log(`Checking if tag ${tagName} already exists...`);

    git.fetch();

    if (git.tagExists(tagName)) {
      log(`Tag ${tagName} already exists - build already synced`);
      return;
    }

    log(`New production release detected: build #${liveStatus.buildNumber}`);

    // Step 3: Get commit SHA for this build
    log(`Getting commit SHA for build #${liveStatus.buildNumber}...`);
    const commitInfo = await asc.getBuildCommitSHA(liveStatus.buildNumber);

    if (!commitInfo.found || !commitInfo.commitSha) {
      log(`No commit SHA found for build #${liveStatus.buildNumber}`);
      log('This build may have been submitted before commit tracking was implemented');
      return;
    }

    let commitSha = commitInfo.commitSha;
    log(`Found commit reference: ${commitSha}`);

    // Step 4: Resolve to full commit SHA if needed
    if (!/^[0-9a-fA-F]{40}$/.test(commitSha)) {
      log(`Resolving reference ${commitSha} to commit SHA...`);
      const resolved = git.resolveRef(commitSha);

      if (!resolved) {
        log(`Could not resolve reference '${commitSha}' to a commit`);
        return;
      }

      commitSha = resolved;
      log(`Resolved to commit SHA: ${commitSha}`);
    }

    // Step 5: Verify commit exists
    if (!git.commitExists(commitSha)) {
      log(`ERROR: Commit ${commitSha} not found in repository`);
      process.exit(1);
    }

    const commitMsg = git.getCommitMessage(commitSha);
    log(`Commit message: ${commitMsg}`);

    // Step 6: Create and push tag
    if (DRY_RUN) {
      log(`[DRY RUN] Would create tag ${tagName} on commit ${commitSha.substring(0, 7)}`);
      log(`[DRY RUN] Would push tag to origin`);
    } else {
      log(`Creating tag ${tagName}...`);
      git.createTag(tagName, commitSha, `Production release: version ${liveStatus.version}, build ${liveStatus.buildNumber}`);

      log(`Pushing tag ${tagName}...`);
      git.pushTag(tagName);

      log(`Created and pushed tag ${tagName}`);
    }

    // Step 7: Comment on the PR
    const prNumber = github.findPRFromCommit(commitSha);

    if (prNumber) {
      if (DRY_RUN) {
        log(`[DRY RUN] Would add release comment to PR #${prNumber}`);
      } else {
        const comment = `Build #${liveStatus.buildNumber} has been released to the App Store as version ${liveStatus.version}.`;
        if (github.addPRComment(prNumber, comment)) {
          log(`Added release comment to PR #${prNumber}`);
        }
      }
    }

    log(`Successfully synced build #${liveStatus.buildNumber} and tagged as ${tagName}`);
    log('Release sync complete');

  } catch (error) {
    log(`ERROR: ${error.message}`);
    if (error.stack) {
      log(`Stack: ${error.stack.split('\n').slice(1, 4).join('\n')}`);
    }
    process.exit(1);
  }
}

// Run
main();
