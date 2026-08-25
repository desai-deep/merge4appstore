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

test('finds one closed PR for the exact source and destination branches', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([
    {
      number: 40,
      state: 'MERGED',
      closedAt: '2026-08-21T10:00:00Z',
      mergedAt: '2026-08-21T10:00:00Z',
      headRefName: 'feature/player',
      baseRefName: 'develop',
    },
  ]);

  assert.deepEqual(
    github.findClosedPRForBuild('abc123', 'develop', 'feature/player'),
    {
      number: 40,
      headBranch: 'feature/player',
      baseBranch: 'develop',
      mergedAt: '2026-08-21T10:00:00Z',
      closedAt: '2026-08-21T10:00:00Z',
    },
  );
});

test('finds a PR closed without merging', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([
    {
      number: 40,
      state: 'CLOSED',
      closedAt: '2026-08-21T10:00:00Z',
      mergedAt: null,
      headRefName: 'feature/player',
      baseRefName: 'develop',
    },
  ]);

  assert.deepEqual(
    github.findClosedPRForBuild('abc123', 'develop', 'feature/player'),
    {
      number: 40,
      headBranch: 'feature/player',
      baseBranch: 'develop',
      mergedAt: null,
      closedAt: '2026-08-21T10:00:00Z',
    },
  );
});

test('keeps a branch when it has a currently open PR', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([
    {
      number: 40,
      state: 'CLOSED',
      closedAt: '2026-08-20T10:00:00Z',
      mergedAt: null,
      headRefName: 'feature/player',
      baseRefName: 'develop',
    },
    {
      number: 41,
      state: 'OPEN',
      closedAt: null,
      mergedAt: null,
      headRefName: 'feature/player',
      baseRefName: 'develop',
    },
  ]);

  assert.equal(
    github.findClosedPRForBuild('abc123', 'develop', 'feature/player'),
    null,
  );
});

test('uses the commit association to disambiguate a reused closed branch', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  let calls = 0;
  github.exec = () => {
    calls += 1;
    if (calls === 1) return JSON.stringify([
      { number: 40, state: 'CLOSED', closedAt: '2026-08-20T10:00:00Z', mergedAt: null, headRefName: 'feature/player', baseRefName: 'develop' },
      { number: 41, state: 'MERGED', closedAt: '2026-08-21T10:00:00Z', mergedAt: '2026-08-21T10:00:00Z', headRefName: 'feature/player', baseRefName: 'develop' },
    ]);
    return JSON.stringify([{ number: 41 }]);
  };

  assert.equal(github.findClosedPRForBuild('abc123', 'develop', 'feature/player').number, 41);
});

test('treats a reused closed branch without one commit match as ambiguous', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  let calls = 0;
  github.exec = () => {
    calls += 1;
    if (calls === 1) return JSON.stringify([
      { number: 40, state: 'CLOSED', closedAt: '2026-08-20T10:00:00Z', mergedAt: null, headRefName: 'feature/player', baseRefName: 'develop' },
      { number: 41, state: 'MERGED', closedAt: '2026-08-21T10:00:00Z', mergedAt: '2026-08-21T10:00:00Z', headRefName: 'feature/player', baseRefName: 'develop' },
    ]);
    return '[]';
  };

  assert.equal(github.findClosedPRForBuild('abc123', 'develop', 'feature/player'), null);
});
