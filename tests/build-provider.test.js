import test from 'node:test';
import assert from 'node:assert/strict';

import { XcodeCloudBuildProvider } from '../lib/build-provider.js';
import {
  buildIntentFromEnvironment,
  effectiveTriggerDryRun,
  runManagedBuildTrigger,
  waitForBuildCompletion,
} from '../lib/trigger.js';

function intent() {
  return {
    provider: 'xcode_cloud',
    purpose: 'pull_request',
    appRole: 'uat',
    workflowId: 'workflow-pr',
    commitSha: 'abcdef1234567890',
    branch: 'codex/e2e-managed-trigger',
  };
}

test('enforces native, shadow, and managed trigger safety modes', () => {
  assert.throws(() => effectiveTriggerDryRun('native', false), /trigger mode is native/);
  assert.equal(effectiveTriggerDryRun('native', true), true);
  assert.equal(effectiveTriggerDryRun('shadow', false), true);
  assert.equal(effectiveTriggerDryRun('shadow', true), true);
  assert.equal(effectiveTriggerDryRun('managed', false), false);
  assert.equal(effectiveTriggerDryRun('managed', true), true);
  assert.throws(() => effectiveTriggerDryRun('other', false), /Unsupported build trigger mode/);
});

test('starts an Xcode Cloud build for a provider-neutral intent', async () => {
  let started = null;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowRunStatus: async () => ({ found: false }),
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    startWorkflowBuild: async (workflowId, sourceReferenceId) => {
      started = { workflowId, sourceReferenceId };
      return { runId: 'run-1', number: 150, executionProgress: 'PENDING' };
    },
  });

  const result = await provider.trigger(intent());

  assert.deepEqual(started, { workflowId: 'workflow-pr', sourceReferenceId: 'branch-ref' });
  assert.deepEqual(result, {
    action: 'started',
    provider: 'xcode_cloud',
    source: 'branch',
    runId: 'run-1',
    number: 150,
    executionProgress: 'PENDING',
  });
});

test('reuses an existing run for the same workflow and commit', async () => {
  let started = false;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    getWorkflowRunStatus: async () => ({
      found: true,
      runId: 'run-existing',
      number: 149,
      executionProgress: 'COMPLETE',
      completionStatus: 'SUCCEEDED',
    }),
    startWorkflowBuild: async () => { started = true; },
  });

  const result = await provider.trigger(intent());

  assert.equal(started, false);
  assert.equal(result.action, 'existing');
  assert.equal(result.runId, 'run-existing');
});

test('protects an active branch run whose commit is not available yet', async () => {
  const provider = new XcodeCloudBuildProvider({
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    getWorkflowRunStatus: async () => ({
      found: false,
      unknownActiveBranchRun: {
        runId: 'run-pending',
        number: 148,
        executionProgress: 'PENDING',
      },
    }),
  });

  const result = await provider.trigger(intent());
  assert.equal(result.action, 'waiting');
  assert.equal(result.runId, 'run-pending');
});

test('passes the resolved branch relationship id before checking active runs', async () => {
  let statusArguments = null;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowBranchReference: async () => ({ id: 'main-ref' }),
    getWorkflowRunStatus: async (...args) => {
      statusArguments = args;
      return {
        found: false,
        unknownActiveBranchRun: {
          runId: 'run-main-pending',
          number: 148,
          executionProgress: 'PENDING',
        },
      };
    },
  });

  const result = await provider.trigger({ ...intent(), branch: 'main' });

  assert.deepEqual(statusArguments, [
    'workflow-pr',
    'abcdef1234567890',
    'main',
    undefined,
    null,
    'main-ref',
  ]);
  assert.equal(result.action, 'waiting');
  assert.equal(result.runId, 'run-main-pending');
});

test('retries when an active branch run has no comparable identity', async () => {
  let started = false;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowBranchReference: async () => ({ id: 'main-ref' }),
    getWorkflowRunStatus: async () => ({
      found: false,
      uncertainActiveBranchRun: {
        runId: 'run-branch-unknown',
        number: 147,
        executionProgress: 'PENDING',
      },
    }),
    startWorkflowBuild: async () => { started = true; },
  });

  await assert.rejects(
    provider.trigger({ ...intent(), branch: 'main' }),
    error => error.code === 'SOURCE_ACTIVE_RUN_UNCERTAIN'
      && error.statusCode === 503
      && error.retryAfter === 5,
  );
  assert.equal(started, false);
});

