import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AppStoreConnectAPI,
  appStoreErrorDetails,
  formatAppStoreErrorDetail,
} from '../lib/app-store-connect.js';

test('surfaces associated App Store errors instead of only the generic wrapper', () => {
  const details = appStoreErrorDetails({
    errors: [{
      code: 'ENTITY_ERROR',
      detail: 'This resource cannot be reviewed',
      meta: {
        associatedErrors: {
          '/v1/appStoreVersions/version-1': [{
            code: 'STATE_ERROR.SCREENSHOT_REQUIRED.APP_IPAD_PRO_3GEN_129',
            title: 'App screenshot missing (APP_IPAD_PRO_3GEN_129)',
            detail: 'A screenshot with type ipadPro129 is required but was not provided',
          }],
        },
      },
    }, {
      code: 'ANOTHER_REQUIREMENT',
      title: 'Export compliance missing',
      detail: 'Answer the export compliance questions',
    }],
  });

  assert.deepEqual(details, [{
    code: 'STATE_ERROR.SCREENSHOT_REQUIRED.APP_IPAD_PRO_3GEN_129',
    title: 'App screenshot missing (APP_IPAD_PRO_3GEN_129)',
    detail: 'A screenshot with type ipadPro129 is required but was not provided',
  }, {
    code: 'ANOTHER_REQUIREMENT',
    title: 'Export compliance missing',
    detail: 'Answer the export compliance questions',
  }]);
  assert.equal(
    formatAppStoreErrorDetail(details[0]),
    'App screenshot missing (APP_IPAD_PRO_3GEN_129): A screenshot with type ipadPro129 is required but was not provided',
  );
});

function createASCWithVersions(versions) {
  const asc = new AppStoreConnectAPI('key', 'issuer', Buffer.from('fake-key').toString('base64'));
  asc.getAppStoreVersions = async () => versions;
  return asc;
}

test('uses App Store Connect resources for release-editable text metadata', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.appId = 'app-1';
  const requests = [];
  asc.request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint === '/apps/app-1?fields[apps]=primaryLocale') {
      return { data: { id: 'app-1', attributes: { primaryLocale: 'en-US' } } };
    }
    if (endpoint === '/apps/app-1/appInfos?limit=200') {
      return { data: [{ id: 'info-live', attributes: { state: 'READY_FOR_SALE' } }, {
        id: 'info-editable', attributes: { state: 'PREPARE_FOR_SUBMISSION' },
      }] };
    }
    if (endpoint === '/appInfos/info-editable/appInfoLocalizations?limit=200') return { data: [] };
    if (endpoint === '/appStoreVersions/version-1/appStoreReviewDetail') return { data: null };
    return { data: { id: 'created' } };
  };

  assert.equal(await asc.getAppPrimaryLocale(), 'en-US');
  assert.equal((await asc.getEditableAppInfo()).id, 'info-editable');
  assert.deepEqual(await asc.getAppInfoLocalizations('info-editable'), []);
  await asc.updateAppStoreVersion('version-1', { copyright: '2026 Example Ltd' });
  await asc.createAppInfoLocalization('info-editable', 'en-US', { name: 'Example' });
  await asc.updateAppInfoLocalization('localization-1', { subtitle: 'A useful app' });
  assert.equal(await asc.getAppStoreReviewDetail('version-1'), null);
  await asc.createAppStoreReviewDetail('version-1', {
    contactFirstName: 'Ada', demoAccountRequired: false,
  });
  await asc.updateAppStoreReviewDetail('review-1', { notes: 'Please test offline.' });

  const writes = requests.filter(request => request.options.method);
  assert.deepEqual(writes.map(request => [
    request.endpoint,
    request.options.method,
    JSON.parse(request.options.body).data,
  ]), [[
    '/appStoreVersions/version-1',
    'PATCH',
    { type: 'appStoreVersions', id: 'version-1', attributes: { copyright: '2026 Example Ltd' } },
  ], [
    '/appInfoLocalizations',
    'POST',
    {
      type: 'appInfoLocalizations',
      attributes: { locale: 'en-US', name: 'Example' },
      relationships: { appInfo: { data: { type: 'appInfos', id: 'info-editable' } } },
    },
  ], [
    '/appInfoLocalizations/localization-1',
    'PATCH',
    { type: 'appInfoLocalizations', id: 'localization-1', attributes: { subtitle: 'A useful app' } },
  ], [
    '/appStoreReviewDetails',
    'POST',
    {
      type: 'appStoreReviewDetails',
      attributes: { contactFirstName: 'Ada', demoAccountRequired: false },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'version-1' } } },
    },
  ], [
    '/appStoreReviewDetails/review-1',
    'PATCH',
    { type: 'appStoreReviewDetails', id: 'review-1', attributes: { notes: 'Please test offline.' } },
  ]]);
});

