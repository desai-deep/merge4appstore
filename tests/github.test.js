import test from 'node:test';
import assert from 'node:assert/strict';

import { GitHubAPI } from '../lib/github.js';

test('lists open pull requests with the state needed for safe rebasing', () => {
  const github = new GitHubAPI('example', 'ios');
  let args;
  github.exec = received => {
    args = received;
    return JSON.stringify([{
      number: 42,
      id: 'PR_node',
      headRefOid: 'head-sha',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      url: 'https://github.test/pull/42',
    }]);
  };

  assert.equal(github.listOpenPullRequests('develop')[0].number, 42);
  assert.deepEqual(args, [
    'pr', 'list', '--repo', 'example/ios', '--state', 'open', '--base', 'develop',
    '--limit', '1000', '--json', 'number,url,id,headRefOid,mergeable,mergeStateStatus',
  ]);
});

test('rebases a pull request with an optimistic head check', () => {
  const github = new GitHubAPI('example', 'ios');
  let args;
  github.exec = received => {
    args = received;
    return JSON.stringify({ data: { updatePullRequestBranch: { pullRequest: {
      number: 42,
      url: 'https://github.test/pull/42',
      headRefOid: 'rebased-sha',
    } } } });
  };

  assert.deepEqual(github.rebasePullRequest('PR_node', 'head-sha'), {
    number: 42,
    url: 'https://github.test/pull/42',
    headRefOid: 'rebased-sha',
  });
  assert.ok(args.includes('pullRequestId=PR_node'));
  assert.ok(args.includes('expectedHeadOid=head-sha'));
  assert.match(args.find(argument => argument.startsWith('query=')), /updateMethod: REBASE/);
});

test('surfaces GraphQL details when a pull request cannot be rebased', () => {
  const github = new GitHubAPI('example', 'ios');
  github.exec = () => JSON.stringify({
    data: { updatePullRequestBranch: null },
    errors: [
      { message: 'Head branch was modified' },
      { message: 'Pull request is not updateable' },
    ],
  });

  assert.throws(
    () => github.rebasePullRequest('PR_node', 'stale-head'),
    /Head branch was modified; Pull request is not updateable/,
  );
});

test('loads repository assets through the Git blob API', () => {
  const github = new GitHubAPI('example', 'ios');
  const calls = [];
  github.exec = args => {
    calls.push(args);
    if (args[1].includes('/contents/')) return JSON.stringify({ type: 'file', sha: 'blob-sha' });
    return JSON.stringify({ encoding: 'base64', content: 'aW1h\nZ2U=' });
  };

  assert.deepEqual(
    github.getRepositoryFile('AppStore/screenshots/en-US/iPad 01.png', 'release/1.2'),
    Buffer.from('image'),
  );
  assert.deepEqual(calls, [
    ['api', 'repos/example/ios/contents/AppStore/screenshots/en-US/iPad%2001.png?ref=release%2F1.2'],
    ['api', 'repos/example/ios/git/blobs/blob-sha'],
  ]);
});

test('lists a metadata subtree from an immutable repository tree', () => {
  const github = new GitHubAPI('example', 'ios');
  const calls = [];
  github.exec = args => {
    calls.push(args);
    if (args[1].includes('/commits/')) {
      return JSON.stringify({ commit: { tree: { sha: 'tree-sha' } } });
    }
    return JSON.stringify({ truncated: false, tree: [
      { path: 'AppStore', type: 'tree', sha: 'root' },
      { path: 'AppStore/en-US/description.txt', type: 'blob', sha: 'description' },
      { path: 'Sources/App.swift', type: 'blob', sha: 'source' },
    ] });
  };

  assert.deepEqual(github.getRepositoryTree('AppStore', 'release/1.2').map(item => item.sha), [
    'root', 'description',
  ]);
  assert.deepEqual(calls, [
    ['api', 'repos/example/ios/commits/release%2F1.2'],
    ['api', 'repos/example/ios/git/trees/tree-sha?recursive=1'],
  ]);
});

test('updates the existing marked automation comment', () => {
  const github = new GitHubAPI('example', 'ios');
  const calls = [];
  github.exec = args => {
    calls.push(args);
    if (args.includes('--slurp')) return JSON.stringify([[
      { id: 456, body: '<!-- submission:1 -->\nOld failure' },
    ]]);
    return '';
  };

  assert.equal(
    github.upsertPRComment(12, '<!-- submission:1 -->', '<!-- submission:1 -->\nNew failure'),
    'updated',
  );
  assert.deepEqual(calls[1], [
    'api', '--method', 'PATCH',
    'repos/example/ios/issues/comments/456',
    '-f', 'body=<!-- submission:1 -->\nNew failure',
  ]);
});

test('reopens and updates a marked release issue', () => {
  const github = new GitHubAPI('example', 'ios');
  const calls = [];
  github.exec = args => {
    calls.push(args);
    if (args[0] === 'issue') return JSON.stringify([{
      number: 45,
      title: 'Old title',
      body: '<!-- release:1 -->\nOld failure',
      state: 'CLOSED',
      url: 'https://github.test/issues/45',
    }]);
    return JSON.stringify({
      number: 45,
      html_url: 'https://github.test/issues/45',
    });
  };

  assert.deepEqual(
    github.upsertIssue('<!-- release:1 -->', 'Release blocked', 'New failure'),
    { number: 45, url: 'https://github.test/issues/45', action: 'reopened' },
  );
  assert.ok(calls[1].includes('state=open'));
});

