import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverMissedProductionBuild, runDeployCheck } from '../lib/deploy.js';

async function withWorkflowId(workflowId, fn) {
  const previousWorkflowId = process.env.XCODE_WORKFLOW_ID;
  process.env.XCODE_WORKFLOW_ID = workflowId;

  try {
    await fn();
  } finally {
    if (previousWorkflowId === undefined) {
      delete process.env.XCODE_WORKFLOW_ID;
    } else {
      process.env.XCODE_WORKFLOW_ID = previousWorkflowId;
    }
  }
}

async function withTriggerRecovery(fn) {
  const previous = process.env.RECOVER_MISSED_XCODE_BUILDS;
  process.env.RECOVER_MISSED_XCODE_BUILDS = 'true';

  try {
    await withWorkflowId('workflow-1', fn);
  } finally {
    if (previous === undefined) {
      delete process.env.RECOVER_MISSED_XCODE_BUILDS;
    } else {
      process.env.RECOVER_MISSED_XCODE_BUILDS = previous;
    }
  }
}

function createASC(overrides = {}) {
  return {
    checkBuildInReview: async () => ({ inReview: false }),
    checkRejectedVersion: async () => ({ rejected: false }),
    checkVersionWithUnresolvedIssues: async () => ({ hasUnresolvedIssues: false }),
    getLiveProductionBuild: async () => ({ live: false, buildId: null }),
    getTestFlightReadyBuilds: async () => [],
    getBuildCommitSHA: async () => ({
      found: true,
      commitSha: 'abcdef1234567890',
      workflowId: 'workflow-1',
      workflowName: 'Publish to App Store',
    }),
    getBuildByNumber: async buildNumber => ({
      buildId: `build-${buildNumber}`,
      version: buildNumber === '101' ? '1.2.4' : '1.2.3',
    }),
    getOrCreateAppStoreVersion: async version => ({
      exists: true,
      versionId: `version-${version}`,
      state: 'PREPARE_FOR_SUBMISSION',
    }),
    selectBuildForVersion: async () => {},
    updateReleaseNotes: async () => {},
    submitForReview: async () => {},
    removeDraftReviewSubmission: async () => ({ removed: true, state: 'READY_FOR_REVIEW' }),
    ...overrides,
  };
}

function createGitHub(overrides = {}) {
  return {
    findPRFromCommit: () => 123,
    getPRDetails: () => ({ title: 'Release build' }),
    extractReleaseNotes: () => 'Release build',
    addPRComment: () => true,
    upsertPRComment: () => 'created',
    upsertIssue: () => ({ number: 456, url: 'https://github.test/issues/456', action: 'created' }),
    closeIssueByMarker: () => false,
    ...overrides,
  };
}

test('surfaces App Store requirements on the release PR without hiding the failure', async () => {
  await withWorkflowId('workflow-1', async () => {
    const failure = new Error('API Error 409: This resource cannot be reviewed');
    failure.statusCode = 409;
    failure.reviewSubmissionId = 'submission-1';
    failure.appStoreErrors = [{
      code: 'STATE_ERROR.SCREENSHOT_REQUIRED.APP_IPAD_PRO_3GEN_129',
      title: 'App screenshot missing (APP_IPAD_PRO_3GEN_129)',
      detail: 'A screenshot with type ipadPro129 is required but was not provided',
    }];
    const events = [];
    let posted = null;
    const asc = createASC({
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '161', version: '1.2', buildId: 'build-161' },
      ]),
      getBuildByNumber: async () => ({ buildId: 'build-161', version: '1.2' }),
      submitForReview: async () => { throw failure; },
      removeDraftReviewSubmission: async submissionId => {
        events.push(`delete:${submissionId}`);
        return { removed: true, state: 'READY_FOR_REVIEW' };
      },
    });
    const github = createGitHub({
      upsertIssue: () => {
        events.push('issue');
        return { number: 456, url: 'https://github.test/issues/456', action: 'created' };
      },
      upsertPRComment: (prNumber, marker, comment) => {
        events.push('comment');
        posted = { prNumber, marker, comment };
        return 'created';
      },
    });

    await assert.rejects(runDeployCheck(asc, github, false), error => error === failure);
    assert.equal(posted.prNumber, 123);
    assert.match(posted.marker, /version-1\.2:161/);
    assert.match(posted.comment, /App screenshot missing \(APP_IPAD_PRO_3GEN_129\)/);
    assert.match(posted.comment, /ipadPro129 is required/);
    assert.match(posted.comment, /Build #161 remains selected for version 1\.2/);
    assert.match(posted.comment, /A new build is not required/);
    assert.match(posted.comment, /Track remediation in \[#456\]/);
    assert.deepEqual(events, ['issue', 'comment', 'delete:submission-1']);
  });
});

