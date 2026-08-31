import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const FILE_LOCK_HELPER = [
  'process.stdout.write("acquired\\n");',
  'process.stdin.resume();',
].join('');

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

function fileLockCommand(lockFile) {
  if (process.platform === 'linux') {
    return {
      command: 'flock',
      args: [
        '--exclusive', '--nonblock', '--conflict-exit-code', '75', lockFile,
        process.execPath, '-e', FILE_LOCK_HELPER,
      ],
      label: 'Linux',
    };
  }
  if (process.platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: [
        '-s', '-k', '-w', '-t', '0', lockFile,
        process.execPath, '-e', FILE_LOCK_HELPER,
      ],
      label: 'macOS',
    };
  }
  return null;
}

async function tryAcquireFileLock(directory, digest) {
  const lockFile = await ensureFileLockPath(directory, digest);
  const helper = fileLockCommand(lockFile);
  return new Promise((resolve, reject) => {
    const child = spawn(helper.command, helper.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stderr = '';
    let stdout = '';
    const readinessTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupReadiness();
      child.on('error', () => {});
      child.kill('SIGKILL');
      const error = new Error(`Timed out starting the ${helper.label} process-lock helper for ${path.basename(lockFile)}`);
      error.code = 'ELOCKHELPER';
      reject(error);
    }, 2_000);
    readinessTimer.unref?.();

    const cleanupReadiness = () => {
      clearTimeout(readinessTimer);
      child.stdout.removeListener('data', onStdout);
      child.removeListener('error', onError);
      child.removeListener('exit', onExitBeforeReady);
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanupReadiness();
      reject(error);
    };
    const onExitBeforeReady = code => {
      if (settled) return;
      settled = true;
      cleanupReadiness();
      if (code === 75) resolve(null);
      else {
        const error = new Error(
          `${helper.label} process-lock helper exited ${code ?? 'without a status'}${stderr ? `: ${stderr.trim()}` : ''}`,
        );
        error.code = 'ELOCKHELPER';
        reject(error);
      }
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
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise((releaseResolve, releaseReject) => {
          const onReleaseError = error => {
            child.removeListener('exit', onReleaseExit);
            releaseReject(error);
          };
          const onReleaseExit = () => {
            child.removeListener('error', onReleaseError);
            releaseResolve();
          };
          child.once('error', onReleaseError);
          child.once('exit', onReleaseExit);
          child.stdin.end();
        });
      });
    };

    child.stderr.on('data', chunk => {
      if (stderr.length < 4_096) stderr += chunk.toString().slice(0, 4_096 - stderr.length);
    });
    child.once('error', onError);
    child.once('exit', onExitBeforeReady);
    child.stdout.on('data', onStdout);
  });
}

export async function tryAcquireProcessLock(directory, key) {
  // A lexical path is not a lock identity: two symlinks can name the same
  // state directory. Resolve it before deriving either the socket name or the
  // file-lock location so every alias contends for the same OS lock.
  const canonicalDirectory = await canonicalLockDirectory(directory);
  const digest = lockDigest(canonicalDirectory, key);
  const address = lockAddress(digest);
  if (address !== null) return tryAcquireSocketLock(address);
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return tryAcquireFileLock(canonicalDirectory, digest);
  }
  const error = new Error(`Process locks are not supported on ${process.platform}`);
  error.code = 'ENOTSUP';
  throw error;
}

export async function acquireProcessLock(directory, key, {
  timeoutMs = 60_000,
  retryMs = 100,
  signal = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw abortReason(signal);
    const release = await tryAcquireProcessLock(directory, key);
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
