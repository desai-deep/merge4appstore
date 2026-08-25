import test from 'node:test';
import assert from 'node:assert/strict';

import { AppStoreConnectAPI } from '../lib/app-store-connect.js';

function createASCWithVersions(versions) {
  const asc = new AppStoreConnectAPI('key', 'issuer', Buffer.from('fake-key').toString('base64'));
  asc.getAppStoreVersions = async () => versions;
  return asc;
}

test('finds a workflow run for the release commit', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getBuildRuns = async () => ({
    data: [
      {
        id: 'run-140',
        attributes: {
          number: 140,
          sourceCommit: { commitSha: 'abcdef1234567890' },
          executionProgress: 'RUNNING',
          completionStatus: null,
        },
        relationships: {
          sourceBranchOrTag: { data: { id: 'main-ref' } },
        },
      },
    ],
    included: [
      {
        id: 'main-ref',
        type: 'scmGitReferences',
        attributes: { name: 'main', canonicalName: 'refs/heads/main' },
      },
    ],
  });

  assert.deepEqual(
    await asc.getWorkflowRunStatus('workflow-1', 'abcdef1234567890', 'main'),
    {
      found: true,
      runId: 'run-140',
      number: 140,
      executionProgress: 'RUNNING',
      completionStatus: null,
    },
  );
});

test('protects an active branch run before Xcode Cloud exposes its commit', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getBuildRuns = async () => ({
    data: [
      {
        id: 'run-140',
        attributes: {
          number: 140,
          sourceCommit: { commitSha: '' },
          executionProgress: 'PENDING',
          completionStatus: null,
        },
        relationships: {
          sourceBranchOrTag: { data: { id: 'main-ref' } },
        },
      },
    ],
    included: [
      {
        id: 'main-ref',
        type: 'scmGitReferences',
        attributes: { canonicalName: 'refs/heads/main' },
      },
    ],
  });

  assert.deepEqual(
    await asc.getWorkflowRunStatus('workflow-1', 'abcdef1234567890', 'main'),
    {
      found: false,
      unknownActiveBranchRun: {
        runId: 'run-140',
        number: 140,
        executionProgress: 'PENDING',
      },
    },
  );
});

test('starts a clean workflow build for the selected branch reference', async () => {
  const asc = createASCWithVersions({ data: [] });
  let request = null;
  asc.ciBuildRuns = [{ cached: true }];
  asc.request = async (endpoint, options) => {
    request = { endpoint, options };
    return {
      data: {
        id: 'run-140',
        attributes: { number: 140, executionProgress: 'PENDING' },
      },
    };
  };

  const run = await asc.startWorkflowBuild('workflow-1', 'main-ref');

  assert.equal(request.endpoint, '/ciBuildRuns');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    data: {
      type: 'ciBuildRuns',
      attributes: { clean: true },
      relationships: {
        workflow: { data: { type: 'ciWorkflows', id: 'workflow-1' } },
        sourceBranchOrTag: { data: { type: 'scmGitReferences', id: 'main-ref' } },
      },
    },
  });
  assert.deepEqual(run, {
    runId: 'run-140',
    number: 140,
    executionProgress: 'PENDING',
  });
  assert.equal(asc.ciBuildRuns, null);
});

test('reuses an empty review draft instead of creating another submission', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getReviewSubmissionIdForVersion = async () => null;
  asc.getReusableDraftReviewSubmissionId = async () => 'draft-1';
  const requests = [];
  asc.request = async (endpoint, options) => {
    requests.push({ endpoint, options });
    return { data: { id: 'item-1' } };
  };

  const submissionId = await asc.getOrCreateDraftReviewSubmission('version-1');

  assert.equal(submissionId, 'draft-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].endpoint, '/reviewSubmissionItems');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: {
          data: { type: 'reviewSubmissions', id: 'draft-1' },
        },
        appStoreVersion: {
          data: { type: 'appStoreVersions', id: 'version-1' },
        },
      },
    },
  });
});

test('finds an empty ready-for-review draft', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getAppId = async () => 'app-1';
  asc.request = async endpoint => {
    assert.match(endpoint, /filter\[state\]=READY_FOR_REVIEW/);
    return {
      data: [
        {
          id: 'draft-with-item',
          relationships: { items: { data: [{ id: 'item-1' }] } },
        },
        {
          id: 'empty-draft',
          relationships: { items: { data: [] } },
        },
      ],
    };
  };

  assert.equal(await asc.getReusableDraftReviewSubmissionId(), 'empty-draft');
});

