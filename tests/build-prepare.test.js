import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, nextMinorVersion, prepareBuild, selectMarketingVersion } from '../lib/build-prepare.js';

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

test('prepares version and notes without exposing provider credentials to the app repo', async () => {
  const profile = { repository: { owner: 'example', name: 'ios', beta_branch: 'develop' } };
  const build = { purpose: 'pull_request', appRole: 'uat', appId: '1', workflowId: 'wf-pr' };
  const payload = { repository: 'example/ios', workflow_id: 'wf-pr', commit: 'abc', branch: 'feature', target_branch: 'develop', pull_request: 42, current_marketing_version: '1.4' };
  const asc = { appId: null, getAppStoreVersions: async () => ({ data: [] }) };
  const github = {
    getCommitSubject: () => 'Fallback subject',
    getPRDetails: () => ({ title: 'Freshen controls' }),
    findPullRequestTitleForCommit: () => null,
  };
  assert.deepEqual(await prepareBuild({ profile, build, payload, asc, github }), {
    role: 'uat', purpose: 'pull_request', marketing_version: '1.4', testflight_notes: 'Freshen controls', warnings: [],
  });
  assert.equal(asc.appId, '1');
});