test('protects an active pull-request run whose commit is not available yet', async () => {
  let statusArguments = null;
  let starts = 0;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowPullRequest: async () => ({ id: 'apple-pr-49', number: '49' }),
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    getWorkflowRunStatus: async (...args) => {
      statusArguments = args;
      return {
        found: false,
        unknownActivePullRequestRun: {
          runId: 'run-pr-pending',
          number: 149,
          executionProgress: 'PENDING',
        },
      };
    },
    startWorkflowBuild: async () => { starts += 1; },
  });

  const result = await provider.trigger({ ...intent(), pullRequest: '49' });

  assert.deepEqual(statusArguments, [
    'workflow-pr',
    'abcdef1234567890',
    'codex/e2e-managed-trigger',
    '49',
    'apple-pr-49',
    'branch-ref',
  ]);
  assert.equal(result.action, 'waiting');
  assert.equal(result.runId, 'run-pr-pending');
  assert.equal(starts, 0);
});

test('starts for the requested PR when a different PR has a hidden active commit', async () => {
  let started = null;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowPullRequest: async () => ({ id: 'apple-pr-50', number: '50' }),
    getWorkflowRunStatus: async (_workflow, _commit, _branch, _number, pullRequestId) => {
      assert.equal(pullRequestId, 'apple-pr-50');
      return { found: false, unknownActiveBranchRun: null };
    },
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    startWorkflowBuild: async (workflowId, sourceReferenceId, options) => {
      started = { workflowId, sourceReferenceId, options };
      return { runId: 'run-pr-50', number: 150, executionProgress: 'PENDING' };
    },
  });

  const result = await provider.trigger({ ...intent(), pullRequest: '50' });

  assert.deepEqual(started, {
    workflowId: 'workflow-pr',
    sourceReferenceId: null,
    options: { pullRequestId: 'apple-pr-50' },
  });
  assert.equal(result.action, 'started');
});

test('retries when an active pull-request run has no comparable identity', async () => {
  let started = false;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowPullRequest: async () => ({ id: 'apple-pr-50', number: '50' }),
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    getWorkflowRunStatus: async () => ({
      found: false,
      uncertainActivePullRequestRun: {
        runId: 'run-unknown',
        number: 149,
        executionProgress: 'PENDING',
      },
    }),
    startWorkflowBuild: async () => { started = true; },
  });

  await assert.rejects(
    provider.trigger({ ...intent(), pullRequest: '50' }),
    error => error.code === 'SOURCE_ACTIVE_RUN_UNCERTAIN'
      && error.statusCode === 503
      && error.retryAfter === 5,
  );
  assert.equal(started, false);
});

test('dry run resolves the branch without starting a build', async () => {
  let started = false;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowRunStatus: async () => ({ found: false }),
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    startWorkflowBuild: async () => { started = true; },
  });

  const result = await provider.trigger(intent(), { dryRun: true });
  assert.equal(started, false);
  assert.equal(result.action, 'would_start');
});

test('reports a transient error when Apple has not mirrored the source branch', async () => {
  const provider = new XcodeCloudBuildProvider({
    getWorkflowRunStatus: async () => ({ found: false }),
    getWorkflowBranchReference: async () => null,
  });

  await assert.rejects(
    provider.trigger(intent()),
    error => error.code === 'SOURCE_REFERENCE_NOT_FOUND',
  );
});

test('starts a pull request workflow through the Apple SCM pull request', async () => {
  let started = null;
  const provider = new XcodeCloudBuildProvider({
    getWorkflowRunStatus: async () => ({ found: false }),
    getWorkflowPullRequest: async (workflowId, number) => {
      assert.equal(workflowId, 'workflow-pr');
      assert.equal(number, '49');
      return { id: 'apple-pr-49', number: '49' };
    },
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    startWorkflowBuild: async (workflowId, sourceReferenceId, options) => {
      started = { workflowId, sourceReferenceId, options };
      return { runId: 'run-pr', number: 151, executionProgress: 'PENDING' };
    },
  });

  const result = await provider.trigger({ ...intent(), pullRequest: '49' });

  assert.deepEqual(started, {
    workflowId: 'workflow-pr',
    sourceReferenceId: null,
    options: { pullRequestId: 'apple-pr-49' },
  });
  assert.equal(result.action, 'started');
  assert.equal(result.runId, 'run-pr');
  assert.equal(result.source, 'pull_request');
});

