import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publishTestFlightNotesForRun,
  refreshTestFlightNotes,
} from '../lib/refresh-notes.js';

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

test('retries post-build note publication until the upload is visible and valid', async () => {
  const profile = { repository: { beta_branch: 'develop', production_branch: 'main' } };
  const build = { purpose: 'pull_request', appId: 'app-1', workflowId: 'wf-pr', includeCommits: true };
  const github = {};

  for (const builds of [
    [],
    [{ buildId: 'build-current', buildNumber: '102', processingState: 'PROCESSING' }],
  ]) {
    const asc = {
      getBuildRunNotesContext: async () => ({
        workflowId: 'wf-pr',
        completionStatus: 'SUCCEEDED',
        commitSha: 'head',
        builds,
      }),
    };
    await assert.rejects(
      publishTestFlightNotesForRun(asc, github, profile, build, 'run-102'),
      error => error.statusCode === 503 && error.retryAfter === 15,
    );
  }
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