test('treats a missing App Review detail as not configured', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.request = async () => {
    const error = new Error('not found');
    error.statusCode = 404;
    throw error;
  };
  assert.equal(await asc.getAppStoreReviewDetail('version-1'), null);
});

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

test('resolves an open Apple SCM pull request for a workflow', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.request = async endpoint => {
    if (endpoint === '/ciWorkflows/workflow-1/repository') {
      return { data: { id: 'repository-1' } };
    }
    assert.equal(endpoint, '/scmRepositories/repository-1/pullRequests?limit=200');
    return {
      data: [
        { id: 'closed-pr', attributes: { number: 48, isClosed: true } },
        {
          id: 'open-pr',
          attributes: {
            number: 49,
            isClosed: false,
            sourceBranchName: 'feature',
            destinationBranchName: 'develop',
          },
        },
      ],
    };
  };

  assert.deepEqual(await asc.getWorkflowPullRequest('workflow-1', '49'), {
    id: 'open-pr',
    number: '49',
    sourceBranchName: 'feature',
    destinationBranchName: 'develop',
  });
});

test('starts a clean workflow build for an Apple SCM pull request', async () => {
  const asc = createASCWithVersions({ data: [] });
  let request = null;
  asc.request = async (endpoint, options) => {
    request = { endpoint, options };
    return {
      data: {
        id: 'run-141',
        attributes: { number: 141, executionProgress: 'PENDING' },
      },
    };
  };

  await asc.startWorkflowBuild('workflow-1', null, { pullRequestId: 'apple-pr-49' });

  assert.deepEqual(JSON.parse(request.options.body).data.relationships, {
    workflow: { data: { type: 'ciWorkflows', id: 'workflow-1' } },
    pullRequest: { data: { type: 'scmPullRequests', id: 'apple-pr-49' } },
  });
});

test('normalizes one Xcode Cloud build run', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.request = async endpoint => {
    assert.equal(endpoint, '/ciBuildRuns/run-140');
    return {
      data: {
        id: 'run-140',
        attributes: {
          number: 140,
          executionProgress: 'COMPLETE',
          completionStatus: 'SUCCEEDED',
          sourceCommit: { commitSha: 'abcdef1234567890' },
        },
      },
    };
  };

  assert.deepEqual(await asc.getBuildRun('run-140'), {
    runId: 'run-140',
    number: 140,
    executionProgress: 'COMPLETE',
    completionStatus: 'SUCCEEDED',
    sourceCommit: { commitSha: 'abcdef1234567890' },
  });
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

  const submission = await asc.getOrCreateDraftReviewSubmission('version-1');

  assert.deepEqual(submission, { submissionId: 'draft-1', itemId: 'item-1' });
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

test('retains the draft submission id when adding its version fails', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getReviewSubmissionIdForVersion = async () => null;
  asc.getReusableDraftReviewSubmissionId = async () => 'draft-1';
  const failure = new Error('Screenshot required');
  asc.request = async endpoint => {
    assert.equal(endpoint, '/reviewSubmissionItems');
    throw failure;
  };

  await assert.rejects(
    asc.getOrCreateDraftReviewSubmission('version-1'),
    error => error === failure && error.reviewSubmissionId === 'draft-1',
  );
});

test('removes the failed item from its draft review submission', async () => {
  const asc = createASCWithVersions({ data: [] });
  let request = null;
  asc.request = async (endpoint, options = {}) => { request = { endpoint, options }; };

  await asc.removeReviewSubmissionItem('item-1');
  assert.deepEqual(request, {
    endpoint: '/reviewSubmissionItems/item-1',
    options: { method: 'DELETE' },
  });
});

