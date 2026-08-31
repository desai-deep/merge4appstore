import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireProcessLock, tryAcquireProcessLock } from '../lib/process-lock.js';

const worker = fileURLToPath(new URL('./fixtures/process-lock-worker.js', import.meta.url));
const clusterWorker = fileURLToPath(new URL('./fixtures/process-lock-cluster.js', import.meta.url));
const stalledHolder = fileURLToPath(new URL('./fixtures/process-lock-stalled-holder.js', import.meta.url));

function waitForOutput(child, expected, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for process-lock worker output: ${output}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const onData = chunk => {
      output += chunk;
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onExit = code => {
      cleanup();
      reject(new Error(`Process-lock worker exited ${code} before acquiring the lock`));
    };
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForProcessesToExit(pids, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processExists)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

test('releases a cross-process lock after its owner is killed', {
  skip: process.platform === 'win32' ? 'SIGKILL is not portable to Windows' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-'));
  const child = spawn(process.execPath, [worker, root, 'crash-recovery'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child);
    await fs.rm(root, { recursive: true, force: true });
  });

  await waitForOutput(child, 'acquired\n');
  assert.equal(await tryAcquireProcessLock(root, 'crash-recovery'), null);

  child.kill('SIGKILL');
  await waitForExit(child);
  const release = await acquireProcessLock(root, 'crash-recovery', {
    timeoutMs: 5_000,
    retryMs: 20,
  });
  await release();

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const lockDirectory = path.join(root, '.process-locks');
    assert.equal((await fs.stat(lockDirectory)).mode & 0o777, 0o700);
    const [lockFile] = await fs.readdir(lockDirectory);
    assert.equal((await fs.stat(path.join(lockDirectory, lockFile))).mode & 0o777, 0o600);
  }
});

test('declares and deploy-checks the supported minimum Node version', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const deployScript = await fs.readFile(new URL('../scripts/deploy-vps.sh', import.meta.url), 'utf8');
  const workflow = await fs.readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

  assert.equal(packageJson.engines.node, '>=20.0.0');
  assert.equal(packageLock.packages[''].engines.node, '>=20.0.0');
  assert.match(deployScript, /Node\.js 20\.0\.0 or newer is required/);
  assert.match(workflow, /Node\.js 20\.0\.0 or newer is required/);
});

test('does not share one lock listener between Node cluster workers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-cluster-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [clusterWorker, root, 'cluster-contention'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, stderr);
});

test('serializes aliases of the same physical lock directory', {
  skip: process.platform === 'win32' ? 'directory symlinks require elevated privileges on Windows' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-alias-'));
  const physicalDirectory = path.join(root, 'physical');
  const firstAlias = path.join(root, 'first-alias');
  const secondAlias = path.join(root, 'second-alias');
  await fs.mkdir(physicalDirectory);
  await fs.symlink(physicalDirectory, firstAlias, 'dir');
  await fs.symlink(physicalDirectory, secondAlias, 'dir');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const releaseFirst = await tryAcquireProcessLock(firstAlias, 'shared-resource');
  assert.equal(typeof releaseFirst, 'function');
  assert.equal(await tryAcquireProcessLock(secondAlias, 'shared-resource'), null);

  await releaseFirst();
  const releaseSecond = await tryAcquireProcessLock(secondAlias, 'shared-resource');
  assert.equal(typeof releaseSecond, 'function');
  await releaseSecond();
});

test('retries only process-lock helper startup timeouts before acquiring', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const expectedRelease = async () => { events.push('released'); };

  const release = await tryAcquireProcessLock(root, 'startup-retry', {
    helperStartupRetryMs: 0,
    fileLockAttempt: async (_directory, _digest, options) => {
      events.push(`attempt:${options.startupTimeoutMs}`);
      if (events.length === 1) {
        const error = new Error('fixture helper startup timeout');
        error.code = 'ELOCKSTARTTIMEOUT';
        throw error;
      }
      return expectedRelease;
    },
  });

  assert.equal(release, expectedRelease);
  assert.deepEqual(events, ['attempt:5000', 'attempt:5000']);
  await release();
  assert.deepEqual(events, ['attempt:5000', 'attempt:5000', 'released']);
});

test('does not retry permanent process-lock helper failures', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-permanent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const failure = new Error('fixture permission failure');
  failure.code = 'EACCES';

  await assert.rejects(
    tryAcquireProcessLock(root, 'permanent-failure', {
      fileLockAttempt: async () => {
        attempts += 1;
        throw failure;
      },
    }),
    error => error === failure,
  );
  assert.equal(attempts, 1);
});

test('rejects malformed holder argv before spawning a process-lock helper', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sparseHolderCommand = ['/bin/sh'];
  sparseHolderCommand[2] = '-c';

  for (const fileLockHolderCommand of [
    [],
    '',
    [42],
    sparseHolderCommand,
    ['/bin/sh', 'invalid\0argument'],
  ]) {
    await assert.rejects(
      tryAcquireProcessLock(root, 'invalid-holder-command', {
        helperStartupAttempts: 1,
        fileLockHolderCommand,
      }),
      error => error.code === 'ELOCKCONFIG',
    );
  }
});

