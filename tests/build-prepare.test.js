import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTestFlightNotes,
  generateTestFlightNotes,
} from '../lib/build-prepare.js';

const COMMIT = 'a'.repeat(40);
const MISSING_COMMIT = 'b'.repeat(40);

test('sizes truncated TestFlight notes using the commits remaining after each candidate', () => {
  const subjects = Array.from({ length: 11 }, (_, index) => `Commit ${index + 1}`);
  const twoLinesAndSuffix = '• Commit 1\n• Commit 2\n• … 9 more commits';
  const result = formatTestFlightNotes(subjects, twoLinesAndSuffix.length);

  assert.equal(result.text, twoLinesAndSuffix);
  assert.equal(result.omitted, 9);
});

test('falls back conservatively when the Git history mirror is unavailable', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  const payload = { repository: 'example/ios', commit: COMMIT, branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const asc = {
    appId: null,
    getAppStoreVersions: async () => ({ data: [] }),
    getPublishedWorkflowCommits: async () => [],
  };
  const github = {
    getCommitSubjectAsync: async () => 'Fallback subject',
    getPRDetailsAsync: async () => ({ title: 'Freshen controls', body: '', headRefOid: COMMIT }),
    getCommitSubjectsSince: async () => {
      throw Object.assign(new Error('fetch timed out'), { statusCode: 503 });
    },
    getPullRequestCommitSubjectsAsync: async () => ['Add playback state'],
  };

  const result = await generateTestFlightNotes({ profile, build, payload, asc, github });

  assert.match(result.text, /Add playback state/);
  assert.deepEqual(result.warnings, [
    'Git history mirror unavailable; using pull-request commits',
    'No ancestor published build found; using all pull-request commits',
  ]);
});

test('treats published build history as optional when App Store Connect is unavailable', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  let mirrorCalled = false;
  const result = await generateTestFlightNotes({
    profile,
    build,
    payload: { repository: 'example/ios', commit: COMMIT, branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' },
    asc: {
      appId: null,
      getAppStoreVersions: async () => ({ data: [] }),
      getPublishedWorkflowCommits: async () => { throw new Error('Apple history unavailable'); },
    },
    github: {
      getCommitSubject: () => 'Build commit',
      getPRDetails: () => ({ title: 'Feature', body: '', headRefOid: COMMIT }),
      getCommitSubjectsSince: () => { mirrorCalled = true; return null; },
      getPullRequestCommitSubjects: () => ['First PR commit'],
    },
  });

  assert.equal(mirrorCalled, false);
  assert.match(result.text, /First PR commit/);
  assert.deepEqual(result.warnings, [
    'Published build history unavailable; using pull-request commits',
    'No ancestor published build found; using all pull-request commits',
  ]);
});

test('ignores mutable pull-request metadata after its head is force-pushed', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  let pullRequestCommitsCalled = false;
  const result = await generateTestFlightNotes({
    profile,
    build,
    payload: { repository: 'example/ios', commit: COMMIT, branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' },
    asc: {
      appId: null,
      getAppStoreVersions: async () => ({ data: [] }),
      getPublishedWorkflowCommits: async () => [],
    },
    github: {
      getCommitSubject: () => 'Immutable old-head subject',
      getPRDetails: () => ({
        title: 'Unrelated new head',
        body: 'Instructions added after the build',
        headRefOid: MISSING_COMMIT,
      }),
      getCommitSubjectsSince: () => null,
      getPullRequestCommitSubjects: () => { pullRequestCommitsCalled = true; return ['Wrong commit']; },
    },
  });

  assert.equal(pullRequestCommitsCalled, false);
  assert.doesNotMatch(result.text, /Unrelated|Instructions|Wrong/);
  assert.match(result.text, /Immutable old-head subject/);
  assert.deepEqual(result.warnings, [
    'Pull-request head changed; ignored its current title, description, and commits',
    'No ancestor published build found; using the current commit',
  ]);
});

test('keeps the pull request description before commits for its first build', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  const payload = { repository: 'example/ios', commit: COMMIT, branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const asc = {
    appId: null,
    getAppStoreVersions: async () => ({ data: [] }),
    getPublishedWorkflowCommits: async () => [],
  };
  const github = {
    getCommitSubject: () => 'Fallback subject',
    getPRDetails: () => ({ title: 'Freshen controls', body: 'Please verify playback and lock-screen controls.', headRefOid: COMMIT }),
    getCommitSubjectsSince: () => null,
    getPullRequestCommitSubjects: () => ['Add playback state', 'Fix lock screen'],
  };

  const result = await generateTestFlightNotes({ profile, build, payload, asc, github });

  assert.equal(result.text, 'Please verify playback and lock-screen controls.\n\nCommits in this pull request:\n\n• Add playback state\n• Fix lock screen');
  assert.deepEqual(result.warnings, ['No ancestor published build found; using all pull-request commits']);
});

