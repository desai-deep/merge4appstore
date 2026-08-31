import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  clearGitMirrorRegistry,
  ensureStateDirectory,
  gitSupportsNoLazyFetch,
  GitMirror,
  requestMirrorLockTimeoutMs,
  resolveStateDirectory,
} from '../lib/git-mirror.js';
import { GitHubAPI } from '../lib/github.js';
import { acquireProcessLock } from '../lib/process-lock.js';
import {
  prewarmGitMirrorOptions,
  prewarmGitMirrors,
} from '../scripts/prepare-git-mirrors.js';

const execFileAsync = promisify(execFile);
const stateDirectoryWorker = fileURLToPath(new URL('./fixtures/state-directory-worker.js', import.meta.url));

test('keeps request-time mirror initialization within the steady-state command budget', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-mirror-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mirror = new GitMirror('example', 'runtime', {
    stateDirectory: path.join(root, 'state'),
    commandTimeoutMs: 12_345,
  });

  assert.equal(mirror.commandTimeoutMs, 12_345);
  assert.equal(mirror.cloneTimeoutMs, 12_345);
  assert.equal(mirror.fetchTimeoutMs, 12_345);

  for (const [index, invalid] of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'invalid'].entries()) {
    const normalized = new GitMirror('example', `invalid-${index}`, {
      stateDirectory: path.join(root, 'state'),
      commandTimeoutMs: 12_345,
      cloneTimeoutMs: invalid,
    });
    assert.equal(normalized.cloneTimeoutMs, 12_345);
  }

  const invalidCommand = new GitMirror('example', 'invalid-command', {
    stateDirectory: path.join(root, 'state'),
    commandTimeoutMs: 0,
    fetchTimeoutMs: 0,
    lockTimeoutMs: 0,
  });
  assert.equal(invalidCommand.commandTimeoutMs, 15_000);
  assert.equal(invalidCommand.cloneTimeoutMs, 15_000);
  assert.equal(invalidCommand.fetchTimeoutMs, 15_000);
  assert.equal(invalidCommand.lockTimeoutMs, 5_000);

  assert.equal(requestMirrorLockTimeoutMs({}), 5_000);
  assert.equal(requestMirrorLockTimeoutMs({
    MERGE4APPSTORE_MIRROR_LOCK_TIMEOUT_MS: '60000',
  }), 5_000);
  assert.equal(requestMirrorLockTimeoutMs({
    MERGE4APPSTORE_MIRROR_LOCK_TIMEOUT_MS: '2500',
  }), 2_500);
  assert.equal(requestMirrorLockTimeoutMs({
    MERGE4APPSTORE_MIRROR_REQUEST_LOCK_TIMEOUT_MS: '60000',
    MERGE4APPSTORE_MIRROR_LOCK_TIMEOUT_MS: '1000',
  }), 5_000);
  assert.equal(requestMirrorLockTimeoutMs({
    MERGE4APPSTORE_MIRROR_REQUEST_LOCK_TIMEOUT_MS: '2500',
  }), 2_500);
});

test('gives deployment prewarming a longer Git command budget without changing runtime defaults', () => {
  assert.deepEqual(prewarmGitMirrorOptions({}), {
    commandTimeoutMs: 60_000,
    cloneTimeoutMs: 120_000,
    fetchTimeoutMs: 120_000,
    lockTimeoutMs: 60_000,
  });
  assert.deepEqual(prewarmGitMirrorOptions({
    MERGE4APPSTORE_MIRROR_PREWARM_TIMEOUT_MS: '90000',
    MERGE4APPSTORE_MIRROR_CLONE_TIMEOUT_MS: '180000',
    MERGE4APPSTORE_MIRROR_PREWARM_FETCH_TIMEOUT_MS: '150000',
    MERGE4APPSTORE_MIRROR_PREWARM_LOCK_TIMEOUT_MS: '30000',
  }), {
    commandTimeoutMs: 90_000,
    cloneTimeoutMs: 180_000,
    fetchTimeoutMs: 150_000,
    lockTimeoutMs: 30_000,
  });
  assert.deepEqual(prewarmGitMirrorOptions({
    MERGE4APPSTORE_MIRROR_PREWARM_TIMEOUT_MS: 'invalid',
    MERGE4APPSTORE_MIRROR_CLONE_TIMEOUT_MS: '0',
    MERGE4APPSTORE_MIRROR_PREWARM_FETCH_TIMEOUT_MS: '-1',
    MERGE4APPSTORE_MIRROR_PREWARM_LOCK_TIMEOUT_MS: '-1',
  }), {
    commandTimeoutMs: 60_000,
    cloneTimeoutMs: 120_000,
    fetchTimeoutMs: 120_000,
    lockTimeoutMs: 60_000,
  });
});

test('prewarms a missing mirror with one lock and no redundant post-clone fetch', async t => {
  const fixture = await createRepository(t);
  let lockCalls = 0;
  let cloneCalls = 0;
  let fetchCalls = 0;
  const mirror = new GitMirror('example', 'single-lock-prewarm', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    run: async (args, options) => {
      if (args.includes('clone')) cloneCalls += 1;
      if (args.includes('fetch')) fetchCalls += 1;
      return git(args, options);
    },
  });
  const withMutationLock = mirror.withMutationLock.bind(mirror);
  mirror.withMutationLock = (...args) => {
    lockCalls += 1;
    return withMutationLock(...args);
  };

  await mirror.refresh({ force: true });
  assert.deepEqual({ lockCalls, cloneCalls, fetchCalls }, {
    lockCalls: 1,
    cloneCalls: 1,
    fetchCalls: 0,
  });

  await mirror.refresh({ force: true });
  assert.deepEqual({ lockCalls, cloneCalls, fetchCalls }, {
    lockCalls: 2,
    cloneCalls: 1,
    fetchCalls: 1,
  });
});

