import fs from 'fs';
import path from 'path';
import { CONFIG, log } from './config.js';

const LOCK_FILE = path.join(CONFIG.rootDir, '.merge2fly.lock');
const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export function acquireLock() {
  // First, check for and remove stale locks
  try {
    const stats = fs.statSync(LOCK_FILE);
    const age = Date.now() - stats.mtimeMs;

    if (age > LOCK_MAX_AGE_MS) {
      log(`Removing stale lock (age: ${Math.round(age / 1000)}s)`);
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {
    // File doesn't exist, which is fine
    if (e.code !== 'ENOENT') {
      return false;
    }
  }

  // Attempt atomic lock acquisition using 'wx' flag
  // This fails if the file already exists, preventing race conditions
  try {
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Lock file exists, another process has the lock
      return false;
    }
    // Unexpected error
    return false;
  }
}

export function releaseLock() {
  try {
    // Only delete if we own the lock (pid matches)
    const content = fs.readFileSync(LOCK_FILE, 'utf8');
    if (content.trim() === process.pid.toString()) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log(`Warning: Failed to remove lock file: ${e.message}`);
    }
  }
}
