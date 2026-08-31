import fs from 'fs';
import path from 'path';
import { CONFIG, log } from './config.js';
import { ensureStateDirectory, resolveStateDirectory } from './git-mirror.js';
import { tryAcquireProcessLock } from './process-lock.js';

const DEFAULT_LOCK_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_RETRY_MS = 1000;

function assertOwnedDirectory(directory) {
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Lock parent is not a real directory: ${directory}`);
  }

  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`Lock parent is not owned by the current user: ${directory}`);
  }

  return stats;
}

async function ensureLockParentDirectory(lockFile) {
  const lockDirectory = path.dirname(path.resolve(lockFile));
  const stateDirectory = path.dirname(lockDirectory);
  const expectedStateDirectory = resolveStateDirectory(
    process.env.MERGE4APPSTORE_STATE_DIR,
  );
  if (expectedStateDirectory !== stateDirectory) {
    throw new Error('Lock path does not belong to the shared state directory');
  }
  await ensureStateDirectory(stateDirectory);

  try {
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  assertOwnedDirectory(lockDirectory);

  // Open without following the final path component before tightening an
  // existing directory. This avoids chmod following a symlink introduced
  // between validation and the mode change.
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY ?? 0)
    | (fs.constants.O_NOFOLLOW ?? 0);
  const directoryFd = fs.openSync(lockDirectory, flags);
  try {
    const stats = fs.fstatSync(directoryFd);
    if (!stats.isDirectory()) throw new Error(`Lock parent is not a directory: ${lockDirectory}`);
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error(`Lock parent is not owned by the current user: ${lockDirectory}`);
    }
    fs.fchmodSync(directoryFd, 0o700);
  } finally {
    fs.closeSync(directoryFd);
  }
}

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

let heldLockRelease = null;

export async function acquireLock() {
  if (heldLockRelease) return false;
  await ensureLockParentDirectory(CONFIG.lockFile);
  const release = await tryAcquireProcessLock(
    path.dirname(CONFIG.lockFile),
    `job:${path.basename(CONFIG.lockFile)}`,
  );
  if (!release) return false;
  heldLockRelease = release;
  return true;
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

  while (!await acquire()) {
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

export async function releaseLock() {
  const release = heldLockRelease;
  heldLockRelease = null;
  if (!release) return;
  try {
    await release();
  } catch (error) {
    log(`Warning: Failed to release process lock: ${error.message}`);
  }
}
