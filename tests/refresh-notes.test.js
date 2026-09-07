import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publishTestFlightNotesForRun,
  refreshAppStoreReleaseNotes,
  refreshTestFlightNotes,
} from '../lib/refresh-notes.js';

const RELEASE_COMMIT = 'a'.repeat(40);

function appStoreReleaseNoteFixture({
  state = 'WAITING_FOR_REVIEW',
  currentNotes = 'Old title',
  update = async () => {},
} = {}) {
  const forbidden = operation => async () => {
    assert.fail(`${operation} must not run during a release-note refresh`);
  };
  return {
    asc: {
      getBuildsForWorkflowCommit: async (workflowId, commitSha) => {
        assert.equal(workflowId, 'wf-prod');
        assert.equal(commitSha, RELEASE_COMMIT);
        return [{ buildId: 'build-176', buildNumber: '176' }];
      },
      getAppStoreVersions: async () => ({
        data: [{
          id: 'version-1.8',
          attributes: { versionString: '1.8', appStoreState: state },
          relationships: { build: { data: { id: 'build-176' } } },
        }],
      }),
      getAppStoreVersionLocalizations: async versionId => {
        assert.equal(versionId, 'version-1.8');
        return [{
          id: 'localization-en-US',
          attributes: { locale: 'en-US', whatsNew: currentNotes },
        }];
      },
      updateAppStoreVersionLocalization: update,
      cancelReview: forbidden('cancelReview'),
      getOrCreateAppStoreVersion: forbidden('getOrCreateAppStoreVersion'),
      selectBuildForVersion: forbidden('selectBuildForVersion'),
      submitForReview: forbidden('submitForReview'),
    },
    github: {
      findPRFromCommit: commitSha => {
        assert.equal(commitSha, RELEASE_COMMIT);
        return '65';
      },
      getPRDetails: pullRequest => {
        assert.equal(String(pullRequest), '65');
        return { title: 'Updated title', body: '', headRefOid: 'release-head' };
      },
      extractReleaseNotes: details => details.title,
    },
  };
}

function refreshReleaseOptions(overrides = {}) {
  return {
    workflowId: 'wf-prod',
    commitSha: RELEASE_COMMIT,
    pullRequest: '65',
    ...overrides,
  };
}

test('publishes notes to the exact successful run build and excludes it from history', async () => {
  const updated = [];
  const asc = {
    appId: null,
    getBuildRunNotesContext: async runId => {
      assert.equal(runId, 'run-102');
      return {
        runId,
        workflowId: 'wf-pr',
        completionStatus: 'SUCCEEDED',
        commitSha: 'head',
        branch: 'feature/player',
        targetBranch: 'develop',
        pullRequest: '42',
        builds: [{ buildId: 'build-current', buildNumber: '102', processingState: 'VALID' }],
      };
    },
    getPublishedWorkflowCommits: async () => [
      { buildId: 'build-current', commitSha: 'head', buildNumber: '102', marketingVersion: '1.4' },
      { buildId: 'build-previous', commitSha: 'previous', buildNumber: '101', marketingVersion: '1.4' },
    ],
    updateBetaBuildNotes: async (buildId, notes) => updated.push({ buildId, notes }),
  };
  const github = {
    getCommitSubject: () => 'Current subject',
    getPRDetails: () => ({ title: 'Feature', body: 'Manual tester instructions', headRefOid: 'head' }),
    getCommitSubjectsSince: published => {
      assert.deepEqual(published.map(candidate => candidate.buildId), ['build-previous']);
      return {
        baseCommit: 'previous',
        baseBuildNumber: '101',
        baseMarketingVersion: '1.4',
        subjects: ['Current subject'],
      };
    },
    getPullRequestCommitSubjects: () => [],
  };
  const profile = { repository: { beta_branch: 'develop', production_branch: 'main' } };
  const build = { purpose: 'pull_request', appId: 'app-1', workflowId: 'wf-pr', includeCommits: true };

  const result = await publishTestFlightNotesForRun(
    asc,
    github,
    profile,
    build,
    'run-102',
  );

  assert.equal(result.updated, 1);
  assert.equal(asc.appId, 'app-1');
  assert.deepEqual(updated, [{
    buildId: 'build-current',
    notes: 'Commits since 1.4 (101):\n\n• Current subject\n\nManual tester instructions',
  }]);
});