test('closes an open marked release issue with a resolution comment', () => {
  const github = new GitHubAPI('example', 'ios');
  const calls = [];
  github.exec = args => {
    calls.push(args);
    if (args[0] === 'issue') return JSON.stringify([{
      number: 45,
      body: '<!-- release:1 -->',
      state: 'OPEN',
      url: 'https://github.test/issues/45',
    }]);
    return '{}';
  };

  assert.deepEqual(
    github.closeIssueByMarker('<!-- release:1 -->', 'Submitted successfully'),
    { number: 45, url: 'https://github.test/issues/45' },
  );
  assert.match(calls[1].join(' '), /issues\/45\/comments/);
  assert.ok(calls[2].includes('state=closed'));
});

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

test('selects the newest published ancestor and returns every comparison commit', () => {
  const github = new GitHubAPI('example', 'ios');
  github.exec = args => {
    const endpoint = args.at(-1);
    if (endpoint.includes('newest...head')) return JSON.stringify([{ status: 'diverged', commits: [] }]);
    return JSON.stringify([{ status: 'ahead', commits: [
      { commit: { message: 'First change\n\nDetails' } },
      { commit: { message: 'Second change' } },
    ] }]);
  };
  assert.deepEqual(github.getCommitSubjectsSince([
    { commitSha: 'newest', buildNumber: '102' },
    { commitSha: 'ancestor', buildNumber: '101' },
  ], 'head'), {
    baseCommit: 'ancestor',
    baseBuildNumber: '101',
    subjects: ['First change', 'Second change'],
  });
});

test('returns all pull-request commit subjects across paginated results', () => {
  const github = new GitHubAPI('example', 'ios');
  github.exec = () => JSON.stringify([
    [{ commit: { message: 'First' } }],
    [{ commit: { message: 'Second\nBody' } }],
  ]);
  assert.deepEqual(github.getPullRequestCommitSubjects(42), ['First', 'Second']);
});

test('URL-encodes slash-containing branch names when resolving their head', () => {
  const github = new GitHubAPI('example', 'ios');
  let endpoint;
  github.exec = args => {
    endpoint = args[1];
    return 'abc123';
  };

  assert.equal(github.getBranchHead('feature/player'), 'abc123');
  assert.equal(endpoint, 'repos/example/ios/commits/feature%2Fplayer');
});

test('reads paginated branch comparisons for release PR maintenance', () => {
  const github = new GitHubAPI('example', 'ios');
  let args;
  github.exec = received => {
    args = received;
    return JSON.stringify([
      { status: 'ahead', commits: [{ sha: 'one', commit: { message: 'First' } }] },
      { commits: [{ sha: 'two', commit: { message: 'Second\nBody' } }] },
    ]);
  };

  assert.deepEqual(github.compareBranches('release/1', 'develop/next'), {
    status: 'ahead',
    commits: [
      { sha: 'one', message: 'First' },
      { sha: 'two', message: 'Second\nBody' },
    ],
  });
  assert.equal(args.at(-1), 'repos/example/ios/compare/release%2F1...develop%2Fnext?per_page=100');
});

test('recovers an open pull request only for the exact branch head commit', () => {
  const github = new GitHubAPI('example', 'ios');
  github.exec = () => JSON.stringify([
    { number: 49, headRefOid: 'abc123', headRefName: 'feature/player', baseRefName: 'develop' },
  ]);

  assert.deepEqual(
    github.findOpenPullRequestForCommit('abc123', 'develop', 'feature/player'),
    { number: '49', headBranch: 'feature/player', baseBranch: 'develop' },
  );
  assert.equal(
    github.findOpenPullRequestForCommit('newer456', 'develop', 'feature/player'),
    null,
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

test('uses an exact commit association when Apple omits the source branch', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([{
    number: 54,
    state: 'closed',
    closed_at: '2026-08-27T20:08:08Z',
    merged_at: '2026-08-27T20:08:08Z',
    head: { ref: 'codex/thin-xcode-cloud-ci' },
    base: { ref: 'develop' },
  }]);

  assert.deepEqual(github.findClosedPRForBuild('abc123', 'develop', null), {
    number: 54,
    headBranch: 'codex/thin-xcode-cloud-ci',
    baseBranch: 'develop',
    mergedAt: '2026-08-27T20:08:08Z',
    closedAt: '2026-08-27T20:08:08Z',
  });
});

test('keeps a source-less build when its commit association is ambiguous', () => {
  const github = new GitHubAPI('desai-deep', 'JamsOnToast');
  github.exec = () => JSON.stringify([
    { number: 53, state: 'closed', head: { ref: 'one' }, base: { ref: 'develop' } },
    { number: 54, state: 'closed', head: { ref: 'two' }, base: { ref: 'develop' } },
  ]);

  assert.equal(github.findClosedPRForBuild('abc123', 'develop', null), null);
});
