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
