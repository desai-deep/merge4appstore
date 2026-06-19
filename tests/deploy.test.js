import test from 'node:test';
import assert from 'node:assert/strict';

import { runDeployCheck } from '../lib/deploy.js';

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
    ...overrides,
  };
}

function createGitHub(overrides = {}) {
  return {
    findPRFromCommit: () => 123,
    getPRDetails: () => ({ title: 'Release build' }),
    extractReleaseNotes: () => 'Release build',
    addPRComment: () => true,
    ...overrides,
  };
}

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

test('resubmits a newer build over a previously rejected same-version number', async () => {
  await withWorkflowId('workflow-1', async () => {
    let clearedVersionId = null;
    let selectedBuildId = null;
    let submittedVersionId = null;
    const asc = createASC({
      checkRejectedVersion: async () => ({
        rejected: true,
        blockReason: 'rejected',
        version: '1.2.3',
        state: 'REJECTED',
        buildNumber: '100',
        versionId: 'version-1.2.3',
      }),
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '105', version: '1.2.3', buildId: 'build-105' },
      ]),
      getBuildByNumber: async buildNumber => ({
        buildId: `build-${buildNumber}`,
        version: '1.2.3',
      }),
      // The existing 1.2.3 version is still sitting in REJECTED.
      getOrCreateAppStoreVersion: async version => ({
        exists: true,
        versionId: `version-${version}`,
        state: 'REJECTED',
      }),
      cancelReview: async versionId => {
        clearedVersionId = versionId;
        return { success: true };
      },
      selectBuildForVersion: async (_versionId, buildId) => {
        selectedBuildId = buildId;
      },
      submitForReview: async versionId => {
        submittedVersionId = versionId;
      },
    });

    const result = await runDeployCheck(asc, createGitHub(), false);

    assert.equal(result.status, 'submitted');
    assert.equal(result.resubmittedOverRejected, true);
    assert.equal(selectedBuildId, 'build-105');
    assert.equal(submittedVersionId, 'version-1.2.3');
    // Any stale submission on the rejected version is cleared before resubmitting.
    assert.equal(clearedVersionId, 'version-1.2.3');
  });
});

test('treats METADATA_REJECTED as submittable', async () => {
  await withWorkflowId('workflow-1', async () => {
    let submittedVersionId = null;
    const asc = createASC({
      checkRejectedVersion: async () => ({
        rejected: true,
        blockReason: 'rejected',
        version: '1.2.3',
        state: 'METADATA_REJECTED',
        buildNumber: '100',
        versionId: 'version-1.2.3',
      }),
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '105', version: '1.2.3', buildId: 'build-105' },
      ]),
      getBuildByNumber: async buildNumber => ({
        buildId: `build-${buildNumber}`,
        version: '1.2.3',
      }),
      getOrCreateAppStoreVersion: async version => ({
        exists: true,
        versionId: `version-${version}`,
        state: 'METADATA_REJECTED',
      }),
      cancelReview: async () => ({ success: true }),
      submitForReview: async versionId => {
        submittedVersionId = versionId;
      },
    });

    const result = await runDeployCheck(asc, createGitHub(), false);

    assert.equal(result.status, 'submitted');
    assert.equal(submittedVersionId, 'version-1.2.3');
  });
});

test('returns no-eligible-build when only other-workflow builds exist', async () => {
  await withWorkflowId('workflow-1', async () => {
    const asc = createASC({
      getTestFlightReadyBuilds: async () => ([
        { buildNumber: '105', version: '1.2.3', buildId: 'build-105' },
      ]),
      getBuildCommitSHA: async () => ({
        found: true,
        commitSha: 'abcdef1234567890',
        workflowId: 'public-beta',
        workflowName: 'Public Beta',
      }),
    });

    const result = await runDeployCheck(asc, createGitHub(), false);
    assert.equal(result.status, 'no-eligible-build');
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
