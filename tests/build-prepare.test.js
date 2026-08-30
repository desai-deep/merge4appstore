import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareVersions,
  formatTestFlightNotes,
  inferBuildPurpose,
  nextMinorVersion,
  prepareBuild,
  selectMarketingVersion,
} from '../lib/build-prepare.js';

test('compares two- and three-part marketing versions', () => {
  assert.equal(compareVersions('1.4', '1.4.0'), 0);
  assert.equal(compareVersions('1.5', '1.4.9'), 1);
  assert.equal(nextMinorVersion('1.4'), '1.5');
  assert.equal(nextMinorVersion('1.4.2'), '1.5.0');
});

test('production compares with live versions while beta includes active versions', () => {
  const versions = { data: [
    { attributes: { versionString: '1.3', appStoreState: 'READY_FOR_SALE' } },
    { attributes: { versionString: '1.4', appStoreState: 'PREPARE_FOR_SUBMISSION' } },
  ] };
  assert.equal(selectMarketingVersion('1.4', versions, 'production'), '1.4');
  assert.equal(selectMarketingVersion('1.4', versions, 'beta'), '1.5');
});

test('infers build purpose from repository profile branches and pull-request context', () => {
  const profile = { repository: { beta_branch: 'develop', production_branch: 'main' } };
  assert.equal(inferBuildPurpose(profile, { pull_request: 42, branch: 'feature' }), 'pull_request');
  assert.equal(inferBuildPurpose(profile, { branch: 'develop' }), 'beta');
  assert.equal(inferBuildPurpose(profile, { branch: 'main' }), 'production');
  assert.equal(inferBuildPurpose(profile, { purpose: 'beta', branch: 'custom' }), 'beta');
  assert.throws(() => inferBuildPurpose(profile, { branch: 'feature' }), /Cannot infer build purpose/);
});

test('rejects an unsupported client-supplied build purpose as a bad request', () => {
  const profile = { repository: { beta_branch: 'develop', production_branch: 'main' } };
  assert.throws(
    () => inferBuildPurpose(profile, { purpose: 'nightly' }),
    error => error.statusCode === 400 && /Unsupported build purpose/.test(error.message),
  );
});

test('classifies prepare payload validation failures as bad requests', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop', production_branch: 'main' } };
  const validPayload = { repository: 'example/ios', commit: 'abc', branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const pullRequestBuild = { purpose: 'pull_request', appRole: 'prod', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  const cases = [
    [{ ...pullRequestBuild }, { ...validPayload, repository: 'wrong/ios' }, /Repository does not match profile/],
    [{ ...pullRequestBuild }, { ...validPayload, workflow_id: 'wrong' }, /Workflow does not match build purpose/],
    [{ ...pullRequestBuild }, { ...validPayload, commit: '' }, /Commit is required/],
    [{ ...pullRequestBuild }, { ...validPayload, current_marketing_version: 'version one' }, /Invalid marketing version/],
    [{ ...pullRequestBuild }, { ...validPayload, target_branch: 'main' }, /Pull-request builds must target develop/],
    [{ ...pullRequestBuild, purpose: 'beta' }, { ...validPayload, pull_request: null, branch: 'feature' }, /Beta builds must use develop/],
    [{ ...pullRequestBuild, purpose: 'production' }, { ...validPayload, pull_request: null, branch: 'develop' }, /Production builds must use main/],
  ];

  for (const [build, payload, message] of cases) {
    await assert.rejects(
      prepareBuild({ profile, build, payload, asc: {}, github: {} }),
      error => error.statusCode === 400 && message.test(error.message),
    );
  }
});

test('sizes truncated TestFlight notes using the commits remaining after each candidate', () => {
  const subjects = Array.from({ length: 11 }, (_, index) => `Commit ${index + 1}`);
  const twoLinesAndSuffix = '• Commit 1\n• Commit 2\n• … 9 more commits';
  const result = formatTestFlightNotes(subjects, twoLinesAndSuffix.length);

  assert.equal(result.text, twoLinesAndSuffix);
  assert.equal(result.omitted, 9);
});

test('prepares version and notes without exposing provider credentials to the app repo', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  const payload = { repository: 'example/ios', workflow_id: 'wf-pr', commit: 'abc', branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const asc = {
    appId: null,
    getAppStoreVersions: async () => ({ data: [] }),
    getPublishedWorkflowCommits: async () => [{ commitSha: 'previous' }],
  };
  const github = {
    getCommitSubject: () => 'Fallback subject',
    getPRDetails: () => ({ title: 'Freshen controls', body: 'Please verify playback and lock-screen controls.' }),
    findPullRequestTitleForCommit: () => null,
    getCommitSubjectsSince: () => ({ baseCommit: 'previous', subjects: ['Add playback state', 'Fix lock screen'] }),
    getPullRequestCommitSubjects: () => [],
  };
  assert.deepEqual(await prepareBuild({ profile, build, payload, asc, github }), {
    schema_version: 1,
    role: 'uat',
    purpose: 'pull_request',
    marketing_version: '1.4',
    testflight_notes: 'Commits since the last published build:\n\n• Add playback state\n• Fix lock screen\n\nPlease verify playback and lock-screen controls.',
    warnings: [],
  });
  assert.equal(asc.appId, '1');
});

test('keeps the pull request description before commits for its first build', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  const payload = { repository: 'example/ios', commit: 'abc', branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const asc = {
    appId: null,
    getAppStoreVersions: async () => ({ data: [] }),
    getPublishedWorkflowCommits: async () => [],
  };
  const github = {
    getCommitSubject: () => 'Fallback subject',
    getPRDetails: () => ({ title: 'Freshen controls', body: 'Please verify playback and lock-screen controls.' }),
    getCommitSubjectsSince: () => null,
    getPullRequestCommitSubjects: () => ['Add playback state', 'Fix lock screen'],
  };

  const result = await prepareBuild({ profile, build, payload, asc, github });

  assert.equal(result.testflight_notes, 'Please verify playback and lock-screen controls.\n\nCommits since the last published build:\n\n• Add playback state\n• Fix lock screen');
  assert.deepEqual(result.warnings, ['No ancestor published build found; using all pull-request commits']);
});

test('beta notes default to a summary without listing commits', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  const payload = { repository: 'example/ios', commit: 'abc', branch: 'develop', current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  const github = {
    getCommitSubject: () => 'Merge feature',
    findPullRequestTitleForCommit: () => 'Improve playback',
  };
  const result = await prepareBuild({ profile, build, payload, asc, github });
  assert.equal(result.testflight_notes, 'Improve playback');
});

test('uses the pull request target branch when finding a title fallback', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'prod', appId: '1', workflowId: 'wf-pr', includeCommits: false };
  const payload = { repository: 'example/ios', commit: 'abc', branch: 'feature/player', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
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

  const result = await prepareBuild({ profile, build, payload, asc, github });
  assert.equal(titleBranch, 'develop');
  assert.equal(result.testflight_notes, 'Improve playback');
});

test('classifies an inaccessible commit as a bad request', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  const payload = { repository: 'example/ios', commit: 'missing', branch: 'develop', current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  const github = { getCommitSubject: () => null };

  await assert.rejects(
    prepareBuild({ profile, build, payload, asc, github }),
    error => error.statusCode === 400 && /Commit is not accessible/.test(error.message),
  );
});
