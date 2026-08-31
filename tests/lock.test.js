import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureStateDirectory } from '../lib/git-mirror.js';
import { CONFIG, log } from '../lib/config.js';
import { acquireLock, isProcessAlive, releaseLock, waitForLock } from '../lib/lock.js';

function withLockEnvironment(testContext) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-lock-'));
  const previousStateDirectory = process.env.MERGE4APPSTORE_STATE_DIR;
  const previousInstanceName = process.env.INSTANCE_NAME;
  process.env.MERGE4APPSTORE_STATE_DIR = stateDirectory;
  process.env.INSTANCE_NAME = `lock-test-${process.pid}`;

  testContext.after(() => {
    if (previousStateDirectory === undefined) delete process.env.MERGE4APPSTORE_STATE_DIR;
    else process.env.MERGE4APPSTORE_STATE_DIR = previousStateDirectory;
    if (previousInstanceName === undefined) delete process.env.INSTANCE_NAME;
    else process.env.INSTANCE_NAME = previousInstanceName;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  });

  return stateDirectory;
}

test('treats an unsignalable process as live and a missing process as stale', () => {
  assert.equal(isProcessAlive(42, () => {}), true);
  assert.equal(isProcessAlive(42, () => {
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  }), true);
  assert.equal(isProcessAlive(42, () => {
    const error = new Error('missing');
    error.code = 'ESRCH';
    throw error;
  }), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test('waits for a busy repository lock instead of dropping the job', async () => {
  let attempts = 0;
  const acquired = await waitForLock({
    timeoutMs: 100,
    retryMs: 1,
    sleep: async () => {},
    now: () => 0,
    acquire: () => {
      attempts += 1;
      return attempts === 3;
    },
  });

  assert.equal(acquired, true);
  assert.equal(attempts, 3);
});

test('reports a lock timeout as an incomplete job', async () => {
  assert.equal(await waitForLock({
    timeoutMs: 0,
    retryMs: 1,
    acquire: () => false,
  }), false);
});

test('surfaces permanent lock setup failures without treating them as contention', async () => {
  const failure = new Error('unsafe lock path');
  let sleeps = 0;
  await assert.rejects(
    waitForLock({
      timeoutMs: 600_000,
      acquire: async () => { throw failure; },
      sleep: async () => { sleeps += 1; },
    }),
    error => error === failure,
  );
  assert.equal(sleeps, 0);
});

test('creates a private jobs directory before acquiring the first lock', async testContext => {
  const stateDirectory = withLockEnvironment(testContext);
  const jobsDirectory = path.join(stateDirectory, 'jobs');

  assert.equal(fs.existsSync(jobsDirectory), false);
  assert.equal(await acquireLock(), true);
  assert.equal(fs.lstatSync(jobsDirectory).isDirectory(), true);
  assert.equal(fs.lstatSync(jobsDirectory).mode & 0o777, 0o700);

  await releaseLock();
});

test('lock-first initialization remains valid for persistent state consumers', async testContext => {
  const stateDirectory = withLockEnvironment(testContext);

  assert.equal(await acquireLock(), true);
  assert.equal(
    fs.readFileSync(path.join(stateDirectory, '.merge4appstore-state'), 'utf8'),
    'merge4appstore-state-v1\n',
  );
  assert.equal(await ensureStateDirectory(stateDirectory), stateDirectory);

  await releaseLock();
});

test('writes CLI locks and logs under the configured shared state root', async testContext => {
  const stateDirectory = withLockEnvironment(testContext);

  assert.equal(await acquireLock(), true);
  log('shared state path test');

  assert.equal(path.dirname(CONFIG.lockFile), path.join(stateDirectory, 'jobs'));
  assert.equal(path.dirname(CONFIG.logFile), path.join(stateDirectory, 'logs'));
  assert.equal(fs.lstatSync(path.dirname(CONFIG.logFile)).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(CONFIG.logFile).mode & 0o777, 0o600);
  await releaseLock();
});

test('defaults CLI locks and logs to the private home state root', () => {
  const previousStateDirectory = process.env.MERGE4APPSTORE_STATE_DIR;
  try {
    delete process.env.MERGE4APPSTORE_STATE_DIR;
    const expected = path.join(os.homedir(), '.local', 'state', 'merge4appstore');
    assert.equal(path.dirname(path.dirname(CONFIG.lockFile)), expected);
    assert.equal(path.dirname(path.dirname(CONFIG.logFile)), expected);
  } finally {
    if (previousStateDirectory === undefined) delete process.env.MERGE4APPSTORE_STATE_DIR;
    else process.env.MERGE4APPSTORE_STATE_DIR = previousStateDirectory;
  }
});

test('refuses a jobs-directory symlink without writing through it', async testContext => {
  const stateDirectory = withLockEnvironment(testContext);
  await ensureStateDirectory(stateDirectory);
  const redirectedDirectory = path.join(stateDirectory, 'redirected');
  const jobsDirectory = path.join(stateDirectory, 'jobs');
  fs.mkdirSync(redirectedDirectory, { mode: 0o700 });
  fs.symlinkSync(redirectedDirectory, jobsDirectory, 'dir');

  await assert.rejects(acquireLock(), /Lock parent is not a real directory|not a directory/);
  assert.deepEqual(fs.readdirSync(redirectedDirectory), []);
});
