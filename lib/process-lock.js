import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const FILE_LOCK_HELPER = [
  'printf "acquired\\n"',
  'while IFS= read -r line; do :; done',
].join('; ');
const DEFAULT_HELPER_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_HELPER_STARTUP_ATTEMPTS = 2;
const DEFAULT_HELPER_STARTUP_RETRY_MS = 100;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function lockDigest(directory, key) {
  return crypto.createHash('sha256')
    .update(`${directory}\0${key}`)
    .digest('hex');
}

async function canonicalLockDirectory(directory) {
  const canonical = await fs.realpath(path.resolve(directory));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function lockAddress(digest) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\merge4appstore-${uid}-${digest}`;
  }
  return null;
}

function abortReason(signal) {
  if (signal?.reason) return signal.reason;
  const error = new Error('Lock acquisition aborted');
  error.name = 'AbortError';
  return error;
}

function delay(milliseconds, signal = null) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function tryAcquireSocketLock(address) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    const onError = error => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE' || error.code === 'EEXIST') resolve(null);
      else reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      let released = false;
      resolve(async () => {
        if (released) return;
        released = true;
        await new Promise((closeResolve, closeReject) => {
          server.close(error => error ? closeReject(error) : closeResolve());
        });
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // Node cluster workers otherwise ask the primary to share one listening
    // handle, which would let every worker believe it owns the same lock.
    server.listen({ path: address, exclusive: true });
  });
}

async function ensureFileLockPath(directory, digest) {
  const lockDirectory = path.join(path.resolve(directory), '.process-locks');
  try {
    await fs.mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const directoryHandle = await fs.open(
    lockDirectory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await directoryHandle.stat();
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
      throw new Error(`Unsafe process-lock directory: ${lockDirectory}`);
    }
    await directoryHandle.chmod(0o700);
  } finally {
    await directoryHandle.close();
  }

  const lockFile = path.join(lockDirectory, `${digest}.lock`);
  let fileHandle;
  try {
    fileHandle = await fs.open(
      lockFile,
      fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const stat = await fileHandle.stat();
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || (uid !== null && stat.uid !== uid)) {
      throw new Error(`Unsafe process-lock file: ${lockFile}`);
    }
    await fileHandle.chmod(0o600);
  } finally {
    await fileHandle?.close();
  }
  return lockFile;
}

function fileLockCommand(lockFile, holderCommand = ['/bin/sh', '-c', FILE_LOCK_HELPER]) {
  if (process.platform === 'linux') {
    return {
      command: 'flock',
      args: [
        '--exclusive', '--nonblock', '--conflict-exit-code', '75', '--no-fork',
        lockFile, ...holderCommand,
      ],
      label: 'Linux',
    };
  }
  if (process.platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: [
        '-s', '-k', '-w', '-t', '0', lockFile,
        ...holderCommand,
      ],
      label: 'macOS',
    };
  }
  return null;
}

function terminateProcessGroup(child) {
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (error.code === 'ESRCH') return;
      try {
        if (child.kill('SIGKILL')) return;
      } catch (fallbackError) {
        const cleanupError = new Error('Could not stop the process-lock helper', {
          cause: fallbackError,
        });
        cleanupError.code = 'ELOCKCLEANUP';
        throw cleanupError;
      }
      const cleanupError = new Error('Could not stop the process-lock helper', { cause: error });
      cleanupError.code = 'ELOCKCLEANUP';
      throw cleanupError;
    }
  }
  if (
    child.exitCode === null
    && child.signalCode === null
    && !child.kill('SIGKILL')
  ) {
    const error = new Error('Could not stop the process-lock helper');
    error.code = 'ELOCKCLEANUP';
    throw error;
  }
}

async function tryAcquireFileLock(directory, digest, {
  signal = null,
  startupTimeoutMs = DEFAULT_HELPER_STARTUP_TIMEOUT_MS,
  holderCommand = null,
} = {}) {
  if (signal?.aborted) throw abortReason(signal);
  const lockFile = await ensureFileLockPath(directory, digest);
  const helper = fileLockCommand(lockFile, holderCommand || undefined);
  return new Promise((resolve, reject) => {
    const child = spawn(helper.command, helper.args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Create this before any readiness event can fire. On macOS `lockf` forks
    // its holder command, and `close` waits for inherited pipes from that child
    // as well as for the wrapper itself.
    let childHasClosed = false;
    const childClosed = new Promise(closeResolve => child.once('close', (...args) => {
      childHasClosed = true;
      closeResolve(args);
    }));
    let settled = false;
    let stderr = '';
    let stdout = '';
    let readinessTimer = null;

    const cleanupReadiness = () => {
      clearTimeout(readinessTimer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.removeListener('data', onStdout);
      child.removeListener('error', onError);
      child.removeListener('exit', onExitBeforeReady);
    };
    const rejectAfterStopping = async error => {
      if (settled) return;
      settled = true;
      cleanupReadiness();
      child.on('error', () => {});
      child.stdin.on('error', () => {});
      child.stdin.end();
      // Linux uses no-fork, while macOS lockf forks its holder command. Both
      // remain in this dedicated process group, so cancellation cannot orphan
      // a descendant that inherited the lock or stdio pipes.
      try {
        terminateProcessGroup(child);
      } catch (cleanupError) {
        reject(cleanupError);
        return;
      }
      await childClosed;
      reject(error);
    };
    const onAbort = () => { void rejectAfterStopping(abortReason(signal)); };
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanupReadiness();
      reject(error);
    };
    const onExitBeforeReady = code => {
      if (settled) return;
      if (code === 75) {
        settled = true;
        cleanupReadiness();
        void childClosed.then(() => resolve(null));
        return;
      }
      const error = new Error(
        `${helper.label} process-lock helper exited ${code ?? 'without a status'}${stderr ? `: ${stderr.trim()}` : ''}`,
      );
      error.code = 'ELOCKHELPER';
      // A macOS lockf wrapper can exit while a command descendant still owns
      // inherited stdio. Reap the detached group before reporting a permanent
      // helper failure, just as we do for a readiness timeout.
      void rejectAfterStopping(error);
    };
    const onStdout = chunk => {
      if (settled) return;
      stdout = `${stdout}${chunk}`.slice(-64);
      if (!stdout.includes('acquired\n')) return;
      settled = true;
      cleanupReadiness();
      child.on('error', () => {});
      let released = false;
      resolve(async () => {
        if (released) return;
        released = true;
        child.stdin.on('error', () => {});
        child.stdin.end();
        // On macOS the lockf wrapper and holder are separate processes. If the
        // wrapper died after readiness, its holder may still have the lock and
        // inherited pipes even though ChildProcess already has an exit status.
        if (
          !childHasClosed
          && (child.exitCode !== null || child.signalCode !== null)
        ) {
          terminateProcessGroup(child);
        }
        await childClosed;
      });
    };

    child.stderr.on('data', chunk => {
      if (stderr.length < 4_096) stderr += chunk.toString().slice(0, 4_096 - stderr.length);
    });
    child.once('error', onError);
    child.once('exit', onExitBeforeReady);
    child.stdout.on('data', onStdout);
    readinessTimer = setTimeout(() => {
      const error = new Error(`Timed out starting the ${helper.label} process-lock helper for ${path.basename(lockFile)}`);
      error.code = 'ELOCKSTARTTIMEOUT';
      void rejectAfterStopping(error);
    }, positiveInteger(startupTimeoutMs, DEFAULT_HELPER_STARTUP_TIMEOUT_MS));
    readinessTimer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function tryAcquireProcessLock(directory, key, {
  signal = null,
  helperStartupTimeoutMs = DEFAULT_HELPER_STARTUP_TIMEOUT_MS,
  helperStartupAttempts = DEFAULT_HELPER_STARTUP_ATTEMPTS,
  helperStartupRetryMs = DEFAULT_HELPER_STARTUP_RETRY_MS,
  deadline = Number.POSITIVE_INFINITY,
  fileLockAttempt = tryAcquireFileLock,
  fileLockHolderCommand = null,
} = {}) {
  if (signal?.aborted) throw abortReason(signal);
  const deadlineError = cause => {
    const error = new Error(`Timed out waiting for process lock ${key}`, cause ? { cause } : undefined);
    error.code = 'ELOCKTIMEOUT';
    return error;
  };
  const releaseIfLate = async release => {
    if (!release) return;
    await release();
  };
  if (Number.isFinite(deadline) && deadline - Date.now() <= 0) throw deadlineError();
  // A lexical path is not a lock identity: two symlinks can name the same
  // state directory. Resolve it before deriving either the socket name or the
  // file-lock location so every alias contends for the same OS lock.
  const canonicalDirectory = await canonicalLockDirectory(directory);
  const digest = lockDigest(canonicalDirectory, key);
  const address = lockAddress(digest);
  if (signal?.aborted) throw abortReason(signal);
  if (Number.isFinite(deadline) && deadline - Date.now() <= 0) throw deadlineError();
  if (address !== null) {
    const release = await tryAcquireSocketLock(address);
    if (signal?.aborted) {
      await releaseIfLate(release);
      throw abortReason(signal);
    }
    if (Number.isFinite(deadline) && deadline - Date.now() <= 0) {
      await releaseIfLate(release);
      throw deadlineError();
    }
    return release;
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const attempts = positiveInteger(helperStartupAttempts, DEFAULT_HELPER_STARTUP_ATTEMPTS);
    const retryMs = nonNegativeInteger(helperStartupRetryMs, DEFAULT_HELPER_STARTUP_RETRY_MS);
    const timeoutMs = positiveInteger(helperStartupTimeoutMs, DEFAULT_HELPER_STARTUP_TIMEOUT_MS);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw abortReason(signal);
      const remaining = deadline - Date.now();
      if (Number.isFinite(remaining) && remaining <= 0) throw deadlineError();
      try {
        const release = await fileLockAttempt(canonicalDirectory, digest, {
          signal,
          startupTimeoutMs: Number.isFinite(remaining)
            ? Math.min(timeoutMs, remaining)
            : timeoutMs,
          holderCommand: fileLockHolderCommand,
        });
        if (signal?.aborted) {
          await releaseIfLate(release);
          throw abortReason(signal);
        }
        if (Number.isFinite(deadline) && deadline - Date.now() <= 0) {
          await releaseIfLate(release);
          throw deadlineError();
        }
        return release;
      } catch (error) {
        if (error.code !== 'ELOCKSTARTTIMEOUT') throw error;
        if (attempt === attempts) throw deadlineError(error);
        const retryRemaining = deadline - Date.now();
        if (retryRemaining <= 0) throw deadlineError(error);
        await delay(Math.min(retryMs, retryRemaining), signal);
      }
    }
  }
  const error = new Error(`Process locks are not supported on ${process.platform}`);
  error.code = 'ENOTSUP';
  throw error;
}

export async function acquireProcessLock(directory, key, {
  timeoutMs = 60_000,
  retryMs = 100,
  signal = null,
  helperStartupTimeoutMs = DEFAULT_HELPER_STARTUP_TIMEOUT_MS,
  helperStartupAttempts = DEFAULT_HELPER_STARTUP_ATTEMPTS,
  helperStartupRetryMs = DEFAULT_HELPER_STARTUP_RETRY_MS,
  fileLockAttempt = tryAcquireFileLock,
  fileLockHolderCommand = null,
} = {}) {
  const immediateAttempt = timeoutMs === 0;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw abortReason(signal);
    const release = await tryAcquireProcessLock(directory, key, {
      signal,
      helperStartupTimeoutMs,
      helperStartupAttempts,
      helperStartupRetryMs,
      deadline: immediateAttempt ? Number.POSITIVE_INFINITY : deadline,
      fileLockAttempt,
      fileLockHolderCommand,
    });
    if (release) return release;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error(`Timed out waiting for process lock ${key}`);
      error.code = 'ELOCKTIMEOUT';
      throw error;
    }
    await delay(Math.min(retryMs, remaining), signal);
  }
}
