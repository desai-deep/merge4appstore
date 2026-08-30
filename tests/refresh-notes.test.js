import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshTestFlightNotes } from '../lib/refresh-notes.js';

test('refreshes the localization for every published build of the PR commit', async () => {
  const updated = [];
  const asc = {
    appId: null,
    getPublishedWorkflowCommits: async () => [{ commitSha: 'previous' }, { commitSha: 'head' }],
    getBuildsForWorkflowCommit: async () => [
      { buildId: 'build-1', buildNumber: '101' },
      { buildId: 'build-2', buildNumber: '102' },
    ],
    updateBetaBuildNotes: async (buildId, notes) => updated.push({ buildId, notes }),
  };
  const github = {
    getCommitSubject: () => 'Current subject',
    getPRDetails: () => ({ title: 'Feature', body: 'Manual tester instructions' }),
    getCommitSubjectsSince: () => ({ baseCommit: 'previous', subjects: ['First', 'Second'] }),
    getPullRequestCommitSubjects: () => [],
  };
  const build = { purpose: 'pull_request', appId: 'app-1', workflowId: 'wf-pr', includeCommits: true };
  const result = await refreshTestFlightNotes(asc, github, build, {
    commit: 'head', branch: 'feature', pull_request: '42',
  });
  assert.equal(result.updated, 2);
  assert.equal(asc.appId, 'app-1');
  assert.equal(updated.length, 2);
  assert.match(updated[0].notes, /^Commits since the last published build:/);
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
    getPRDetails: () => ({
      title: 'Bug fixes and performance improvements',
      body: '## Release Notes\nCI improvements\nacross two lines\n\n## Automation\nMaintained automatically.',
    }),
  };
  const build = { purpose: 'beta', appId: 'app-1', workflowId: 'wf-beta', includeCommits: false };

  const result = await refreshTestFlightNotes(asc, github, build, {
    commit: 'release-head', branch: 'develop', pull_request: '65',
  });

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