test('falls back to GitHub before the request deadline when the mirror lock is held', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-mirror-lock-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mirror = new GitMirror('example', 'contended', {
    stateDirectory: path.join(root, 'state'),
    lockTimeoutMs: 50,
  });
  await mirror.ensureStateDirectories();
  const release = await acquireProcessLock(
    mirror.locksDirectory,
    `mirror:${mirror.lockIdentity}`,
    { timeoutMs: 0 },
  );
  try {
    const signal = AbortSignal.timeout(2_000);
    const github = new GitHubAPI('example', 'contended', 'main', { mirror, signal });
    let fallbackCalls = 0;
    github.execAsync = async () => {
      fallbackCalls += 1;
      return 'Provider fallback subject';
    };
    const startedAt = Date.now();
    assert.equal(
      await github.getCommitSubjectAsync('a'.repeat(40)),
      'Provider fallback subject',
    );
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(signal.aborted, false);
    assert.equal(fallbackCalls, 1);
  } finally {
    await release();
  }
});

test('prewarms every repository sequentially and aggregates per-repository failures', async () => {
  const events = [];
  const messages = [];
  const repositories = new Map([
    ['example/first', { owner: 'example', name: 'first' }],
    ['example/second', { owner: 'example', name: 'second' }],
    ['example/third', { owner: 'example', name: 'third' }],
  ]);
  const failures = new Map([
    ['first', new Error('first clone timed out')],
    ['third', new Error('third fetch failed')],
  ]);

  await assert.rejects(
    prewarmGitMirrors(repositories, {
      mirrorFor: (owner, repository) => ({
        refresh: async options => {
          events.push(`${owner}/${repository}:start`);
          assert.equal(options.force, true);
          assert.equal(options.signal instanceof AbortSignal, true);
          if (failures.has(repository)) throw failures.get(repository);
          events.push(`${owner}/${repository}:ready`);
        },
      }),
      logger: {
        log: message => messages.push(message),
        error: message => messages.push(message),
      },
    }),
    error => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.message, 'Could not prepare 2 Git mirror(s): example/first, example/third');
      assert.deepEqual(error.errors, [...failures.values()]);
      return true;
    },
  );

  assert.deepEqual(events, [
    'example/first:start',
    'example/second:start',
    'example/second:ready',
    'example/third:start',
  ]);
  assert.deepEqual(messages, [
    'Git mirror failed: example/first: first clone timed out',
    'Git mirror ready: example/second',
    'Git mirror failed: example/third: third fetch failed',
  ]);
});

test('retries one transient deployment prewarm failure before advancing', async () => {
  const events = [];
  const messages = [];
  const attempts = new Map();
  const repositories = new Map([
    ['example/first', { owner: 'example', name: 'first' }],
    ['example/second', { owner: 'example', name: 'second' }],
  ]);

  await prewarmGitMirrors(repositories, {
    mirrorFor: (owner, repository) => ({
      refresh: async ({ force, signal }) => {
        assert.equal(force, true);
        assert.equal(signal.aborted, false);
        const attempt = (attempts.get(repository) || 0) + 1;
        attempts.set(repository, attempt);
        events.push(`${owner}/${repository}:attempt-${attempt}`);
        if (repository === 'first' && attempt === 1) {
          const error = new Error('temporary helper startup failure');
          error.statusCode = 503;
          error.retryAfter = 5;
          throw error;
        }
      },
    }),
    logger: {
      log: message => messages.push(message),
      warn: message => messages.push(message),
      error: message => messages.push(message),
    },
    repositoryTimeoutMs: 10_000,
    sleep: async (milliseconds, signal) => {
      assert.equal(milliseconds, 5_000);
      assert.equal(signal.aborted, false);
      events.push(`sleep:${milliseconds}`);
    },
  });

  assert.deepEqual(events, [
    'example/first:attempt-1',
    'sleep:5000',
    'example/first:attempt-2',
    'example/second:attempt-1',
  ]);
  assert.deepEqual(messages, [
    'Git mirror transient failure: example/first: temporary helper startup failure; retrying in 5000ms (attempt 2/2)',
    'Git mirror ready: example/first',
    'Git mirror ready: example/second',
  ]);
});

test('waits for the configured mirror backoff before retrying the same instance', async t => {
  const fixture = await createRepository(t);
  let now = 1_000;
  let cloneCalls = 0;
  const mirror = new GitMirror('example', 'backoff-prewarm', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    retryBackoffMs: 60_000,
    now: () => now,
    run: async (args, options) => {
      if (args[0] === 'clone') {
        cloneCalls += 1;
        if (cloneCalls === 1) {
          const error = new Error('fixture initial transport failure');
          error.code = 128;
          throw error;
        }
      }
      return git(args, options);
    },
  });
  const sleeps = [];

  await prewarmGitMirrors(new Map([
    ['example/backoff-prewarm', { owner: 'example', name: 'backoff-prewarm' }],
  ]), {
    mirrorFor: () => mirror,
    logger: { log() {}, warn() {}, error() {} },
    repositoryTimeoutMs: 120_000,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds + 1;
    },
  });

  assert.deepEqual(sleeps, [60_000]);
  assert.equal(cloneCalls, 2);
});

test('aggregates an exhausted transient prewarm failure and still tries later repositories', async () => {
  const events = [];
  const finalFailure = new Error('transport still unavailable');
  finalFailure.statusCode = 503;
  finalFailure.retryAfter = 1;
  const repositories = new Map([
    ['example/failing', { owner: 'example', name: 'failing' }],
    ['example/healthy', { owner: 'example', name: 'healthy' }],
  ]);

  await assert.rejects(
    prewarmGitMirrors(repositories, {
      mirrorFor: (_owner, repository) => ({
        refresh: async () => {
          events.push(repository);
          if (repository === 'failing') throw finalFailure;
        },
      }),
      logger: { log() {}, warn() {}, error() {} },
      repositoryTimeoutMs: 10_000,
      sleep: async milliseconds => { events.push(`sleep:${milliseconds}`); },
    }),
    error => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [finalFailure]);
      return true;
    },
  );
  assert.equal(events[0], 'failing');
  assert.match(events[1], /^sleep:\d+$/);
  const retryDelay = Number(events[1].slice('sleep:'.length));
  assert.ok(retryDelay > 0 && retryDelay <= 1_000);
  assert.deepEqual(events.slice(2), ['failing', 'healthy']);
});

