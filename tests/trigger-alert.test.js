import test from 'node:test';
import assert from 'node:assert/strict';
import { reportTriggerAlert as report } from '../lib/trigger-alert.js';
import { runManagedBuildTrigger as trigger } from '../lib/trigger.js';

import { MemoryBuildStatusStore } from '../lib/build-status.js';

const stores = new WeakMap();
function storeFor(github) {
  if (!stores.has(github)) stores.set(github, new MemoryBuildStatusStore());
  return stores.get(github);
}
const reportTriggerAlert = (github, source, outcome) => report(github, source, outcome, storeFor(github));
const runManagedBuildTrigger = (provider, github, source, dryRun = false) => trigger(provider, github, source, dryRun, { alertStore: storeFor(github) });

const intent = { purpose: 'pull_request', workflowId: 'uat', branch: 'feature/festival', commitSha: 'abc123', pullRequest: '172' };
const agreementError = () => Object.assign(new Error('API Error 403: A required agreement is missing or has expired.'), { statusCode: 403, retryAfter: 5, beforeBuildStart: true });

function fixture() {
  const calls = [];
  const github = {
    repo: 'owner/ios',
    getPullRequestHead: () => intent.commitSha,
    getBranchHead: () => intent.commitSha,
    repositoryIssuesEnabled: () => true,
    upsertPRComment: (...args) => { calls.push(['comment', ...args]); return 'updated'; },
    upsertIssue: (...args) => { calls.push(['issue', ...args]); return { number: 1 }; },
    closeIssueByMarker: (...args) => { calls.push(['close', ...args]); return null; },
  };
  return { github, calls };
}

test('provider rejection comments on the PR and preserves the exact retryable error', async () => {
  const { github, calls } = fixture();
  const error = agreementError();
  await assert.rejects(runManagedBuildTrigger({ name: 'xcode_cloud', trigger: async () => { throw error; } }, github, intent), e => e === error && e.retryAfter === 5 && e.beforeBuildStart);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'comment');
  assert.equal(calls[0][1], '172');
  assert.match(calls[0][3], /Account Holder/);
  assert.match(calls[0][3], /abc123/);
  assert.deepEqual(calls[0][4], { create: true, ownedOnly: true });
});

test('retries update the same alert; different PRs and workflows have distinct markers', async () => {
  const { github, calls } = fixture();
  for (const source of [intent, { ...intent, commitSha: 'new-head' }, { ...intent, pullRequest: '173' }, { ...intent, workflowId: 'beta' }]) {
    await reportTriggerAlert(github, source, { error: agreementError() });
  }
  assert.equal(calls[0][2], calls[1][2]);
  assert.notEqual(calls[0][2], calls[2][2]);
  assert.notEqual(calls[0][2], calls[3][2]);
});

test('started and existing runs recover an existing comment without creating success chatter', async () => {
  for (const action of ['started', 'existing']) {
    const { github, calls } = fixture();
    await reportTriggerAlert(github, intent, { error: agreementError() });
    calls.length = 0;
    const result = { action, runId: 'run-1', executionProgress: 'COMPLETE', completionStatus: 'FAILED' };
    assert.equal(await runManagedBuildTrigger({ name: 'xcode_cloud', trigger: async () => result }, github, intent), result);
    assert.deepEqual(calls[0][4], { create: false, ownedOnly: true });
    assert.match(calls[0][3], /Build trigger recovered/);
    assert.match(calls[0][3], /may have failed/);
    assert.match(calls[0][3], /run-1/);
  }
});

test('ambiguous waiting results, superseded sources and dry runs do not resolve alerts', async () => {
  const { github, calls } = fixture();
  const provider = { name: 'xcode_cloud', trigger: async () => ({ action: 'waiting', runId: 'unknown' }) };
  await runManagedBuildTrigger(provider, github, intent);
  await runManagedBuildTrigger(provider, github, { ...intent, commitSha: 'stale' });
  provider.trigger = async () => { throw agreementError(); };
  await assert.rejects(runManagedBuildTrigger(provider, github, intent, true));
  provider.trigger = async () => ({ action: 'started', runId: 'run-2' });
  await runManagedBuildTrigger(provider, github, intent, true);
  assert.deepEqual(calls, []);
});

