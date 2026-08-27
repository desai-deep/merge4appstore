import fs from 'fs';
import { CONFIG, log } from './config.js';

const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_LOCK_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_RETRY_MS = 1000;

export function acquireLock() {
  // First, check for and remove stale locks
  try {
    const stats = fs.statSync(CONFIG.lockFile);
    const age = Date.now() - stats.mtimeMs;

    if (age > LOCK_MAX_AGE_MS) {
      log(`Removing stale lock (age: ${Math.round(age / 1000)}s)`);
      fs.unlinkSync(CONFIG.lockFile);
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
    fs.writeFileSync(CONFIG.lockFile, process.pid.toString(), { flag: 'wx' });
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

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function waitForLock({
  timeoutMs = positiveNumber(process.env.MERGE4APPSTORE_LOCK_WAIT_MS, DEFAULT_LOCK_WAIT_MS),
  retryMs = DEFAULT_LOCK_RETRY_MS,
  acquire = acquireLock,
} = {}) {
  const startedAt = Date.now();
  let waiting = false;

  while (!acquire()) {
    if (!waiting) {
      waiting = true;
      log(`Another instance is running; waiting up to ${Math.round(timeoutMs / 1000)}s for its lock`);
    }

    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, remaining)));
  }

  if (waiting) log('Acquired lock after waiting');
  return true;
}

export function releaseLock() {
  try {
    // Only delete if we own the lock (pid matches)
    const content = fs.readFileSync(CONFIG.lockFile, 'utf8');
    if (content.trim() === process.pid.toString()) {
      fs.unlinkSync(CONFIG.lockFile);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log(`Warning: Failed to remove lock file: ${e.message}`);
    }
  }
}