test('polls post-build note publication until the upload is visible and valid', async () => {
  const profile = { repository: { beta_branch: 'develop', production_branch: 'main' } };
  const build = { purpose: 'production', appId: 'app-1', workflowId: 'wf-prod', includeCommits: false };
  const buildsByAttempt = [
    [],
    [{ buildId: 'build-current', buildNumber: '102', processingState: 'PROCESSING' }],
    [{ buildId: 'build-current', buildNumber: '102', processingState: 'VALID' }],
  ];
  const updated = [];
  const asc = {
    getBuildRunNotesContext: async () => ({
        workflowId: 'wf-prod',
        completionStatus: 'SUCCEEDED',
        commitSha: 'head',
        branch: 'main',
        builds: buildsByAttempt.shift(),
      }),
    getPublishedWorkflowCommits: async () => [],
    updateBetaBuildNotes: async (buildId, notes) => updated.push({ buildId, notes }),
  };
  const sleeps = [];
  const result = await publishTestFlightNotesForRun(
    asc,
    { getCommitSubject: () => 'Production release' },
    profile,
    build,
    'run-102',
    false,
    { intervalMs: 15, timeoutMs: 100, sleep: async ms => sleeps.push(ms) },
  );

  assert.equal(result.updated, 1);
  assert.deepEqual(sleeps, [15, 15]);
  assert.deepEqual(updated, [{ buildId: 'build-current', notes: 'Production release' }]);
});

test('bounds the wait for an uploaded build to become valid', async () => {
  let time = 0;
  const asc = {
    getBuildRunNotesContext: async () => ({
      workflowId: 'wf-pr',
      completionStatus: 'SUCCEEDED',
      commitSha: 'head',
      builds: [],
    }),
  };

  await assert.rejects(
    publishTestFlightNotesForRun(
      asc,
      {},
      {},
      { purpose: 'pull_request', appId: 'app-1', workflowId: 'wf-pr' },
      'run-102',
      false,
      {
        intervalMs: 15,
        timeoutMs: 30,
        now: () => time,
        sleep: async ms => { time += ms; },
      },
    ),
    /Timed out waiting for Xcode Cloud build run run-102 to become valid/,
  );
});

test('refreshes the localization for every published build of the PR commit', async () => {
  const updated = [];
  const asc = {
    appId: null,
    getPublishedWorkflowCommits: async () => [
      { commitSha: 'previous', buildNumber: '100', marketingVersion: '1.4' },
      { commitSha: 'head', buildNumber: '101', marketingVersion: '1.4' },
    ],
    getBuildsForWorkflowCommit: async () => [
      { buildId: 'build-1', buildNumber: '101' },
      { buildId: 'build-2', buildNumber: '102' },
    ],
    updateBetaBuildNotes: async (buildId, notes) => updated.push({ buildId, notes }),
  };
  const github = {
    getCommitSubject: () => 'Current subject',
    getPRDetails: () => ({ title: 'Feature', body: 'Manual tester instructions', headRefOid: 'head' }),
    getCommitSubjectsSince: () => ({ baseCommit: 'previous', baseBuildNumber: '100', baseMarketingVersion: '1.4', subjects: ['First', 'Second'] }),
    getPullRequestCommitSubjects: () => [],
  };
  const build = { purpose: 'pull_request', appId: 'app-1', workflowId: 'wf-pr', includeCommits: true };
  const result = await refreshTestFlightNotes(asc, github, build, {
    commit: 'head', branch: 'feature', pull_request: '42',
  });
  assert.equal(result.updated, 2);
  assert.equal(asc.appId, 'app-1');
  assert.equal(updated.length, 2);
  assert.match(updated[0].notes, /^Commits since 1\.4 \(100\):/);
  assert.match(updated[0].notes, /• First\n• Second\n\nManual tester instructions$/);
});

