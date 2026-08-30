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
  assert.match(logs.join('\n'), /Skipping conflicted pull request #2/);
  assert.match(logs.join('\n'), /Skipping pull request #3: Branch update is not allowed/);
});

test('dry run reports rebases without updating branches', () => {
  let updated = false;
  const github = {
    listOpenPullRequests: () => [pull(8)],
    rebasePullRequest: () => { updated = true; },
  };

  assert.deepEqual(rebaseOpenPullRequests(github, 'develop', true), [
    { number: 8, action: 'would_rebase' },
  ]);
  assert.equal(updated, false);
});
