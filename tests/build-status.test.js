import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildFailureMarker,
  FileBuildStatusStore,
  MemoryBuildStatusStore,
  reportXcodeBuildStatus,
} from '../lib/build-status.js';

test('opens one durable GitHub issue for production Xcode build failures', async () => {
  let received;
  const github = {
    upsertIssue: async (...args) => {
      received = args;
      return { number: 12, url: 'https://github.example/issues/12' };
    },
  };
  const result = await reportXcodeBuildStatus(github, {
    status: 'FAILED',
    workflowId: 'workflow-production',
    runId: 'run-42',
    buildNumber: 42,
    commitSha: 'a'.repeat(40),
  }, new MemoryBuildStatusStore());

  assert.equal(result.number, 12);
  assert.equal(received[0], buildFailureMarker('workflow-production', 'production'));
  assert.match(received[1], /build failed.*#42/i);
  assert.match(received[2], /rerun the workflow/i);
});

test('closes the production build failure issue after a success', async () => {
  let received;
  const github = {
    closeIssueByMarker: async (...args) => { received = args; return { number: 12 }; },
  };
  await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED',
    workflowId: 'workflow-production',
    runId: 'run-43',
    buildNumber: 43,
  }, new MemoryBuildStatusStore());
  assert.equal(received[0], buildFailureMarker('workflow-production', 'production'));
  assert.match(received[1], /succeeded/i);
});

test('publishes failure alerts for pull request workflows too', async () => {
  let title;
  await reportXcodeBuildStatus({
    upsertIssue: async (_marker, received) => { title = received; return { number: 13 }; },
  }, {
    status: 'FAILED', purpose: 'pull_request', workflowId: 'workflow-pr', runId: 'run-pr', buildNumber: 7,
  }, new MemoryBuildStatusStore());
  assert.match(title, /pull_request build failed/i);
});

test('skips build alerts when repository issues are disabled and records ordering', async () => {
  const store = new MemoryBuildStatusStore();
  const github = {
    repositoryIssuesEnabled: async () => false,
    upsertIssue: () => { throw new Error('must not publish an issue'); },
    closeIssueByMarker: () => { throw new Error('must not close an issue'); },
  };
  const result = await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-pr', runId: 'run-44', buildNumber: 44,
  }, store);

  assert.deepEqual(result, { skipped: true, reason: 'issues-disabled' });
  assert.equal((await store.read('production:workflow-pr')).status, 'SUCCEEDED');
  assert.deepEqual(await reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-pr', runId: 'run-43', buildNumber: 43,
  }, store), { ignored: true, reason: 'older-build' });
});

test('fails for retry when GitHub cannot publish the build alert', async () => {
  await assert.rejects(
    () => reportXcodeBuildStatus({ upsertIssue: () => false }, {
      status: 'FAILED', workflowId: 'workflow-production', runId: 'run-42',
    }, new MemoryBuildStatusStore()),
    /Could not publish/,
  );
});

test('does not let an older success close a newer build failure', async () => {
  const calls = [];
  const github = {
    upsertIssue: async () => { calls.push('open'); return { number: 12 }; },
    closeIssueByMarker: async () => { calls.push('close'); return { number: 12 }; },
  };
  const store = new MemoryBuildStatusStore();
  await reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-production', runId: 'new', buildNumber: 44,
  }, store);
  const result = await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'old', buildNumber: 43,
  }, store);
  assert.deepEqual(calls, ['open']);
  assert.deepEqual(result, { ignored: true, reason: 'older-build' });
});

test('does not let an older failure reopen after a newer success', async () => {
  const calls = [];
  const github = {
    upsertIssue: async () => { calls.push('open'); return { number: 12 }; },
    closeIssueByMarker: async () => { calls.push('close'); return null; },
  };
  const store = new MemoryBuildStatusStore();
  await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'new', buildNumber: 44,
  }, store);
  await reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-production', runId: 'old', buildNumber: 43,
  }, store);
  assert.deepEqual(calls, ['close']);
});