test('uses a release pull request body for matching beta workflow builds', async () => {
  const updated = [];
  const asc = {
    appId: null,
    getBuildsForWorkflowCommit: async (workflowId, commit) => {
      assert.equal(workflowId, 'wf-beta');
      assert.equal(commit, 'release-head');
      return [{ buildId: 'build-176', buildNumber: '176' }];
    },
    updateBetaBuildNotes: async (buildId, notes) => updated.push({ buildId, notes }),
  };
  const github = {
    getCommitSubject: () => 'Remove app-local release PR automation',
    findOpenPullRequestForCommit: (commit, base, head) => {
      assert.deepEqual({ commit, base, head }, {
        commit: 'release-head',
        base: 'stable',
        head: 'preview',
      });
      return { number: 65 };
    },
    getPRDetails: () => ({
      title: 'Bug fixes and performance improvements',
      body: '## Release Notes\nCI improvements\nacross two lines\n\n## Automation\nMaintained automatically.',
      headRefOid: 'release-head',
    }),
  };
  const build = { purpose: 'beta', appId: 'app-1', workflowId: 'wf-beta', includeCommits: false };

  const result = await refreshTestFlightNotes(asc, github, build, {
    commit: 'release-head', branch: 'preview',
  }, false, { repository: { beta_branch: 'preview', production_branch: 'stable' } });

  assert.equal(result.updated, 1);
  assert.deepEqual(updated, [{ buildId: 'build-176', notes: 'CI improvements\nacross two lines' }]);
});

test('does not publish other PR sections when release notes are empty', async () => {
  const updated = [];
  const asc = {
    appId: null,
    getBuildsForWorkflowCommit: async () => [{ buildId: 'build-176', buildNumber: '176' }],
    updateBetaBuildNotes: async (buildId, notes) => updated.push({ buildId, notes }),
  };
  const github = {
    getCommitSubject: () => 'Remove app-local release PR automation',
    getPRDetails: () => ({
      title: 'Bug fixes and performance improvements',
      body: '## Release Notes\n\n## Automation\nMaintained automatically.',
      headRefOid: 'release-head',
    }),
  };
  const build = { purpose: 'beta', appId: 'app-1', workflowId: 'wf-beta', includeCommits: false };

  await refreshTestFlightNotes(asc, github, build, {
    commit: 'release-head', branch: 'develop', pull_request: '65',
  });

  assert.deepEqual(updated, [{
    buildId: 'build-176', notes: 'Bug fixes and performance improvements',
  }]);
});

test('updates only the existing localization selected by the exact production workflow commit', async () => {
  const updates = [];
  const { asc, github } = appStoreReleaseNoteFixture({
    update: async (id, attributes) => updates.push({ id, attributes }),
  });

  const result = await refreshAppStoreReleaseNotes(
    asc,
    github,
    refreshReleaseOptions(),
  );

  assert.deepEqual(result, {
    updated: 1,
    reason: 'updated',
    versionId: 'version-1.8',
    notes: 'Updated title',
  });
  assert.deepEqual(updates, [{
    id: 'localization-en-US',
    attributes: { whatsNew: 'Updated title' },
  }]);
});

test('does not update a live version or a version selected by another build', async () => {
  const { asc, github } = appStoreReleaseNoteFixture();
  asc.getAppStoreVersions = async () => ({ data: [{
    id: 'version-live',
    attributes: { versionString: '1.8', appStoreState: 'READY_FOR_SALE' },
    relationships: { build: { data: { id: 'build-176' } } },
  }, {
    id: 'version-other',
    attributes: { versionString: '1.9', appStoreState: 'WAITING_FOR_REVIEW' },
    relationships: { build: { data: { id: 'build-177' } } },
  }] });
  asc.getAppStoreVersionLocalizations = async () => assert.fail('no version matched');

  assert.deepEqual(
    await refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions()),
    { updated: 0, reason: 'version_not_found' },
  );
});

test('ignores a delayed title edit after the commit maps to another pull request', async () => {
  const { asc, github } = appStoreReleaseNoteFixture();
  github.findPRFromCommit = () => '66';
  asc.getBuildsForWorkflowCommit = async () => assert.fail('a mismatched PR must stop before App Store lookup');

  assert.deepEqual(
    await refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions()),
    { updated: 0, reason: 'pull_request_mismatch' },
  );
});

