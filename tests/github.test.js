import test from 'node:test';
import assert from 'node:assert/strict';

import { GitHubAPI } from '../lib/github.js';

test('release notes always use the PR title', () => {
  const github = new GitHubAPI('desai-deep', 'merge4appstore');
  const prDetails = {
    title: 'Minor bug fixes',
    body: `## Release Notes
- Fix cold-launch widget stage navigation (#82)

## Automation
This pull request is maintained automatically from \`develop\` to \`main\`.
Merging it triggers the production release path for this repository.
`,
    author: { login: 'app/github-actions' },
    baseRefName: 'main',
    headRefName: 'develop'
  };

  assert.equal(github.extractReleaseNotes(prDetails), 'Minor bug fixes');
});

test('release notes ignore a manual PR release notes section', () => {
  const github = new GitHubAPI('desai-deep', 'merge4appstore');
  const prDetails = {
    title: 'Skip non-publish TestFlight builds during deploy',
    body: `## Summary
- Keep scanning for an eligible build

## Release Notes
Bug fixes and review handling improvements

## Verification
- node --check lib/deploy.js
`,
    author: { login: 'desai-deep' },
    baseRefName: 'main',
    headRefName: 'fix/skip-non-publish-builds'
  };

  assert.equal(
    github.extractReleaseNotes(prDetails),
    'Skip non-publish TestFlight builds during deploy'
  );
});

test('finds a merged PR for the exact source and destination branches', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([
    {
      number: 40,
      merged_at: '2026-08-20T10:00:00Z',
      head: { ref: 'feature/other' },
      base: { ref: 'develop' },
    },
    {
      number: 41,
      merged_at: '2026-08-21T10:00:00Z',
      head: { ref: 'feature/player' },
      base: { ref: 'develop' },
    },
  ]);

  assert.deepEqual(
    github.findMergedPRForCommit('abc123', 'develop', 'feature/player'),
    {
      number: 41,
      headBranch: 'feature/player',
      baseBranch: 'develop',
      mergedAt: '2026-08-21T10:00:00Z',
    },
  );
});

test('ignores open PRs and PRs merged to another branch', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([
    {
      number: 40,
      merged_at: null,
      head: { ref: 'feature/player' },
      base: { ref: 'develop' },
    },
    {
      number: 41,
      merged_at: '2026-08-21T10:00:00Z',
      head: { ref: 'feature/player' },
      base: { ref: 'main' },
    },
  ]);

  assert.equal(
    github.findMergedPRForCommit('abc123', 'develop', 'feature/player'),
    null,
  );
});

test('treats multiple matching merged PRs as ambiguous', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([
    {
      number: 40,
      merged_at: '2026-08-20T10:00:00Z',
      head: { ref: 'feature/player' },
      base: { ref: 'develop' },
    },
    {
      number: 41,
      merged_at: '2026-08-21T10:00:00Z',
      head: { ref: 'feature/player' },
      base: { ref: 'develop' },
    },
  ]);

  assert.equal(
    github.findMergedPRForCommit('abc123', 'develop', 'feature/player'),
    null,
  );
});