test('keeps a failed draft when the release PR cannot be notified', async () => {
  await withWorkflowId('workflow-1', async () => {
    const failure = new Error('Submission failed');
    failure.reviewSubmissionId = 'submission-1';
    let deleted = false;
    const asc = createASC({
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '161', version: '1.2', buildId: 'build-161' },
      ]),
      getBuildByNumber: async () => ({ buildId: 'build-161', version: '1.2' }),
      submitForReview: async () => { throw failure; },
      removeDraftReviewSubmission: async () => {
        deleted = true;
        return { removed: true, state: 'READY_FOR_REVIEW' };
      },
    });
    const github = createGitHub({ upsertPRComment: () => false });

    await assert.rejects(runDeployCheck(asc, github, false), error => error === failure);
    assert.equal(deleted, false);
  });
});

test('recovers a missed production workflow trigger for a merged PR', async () => {
  await withTriggerRecovery(async () => {
    let started = null;
    const asc = createASC({
      getWorkflowRunStatus: async () => ({ found: false, unknownActiveBranchRun: null }),
      getWorkflowBranchReference: async () => ({ id: 'main-ref', name: 'main' }),
      startWorkflowBuild: async (workflowId, sourceReferenceId) => {
        started = { workflowId, sourceReferenceId };
        return { runId: 'run-1', number: 140, executionProgress: 'PENDING' };
      },
    });
    const github = createGitHub({
      getProductionHead: () => 'abcdef1234567890',
    });

    const result = await recoverMissedProductionBuild(asc, github, false);

    assert.deepEqual(started, {
      workflowId: 'workflow-1',
      sourceReferenceId: 'main-ref',
    });
    assert.deepEqual(result, { waiting: true });
  });
});

test('does not duplicate an existing production run for the release commit', async () => {
  await withTriggerRecovery(async () => {
    let started = false;
    const asc = createASC({
      getWorkflowRunStatus: async () => ({
        found: true,
        runId: 'run-1',
        number: 140,
        executionProgress: 'RUNNING',
        completionStatus: null,
      }),
      startWorkflowBuild: async () => {
        started = true;
      },
    });
    const github = createGitHub({
      getProductionHead: () => 'abcdef1234567890',
    });

    const result = await recoverMissedProductionBuild(asc, github, false);

    assert.equal(started, false);
    assert.deepEqual(result, { waiting: true });
  });
});

test('waits for an active branch run whose commit metadata is not populated', async () => {
  await withTriggerRecovery(async () => {
    let started = false;
    const asc = createASC({
      getWorkflowRunStatus: async () => ({
        found: false,
        unknownActiveBranchRun: {
          runId: 'run-1',
          number: 140,
          executionProgress: 'PENDING',
        },
      }),
      startWorkflowBuild: async () => {
        started = true;
      },
    });
    const github = createGitHub({
      getProductionHead: () => 'abcdef1234567890',
    });

    const result = await recoverMissedProductionBuild(asc, github, false);

    assert.equal(started, false);
    assert.deepEqual(result, { waiting: true });
  });
});

test('does not trigger production for a direct push without a merged PR', async () => {
  await withTriggerRecovery(async () => {
    let queriedRuns = false;
    const asc = createASC({
      getWorkflowRunStatus: async () => {
        queriedRuns = true;
        return { found: false };
      },
    });
    const github = createGitHub({
      getProductionHead: () => 'abcdef1234567890',
      findPRFromCommit: () => null,
    });

    const result = await recoverMissedProductionBuild(asc, github, false);

    assert.equal(queriedRuns, false);
    assert.deepEqual(result, { waiting: false });
  });
});