test('preserves repository-managed App Store release notes', async () => {
  const { asc, github } = appStoreReleaseNoteFixture();
  const productionHead = 'b'.repeat(40);
  github.getProductionHead = () => productionHead;
  github.getRepositoryTree = (metadataPath, ref) => {
    assert.equal(metadataPath, 'AppStore');
    assert.equal(ref, productionHead);
    return [
      { path: 'AppStore', type: 'tree', sha: 'root' },
      { path: 'AppStore/en-US/whats_new.txt', type: 'blob', sha: 'notes' },
    ];
  };
  asc.getAppStoreVersionLocalizations = async () => assert.fail('managed notes must not be read or changed');

  assert.deepEqual(
    await refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions({
      metadataPath: 'AppStore',
    })),
    { updated: 0, reason: 'repository_managed', versionId: 'version-1.8' },
  );
});

test('fails closed when current metadata ownership cannot be resolved', async () => {
  const { asc, github } = appStoreReleaseNoteFixture();
  github.getProductionHead = () => null;
  github.getRepositoryTree = () => assert.fail('missing production state must not inspect stale metadata');

  await assert.rejects(
    refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions({
      metadataPath: 'AppStore',
    })),
    error => error.statusCode === 503 && /production branch head/.test(error.message),
  );
});

test('does not create a missing localization or rewrite unchanged release notes', async () => {
  const missing = appStoreReleaseNoteFixture();
  missing.asc.getAppStoreVersionLocalizations = async () => [];
  assert.deepEqual(
    await refreshAppStoreReleaseNotes(missing.asc, missing.github, refreshReleaseOptions()),
    {
      updated: 0,
      reason: 'localization_not_found',
      versionId: 'version-1.8',
      notes: 'Updated title',
    },
  );

  const unchanged = appStoreReleaseNoteFixture({ currentNotes: 'Updated title' });
  assert.deepEqual(
    await refreshAppStoreReleaseNotes(unchanged.asc, unchanged.github, refreshReleaseOptions()),
    {
      updated: 0,
      reason: 'unchanged',
      versionId: 'version-1.8',
      notes: 'Updated title',
    },
  );
});

test('dry-run previews the App Store release-note update without patching it', async () => {
  const { asc, github } = appStoreReleaseNoteFixture({
    update: async () => assert.fail('dry run must not patch release notes'),
  });

  assert.deepEqual(
    await refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions({ dryRun: true })),
    {
      updated: 0,
      reason: 'dry_run',
      versionId: 'version-1.8',
      notes: 'Updated title',
    },
  );
});

test('treats a raw App Store state conflict as a graceful non-editable result', async () => {
  const conflict = new Error('API Error 409: The resource cannot be modified');
  conflict.statusCode = 409;
  conflict.appStoreErrors = [{
    code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
    detail: 'The associated field is invalid',
  }];
  conflict.apiResponse = { errors: [{
    code: 'STATE_ERROR',
    detail: 'The resource cannot be modified in its current state',
  }] };
  const { asc, github } = appStoreReleaseNoteFixture({
    update: async () => { throw conflict; },
  });

  assert.deepEqual(
    await refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions()),
    {
      updated: 0,
      reason: 'not_editable',
      versionId: 'version-1.8',
      notes: 'Updated title',
    },
  );
});

test('propagates a non-state App Store conflict', async () => {
  const conflict = new Error('API Error 409: The value conflicts with a business rule');
  conflict.statusCode = 409;
  conflict.appStoreErrors = [{ code: 'ENTITY_ERROR.ATTRIBUTE.INVALID' }];
  conflict.apiResponse = { errors: [{ code: 'ENTITY_ERROR' }] };
  const { asc, github } = appStoreReleaseNoteFixture({
    update: async () => { throw conflict; },
  });

  await assert.rejects(
    refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions()),
    error => error === conflict,
  );
});

test('propagates unexpected App Store release-note failures', async () => {
  const outage = Object.assign(new Error('App Store unavailable'), {
    statusCode: 503,
    retryAfter: 5,
  });
  const { asc, github } = appStoreReleaseNoteFixture({
    update: async () => { throw outage; },
  });

  await assert.rejects(
    refreshAppStoreReleaseNotes(asc, github, refreshReleaseOptions()),
    error => error === outage,
  );
});