test('repository deadline rejects a retry whose backoff cannot fit', async () => {
  let attempts = 0;
  const transient = new Error('long provider backoff');
  transient.statusCode = 503;
  transient.retryAfter = 60;

  await assert.rejects(
    prewarmGitMirrors(new Map([
      ['example/backoff-timeout', { owner: 'example', name: 'backoff-timeout' }],
    ]), {
      mirrorFor: () => ({
        refresh: async () => {
          attempts += 1;
          throw transient;
        },
      }),
      logger: { log() {}, warn() {}, error() {} },
      repositoryTimeoutMs: 10,
    }),
    error => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0].code === 'EMIRRORPREWARMTIMEOUT',
  );
  assert.equal(attempts, 1);
});

test('wall-clock deadline prevents a retry after the event loop stalls', async () => {
  let attempts = 0;
  const transient = new Error('short provider backoff');
  transient.statusCode = 503;
  transient.retryAfter = 0.001;

  await assert.rejects(
    prewarmGitMirrors(new Map([
      ['example/stalled-loop', { owner: 'example', name: 'stalled-loop' }],
    ]), {
      mirrorFor: () => ({
        refresh: async () => {
          attempts += 1;
          throw transient;
        },
      }),
      logger: { log() {}, warn() {}, error() {} },
      repositoryTimeoutMs: 50,
      sleep: async () => {
        const releaseAt = Date.now() + 75;
        while (Date.now() < releaseAt) {}
      },
    }),
    error => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0].code === 'EMIRRORPREWARMTIMEOUT',
  );
  assert.equal(attempts, 1);
});

test('does not report a mirror ready after refresh exceeds the wall-clock deadline', async () => {
  const messages = [];

  await assert.rejects(
    prewarmGitMirrors(new Map([
      ['example/late-success', { owner: 'example', name: 'late-success' }],
    ]), {
      mirrorFor: () => ({
        refresh: async () => {
          const releaseAt = Date.now() + 75;
          while (Date.now() < releaseAt) {}
        },
      }),
      logger: {
        log: message => messages.push(message),
        warn: message => messages.push(message),
        error: message => messages.push(message),
      },
      repositoryTimeoutMs: 50,
    }),
    error => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0].code === 'EMIRRORPREWARMTIMEOUT',
  );
  assert.deepEqual(messages, [
    'Git mirror failed: example/late-success: Timed out preparing Git mirror example/late-success',
  ]);
});

test('aborts a repository that exceeds its deployment prewarm deadline', async () => {
  const repositories = new Map([
    ['example/stalled', { owner: 'example', name: 'stalled' }],
  ]);

  await assert.rejects(
    prewarmGitMirrors(repositories, {
      mirrorFor: () => ({
        refresh: async ({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      }),
      logger: { log() {}, warn() {}, error() {} },
      repositoryTimeoutMs: 10,
    }),
    error => error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0].code === 'EMIRRORPREWARMTIMEOUT',
  );
});

test('accepts only Git releases that enforce GIT_NO_LAZY_FETCH', () => {
  for (const version of [
    'git version 2.39.4',
    'git version 2.39.5',
    'git version 2.40.2',
    'git version 2.41.1',
    'git version 2.42.2',
    'git version 2.43.4',
    'git version 2.44.1',
    'git version 2.45.1',
    'git version 2.46.0',
    'git version 2.50.1 (Apple Git-155)',
    'git version 2.55.0.windows.1',
    'git version 3.0.0',
  ]) {
    assert.equal(gitSupportsNoLazyFetch(version), true, version);
  }

  for (const version of [
    '',
    'not git',
    'git version 2.38.5',
    'git version 2.39.3',
    'git version 2.40.1',
    'git version 2.41.0',
    'git version 2.42.1',
    'git version 2.43.3',
    'git version 2.44.0',
    'git version 2.45.0',
    'git version 2.46.0.rc1',
  ]) {
    assert.equal(gitSupportsNoLazyFetch(version), false, version);
  }
});

async function git(args, { timeoutMs = 15_000 } = {}) {
  return execFileAsync('git', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
    },
  });
}

async function output(args) {
  return (await git(args)).stdout.trim();
}

async function commit(repository, subject, contents = subject) {
  await fs.writeFile(path.join(repository, 'history.txt'), `${contents}\n`);
  await git(['-C', repository, 'add', 'history.txt']);
  await git(['-C', repository, 'commit', '-m', subject]);
  return output(['-C', repository, 'rev-parse', 'HEAD']);
}

async function createRepository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-mirror-test-'));
  t.after(async () => {
    clearGitMirrorRegistry();
    await fs.rm(root, { recursive: true, force: true });
  });

  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const stateDirectory = path.join(root, 'state');
  await fs.mkdir(source);
  await git(['-C', source, 'init', '--initial-branch=main']);
  await git(['-C', source, 'config', 'user.name', 'Mirror Test']);
  await git(['-C', source, 'config', 'user.email', 'mirror@example.test']);

  const rootCommit = await commit(source, 'Root release', 'root');
  await git(['-C', source, 'switch', '-c', 'diverged']);
  const oldestDivergedCommit = await commit(source, 'Old unrelated release', 'diverged-1');
  const middleDivergedCommit = await commit(source, 'Middle unrelated release', 'diverged-2');
  const divergedCommit = await commit(source, 'Newest unrelated release', 'diverged-3');
  await git(['-C', source, 'switch', 'main']);
  const baseCommit = await commit(source, 'Published release', 'base');
  const firstChange = await commit(source, 'First change', 'first');
  const headCommit = await commit(source, 'Second change', 'second');

  await git(['init', '--bare', '--initial-branch=main', remote]);
  await git(['-C', remote, 'config', 'uploadpack.allowFilter', 'true']);
  await git(['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await git(['-C', source, 'push', '--all', 'origin']);

  return {
    root,
    source,
    remote,
    remoteUrl: pathToFileURL(remote).href,
    stateDirectory,
    rootCommit,
    divergedCommit,
    middleDivergedCommit,
    oldestDivergedCommit,
    baseCommit,
    firstChange,
    headCommit,
  };
}

test('publishes one durable state marker for concurrent first-use processes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-state-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  const startAt = Date.now() + 500;
  const workers = Array.from({ length: 6 }, () => execFileAsync(
    process.execPath,
    [stateDirectoryWorker, stateDirectory, String(startAt)],
    { encoding: 'utf8', timeout: 10_000 },
  ));

  const results = await Promise.all(workers);
  assert.deepEqual(results.map(result => result.stdout), Array(6).fill('ready\n'));
  assert.equal(
    await fs.readFile(path.join(stateDirectory, '.merge4appstore-state'), 'utf8'),
    'merge4appstore-state-v1\n',
  );
  assert.equal((await fs.stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(stateDirectory, '.merge4appstore-state'))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(
    (await fs.readdir(stateDirectory)).sort(),
    ['.merge4appstore-state', '.process-locks'],
  );
});

test('ignores an interrupted marker temporary confined to the lock directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-state-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  const lockDirectory = path.join(stateDirectory, '.process-locks');
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(lockDirectory, '.merge4appstore-state.crashed.tmp'),
    'partial',
    { mode: 0o600 },
  );

  assert.equal(await ensureStateDirectory(stateDirectory), stateDirectory);
  assert.equal(
    await fs.readFile(path.join(stateDirectory, '.merge4appstore-state'), 'utf8'),
    'merge4appstore-state-v1\n',
  );
});

