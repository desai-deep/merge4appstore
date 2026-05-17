import test from 'node:test';
import assert from 'node:assert/strict';

import { runDeployCheck } from '../lib/deploy.js';

function createASC(overrides = {}) {
  return {
    checkBuildInReview: async () => ({ inReview: false }),
    checkRejectedVersion: async () => ({ rejected: false }),
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
  process.env.XCODE_WORKFLOW_ID = 'workflow-1';

  let submitted = false;
  const asc = createASC({
    checkRejectedVersion: async () => ({
      rejected: true,
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

test('submits a newer build after a rejection', async () => {
  process.env.XCODE_WORKFLOW_ID = 'workflow-1';

  let selectedBuildId = null;
  let submittedVersionId = null;
  const asc = createASC({
    checkRejectedVersion: async () => ({
      rejected: true,
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
