import test from 'node:test';
import assert from 'node:assert/strict';

import { XcodeCloudBuildProvider } from '../lib/build-provider.js';
import { buildIntentFromEnvironment, runManagedBuildTrigger, waitForBuildCompletion } from '../lib/trigger.js';

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
    runId: 'run-1',
    number: 150,
    executionProgress: 'PENDING',
  });
});

test('reuses an existing run for the same workflow and commit', async () => {
  let started = false;
  const provider = new XcodeCloudBuildProvider({
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
});

test('reports a transient error when Apple has not mirrored the pull request', async () => {
  const provider = new XcodeCloudBuildProvider({
    getWorkflowRunStatus: async () => ({ found: false }),
    getWorkflowPullRequest: async () => null,
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