test('initializes one atomic, private, blobless bare mirror for concurrent callers', async t => {
  const fixture = await createRepository(t);
  let cloneCalls = 0;
  let connectivityChecks = 0;
  let cloneArgs;
  let cloneTimeoutMs;
  const steadyStateTimeouts = [];
  let cloneFinished;
  let releaseClone;
  const cloneReady = new Promise(resolve => { cloneFinished = resolve; });
  const cloneGate = new Promise(resolve => { releaseClone = resolve; });
  const run = async (args, options) => {
    const result = await git(args, options);
    if (args.includes('fsck')) connectivityChecks += 1;
    if (args[0] === 'clone') {
      cloneCalls += 1;
      cloneArgs = args;
      cloneTimeoutMs = options.timeoutMs;
      cloneFinished();
      await cloneGate;
    } else {
      steadyStateTimeouts.push(options.timeoutMs);
    }
    return result;
  };
  const options = {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    commandTimeoutMs: 23_456,
    cloneTimeoutMs: 78_901,
    run,
  };
  const first = new GitMirror('example', 'ios', options);
  const second = new GitMirror('example', 'ios', options);

  const initializing = Promise.all([first.ensureInitialized(), second.ensureInitialized()]);
  await cloneReady;
  await assert.rejects(fs.access(first.mirrorPath));
  assert.equal(
    (await fs.readdir(first.mirrorsDirectory)).some(entry => entry.includes('.tmp-')),
    true,
  );
  releaseClone();
  await initializing;

  assert.equal(cloneCalls, 1);
  const initializationConnectivityChecks = connectivityChecks;
  assert.ok(initializationConnectivityChecks >= 1);
  assert.deepEqual(cloneArgs.slice(0, 3), ['clone', '--mirror', '--filter=blob:none']);
  assert.equal(cloneTimeoutMs, 78_901);
  assert.ok(steadyStateTimeouts.length > 0);
  assert.deepEqual(new Set(steadyStateTimeouts), new Set([23_456]));
  assert.equal(await output(['-C', first.mirrorPath, 'rev-parse', '--is-bare-repository']), 'true');
  assert.equal(await output(['-C', first.mirrorPath, 'remote', 'get-url', 'origin']), fixture.remoteUrl);
  assert.equal(await output([
    '-C', first.mirrorPath, 'config', '--get', 'remote.origin.partialclonefilter',
  ]), 'blob:none');
  assert.equal(await output([
    '-C', first.mirrorPath, 'config', '--get', 'remote.origin.promisor',
  ]), 'true');
  assert.equal(await output([
    '-C', first.mirrorPath, 'config', '--get', 'merge4appstore.repository',
  ]), 'example/ios');
  assert.equal((await fs.stat(fixture.stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(first.mirrorPath)).mode & 0o777, 0o700);
  await assert.rejects(fs.access(path.join(first.mirrorPath, 'history.txt')));
  await assert.rejects(
    git(['-C', first.mirrorPath, 'cat-file', '-e', 'HEAD:history.txt']),
    error => error.code !== 0,
  );
  assert.equal(
    (await fs.readdir(first.mirrorsDirectory)).some(entry => entry.includes('.tmp-')),
    false,
  );
  assert.equal(await first.getCommitSubject(fixture.headCommit), 'Second change');
  assert.equal(connectivityChecks, initializationConnectivityChecks);
  const origin = new URL(await output(['-C', first.mirrorPath, 'remote', 'get-url', 'origin']));
  assert.equal(origin.username, '');
  assert.equal(origin.password, '');

  let reuseFetches = 0;
  const restartedProcess = new GitMirror('example', 'ios', {
    ...options,
    run: async (args, runOptions) => {
      if (args.includes('fetch')) reuseFetches += 1;
      return git(args, runOptions);
    },
  });
  assert.equal(await restartedProcess.getCommitSubject(fixture.headCommit), 'Second change');
  assert.equal(reuseFetches, 0);
});

test('ignores local Git replacement refs for mirror reads and validation', async t => {
  const fixture = await createRepository(t);
  const mirror = new GitMirror('example', 'replacement-resistant', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
  });
  await mirror.refresh({ force: true });
  await git([
    '-C', mirror.mirrorPath,
    'replace', fixture.headCommit, fixture.baseCommit,
  ]);

  assert.equal(
    await output(['-C', mirror.mirrorPath, 'show', '-s', '--format=%s', fixture.headCommit]),
    'Published release',
  );
  assert.equal(await mirror.getCommitSubject(fixture.headCommit), 'Second change');
  await mirror.verifyObjectConnectivity();
});