test('checkRejectedVersion returns the highest rejected build number', async () => {
  const asc = createASCWithVersions({
    data: [
      {
        id: 'version-older',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.3',
          appStoreState: 'REJECTED',
        },
        relationships: {
          build: {
            data: { id: 'build-100' },
          },
        },
      },
      {
        id: 'version-latest',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.4',
          appStoreState: 'DEVELOPER_REJECTED',
        },
        relationships: {
          build: {
            data: { id: 'build-101' },
          },
        },
      },
    ],
    included: [
      {
        id: 'build-100',
        type: 'builds',
        attributes: { version: '100' },
      },
      {
        id: 'build-101',
        type: 'builds',
        attributes: { version: '101' },
      },
    ],
  });

  const rejectedVersion = await asc.checkRejectedVersion();

  assert.deepEqual(rejectedVersion, {
    rejected: true,
    blockReason: 'rejected',
    version: '1.2.4',
    state: 'DEVELOPER_REJECTED',
    buildNumber: '101',
    versionId: 'version-latest',
  });
});

test('checkVersionWithUnresolvedIssues returns the highest build tied to unresolved review issues', async () => {
  const asc = createASCWithVersions({
    data: [
      {
        id: 'version-older',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.3',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-100' },
          },
        },
      },
      {
        id: 'version-latest',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.4',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-101' },
          },
        },
      },
    ],
    included: [
      {
        id: 'build-100',
        type: 'builds',
        attributes: { version: '100' },
      },
      {
        id: 'build-101',
        type: 'builds',
        attributes: { version: '101' },
      },
    ],
  });

  asc.getAppId = async () => 'app-1';
  asc.request = async endpoint => {
    assert.match(endpoint, /filter\[state\]=UNRESOLVED_ISSUES/);
    return {
      data: [
        {
          id: 'submission-1',
          relationships: {
            items: {
              data: [{ id: 'item-1' }, { id: 'item-2' }],
            },
          },
        },
      ],
      included: [
        {
          id: 'item-1',
          type: 'reviewSubmissionItems',
          attributes: {
            state: 'UNRESOLVED_ISSUES',
          },
          relationships: {
            appStoreVersion: {
              data: { id: 'version-older' },
            },
          },
        },
        {
          id: 'item-2',
          type: 'reviewSubmissionItems',
          attributes: {
            state: 'UNRESOLVED_ISSUES',
          },
          relationships: {
            appStoreVersion: {
              data: { id: 'version-latest' },
            },
          },
        },
      ],
    };
  };

  const unresolvedVersion = await asc.checkVersionWithUnresolvedIssues();

  assert.deepEqual(unresolvedVersion, {
    hasUnresolvedIssues: true,
    blockReason: 'unresolved_review',
    version: '1.2.4',
    state: 'PREPARE_FOR_SUBMISSION',
    buildNumber: '101',
    versionId: 'version-latest',
  });
});

test('checkVersionWithUnresolvedIssues ignores non-unresolved items in the same submission', async () => {
  const asc = createASCWithVersions({
    data: [
      {
        id: 'version-unresolved',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.3',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-100' },
          },
        },
      },
      {
        id: 'version-ready',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.2.4',
          appStoreState: 'PREPARE_FOR_SUBMISSION',
        },
        relationships: {
          build: {
            data: { id: 'build-101' },
          },
        },
      },
    ],
    included: [
      {
        id: 'build-100',
        type: 'builds',
        attributes: { version: '100' },
      },
      {
        id: 'build-101',
        type: 'builds',
        attributes: { version: '101' },
      },
    ],
  });

  asc.getAppId = async () => 'app-1';
  asc.request = async () => ({
    data: [
      {
        id: 'submission-1',
        relationships: {
          items: {
            data: [{ id: 'item-1' }, { id: 'item-2' }],
          },
        },
      },
    ],
    included: [
      {
        id: 'item-1',
        type: 'reviewSubmissionItems',
        attributes: {
          state: 'UNRESOLVED_ISSUES',
        },
        relationships: {
          appStoreVersion: {
            data: { id: 'version-unresolved' },
          },
        },
      },
      {
        id: 'item-2',
        type: 'reviewSubmissionItems',
        attributes: {
          state: 'ACCEPTED',
        },
        relationships: {
          appStoreVersion: {
            data: { id: 'version-ready' },
          },
        },
      },
    ],
  });

  const unresolvedVersion = await asc.checkVersionWithUnresolvedIssues();

  assert.deepEqual(unresolvedVersion, {
    hasUnresolvedIssues: true,
    blockReason: 'unresolved_review',
    version: '1.2.3',
    state: 'PREPARE_FOR_SUBMISSION',
    buildNumber: '100',
    versionId: 'version-unresolved',
  });
});