test('dry run reports recovery without starting Xcode Cloud', async () => {
  await withTriggerRecovery(async () => {
    let started = false;
    const asc = createASC({
      getWorkflowRunStatus: async () => ({ found: false, unknownActiveBranchRun: null }),
      getWorkflowBranchReference: async () => ({ id: 'main-ref', name: 'main' }),
      startWorkflowBuild: async () => {
        started = true;
      },
    });
    const github = createGitHub({
      getProductionHead: () => 'abcdef1234567890',
    });

    const result = await recoverMissedProductionBuild(asc, github, true);

    assert.equal(started, false);
    assert.deepEqual(result, { waiting: true });
  });
});

test('does not submit an older production build while the current build is processing', async () => {
  await withTriggerRecovery(async () => {
    let submitted = false;
    const asc = createASC({
      getWorkflowRunStatus: async () => ({
        found: true,
        runId: 'run-140',
        number: 140,
        executionProgress: 'COMPLETE',
        completionStatus: 'SUCCEEDED',
      }),
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '139', version: '1.1', buildId: 'build-139' },
      ]),
      getBuildCommitSHA: async () => ({
        found: true,
        commitSha: 'older1234567890',
        workflowId: 'workflow-1',
        workflowName: 'Publish to App Store',
      }),
      submitForReview: async () => {
        submitted = true;
      },
    });
    const github = createGitHub({
      getProductionHead: () => 'abcdef1234567890',
    });

    await runDeployCheck(asc, github, false);

    assert.equal(submitted, false);
  });
});

test('does not resubmit the same rejected build on cron runs', async () => {
  await withWorkflowId('workflow-1', async () => {
    let submitted = false;
    const asc = createASC({
      checkRejectedVersion: async () => ({
        rejected: true,
        blockReason: 'rejected',
        version: '1.2.3',
        state: 'REJECTED',
        buildNumber: '100',
        versionId: 'version-123',
      }),
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '100', version: '1.2.3', buildId: 'build-100' },
        { buildNumber: '99', version: '1.2.2', buildId: 'build-99' },
      ]),
      submitForReview: async () => {
        submitted = true;
      },
    });

    await runDeployCheck(asc, createGitHub(), false);

    assert.equal(submitted, false);
  });
});

test('submits a newer build after a rejection', async () => {
  await withWorkflowId('workflow-1', async () => {
    let selectedBuildId = null;
    let submittedVersionId = null;
    const asc = createASC({
      checkRejectedVersion: async () => ({
        rejected: true,
        blockReason: 'rejected',
        version: '1.2.3',
        state: 'REJECTED',
        buildNumber: '100',
        versionId: 'version-123',
      }),
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '101', version: '1.2.4', buildId: 'build-101' },
        { buildNumber: '100', version: '1.2.3', buildId: 'build-100' },
      ]),
      selectBuildForVersion: async (_versionId, buildId) => {
        selectedBuildId = buildId;
      },
      submitForReview: async versionId => {
        submittedVersionId = versionId;
      },
    });

    await runDeployCheck(asc, createGitHub(), false);

    assert.equal(selectedBuildId, 'build-101');
    assert.equal(submittedVersionId, 'version-1.2.4');
  });
});

test('does not resubmit a draft build with unresolved review issues when no newer build exists', async () => {
  await withWorkflowId('workflow-1', async () => {
    let submitted = false;
    const asc = createASC({
      checkVersionWithUnresolvedIssues: async () => ({
        hasUnresolvedIssues: true,
        blockReason: 'unresolved_review',
        version: '1.2.3',
        state: 'PREPARE_FOR_SUBMISSION',
        buildNumber: '100',
        versionId: 'version-123',
      }),
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '100', version: '1.2.3', buildId: 'build-100' },
      ]),
      submitForReview: async () => {
        submitted = true;
      },
    });

    await runDeployCheck(asc, createGitHub(), false);

    assert.equal(submitted, false);
  });
});
