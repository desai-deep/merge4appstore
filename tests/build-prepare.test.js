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

const COMMIT = 'a'.repeat(40);
const MISSING_COMMIT = 'b'.repeat(40);

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
  const validPayload = { repository: 'example/ios', commit: COMMIT, branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
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
  const payload = { repository: 'example/ios', workflow_id: 'wf-pr', commit: COMMIT, branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const asc = {
    appId: null,
    getAppStoreVersions: async () => ({ data: [] }),
    getPublishedWorkflowCommits: async () => [{ commitSha: 'previous', buildNumber: '101', marketingVersion: '1.4' }],
  };
  let rangeOptions;
  const github = {
    getCommitSubject: () => 'Fallback subject',
    getPRDetails: () => ({ title: 'Freshen controls', body: 'Please verify playback and lock-screen controls.', headRefOid: COMMIT }),
    findPullRequestTitleForCommit: () => null,
    getCommitSubjectsSince: async (_published, _head, options) => {
      rangeOptions = options;
      return { baseCommit: 'previous', baseBuildNumber: '101', baseMarketingVersion: '1.4', subjects: ['Add playback state', 'Fix lock screen'] };
    },
    getPullRequestCommitSubjects: () => [],
  };
  assert.deepEqual(await prepareBuild({ profile, build, payload, asc, github }), {
    schema_version: 1,
    role: 'uat',
    purpose: 'pull_request',
    marketing_version: '1.4',
    testflight_notes: 'Commits since 1.4 (101):\n\n• Add playback state\n• Fix lock screen\n\nPlease verify playback and lock-screen controls.',
    warnings: [],
  });
  assert.equal(asc.appId, '1');
  assert.equal(rangeOptions.branch, 'feature');
  assert.ok(rangeOptions.signal instanceof AbortSignal);
  assert.equal(rangeOptions.signal.aborted, false);
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

  const result = await prepareBuild({ profile, build, payload, asc, github });

  assert.match(result.testflight_notes, /Add playback state/);
  assert.deepEqual(result.warnings, [
    'Git history mirror unavailable; using pull-request commits',
    'No ancestor published build found; using all pull-request commits',
  ]);
});

test('treats published build history as optional when App Store Connect is unavailable', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  let mirrorCalled = false;
  const result = await prepareBuild({
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
  assert.match(result.testflight_notes, /First PR commit/);
  assert.deepEqual(result.warnings, [
    'Published build history unavailable; using pull-request commits',
    'No ancestor published build found; using all pull-request commits',
  ]);
});

test('ignores mutable pull-request metadata after its head is force-pushed', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr', includeCommits: true };
  let pullRequestCommitsCalled = false;
  const result = await prepareBuild({
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
  assert.doesNotMatch(result.testflight_notes, /Unrelated|Instructions|Wrong/);
  assert.match(result.testflight_notes, /Immutable old-head subject/);
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

  const result = await prepareBuild({ profile, build, payload, asc, github });

  assert.equal(result.testflight_notes, 'Please verify playback and lock-screen controls.\n\nCommits in this pull request:\n\n• Add playback state\n• Fix lock screen');
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
  const result = await prepareBuild({ profile, build, payload, asc, github });
  assert.deepEqual(lookups, [{ commit: COMMIT, base: 'main', head: 'develop' }]);
  assert.equal(result.testflight_notes, '- #49 Freshen playback controls UI');
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

  const result = await prepareBuild({ profile, build, payload, asc, github });
  assert.equal(result.testflight_notes, 'Merge pull request #49 from example/freshen-controls');
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

  const result = await prepareBuild({ profile, build, payload, asc, github });
  assert.equal(titleBranch, 'develop');
  assert.equal(result.testflight_notes, 'Improve playback');
});

test('classifies an inaccessible commit as a bad request', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  const payload = { repository: 'example/ios', commit: MISSING_COMMIT, branch: 'develop', current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  const github = { getCommitSubject: () => null };

  await assert.rejects(
    prepareBuild({ profile, build, payload, asc, github }),
    error => error.statusCode === 400 && /Commit is not accessible/.test(error.message),
  );
});

test('rejects mutable refs before asking GitHub to resolve them', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  let githubCalled = false;
  await assert.rejects(
    prepareBuild({
      profile,
      build,
      payload: { repository: 'example/ios', commit: 'main', branch: 'develop', current_marketing_version: '1.4' },
      asc: {},
      github: { getCommitSubject: () => { githubCalled = true; return 'Mutable branch'; } },
    }),
    error => error.statusCode === 400 && /full Git object ID/.test(error.message),
  );
  assert.equal(githubCalled, false);
});

test('loads App Store versions and release notes concurrently', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'beta', appRole: 'prod', appId: '1', workflowId: 'wf-beta', includeCommits: false };
  let versionsStarted = false;
  let notesStarted = false;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const preparing = prepareBuild({
    profile,
    build,
    payload: { repository: 'example/ios', commit: COMMIT, branch: 'develop', current_marketing_version: '1.4' },
    asc: {
      appId: null,
      getAppStoreVersions: async () => { versionsStarted = true; await blocked; return { data: [] }; },
    },
    github: {
      getCommitSubject: async () => { notesStarted = true; await blocked; return 'Release commit'; },
      findOpenPullRequestForCommit: () => null,
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(versionsStarted, true);
  assert.equal(notesStarted, true);
  release();
  assert.equal((await preparing).testflight_notes, 'Release commit');
});