test('isolates mirror storage when one repository identity uses two remote URLs', async t => {
  const fixture = await createRepository(t);
  const remoteAlias = path.join(fixture.root, 'remote-alias.git');
  await fs.symlink(fixture.remote, remoteAlias, 'dir');
  const first = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
  });
  const second = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: pathToFileURL(remoteAlias).href,
  });

  assert.notEqual(first.mirrorPath, second.mirrorPath);
  assert.notEqual(first.lockPath, second.lockPath);
  assert.deepEqual(
    await Promise.all([
      first.getCommitSubject(fixture.headCommit),
      second.getCommitSubject(fixture.headCommit),
    ]),
    ['Second change', 'Second change'],
  );
  assert.equal(
    (await fs.readdir(first.mirrorsDirectory)).some(name => name.includes('.invalid-')),
    false,
  );
});

test('uses branch-aware ancestry locally, fetches a new head, and tolerates a stale fetch', async t => {
  const fixture = await createRepository(t);
  let now = 10_000;
  let fetchCalls = 0;
  const fetchTimeouts = [];
  let failFetch = false;
  const run = async (args, options) => {
    if (args.includes('fetch')) {
      fetchCalls += 1;
      fetchTimeouts.push(options.timeoutMs);
      if (failFetch) {
        const error = new Error('remote temporarily unavailable');
        error.code = 128;
        throw error;
      }
    }
    return git(args, options);
  };
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    refreshTtlMs: 50,
    commandTimeoutMs: 23_456,
    fetchTimeoutMs: 78_901,
    candidateLimit: 3,
    now: () => now,
    run,
  });

  const comparison = await mirror.getCommitSubjectsSince([
    {
      commitSha: fixture.divergedCommit,
      sourceBranch: 'main',
      buildNumber: '104',
      marketingVersion: '2.0',
    },
    {
      commitSha: fixture.middleDivergedCommit,
      sourceBranch: 'main',
      buildNumber: '103',
      marketingVersion: '1.9',
    },
    {
      commitSha: fixture.oldestDivergedCommit,
      sourceBranch: 'refs/heads/main',
      buildNumber: '102',
      marketingVersion: '1.8',
    },
    {
      commitSha: fixture.firstChange,
      sourceBranch: 'release/other',
      buildNumber: '101',
      marketingVersion: '1.7',
    },
    {
      commitSha: fixture.baseCommit,
      sourceBranch: 'refs/heads/main',
      buildNumber: '100',
      marketingVersion: '1.6',
    },
    {
      commitSha: fixture.rootCommit,
      buildNumber: '99',
      marketingVersion: '1.5',
    },
  ], fixture.headCommit, { branch: 'main' });

  assert.deepEqual(comparison, {
    baseCommit: fixture.baseCommit,
    baseBuildNumber: '100',
    baseMarketingVersion: '1.6',
    subjects: ['First change', 'Second change'],
  });
  assert.equal(fetchCalls, 0);

  const newHead = await commit(fixture.source, 'Third change', 'third');
  await git(['-C', fixture.source, 'push', 'origin', 'main']);
  assert.equal(await mirror.getCommitSubject(newHead), 'Third change');
  assert.equal(fetchCalls, 1);

  now += 51;
  failFetch = true;
  assert.equal(await mirror.getCommitSubject(newHead), 'Third change');
  assert.equal(fetchCalls, 2);
  assert.deepEqual(fetchTimeouts, [78_901, 78_901]);
});

test('treats contributor-controlled corruption-like commit subjects as ordinary text', async t => {
  const fixture = await createRepository(t);
  const subject = 'object file harmless-example is corrupt';
  const newHead = await commit(fixture.source, subject, 'benign subject');
  await git(['-C', fixture.source, 'push', 'origin', 'main']);
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
  });

  assert.equal(await mirror.getCommitSubject(newHead), subject);
  const history = await mirror.getCommitSubjectsSince([
    { commitSha: fixture.headCommit, sourceBranch: 'main' },
  ], newHead, { branch: 'main' });
  assert.deepEqual(history.subjects, [subject]);
  assert.equal(
    (await fs.readdir(mirror.mirrorsDirectory)).some(name => name.includes('.invalid-')),
    false,
  );
});

test('rejects unsafe state paths, credential-bearing remotes, and invalid commit input', async t => {
  assert.throws(() => resolveStateDirectory('relative/state'), /must be an absolute path/);
  assert.throws(() => resolveStateDirectory(process.cwd()), /Unsafe Git mirror state directory/);
  assert.throws(
    () => resolveStateDirectory(path.join(process.cwd(), '.git', 'mirrors')),
    /Unsafe Git mirror state directory/,
  );
  if (process.platform !== 'win32') {
    const aliasRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-state-alias-'));
    t.after(() => fs.rm(aliasRoot, { recursive: true, force: true }));
    const checkoutAlias = path.join(aliasRoot, 'checkout-alias');
    const gitAlias = path.join(aliasRoot, 'git-alias');
    await fs.symlink(process.cwd(), checkoutAlias, 'dir');
    await fs.symlink(path.join(process.cwd(), '.git'), gitAlias, 'dir');
    assert.throws(
      () => resolveStateDirectory(path.join(checkoutAlias, 'new-empty-state')),
      /Unsafe Git mirror state directory/,
    );
    assert.throws(
      () => resolveStateDirectory(path.join(gitAlias, 'new-mirror-state')),
      /Unsafe Git mirror state directory/,
    );
    await assert.rejects(fs.access(path.join(process.cwd(), 'new-empty-state')));
    await assert.rejects(fs.access(path.join(process.cwd(), '.git', 'new-mirror-state')));
  }
  assert.throws(() => new GitMirror('example', 'ios', {
    stateDirectory: path.join(os.tmpdir(), 'merge4appstore-test-state'),
    remoteUrl: 'https://user:secret@github.com/example/ios.git',
  }), /must not contain credentials/);
  assert.throws(() => new GitMirror('example', 'ios', {
    stateDirectory: path.join(os.tmpdir(), 'merge4appstore-test-state'),
    remoteUrl: 'ssh://user:secret@github.com/example/ios.git',
  }), /must not contain credentials/);
  assert.throws(() => new GitMirror('example', 'ios', {
    stateDirectory: path.join(os.tmpdir(), 'merge4appstore-test-state'),
    remoteUrl: 'git://user:secret@github.com/example/ios.git',
  }), /must not contain credentials/);

  let gitCalls = 0;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(os.tmpdir(), 'merge4appstore-test-state'),
    remoteUrl: 'https://github.com/example/ios.git',
    run: async () => {
      gitCalls += 1;
      throw new Error('Git should not run for invalid input');
    },
  });
  await assert.rejects(mirror.getCommitSubject('../etc/passwd'), error => (
    error.statusCode === 400 && /Invalid Git commit/.test(error.message)
  ));
  await assert.rejects(mirror.getCommitSubject('abcdef0'), error => (
    error.statusCode === 400 && /Invalid Git commit/.test(error.message)
  ));
  assert.equal(gitCalls, 0);
});

