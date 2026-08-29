import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergedPullRequestsInComparison,
  reconcileReleasePullRequest,
  releasePullRequestBody,
} from '../lib/release-pr.js';
import { DEFAULT_RELEASE_PR_TITLE } from '../lib/profile.js';

const policy = {
  baseBranch: 'main',
  headBranch: 'develop',
  title: DEFAULT_RELEASE_PR_TITLE,
  noteLimit: 100,
};

test('formats release notes from merged pull requests instead of commits', () => {
  const body = releasePullRequestBody([
    { number: 61, title: 'Add shake gesture for random album navigation' },
    { number: 62, title: 'Improve startup performance' },
  ], { ...policy, compareUrl: 'https://github.com/example/ios/compare/main...develop' });

  assert.equal(body, `## Release Notes
- #61 Add shake gesture for random album navigation
- #62 Improve startup performance

## Automation
This pull request is maintained automatically from \`develop\` to \`main\`.
Merging it triggers the configured production release path for this repository.
`);
  assert.equal(body.includes('individual commit'), false);
});

test('limits release notes by pull request count', () => {
  const body = releasePullRequestBody([
    { number: 1, title: 'One' },
    { number: 2, title: 'Two' },
  ], { ...policy, noteLimit: 1, compareUrl: 'https://github.com/example/ios/compare/main...develop' });

  assert.match(body, /- #2 Two/);
  assert.doesNotMatch(body, /- #1 One/);
  assert.match(body, /1 more pull requests/);
});

test('matches merged PRs by merge SHA and GitHub merge subjects in comparison order', () => {
  const pulls = [
    { number: 12, title: 'Squashed', mergeCommit: { oid: 'different' } },
    { number: 11, title: 'Merged', mergeCommit: { oid: 'merge-sha' } },
  ];
  const comparison = { commits: [
    { sha: 'feature-sha', message: 'Feature implementation' },
    { sha: 'merge-sha', message: 'Merge pull request #11 from example/feature' },
    { sha: 'squash-sha', message: 'Squashed (#12)' },
    { sha: 'duplicate', message: 'Merge pull request #11 from example/feature' },
  ] };

  assert.deepEqual(mergedPullRequestsInComparison(comparison, pulls), [pulls[1], pulls[0]]);
});

function githubFixture(overrides = {}) {
  return {
    repo: 'example/ios',
    getBranchSnapshot: branch => ({ sha: `${branch}-sha`, treeSha: `${branch}-tree` }),
    compareBranches: () => ({ commits: [{ sha: 'merge-sha', message: 'Merge pull request #61 from example/feature' }] }),
    listMergedPullRequests: () => [{ number: 61, title: 'Feature', mergeCommit: { oid: 'merge-sha' } }],
    findOpenPullRequest: () => null,
    createPullRequest: () => ({ number: 70, url: 'https://github.com/example/ios/pull/70' }),
    updatePullRequest: () => ({ number: 69, url: 'https://github.com/example/ios/pull/69' }),
    ...overrides,
  };
}

test('does not create a release PR when branch trees match', () => {
  let compared = false;
  const github = githubFixture({
    getBranchSnapshot: branch => ({ sha: `${branch}-sha`, treeSha: 'same-tree' }),
    compareBranches: () => { compared = true; },
  });

  assert.deepEqual(reconcileReleasePullRequest(github, policy), {
    action: 'noop', reason: 'contents_match',
  });
  assert.equal(compared, false);
});

test('does not create a release PR when the release branch has no commits ahead', () => {
  let listed = false;
  const github = githubFixture({
    compareBranches: () => ({ commits: [] }),
    listMergedPullRequests: () => { listed = true; },
  });

  assert.deepEqual(reconcileReleasePullRequest(github, policy), {
    action: 'noop', reason: 'head_not_ahead',
  });
  assert.equal(listed, false);
});

test('creates a release PR with the default title', () => {
  let created;
  const github = githubFixture({
    createPullRequest: (...args) => {
      created = args;
      return { number: 70, url: 'https://github.com/example/ios/pull/70' };
    },
  });

  const result = reconcileReleasePullRequest(github, policy);
  assert.equal(result.action, 'created');
  assert.deepEqual(created.slice(0, 3), ['main', 'develop', 'Bug fixes and performance improvements']);
  assert.match(created[3], /- #61 Feature/);
});

test('updates the exact open release PR', () => {
  let updated;
  const github = githubFixture({
    findOpenPullRequest: () => ({ number: 69 }),
    updatePullRequest: (...args) => {
      updated = args;
      return { number: 69, url: 'https://github.com/example/ios/pull/69' };
    },
  });

  assert.equal(reconcileReleasePullRequest(github, policy).action, 'updated');
  assert.equal(updated[0], 69);
  assert.equal(updated[1], DEFAULT_RELEASE_PR_TITLE);
});