test('branch builds upsert and close a source-specific issue', async () => {
  const { github, calls } = fixture();
  const source = { ...intent, purpose: 'production', pullRequest: null, branch: 'main' };
  await reportTriggerAlert(github, source, { error: agreementError() });
  await reportTriggerAlert(github, source, { result: { action: 'started', runId: 'run-1' } });
  await reportTriggerAlert(github, { ...source, branch: 'release' }, { error: agreementError() });
  assert.equal(calls[0][0], 'issue');
  assert.equal(calls[1][0], 'close');
  assert.equal(calls[0][1], calls[1][1]);
  assert.notEqual(calls[0][1], calls[2][1]);
});

test('disabled issues do not prevent trigger retries', async () => {
  const { github, calls } = fixture();
  github.repositoryIssuesEnabled = () => false;
  await reportTriggerAlert(github, { ...intent, pullRequest: null }, { error: agreementError() });
  assert.deepEqual(calls, []);
});

test('GitHub publication failures preserve provider errors and successful trigger results', async () => {
  for (const failure of [() => false, () => { throw new Error('GitHub unavailable'); }]) {
    const { github } = fixture();
    github.upsertPRComment = failure;
    const error = agreementError();
    const provider = { name: 'xcode_cloud', trigger: async () => { throw error; } };
    await assert.rejects(runManagedBuildTrigger(provider, github, intent), e => e === error);
    const result = { action: 'started', runId: 'run-1' };
    provider.trigger = async () => result;
    assert.equal(await runManagedBuildTrigger(provider, github, intent), result);
  }
});

test('public diagnosis omits raw provider text, credentials, mentions and markup', async () => {
  const { github, calls } = fixture();
  await reportTriggerAlert(github, intent, { error: Object.assign(new Error('token=secret @everyone <script>'), { statusCode: 401 }) });
  assert.match(calls[0][3], /HTTP 401/);
  assert.doesNotMatch(calls[0][3], /secret|@everyone|<script>/);
});

test('routine success performs no GitHub alert lookup without a recorded blocker', async () => {
  const { github, calls } = fixture();
  for (const source of [intent, { ...intent, pullRequest: null }]) {
    await runManagedBuildTrigger({ name: 'xcode_cloud', trigger: async () => ({ action: 'started', runId: 'run-1' }) }, github, source);
  }
  assert.deepEqual(calls, []);
});

test('branch recovery uses the persisted issue number and skips subsequent successes', async () => {
  const { github, calls } = fixture();
  const source = { ...intent, pullRequest: null };
  await reportTriggerAlert(github, source, { error: agreementError() });
  await reportTriggerAlert(github, source, { error: agreementError() });
  await reportTriggerAlert(github, source, { result: { action: 'existing', runId: 'run-1' } });
  await reportTriggerAlert(github, source, { result: { action: 'existing', runId: 'run-1' } });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1][4], { ownedOnly: true, issueNumber: 1 });
  assert.deepEqual(calls[2][3], { ownedOnly: true, issueNumber: 1 });
});

test('an unavailable alert store cannot replace a provider outcome', async () => {
  const { github } = fixture();
  const alertStore = { withLock: async () => { throw new Error('Disk unavailable'); } };
  const error = agreementError();
  await assert.rejects(trigger({ name: 'xcode_cloud', trigger: async () => { throw error; } }, github, intent, false, { alertStore }), e => e === error);
  const result = { action: 'started', runId: 'run-1' };
  assert.equal(await trigger({ name: 'xcode_cloud', trigger: async () => result }, github, intent, false, { alertStore }), result);
});

test('alert recovery retains its issue reference across process/store restarts', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { FileBuildStatusStore } = await import('../lib/build-status.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'trigger-alert-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { ...intent, pullRequest: null };
  const { github, calls } = fixture();
  await report(github, source, { error: agreementError() }, new FileBuildStatusStore({ stateDirectory: directory }));
  await report(github, source, { result: { action: 'existing', runId: 'run-1' } }, new FileBuildStatusStore({ stateDirectory: directory }));
  assert.equal(calls[1][0], 'close');
  assert.deepEqual(calls[1][3], { ownedOnly: true, issueNumber: 1 });
  await report(github, source, { result: { action: 'existing', runId: 'run-1' } }, new FileBuildStatusStore({ stateDirectory: directory }));
  assert.equal(calls.length, 2);
});