test('backs off after a failed initialization instead of cloning twice in one request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-mirror-backoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1_000;
  let cloneCalls = 0;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'state'),
    remoteUrl: 'https://github.com/example/ios.git',
    retryBackoffMs: 5_000,
    now: () => now,
    run: async args => {
      if (args[0] === 'clone') cloneCalls += 1;
      const error = new Error('network unavailable');
      error.code = 128;
      throw error;
    },
  });

  await assert.rejects(mirror.ensureInitialized(), error => error.statusCode === 503);
  await assert.rejects(mirror.ensureInitialized(), error => error.statusCode === 503);
  assert.equal(cloneCalls, 1);

  now += 5_001;
  await assert.rejects(mirror.ensureInitialized(), error => error.statusCode === 503);
  assert.equal(cloneCalls, 2);
});

test('coalesces concurrent initialization failures behind one backoff window', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-init-outage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let cloneCalls = 0;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'state'),
    remoteUrl: 'https://github.com/example/ios.git',
    retryBackoffMs: 60_000,
    run: async args => {
      if (args[0] === 'clone') cloneCalls += 1;
      const error = new Error('remote offline');
      error.code = 128;
      throw error;
    },
  });

  const results = await Promise.allSettled(Array.from(
    { length: 3 },
    () => mirror.ensureInitialized(),
  ));
  assert.equal(results.every(result => result.status === 'rejected'), true);
  assert.equal(cloneCalls, 1);
});

test('fails initialization when the remote silently ignores the blobless filter', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-filter-warning-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let cloneCalls = 0;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'state'),
    remoteUrl: 'https://github.com/example/ios.git',
    run: async args => {
      if (args[0] !== 'clone') throw new Error(`Unexpected Git command: ${args.join(' ')}`);
      cloneCalls += 1;
      return {
        stdout: '',
        stderr: 'warning: filtering not recognized by server, ignoring\n',
      };
    },
  });

  await assert.rejects(mirror.ensureInitialized(), error => (
    error.statusCode === 503
    && /blobless clone filter/.test(error.cause?.message || '')
  ));
  assert.equal(cloneCalls, 1);
  assert.equal(
    (await fs.readdir(mirror.mirrorsDirectory)).some(name => name.includes('.tmp-')),
    false,
  );
});

test('rejects a local clone transport that ignores the blob filter', async t => {
  const fixture = await createRepository(t);
  const mirror = new GitMirror('example', 'local-transport', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remote,
  });

  await assert.rejects(mirror.ensureInitialized(), error => (
    error.statusCode === 503
    && /blobless clone filter/.test(error.cause?.message || '')
  ));
  assert.equal(
    (await fs.readdir(mirror.mirrorsDirectory)).some(name => name.includes('.tmp-')),
    false,
  );
});

test('backs off a failed refresh so one preparation does not repeat the transport outage', async t => {
  const fixture = await createRepository(t);
  let now = 1_000;
  let fetchCalls = 0;
  let failFetch = false;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    refreshTtlMs: 10,
    retryBackoffMs: 50,
    now: () => now,
    run: async (args, options) => {
      if (args.includes('fetch')) {
        fetchCalls += 1;
        if (failFetch) {
          const error = new Error('transport unavailable');
          error.code = 128;
          throw error;
        }
      }
      return git(args, options);
    },
  });
  await mirror.ensureInitialized();
  const newHead = await commit(fixture.source, 'Unfetched head', 'unfetched');
  await git(['-C', fixture.source, 'push', 'origin', 'main']);
  failFetch = true;
  now += 11;

  const concurrent = await Promise.allSettled(Array.from(
    { length: 3 },
    () => mirror.getCommitSubject(newHead),
  ));
  assert.equal(concurrent.every(result => (
    result.status === 'rejected' && result.reason.statusCode === 503
  )), true);
  await assert.rejects(mirror.getCommitSubject(newHead), error => error.statusCode === 503);
  assert.equal(fetchCalls, 1);
  now += 51;
  await assert.rejects(mirror.getCommitSubject(newHead), error => error.statusCode === 503);
  assert.equal(fetchCalls, 2);
});

test('does not mark a refresh healthy when the remote ignores its blob filter', async t => {
  const fixture = await createRepository(t);
  let now = 1_000;
  let ignoreFilter = false;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    now: () => now,
    run: async (args, options) => {
      if (ignoreFilter && args.includes('fetch')) {
        return {
          stdout: '',
          stderr: 'warning: filtering not recognized by server, ignoring\n',
        };
      }
      return git(args, options);
    },
  });
  await mirror.ensureInitialized();
  const stamp = path.join(mirror.mirrorPath, mirror.refreshStampName);
  const refreshedAt = (await fs.stat(stamp)).mtimeMs;
  now += 1_000;
  ignoreFilter = true;

  await assert.rejects(mirror.refresh({ force: true }), error => (
    error.statusCode === 503 && /blobless fetch filter/.test(error.message)
  ));
  assert.equal((await fs.stat(stamp)).mtimeMs, refreshedAt);
});