test('waits for a withdrawn App Store version to become editable', async () => {
  const asc = createASCWithVersions({ data: [] });
  const states = ['WAITING_FOR_REVIEW', 'PREPARE_FOR_SUBMISSION'];
  const requests = [];
  asc.request = async endpoint => {
    requests.push(endpoint);
    return { data: { attributes: { appStoreState: states.shift() } } };
  };

  const state = await asc.waitForVersionEditable('version-1', {
    pollDelayMs: 0,
    timeoutMs: 10000,
  });

  assert.equal(state, 'PREPARE_FOR_SUBMISSION');
  assert.deepEqual(requests, [
    '/appStoreVersions/version-1?fields[appStoreVersions]=appStoreState',
    '/appStoreVersions/version-1?fields[appStoreVersions]=appStoreState',
  ]);
});

test('finds and cancels a version review through the app-scoped submissions endpoint', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getAppId = async () => 'app-1';
  const requests = [];
  asc.request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint.startsWith('/apps/app-1/reviewSubmissions?')) {
      return {
        data: [{
          id: 'submission-1',
          relationships: { items: { data: [{ id: 'item-1' }] } },
        }],
        included: [{
          type: 'reviewSubmissionItems',
          id: 'item-1',
          relationships: { appStoreVersion: { data: { id: 'version-1' } } },
        }],
      };
    }
    return { data: { id: 'submission-1' } };
  };

  assert.deepEqual(await asc.cancelReview('version-1'), { success: true });
  assert.match(requests[0].endpoint, /^\/apps\/app-1\/reviewSubmissions\?/);
  assert.equal(requests[1].endpoint, '/reviewSubmissions/submission-1');
  assert.equal(requests[1].options.method, 'PATCH');
  assert.equal(JSON.parse(requests[1].options.body).data.attributes.canceled, true);
});

test('finds an empty ready-for-review draft', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getAppId = async () => 'app-1';
  asc.request = async endpoint => {
    assert.match(endpoint, /^\/apps\/app-1\/reviewSubmissions\?/);
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

test('finds uploaded commits for one configured workflow', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  asc.getAppId = async () => 'app-1';
  asc.request = async endpoint => {
    assert.match(endpoint, /filter\[app\]=app-1/);
    return { data: [
      { id: 'build-2', attributes: { version: '2', uploadedDate: '2026-08-27T02:00:00Z' } },
      { id: 'build-1', attributes: { version: '1', uploadedDate: '2026-08-27T01:00:00Z' } },
    ] };
  };
  let scopedLoads = 0;
  asc.loadCIBuildRunsForWorkflow = async workflowId => {
    scopedLoads += 1;
    assert.equal(workflowId, 'workflow-1');
    return [{
      workflowId,
      run: {
        attributes: { number: 1, sourceCommit: { commitSha: 'ancestor' } },
        relationships: { builds: { data: [{ id: 'build-1' }] } },
      },
    }];
  };
  assert.deepEqual(await asc.getPublishedWorkflowCommits('workflow-1'), [{
    commitSha: 'ancestor', buildId: 'build-1', buildNumber: '1', uploadedDate: '2026-08-27T01:00:00Z',
  }]);
  assert.equal(scopedLoads, 1);
});

test('finds builds for a commit without enumerating unrelated workflows', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  asc.getAppId = async () => 'app-1';
  asc.request = async () => ({ data: [
    { id: 'build-1', attributes: { version: '1' } },
    { id: 'build-2', attributes: { version: '2' } },
  ] });
  asc.loadCIBuildRuns = async () => { throw new Error('global workflow scan should not run'); };
  asc.loadCIBuildRunsForWorkflow = async workflowId => [{
    workflowId,
    run: {
      attributes: { sourceCommit: { commitSha: 'head' } },
      relationships: { builds: { data: [{ id: 'build-2' }] } },
    },
  }];

  assert.deepEqual(await asc.getBuildsForWorkflowCommit('workflow-1', 'head'), [
    { buildId: 'build-2', buildNumber: '2' },
  ]);
});

