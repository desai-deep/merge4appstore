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
  assert.match(updated[0].notes, /^Manual tester instructions/);
  assert.match(updated[0].notes, /• First\n• Second$/);
});