test('repairs a mirror deleted or corrupted after in-process validation', async t => {
  const fixture = await createRepository(t);
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
  });
  await mirror.ensureInitialized();
  await fs.rm(mirror.mirrorPath, { recursive: true, force: true });
  assert.equal(await mirror.getCommitSubject(fixture.headCommit), 'Second change');

  await git(['-C', mirror.mirrorPath, 'config', 'merge4appstore.repository', 'wrong/repository']);
  assert.equal(await mirror.getCommitSubject(fixture.headCommit, { forceRefresh: true }), 'Second change');
  assert.equal(
    (await fs.readdir(mirror.mirrorsDirectory)).some(name => name.includes('.invalid-')),
    true,
  );
});

test('rebuilds object corruption and cleans abandoned clone directories under the lock', async t => {
  const fixture = await createRepository(t);
  let mirror;
  let injectCorruption = false;
  let corruptionInjected = false;
  let corruptPack;
  const run = async (args, options) => {
    const result = await git(args, options);
    if (injectCorruption && !corruptionInjected && args.includes('cat-file')) {
      corruptionInjected = true;
      const abandoned = `${mirror.mirrorPath}.tmp-999999-abandoned`;
      await fs.mkdir(abandoned);
      await fs.writeFile(path.join(abandoned, 'partial-clone'), 'incomplete');
      const packDirectory = path.join(mirror.mirrorPath, 'objects', 'pack');
      corruptPack = (await fs.readdir(packDirectory)).find(name => name.endsWith('.pack'));
      assert.ok(corruptPack, 'the partial mirror should contain a pack file');
      const corruptPath = path.join(packDirectory, corruptPack);
      await fs.chmod(corruptPath, 0o600);
      await fs.truncate(corruptPath, 32);
    }
    return result;
  };
  mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    run,
  });
  await mirror.ensureInitialized();

  injectCorruption = true;
  assert.equal(await mirror.getCommitSubject(fixture.headCommit), 'Second change');
  assert.equal(corruptionInjected, true);

  const entries = await fs.readdir(mirror.mirrorsDirectory);
  const abandonedPrefix = `${path.basename(mirror.mirrorPath)}.tmp-`;
  assert.equal(entries.some(name => name.startsWith(abandonedPrefix)), false);
  const quarantinePrefix = `${path.basename(mirror.mirrorPath)}.invalid-`;
  const quarantines = entries.filter(name => name.startsWith(quarantinePrefix));
  assert.equal(quarantines.length, 1);
  assert.equal(
    (await fs.stat(path.join(
      mirror.mirrorsDirectory,
      quarantines[0],
      'objects',
      'pack',
      corruptPack,
    ))).size,
    32,
  );
});

test('rebuilds a mirror whose pack index disappeared after a successful clone', async t => {
  const fixture = await createRepository(t);
  let cloneCalls = 0;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    run: async (args, options) => {
      if (args[0] === 'clone') cloneCalls += 1;
      return git(args, options);
    },
  });
  await mirror.ensureInitialized();
  assert.equal(cloneCalls, 1);

  const packDirectory = path.join(mirror.mirrorPath, 'objects', 'pack');
  const packIndex = (await fs.readdir(packDirectory)).find(name => name.endsWith('.idx'));
  assert.ok(packIndex, 'the partial mirror should contain a pack index');
  await fs.rename(
    path.join(packDirectory, packIndex),
    path.join(fixture.root, packIndex),
  );

  assert.equal(
    await mirror.getCommitSubject(fixture.headCommit, { forceRefresh: true }),
    'Second change',
  );
  assert.equal(cloneCalls, 2);
  assert.equal(
    (await fs.readdir(mirror.mirrorsDirectory)).some(name => name.includes('.invalid-')),
    true,
  );
});

test('backs off initialization when a corrupt mirror cannot be replaced', async t => {
  const fixture = await createRepository(t);
  let now = 1_000;
  let cloneCalls = 0;
  let failClone = false;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    retryBackoffMs: 60_000,
    now: () => now,
    run: async (args, options) => {
      if (args[0] === 'clone') {
        cloneCalls += 1;
        if (failClone) {
          const error = new Error('replacement remote unavailable');
          error.code = 128;
          throw error;
        }
      }
      return git(args, options);
    },
  });
  await mirror.ensureInitialized();

  const packDirectory = path.join(mirror.mirrorPath, 'objects', 'pack');
  const packIndex = (await fs.readdir(packDirectory)).find(name => name.endsWith('.idx'));
  assert.ok(packIndex, 'the partial mirror should contain a pack index');
  await fs.rm(path.join(packDirectory, packIndex));
  failClone = true;

  await assert.rejects(
    mirror.refresh({ headCommit: fixture.headCommit, force: true }),
    error => error.statusCode === 503,
  );
  assert.equal(cloneCalls, 2);

  await assert.rejects(
    mirror.refresh({ headCommit: fixture.headCommit }),
    error => error.statusCode === 503,
  );
  assert.equal(cloneCalls, 2, 'initialization backoff must prevent an immediate replacement clone');

  now += 60_001;
  await assert.rejects(
    mirror.refresh({ headCommit: fixture.headCommit }),
    error => error.statusCode === 503,
  );
  assert.equal(cloneCalls, 3, 'replacement clone should be retried after initialization backoff');
});

test('does not quarantine a healthy mirror when connectivity verification times out', async t => {
  const fixture = await createRepository(t);
  const initialized = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
  });
  await initialized.ensureInitialized();

  let cloneCalls = 0;
  const restarted = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
    run: async (args, options) => {
      if (args[0] === 'clone') cloneCalls += 1;
      if (args.includes('fsck')) {
        const error = new Error('Git connectivity check timed out');
        error.code = null;
        error.killed = true;
        error.signal = 'SIGTERM';
        throw error;
      }
      return git(args, options);
    },
  });

  await assert.rejects(restarted.ensureInitialized(), error => error.statusCode === 503);
  assert.equal(cloneCalls, 0);
  assert.equal(
    (await fs.readdir(restarted.mirrorsDirectory)).some(name => name.includes('.invalid-')),
    false,
  );
  assert.equal(await output(['-C', restarted.mirrorPath, 'rev-parse', 'HEAD']), fixture.headCommit);
});