test('updates or creates English TestFlight build notes', async () => {
  const asc = createASCWithVersions({ data: [], included: [] });
  const requests = [];
  asc.request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint === '/builds/build-1/betaBuildLocalizations') {
      return { data: [{ id: 'localization-1', attributes: { locale: 'en-US' } }] };
    }
    return { data: { id: 'localization-new' } };
  };
  assert.deepEqual(await asc.updateBetaBuildNotes('build-1', 'New notes'), {
    created: false, localizationId: 'localization-1',
  });
  assert.equal(requests[1].endpoint, '/betaBuildLocalizations/localization-1');
  assert.equal(JSON.parse(requests[1].options.body).data.attributes.whatsNew, 'New notes');

  requests.length = 0;
  asc.request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint.includes('betaBuildLocalizations') && !options.method) return { data: [] };
    return { data: { id: 'localization-new' } };
  };
  assert.deepEqual(await asc.updateBetaBuildNotes('build-2', 'First notes'), {
    created: true, localizationId: 'localization-new',
  });
  assert.equal(requests[1].endpoint, '/betaBuildLocalizations');
  assert.equal(JSON.parse(requests[1].options.body).data.relationships.build.data.id, 'build-2');
});

test('makes a declared screenshot set match repository order', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getScreenshotSets = async () => ([
    { id: 'set-1', attributes: { screenshotDisplayType: 'APP_IPAD_PRO_3GEN_129' } },
  ]);
  asc.getScreenshots = async () => ([
    { id: 'old', attributes: { fileName: 'old.png', sourceFileChecksum: 'old' } },
    { id: 'two', attributes: { fileName: '02.png', sourceFileChecksum: 'bbb' } },
  ]);
  const deleted = [];
  const uploaded = [];
  const events = [];
  let order = null;
  asc.deleteScreenshot = async id => { deleted.push(id); events.push(`delete:${id}`); };
  asc.uploadScreenshot = async (_setId, asset) => {
    uploaded.push(asset.fileName);
    events.push(`upload:${asset.fileName}`);
    return { id: `uploaded-${asset.fileName}` };
  };
  asc.replaceScreenshotOrder = async (_setId, ids) => { order = ids; };

  assert.deepEqual(await asc.syncScreenshotSet('localization-1', 'APP_IPAD_PRO_3GEN_129', [
    { fileName: '01.png', checksum: 'aaa', bytes: Buffer.from('one') },
    { fileName: '02.png', checksum: 'bbb', bytes: Buffer.from('two') },
  ]), { kept: 1, uploaded: 1, removed: 1 });
  assert.deepEqual(deleted, ['old']);
  assert.deepEqual(uploaded, ['01.png']);
  assert.deepEqual(events, ['upload:01.png', 'delete:old']);
  assert.deepEqual(order, ['uploaded-01.png', 'two']);
});

test('does not create an absent screenshot set when the declared set is empty', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getScreenshotSets = async () => [];
  asc.createScreenshotSet = async () => assert.fail('empty set should not be created');

  assert.deepEqual(
    await asc.syncScreenshotSet('localization-1', 'APP_IPAD_PRO_3GEN_129', []),
    { kept: 0, uploaded: 0, removed: 0 },
  );
});

test('replaces a full screenshot set one slot at a time and reports every removal', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getScreenshotSets = async () => ([
    { id: 'set-1', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } },
  ]);
  asc.getScreenshots = async () => Array.from({ length: 10 }, (_, index) => ({
    id: `old-${index}`,
    attributes: { fileName: `old-${index}.png`, sourceFileChecksum: `old-${index}` },
  }));
  const events = [];
  asc.deleteScreenshot = async id => { events.push(`delete:${id}`); };
  asc.uploadScreenshot = async (_setId, asset) => {
    events.push(`upload:${asset.fileName}`);
    return { id: 'new-1' };
  };
  asc.replaceScreenshotOrder = async () => {};

  assert.deepEqual(await asc.syncScreenshotSet('localization-1', 'APP_IPHONE_67', [
    { fileName: 'new.png', checksum: 'new', bytes: Buffer.from('new') },
  ]), { kept: 0, uploaded: 1, removed: 10 });
  assert.deepEqual(events.slice(0, 2), ['delete:old-0', 'upload:new.png']);
  assert.equal(events.filter(event => event.startsWith('delete:')).length, 10);
});

