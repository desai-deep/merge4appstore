import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

function safeInstanceName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

// Configuration - use getters to read env vars at runtime (after dotenv loads)
export const CONFIG = {
  get appId() { return process.env.APP_ID || ''; },
  get appIdentifier() { return process.env.APP_BUNDLE_ID || ''; },
  get appName() { return process.env.APP_NAME || ''; },
  get repoOwner() { return process.env.GITHUB_REPO_OWNER || ''; },
  get repoName() { return process.env.GITHUB_REPO_NAME || ''; },
  get workflowId() { return process.env.XCODE_WORKFLOW_ID || ''; },
  get expireWorkflowId() { return process.env.EXPIRE_XCODE_WORKFLOW_ID || ''; },
  get recoverMissedBuilds() { return process.env.RECOVER_MISSED_XCODE_BUILDS === 'true'; },
  get iosRepoPath() { return process.env.IOS_REPO_PATH || ''; },
  get productionBranch() { return process.env.PRODUCTION_BRANCH || 'main'; },
  get betaBranch() { return process.env.BETA_BRANCH || 'develop'; },
  get expireMergedBuilds() { return process.env.EXPIRE_MERGED_BUILDS !== 'false'; },
  get instanceName() {
    return safeInstanceName(process.env.INSTANCE_NAME || process.env.GITHUB_REPO_NAME || 'default');
  },
  get logFile() { return path.join(ROOT_DIR, 'logs', `${this.instanceName}.log`); },
  get lockFile() { return path.join(ROOT_DIR, `.merge4appstore-${this.instanceName}.lock`); },
  apiBaseUrl: 'https://api.appstoreconnect.apple.com/v1',
  rootDir: ROOT_DIR,
};

export function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `${timestamp} [${CONFIG.instanceName}] - ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
    fs.appendFileSync(CONFIG.logFile, line + '\n');
  } catch (e) {
    // Ignore logging errors
  }
}