test('bounds helper startup recovery by the overall lock deadline', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-deadline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let released = false;

  await assert.rejects(
    acquireProcessLock(root, 'bounded-startup', {
      timeoutMs: 200,
      helperStartupAttempts: 1,
      fileLockAttempt: async () => {
        const finishAt = Date.now() + 250;
        while (Date.now() < finishAt) {}
        return async () => { released = true; };
      },
    }),
    error => error.code === 'ELOCKTIMEOUT',
  );
  assert.equal(released, true);
});

test('allows one nonblocking attempt when the overall lock timeout is zero', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-immediate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const release = await acquireProcessLock(root, 'immediate', { timeoutMs: 0 });
  assert.equal(typeof release, 'function');
  await assert.rejects(
    acquireProcessLock(root, 'immediate', { timeoutMs: 0 }),
    error => error.code === 'ELOCKTIMEOUT',
  );
  await release();
});

test('releases a lock acquired immediately before cancellation', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-abort-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  let released = false;

  await assert.rejects(
    tryAcquireProcessLock(root, 'cancelled-acquisition', {
      signal: controller.signal,
      fileLockAttempt: async () => {
        controller.abort(reason);
        return async () => { released = true; };
      },
    }),
    error => error === reason,
  );
  assert.equal(released, true);
});

test('observes cancellation that occurs while registering a retry delay', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-abort-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reason = new Error('fixture registration-race cancellation');
  let attempts = 0;
  const signal = {
    aborted: false,
    reason,
    addEventListener() {
      // Model an abort that happens after delay() checks `aborted`, but before
      // its listener registration returns control to the caller.
      this.aborted = true;
    },
    removeEventListener() {},
  };

  await assert.rejects(
    tryAcquireProcessLock(root, 'retry-delay-abort-race', {
      signal,
      helperStartupAttempts: 2,
      helperStartupRetryMs: 60_000,
      fileLockAttempt: async () => {
        attempts += 1;
        const error = new Error('fixture startup timeout');
        error.code = 'ELOCKSTARTTIMEOUT';
        throw error;
      },
    }),
    error => error === reason,
  );
  assert.equal(attempts, 1);
});

test('kills and closes a stalled helper process group before reporting timeout', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-cleanup-'));
  const pidFile = path.join(root, 'holder-pids');
  let fixturePids = [];
  t.after(async () => {
    for (const pid of fixturePids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    tryAcquireProcessLock(root, 'stalled-holder', {
      helperStartupAttempts: 1,
      helperStartupTimeoutMs: 2_000,
      fileLockHolderCommand: [
        '/bin/sh',
        '-c',
        'sleep 600 & descendant=$!; printf "%s\\n%s\\n" "$$" "$descendant" > "$1"; wait',
        'process-lock-stalled-holder',
        pidFile,
      ],
    }),
    error => error.code === 'ELOCKTIMEOUT'
      && error.cause?.code === 'ELOCKSTARTTIMEOUT',
  );

  fixturePids = (await fs.readFile(pidFile, 'utf8'))
    .trim().split('\n').map(Number);
  assert.equal(fixturePids.length, 2);
  assert.equal(await waitForProcessesToExit(fixturePids), true);
  fixturePids = [];

  const release = await acquireProcessLock(root, 'stalled-holder', { timeoutMs: 5_000 });
  await release();
});

test('release reaps an acquired holder after its macOS lockf wrapper dies', {
  skip: process.platform !== 'darwin' ? 'macOS lockf uses a wrapper process' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-wrapper-exit-'));
  const pidFile = path.join(root, 'holder-pids');
  let fixturePids = [];
  t.after(async () => {
    for (const pid of fixturePids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const release = await tryAcquireProcessLock(root, 'wrapper-exit-after-ready', {
    helperStartupAttempts: 1,
    helperStartupTimeoutMs: 10_000,
    fileLockHolderCommand: [
      process.execPath,
      stalledHolder,
      pidFile,
      'kill-wrapper-after-ready',
    ],
  });
  fixturePids = (await fs.readFile(pidFile, 'utf8'))
    .trim().split('\n').map(Number);
  const [holderPid, wrapperPid] = fixturePids;
  assert.equal(await waitForProcessesToExit([wrapperPid]), true);
  assert.equal(processExists(holderPid), true);

  await release();
  assert.equal(await waitForProcessesToExit([holderPid]), true);
  fixturePids = [];
});

test('reaps inherited-stdio descendants before reporting a helper exit', {
  skip: process.platform === 'win32' ? 'Windows uses socket locks' : false,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-process-lock-early-exit-'));
  const pidFile = path.join(root, 'holder-pids');
  let descendantPid = null;
  t.after(async () => {
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    tryAcquireProcessLock(root, 'exit-before-ready', {
      helperStartupAttempts: 1,
      helperStartupTimeoutMs: 10_000,
      fileLockHolderCommand: [
        process.execPath,
        stalledHolder,
        pidFile,
        'exit-before-ready',
      ],
    }),
    error => error.code === 'ELOCKHELPER',
  );
  descendantPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.equal(await waitForProcessesToExit([descendantPid]), true);
  descendantPid = null;
});

test('uses a no-fork shell holder instead of a second Node cold start on Linux', async () => {
  const source = await fs.readFile(new URL('../lib/process-lock.js', import.meta.url), 'utf8');
  assert.match(source, /'--no-fork'/);
  assert.match(source, /holderCommand = \['\/bin\/sh', '-c', FILE_LOCK_HELPER\]/);
  assert.doesNotMatch(source, /process\.execPath, '-e', FILE_LOCK_HELPER/);
});