test('build commit lookup is scoped to the configured app product', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  asc.getAppId = async () => 'jams-app';
  asc.getCIProducts = async () => ([
    {
      id: 'running-order-product',
      relationships: { app: { data: { id: 'running-order-app' } } },
    },
    {
      id: 'jams-product',
      relationships: { app: { data: { id: 'jams-app' } } },
    },
  ]);
  asc.getWorkflows = async productId => ([
    { id: `${productId}-workflow`, attributes: { name: 'Publish to App Store' } },
  ]);
  asc.getBuildRuns = async workflowId => ({
    data: [{
      attributes: {
        number: 100,
        sourceCommit: {
          commitSha: workflowId.startsWith('jams-product') ? 'jams-commit' : 'running-order-commit',
        },
      },
    }],
  });

  const commit = await asc.getBuildCommitSHA('100');

  assert.equal(commit.commitSha, 'jams-commit');
  assert.equal(commit.workflowId, 'jams-product-workflow');
});

test('cleanup candidates exclude expired, invalid, and App Store-selected builds', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  asc.getAppId = async () => 'app-1';
  asc.request = async endpoint => {
    assert.match(endpoint, /filter\[expired\]=false/);
    assert.match(endpoint, /include=preReleaseVersion,appStoreVersion/);
    return {
      data: [
        {
          id: 'build-eligible',
          attributes: { version: '101', processingState: 'VALID', expired: false },
          relationships: {
            preReleaseVersion: { data: { id: 'pre-1' } },
            appStoreVersion: { data: null },
          },
        },
        {
          id: 'build-selected',
          attributes: { version: '102', processingState: 'VALID', expired: false },
          relationships: { appStoreVersion: { data: { id: 'version-1' } } },
        },
        {
          id: 'build-invalid',
          attributes: { version: '103', processingState: 'INVALID', expired: false },
          relationships: {},
        },
      ],
      included: [{ id: 'pre-1', type: 'preReleaseVersions', attributes: { version: '2.4' } }],
    };
  };

  assert.deepEqual(await asc.getTestFlightCleanupCandidates(), [{
    buildId: 'build-eligible',
    buildNumber: '101',
    version: '2.4',
    uploadedDate: null,
  }]);
});

test('expires a build through the build update endpoint', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  let request = null;
  asc.request = async (endpoint, options) => {
    request = { endpoint, options };
    return { data: { id: 'build-101' } };
  };

  await asc.expireBuild('build-101');

  assert.equal(request.endpoint, '/builds/build-101');
  assert.equal(request.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), {
    data: {
      type: 'builds',
      id: 'build-101',
      attributes: { expired: true },
    },
  });
});

test('maps an App Store build ID to its Xcode Cloud commit and branch', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  asc.loadCIBuildRuns = async () => ([{
    workflowId: 'workflow-1',
    workflowName: 'Public Beta',
    sourceBranch: 'refs/heads/feature/player',
    run: {
      attributes: { sourceCommit: { commitSha: 'abc123' } },
      relationships: { builds: { data: [{ id: 'build-101' }] } },
    },
  }]);

  assert.deepEqual(await asc.getBuildSource('build-101'), {
    found: true,
    commitSha: 'abc123',
    sourceBranch: 'feature/player',
    workflowId: 'workflow-1',
    workflowName: 'Public Beta',
  });
});

test('falls back to a unique Xcode Cloud build number when Apple omits build linkage', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  asc.loadCIBuildRuns = async () => ([{
    workflowId: 'workflow-1',
    workflowName: 'Public Beta',
    sourceBranch: 'develop',
    run: {
      attributes: { number: 101, sourceCommit: { commitSha: 'abc123' } },
      relationships: { builds: { data: [] } },
    },
  }]);

  assert.deepEqual(await asc.getBuildSource('build-101', '101'), {
    found: true,
    commitSha: 'abc123',
    sourceBranch: 'develop',
    workflowId: 'workflow-1',
    workflowName: 'Public Beta',
  });
});

test('does not use an ambiguous Xcode Cloud build-number fallback', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  asc.loadCIBuildRuns = async () => ([
    { run: { attributes: { number: 101 }, relationships: { builds: { data: [] } } } },
    { run: { attributes: { number: 101 }, relationships: { builds: { data: [] } } } },
  ]);

  assert.deepEqual(await asc.getBuildSource('build-101', '101'), { found: false });
});