test('falls back to the source branch when Apple rejects a manual pull-request build', async () => {
  const starts = [];
  const provider = new XcodeCloudBuildProvider({
    getWorkflowRunStatus: async () => ({ found: false }),
    getWorkflowPullRequest: async () => ({ id: 'apple-pr-49', number: '49' }),
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
    startWorkflowBuild: async (workflowId, sourceReferenceId, options) => {
      starts.push({ workflowId, sourceReferenceId, options });
      if (options?.pullRequestId) {
        const error = new Error('Manual pull request is not associated with this workflow');
        error.statusCode = 409;
        throw error;
      }
      return { runId: 'run-fallback', number: 152, executionProgress: 'PENDING' };
    },
  });

  const result = await provider.trigger({ ...intent(), pullRequest: '49' });

  assert.deepEqual(starts, [
    { workflowId: 'workflow-pr', sourceReferenceId: null, options: { pullRequestId: 'apple-pr-49' } },
    { workflowId: 'workflow-pr', sourceReferenceId: 'branch-ref', options: undefined },
  ]);
  assert.equal(result.action, 'started');
  assert.equal(result.source, 'branch_fallback');
  assert.equal(result.runId, 'run-fallback');
});

test('reports a transient error when Apple has not mirrored the pull request', async () => {
  const provider = new XcodeCloudBuildProvider({
    getWorkflowRunStatus: async () => ({ found: false }),
    getWorkflowPullRequest: async () => null,
    getWorkflowBranchReference: async () => ({ id: 'branch-ref' }),
  });

  await assert.rejects(
    provider.trigger({ ...intent(), pullRequest: '49' }),
    error => error.code === 'SOURCE_PULL_REQUEST_NOT_FOUND',
  );
});

test('creates a normalized intent from GitHub event environment values', () => {
  const build = {
    provider: 'xcode_cloud',
    purpose: 'pull_request',
    appRole: 'uat',
    workflowId: 'workflow-pr',
  };
  assert.deepEqual(buildIntentFromEnvironment(build, {
    BUILD_COMMIT_SHA: 'abcdef1234567890',
    BUILD_BRANCH: 'refs/heads/codex/e2e-managed-trigger',
    BUILD_PULL_REQUEST: '49',
    BUILD_SOURCE_DELIVERY_ID: 'delivery-1',
  }), {
    provider: 'xcode_cloud',
    purpose: 'pull_request',
    appRole: 'uat',
    workflowId: 'workflow-pr',
    commitSha: 'abcdef1234567890',
    branch: 'codex/e2e-managed-trigger',
    pullRequest: '49',
    sourceDeliveryId: 'delivery-1',
  });
});

test('does not trigger a superseded branch intent', async () => {
  let triggered = false;
  const provider = {
    name: 'xcode_cloud',
    trigger: async () => { triggered = true; },
  };
  const github = {
    getBranchHead: () => 'newer1234567890',
  };

  const result = await runManagedBuildTrigger(provider, github, intent());

  assert.equal(triggered, false);
  assert.equal(result.action, 'superseded');
  assert.equal(result.currentCommitSha, 'newer1234567890');
});

test('verifies a pull request head before triggering', async () => {
  let triggered = false;
  const pullIntent = { ...intent(), pullRequest: '49' };
  const provider = {
    name: 'xcode_cloud',
    trigger: async () => {
      triggered = true;
      return { action: 'started', provider: 'xcode_cloud', runId: 'run-1' };
    },
  };
  const github = {
    getPullRequestHead: prNumber => {
      assert.equal(prNumber, '49');
      return pullIntent.commitSha;
    },
  };

  const result = await runManagedBuildTrigger(provider, github, pullIntent);

  assert.equal(triggered, true);
  assert.equal(result.action, 'started');
});

test('waits for a provider build to complete', async () => {
  const states = [
    { runId: 'run-1', number: 150, executionProgress: 'RUNNING', completionStatus: null },
    { runId: 'run-1', number: 150, executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED' },
  ];
  const provider = {
    getRun: async () => states.shift(),
  };

  const result = await waitForBuildCompletion(provider, 'run-1', {
    intervalMs: 0,
    timeoutMs: 1000,
    sleep: async () => {},
  });

  assert.equal(result.completionStatus, 'SUCCEEDED');
});
