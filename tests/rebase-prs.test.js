import test from 'node:test';
import assert from 'node:assert/strict';

import { rebaseOpenPullRequests } from '../lib/rebase-prs.js';

function pull(number, overrides = {}) {
  return {
    number,
    id: `PR_${number}`,
    headRefOid: `head-${number}`,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BEHIND',
    ...overrides,
  };
}

test('rebases every updatable pull request and skips conflicts and API failures', () => {
  const rebased = [];
  const comments = [];
  const logs = [];
  const github = {
    listOpenPullRequests: () => [
      pull(1),
      pull(2, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      pull(3),
      pull(4),
    ],
    rebasePullRequest: (id, head) => {
      rebased.push([id, head]);
      if (id === 'PR_3') throw new Error('Branch update is not allowed');
      return { url: `https://github.test/pull/${id.slice(3)}` };
    },
    upsertPRComment: (...args) => {
      comments.push(args);
      return 'created';
    },
  };

  assert.deepEqual(rebaseOpenPullRequests(github, 'develop', false, message => logs.push(message)), [
    { number: 1, action: 'rebased', url: 'https://github.test/pull/1' },
    { number: 2, action: 'skipped', reason: 'conflicted' },
    { number: 3, action: 'skipped', reason: 'not_updatable' },
    { number: 4, action: 'rebased', url: 'https://github.test/pull/4' },
  ]);
  assert.deepEqual(rebased, [
    ['PR_1', 'head-1'],
    ['PR_3', 'head-3'],
    ['PR_4', 'head-4'],
  ]);
  assert.equal(comments.length, 2);
  assert.equal(comments[0][0], 2);
  assert.match(comments[0][1], /auto-rebase-failure/);
  assert.match(comments[0][2], /conflicts with the target branch/);
  assert.equal(comments[1][0], 3);
  assert.match(comments[1][2], /GitHub did not allow the branch/);
  assert.match(comments[1][2], /onto `develop`/);
  assert.match(logs.join('\n'), /Skipping conflicted pull request #2/);
  assert.match(logs.join('\n'), /Skipping pull request #3: Branch update is not allowed/);
});

test('dry run reports rebases without updating branches', () => {
  let updated = false;
  let commented = false;
  const github = {
    listOpenPullRequests: () => [
      pull(8),
      pull(9, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    ],
    rebasePullRequest: () => { updated = true; },
    upsertPRComment: () => { commented = true; },
  };

  assert.deepEqual(rebaseOpenPullRequests(github, 'develop', true), [
    { number: 8, action: 'would_rebase' },
    { number: 9, action: 'skipped', reason: 'conflicted' },
  ]);
  assert.equal(updated, false);
  assert.equal(commented, false);
});

test('a comment failure does not prevent remaining pull requests from rebasing', () => {
  const rebased = [];
  const logs = [];
  const github = {
    listOpenPullRequests: () => [
      pull(10, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      pull(11),
    ],
    upsertPRComment: () => { throw new Error('comments are disabled'); },
    rebasePullRequest: id => {
      rebased.push(id);
      return { url: 'https://github.test/pull/11' };
    },
  };

  rebaseOpenPullRequests(github, 'develop', false, message => logs.push(message));
  assert.deepEqual(rebased, ['PR_11']);
  assert.match(logs.join('\n'), /could not comment on pull request #10/);
});