test('uploads and commits screenshot bytes using Apple upload operations', async t => {
  const asc = createASCWithVersions({ data: [] });
  const requests = [];
  let poll = 0;
  asc.request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint === '/appScreenshots' && options.method === 'POST') {
      return { data: { id: 'screenshot-1', attributes: { uploadOperations: [{
        url: 'https://upload.example/asset', method: 'PUT', offset: 0,
        requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
      }] } } };
    }
    if (endpoint === '/appScreenshots/screenshot-1' && !options.method) {
      poll += 1;
      return { data: { id: 'screenshot-1', attributes: {
        assetDeliveryState: { state: poll > 1 ? 'COMPLETE' : 'AWAITING_UPLOAD' },
      } } };
    }
    return { data: {} };
  };
  const uploads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    uploads.push({ url, options });
    return { ok: true, status: 200 };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await asc.uploadScreenshot('set-1', {
    fileName: '01.png', bytes: Buffer.from('image'), checksum: 'checksum',
  }, { pollDelayMs: 0 });

  assert.equal(result.id, 'screenshot-1');
  assert.equal(uploads[0].url, 'https://upload.example/asset');
  assert.deepEqual(uploads[0].options.body, Buffer.from('image'));
  const commit = JSON.parse(requests.find(call => call.options.method === 'PATCH').options.body);
  assert.deepEqual(commit.data.attributes, { uploaded: true, sourceFileChecksum: 'checksum' });
});

test('makes a declared app preview set match repository order', async () => {
  const asc = createASCWithVersions({ data: [] });
  asc.getPreviewSets = async () => ([
    { id: 'set-1', attributes: { previewType: 'IPHONE_65' } },
  ]);
  asc.getPreviews = async () => ([
    { id: 'old', attributes: { fileName: 'old.mov', sourceFileChecksum: 'old' } },
    { id: 'two', attributes: { fileName: '02.mov', sourceFileChecksum: 'bbb' } },
  ]);
  const deleted = [];
  const uploaded = [];
  const events = [];
  let order = null;
  asc.deletePreview = async id => { deleted.push(id); events.push(`delete:${id}`); };
  asc.uploadPreview = async (_setId, asset) => {
    uploaded.push(asset.fileName);
    events.push(`upload:${asset.fileName}`);
    return { id: `uploaded-${asset.fileName}` };
  };
  asc.replacePreviewOrder = async (_setId, ids) => { order = ids; };

  assert.deepEqual(await asc.syncPreviewSet('localization-1', 'IPHONE_65', [
    { fileName: '01.mov', checksum: 'aaa', bytes: Buffer.from('one') },
    { fileName: '02.mov', checksum: 'bbb', bytes: Buffer.from('two') },
  ]), { kept: 1, uploaded: 1, removed: 1 });
  assert.deepEqual(deleted, ['old']);
  assert.deepEqual(uploaded, ['01.mov']);
  assert.deepEqual(events, ['upload:01.mov', 'delete:old']);
  assert.deepEqual(order, ['uploaded-01.mov', 'two']);
});

test('uploads and commits app preview video bytes', async t => {
  const asc = createASCWithVersions({ data: [] });
  const requests = [];
  asc.request = async (endpoint, options = {}) => {
    requests.push({ endpoint, options });
    if (endpoint === '/appPreviews' && options.method === 'POST') {
      return { data: { id: 'preview-1', attributes: { uploadOperations: [{
        url: 'https://upload.example/video', method: 'PUT', offset: 0,
        requestHeaders: [{ name: 'Content-Type', value: 'video/quicktime' }],
      }] } } };
    }
    if (endpoint === '/appPreviews/preview-1' && !options.method) {
      return { data: { id: 'preview-1', attributes: {
        assetDeliveryState: { state: 'COMPLETE' },
        videoDeliveryState: { state: 'COMPLETE' },
      } } };
    }
    return { data: {} };
  };
  const uploads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    uploads.push(options.body);
    return { ok: true, status: 200 };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await asc.uploadPreview('set-1', {
    fileName: '01.mov', bytes: Buffer.from('video'), checksum: 'checksum',
  }, { pollDelayMs: 0 });
  assert.equal(result.id, 'preview-1');
  assert.deepEqual(uploads, [Buffer.from('video')]);
  const commit = JSON.parse(requests.find(call => call.options.method === 'PATCH').options.body);
  assert.deepEqual(commit.data.attributes, { uploaded: true, sourceFileChecksum: 'checksum' });
});