test('skips malformed provider SHAs and checks more than three unknown-branch ancestors', async t => {
  const fixture = await createRepository(t);
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: fixture.stateDirectory,
    remoteUrl: fixture.remoteUrl,
  });
  const divergent = [
    fixture.divergedCommit,
    fixture.middleDivergedCommit,
    fixture.oldestDivergedCommit,
    fixture.divergedCommit,
  ].map((commitSha, index) => ({ commitSha, buildNumber: String(200 - index) }));
  const result = await mirror.getCommitSubjectsSince([
    { commitSha: 'not-a-provider-sha', sourceBranch: 'main', buildNumber: '999' },
    ...divergent,
    { commitSha: fixture.rootCommit, buildNumber: '100', marketingVersion: '1.0' },
  ], fixture.headCommit, { branch: 'main' });

  assert.equal(result.baseCommit, fixture.rootCommit);
  assert.deepEqual(result.subjects, ['Published release', 'First change', 'Second change']);
});

test('preserves newest-first order between unknown and exact-branch ancestors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-candidate-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const newerUnknown = 'a'.repeat(40);
  const olderExact = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'state'),
    remoteUrl: 'https://github.com/example/ios.git',
  });
  mirror.refresh = async () => {};
  mirror.hasCommitUnchecked = async () => true;
  mirror.git = async args => {
    if (args.includes('merge-base')) return { stdout: '' };
    if (args.includes('log')) return { stdout: 'Only the unpublished change\n' };
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };

  const result = await mirror.getCommitSubjectsSince([
    { commitSha: newerUnknown, buildNumber: '102' },
    { commitSha: olderExact, sourceBranch: 'main', buildNumber: '101' },
  ], head, { branch: 'main' });

  assert.equal(result.baseCommit, newerUnknown);
  assert.equal(result.baseBuildNumber, '102');

  const branchlessCandidates = Array.from({ length: 25 }, (_, index) => ({
    commitSha: index.toString(16).padStart(40, '0'),
    buildNumber: String(200 - index),
  }));
  assert.deepEqual(
    mirror.selectCandidates(branchlessCandidates, head, null),
    branchlessCandidates.slice(0, 20),
  );
  assert.deepEqual(
    mirror.selectCandidates(
      branchlessCandidates.map(candidate => ({ ...candidate, sourceBranch: 'main' })),
      head,
      'main',
    ),
    branchlessCandidates.slice(0, 20).map(candidate => ({
      ...candidate,
      sourceBranch: 'main',
    })),
  );

  const explicitlyOversized = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'oversized-state'),
    remoteUrl: 'https://github.com/example/ios.git',
    candidateLimit: 500,
  });
  assert.deepEqual(
    explicitlyOversized.selectCandidates(branchlessCandidates, head, null),
    branchlessCandidates.slice(0, 20),
  );
});

test('does not cache an older release base while a preferred candidate is unavailable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-range-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preferred = 'a'.repeat(40);
  const fallback = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const available = new Set([fallback, head]);
  const historyReads = [];
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'state'),
    remoteUrl: 'https://github.com/example/ios.git',
  });
  mirror.refresh = async () => {};
  mirror.hasCommitUnchecked = async commitSha => available.has(commitSha);
  mirror.git = async args => {
    if (args.includes('merge-base')) return { stdout: '' };
    if (args.includes('log')) {
      const range = args.at(-1);
      historyReads.push(range);
      return { stdout: range.startsWith(preferred)
        ? 'Only the newest change\n'
        : 'Already published change\nOnly the newest change\n' };
    }
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };

  const candidates = [
    { commitSha: preferred, sourceBranch: 'main', buildNumber: '102' },
    { commitSha: fallback, sourceBranch: 'main', buildNumber: '101' },
  ];
  const first = await mirror.getCommitSubjectsSince(candidates, head, { branch: 'main' });
  assert.equal(first.baseCommit, fallback);
  assert.equal(mirror.rangeCache.size, 0);

  available.add(preferred);
  const second = await mirror.getCommitSubjectsSince(candidates, head, { branch: 'main' });
  assert.equal(second.baseCommit, preferred);
  assert.deepEqual(second.subjects, ['Only the newest change']);
  assert.deepEqual(historyReads, [`${fallback}..${head}`, `${preferred}..${head}`]);
});

test('caches a definitive no-ancestor result without repeating local comparisons', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-null-range-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  let comparisons = 0;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'state'),
    remoteUrl: 'https://github.com/example/ios.git',
  });
  mirror.refresh = async () => {};
  mirror.hasCommitUnchecked = async () => true;
  mirror.git = async args => {
    if (args.includes('merge-base')) {
      comparisons += 1;
      const error = new Error('not an ancestor');
      error.code = 1;
      throw error;
    }
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };
  const published = [{ commitSha: candidate, sourceBranch: 'main' }];

  assert.equal(await mirror.getCommitSubjectsSince(published, head, { branch: 'main' }), null);
  assert.equal(await mirror.getCommitSubjectsSince(published, head, { branch: 'main' }), null);
  assert.equal(comparisons, 1);
});

test('does not retain an ancestry result larger than the weighted cache budget', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-range-cache-weight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  let historyReads = 0;
  const mirror = new GitMirror('example', 'ios', {
    stateDirectory: path.join(root, 'state'),
    remoteUrl: 'https://github.com/example/ios.git',
    rangeCacheMaxBytes: 256,
  });
  mirror.refresh = async () => {};
  mirror.hasCommitUnchecked = async () => true;
  mirror.git = async args => {
    if (args.includes('merge-base')) return { stdout: '', stderr: '' };
    if (args.includes('log')) {
      historyReads += 1;
      return { stdout: `${'large subject '.repeat(100)}\n`, stderr: '' };
    }
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };
  const published = [{ commitSha: candidate, sourceBranch: 'main' }];

  await mirror.getCommitSubjectsSince(published, head, { branch: 'main' });
  await mirror.getCommitSubjectsSince(published, head, { branch: 'main' });
  assert.equal(historyReads, 2);
  assert.equal(mirror.rangeCache.size, 0);
  assert.equal(mirror.rangeCacheBytes, 0);
});
