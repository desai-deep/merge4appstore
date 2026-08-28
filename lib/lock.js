import fs from 'fs';
import { CONFIG, log } from './config.js';

const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_LOCK_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_RETRY_MS = 1000;

export function isProcessAlive(pid, signal = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signaled by this user.
    return error.code === 'EPERM';
  }
}

export function acquireLock() {
  // First, check for and remove stale locks
  try {
    const stats = fs.statSync(CONFIG.lockFile);
    const age = Date.now() - stats.mtimeMs;

    if (age > LOCK_MAX_AGE_MS) {
      const ownerPid = Number.parseInt(fs.readFileSync(CONFIG.lockFile, 'utf8').trim(), 10);
      if (isProcessAlive(ownerPid)) {
        log(`Lock is old but its owner PID ${ownerPid} is still running; keeping it`);
      } else {
        log(`Removing stale lock (age: ${Math.round(age / 1000)}s, owner PID: ${ownerPid || 'unknown'})`);
        fs.unlinkSync(CONFIG.lockFile);
      }
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
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  now = Date.now,
} = {}) {
  const startedAt = now();
  let waiting = false;

  while (!acquire()) {
    if (!waiting) {
      waiting = true;
      log(`Another instance is running; waiting up to ${Math.round(timeoutMs / 1000)}s for its lock`);
    }

    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) return false;
    await sleep(Math.min(retryMs, remaining));
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
