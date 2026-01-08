import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

// Configuration - use getters to read env vars at runtime (after dotenv loads)
export const CONFIG = {
  get appId() { return process.env.APP_ID || ''; },
  get appIdentifier() { return process.env.APP_BUNDLE_ID || ''; },
  get appName() { return process.env.APP_NAME || ''; },
  get repoOwner() { return process.env.GITHUB_REPO_OWNER || ''; },
  get repoName() { return process.env.GITHUB_REPO_NAME || ''; },
  get workflowId() { return process.env.XCODE_WORKFLOW_ID || ''; },
  get iosRepoPath() { return process.env.IOS_REPO_PATH || ''; },
  apiBaseUrl: 'https://api.appstoreconnect.apple.com/v1',
  rootDir: ROOT_DIR,
};

// Logging
const LOG_FILE = path.join(ROOT_DIR, 'logs', 'merge4appstore.log');

export function log(message) {
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