test('serializes concurrent completions before applying monotonic ordering', async () => {
  const calls = [];
  let allowNewerToFinish;
  const newerCanFinish = new Promise(resolve => { allowNewerToFinish = resolve; });
  let newerStarted;
  const newerDidStart = new Promise(resolve => { newerStarted = resolve; });
  const github = {
    closeIssueByMarker: async () => {
      calls.push('close-start');
      newerStarted();
      await newerCanFinish;
      calls.push('close-finish');
      return null;
    },
    upsertIssue: async () => {
      calls.push('open');
      return { number: 12 };
    },
  };
  const store = new MemoryBuildStatusStore();
  const newer = reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'new', buildNumber: 44,
  }, store);
  await newerDidStart;
  const older = reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-production', runId: 'old', buildNumber: 43,
  }, store);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['close-start']);
  allowNewerToFinish();
  const [, olderResult] = await Promise.all([newer, older]);
  assert.deepEqual(calls, ['close-start', 'close-finish']);
  assert.deepEqual(olderResult, { ignored: true, reason: 'older-build' });
});

test('uses completion time ordering when Apple omits a build number', async () => {
  const calls = [];
  const github = {
    upsertIssue: async () => { calls.push('open'); return { number: 12 }; },
    closeIssueByMarker: async () => { calls.push('close'); return null; },
  };
  const store = new MemoryBuildStatusStore();
  await reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-production', runId: 'new',
    buildNumber: null, completedAt: '2026-08-31T12:00:00Z',
  }, store);
  await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'old',
    buildNumber: null, completedAt: '2026-08-31T11:00:00Z',
  }, store);
  assert.deepEqual(calls, ['open']);
});

test('uses completion time when only one of two events has a build number', async () => {
  const calls = [];
  const github = {
    upsertIssue: async () => { calls.push('open'); return { number: 12 }; },
    closeIssueByMarker: async () => { calls.push('close'); return null; },
  };
  const store = new MemoryBuildStatusStore();
  await reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-production', runId: 'new',
    buildNumber: 44, completedAt: '2026-08-31T12:00:00Z',
  }, store);
  await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'old',
    buildNumber: null, completedAt: '2026-08-31T11:00:00Z',
  }, store);
  assert.deepEqual(calls, ['open']);
});

test('uses completion time to order conflicting events for the same build number', async () => {
  const calls = [];
  const github = {
    upsertIssue: async () => { calls.push('open'); return { number: 12 }; },
    closeIssueByMarker: async () => { calls.push('close'); return null; },
  };
  const store = new MemoryBuildStatusStore();
  await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'new',
    buildNumber: 44, completedAt: '2026-08-31T12:00:00Z',
  }, store);
  await reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-production', runId: 'old',
    buildNumber: 44, completedAt: '2026-08-31T11:00:00Z',
  }, store);
  assert.deepEqual(calls, ['close']);
});

test('does not let an unorderable completion overwrite known newer state', async () => {
  const calls = [];
  const github = {
    upsertIssue: async () => { calls.push('open'); return { number: 12 }; },
    closeIssueByMarker: async () => { calls.push('close'); return null; },
  };
  const store = new MemoryBuildStatusStore();
  await reportXcodeBuildStatus(github, {
    status: 'FAILED', workflowId: 'workflow-production', runId: 'known',
    buildNumber: 44, completedAt: '2026-08-31T12:00:00Z',
  }, store);
  const ignored = await reportXcodeBuildStatus(github, {
    status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'unknown',
    buildNumber: null, completedAt: null,
  }, store);
  assert.deepEqual(calls, ['open']);
  assert.deepEqual(ignored, { ignored: true, reason: 'unorderable-event' });
});

test('does not advance monotonic state when closing the GitHub issue fails', async () => {
  const store = new MemoryBuildStatusStore();
  await assert.rejects(
    () => reportXcodeBuildStatus({
      closeIssueByMarker: async () => { throw new Error('GitHub unavailable'); },
    }, {
      status: 'SUCCEEDED', workflowId: 'workflow-production', runId: 'run-45', buildNumber: 45,
    }, store),
    /GitHub unavailable/,
  );
  assert.equal(await store.read('production:workflow-production'), null);
});

test('persists build order across process restarts', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'build-status-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const store = new FileBuildStatusStore({ stateDirectory });
  await store.write('beta:wf', { order: { build: 8, time: null }, status: 'FAILED' });
  assert.deepEqual(
    await new FileBuildStatusStore({ stateDirectory }).read('beta:wf'),
    { key: 'beta:wf', order: { build: 8, time: null }, status: 'FAILED' },
  );
});