test('recovers pull request notes for an exact branch-fallback build', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  const payload = { repository: 'example/ios', commit: COMMIT, branch: 'feature', target_branch: 'preview', pull_request: null };
  const lookups = [];
  const github = {
    getCommitSubject: () => 'Fallback subject',
    findOpenPullRequestForCommit: (commit, base, head) => {
      lookups.push({ commit, base, head });
      return { number: 42 };
    },
    getPRDetails: number => {
      assert.equal(number, '42');
      return { title: 'Freshen controls', body: 'Verify the pinned controls.', headRefOid: COMMIT };
    },
    getCommitSubjectsSince: () => null,
    getPullRequestCommitSubjects: number => {
      assert.equal(number, '42');
      return ['Pin playback controls', 'Polish player spacing'];
    },
  };

  const result = await generateTestFlightNotes({
    profile,
    build,
    payload,
    asc: { getPublishedWorkflowCommits: async () => [] },
    github,
  });

  assert.deepEqual(lookups, [{ commit: COMMIT, base: 'preview', head: 'feature' }]);
  assert.equal(result.text, 'Verify the pinned controls.\n\nCommits in this pull request:\n\n• Pin playback controls\n• Polish player spacing');
  assert.deepEqual(result.warnings, ['No ancestor published build found; using all pull-request commits']);
});

test('beta notes use the exact release pull request without listing commits', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop', production_branch: 'main' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  const payload = { repository: 'example/ios', commit: COMMIT, branch: 'develop', current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  const lookups = [];
  const github = {
    getCommitSubject: () => 'Merge feature',
    findOpenPullRequestForCommit: (commit, base, head) => {
      lookups.push({ commit, base, head });
      return { number: 65 };
    },
    getPRDetails: () => ({
      title: 'Bug fixes and performance improvements',
      body: '## Release Notes\n- #49 Freshen playback controls UI\n\n## Automation\nManaged release PR.',
      headRefOid: COMMIT,
    }),
    findPullRequestTitleForCommit: () => {
      throw new Error('beta notes must not search arbitrary associated pull requests');
    },
  };
  const result = await generateTestFlightNotes({ profile, build, payload, asc, github });
  assert.deepEqual(lookups, [{ commit: COMMIT, base: 'main', head: 'develop' }]);
  assert.equal(result.text, '- #49 Freshen playback controls UI');
});

test('beta notes fall back to the develop commit instead of an unrelated feature pull request', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop', production_branch: 'main' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  const payload = { repository: 'example/ios', commit: COMMIT, branch: 'develop', current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  const github = {
    getCommitSubject: () => 'Merge pull request #49 from example/freshen-controls',
    findOpenPullRequestForCommit: () => null,
    findPullRequestTitleForCommit: () => {
      throw new Error('beta notes must not search feature pull requests containing the commit');
    },
  };

  const result = await generateTestFlightNotes({ profile, build, payload, asc, github });
  assert.equal(result.text, 'Merge pull request #49 from example/freshen-controls');
});

test('uses the pull request target branch when finding a title fallback', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'prod', appId: '1', workflowId: 'wf-pr', includeCommits: false };
  const payload = { repository: 'example/ios', commit: COMMIT, branch: 'feature/player', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  let titleBranch;
  const github = {
    getCommitSubject: () => 'Commit subject',
    getPRDetails: () => null,
    findPullRequestTitleForCommit: (_commit, branch) => {
      titleBranch = branch;
      return 'Improve playback';
    },
  };

  const result = await generateTestFlightNotes({ profile, build, payload, asc, github });
  assert.equal(titleBranch, 'develop');
  assert.equal(result.text, 'Improve playback');
});

test('classifies an inaccessible commit as a bad request', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  const payload = { repository: 'example/ios', commit: MISSING_COMMIT, branch: 'develop', current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  const github = { getCommitSubject: () => null };

  await assert.rejects(
    generateTestFlightNotes({ profile, build, payload, asc, github }),
    error => error.statusCode === 400 && /Commit is not accessible/.test(error.message),
  );
});
