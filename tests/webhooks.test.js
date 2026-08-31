import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { MemoryDeliveryStore } from '../lib/delivery-store.js';
import { MemoryVersionStateStore } from '../lib/version-state.js';
import {
  jobsForGitHubEvent,
  jobsForXcodeCloudEvent,
  verifyGitHubSignature,
  webhookSettings,
} from '../lib/webhooks.js';
import {
  createJobRunner,
  createSerialDispatcher,
  createVersionRequest,
  createWebhookServer,
  inspectDeploymentTransactions,
  loadProfiles,
  runJob,
  singleHeader,
  webhookDeliveryKey,
} from '../webhook-server.js';

const profile = {
  instance: 'example-ios',
  repository: { owner: 'example', name: 'ios', beta_branch: 'develop', production_branch: 'main' },
  versioning: { initial_version: '1.1' },
  apps: { prod: { app_id: '1', bundle_id: 'com.example', name: 'Example', workflows: { pr: 'wf-pr', beta: 'wf-beta', production: 'wf-prod' } } },
  build: {
    trigger_mode: 'managed',
    purposes: { pull_request: { workflow: 'pr' }, beta: { workflow: 'beta' }, production: { workflow: 'production' } },
  },
};
const COMMIT_SHA = 'a'.repeat(40);

function createTestWebhookServer(options) {
  const server = createWebhookServer({
    deliveryStore: new MemoryDeliveryStore(),
    version: createVersionRequest({ store: new MemoryVersionStateStore() }),
    ...options,
  });
  const close = server.close.bind(server);
  server.close = (...args) => {
    server.stopBackgroundRecovery();
    return close(...args);
  };
  return server;
}

test('validates GitHub HMAC signatures against the raw body', () => {
  const body = Buffer.from('{"zen":"hooks"}');
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(verifyGitHubSignature(body, signature, 'secret'), true);
  assert.equal(verifyGitHubSignature(body, signature, 'wrong'), false);
  assert.equal(verifyGitHubSignature(body, [signature, signature], 'secret'), false);
});

test('accepts only one security-sensitive HTTP header value', () => {
  assert.equal(singleHeader('one'), 'one');
  assert.equal(singleHeader(['one', 'two']), '');
  assert.equal(singleHeader(undefined), '');
});

test('namespaces webhook delivery deduplication by profile instance', () => {
  assert.notEqual(
    webhookDeliveryKey('xcode', 'one', 'same-payload'),
    webhookDeliveryKey('xcode', 'two', 'same-payload'),
  );
  assert.notEqual(
    webhookDeliveryKey('github', 'one', 'same-delivery'),
    webhookDeliveryKey('github', 'two', 'same-delivery'),
  );
});

test('defaults to deployed shared webhook secrets and a profile-scoped version token', () => {
  const profileWithoutOverrides = { ...profile, webhooks: undefined, ci: undefined };
  const settings = webhookSettings(profileWithoutOverrides, {
    GH_WEBHOOK_SECRET: 'github',
    XCODE_CLOUD_WEBHOOK_TOKEN: 'xcode',
    MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS: 'build',
  });

  assert.equal(settings.githubSecret, 'github');
  assert.equal(settings.xcodeToken, 'xcode');
  assert.equal(settings.versionToken, 'build');
});

test('maps pull request lifecycle events to trigger and expiry jobs', () => {
  const pull_request = { number: 42, base: { ref: 'develop' }, head: { ref: 'feature', sha: 'abc123' } };
  const repository = { full_name: 'example/ios' };
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', { action: 'opened', pull_request, repository }, 'one'), [{
    mode: 'trigger', purpose: 'pull_request', commitSha: 'abc123', branch: 'feature', pullRequest: '42', deliveryId: 'one',
  }]);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', { action: 'closed', pull_request, repository }, 'two'), [{ mode: 'expire', deliveryId: 'two' }]);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { body: { from: 'Old notes' } },
  }, 'three'), [{
    mode: 'notes', purpose: 'pull_request', commitSha: 'abc123', branch: 'feature', pullRequest: '42', deliveryId: 'three',
  }]);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { title: { from: 'Old title' } },
  }, 'four'), []);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { base: { ref: { from: 'main' } } },
  }, 'five'), [{
    mode: 'trigger', purpose: 'pull_request', commitSha: 'abc123', branch: 'feature', pullRequest: '42', deliveryId: 'five',
  }]);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'synchronize', pull_request, repository,
  }, 'six'), [{
    mode: 'trigger', purpose: 'pull_request', commitSha: 'abc123', branch: 'feature', pullRequest: '42', deliveryId: 'six',
  }]);
});

test('refreshes beta build notes when an automated release pull request body changes', () => {
  const pull_request = {
    number: 65,
    base: { ref: 'main' },
    head: { ref: 'develop', sha: 'release123' },
  };
  const repository = { full_name: 'example/ios' };
  const releaseProfile = { ...profile, release_pull_request: true };

  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { body: { from: 'Old release notes' } },
  }, 'release-edit'), [{
    mode: 'notes', purpose: 'beta', commitSha: 'release123', branch: 'develop', pullRequest: '65', deliveryId: 'release-edit',
  }]);

  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { body: { from: 'Old release notes' } },
  }, 'disabled-release-edit'), []);
});

test('evaluates base changes against the configured release track', () => {
  const pull_request = {
    number: 65,
    base: { ref: 'main' },
    head: { ref: 'develop', sha: 'release123' },
  };
  const repository = { full_name: 'example/ios' };
  const releaseProfile = { ...profile, release_pull_request: true };

  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { base: { ref: { from: 'develop' } } },
  }, 'release-base-edit'), [{
    mode: 'trigger', purpose: 'beta', commitSha: 'release123', branch: 'develop', deliveryId: 'release-base-edit',
  }]);
});

test('maps beta and production pushes to their managed build purposes', () => {
  const repository = { full_name: 'example/ios' };
  assert.deepEqual(jobsForGitHubEvent(profile, 'push', {
    ref: 'refs/heads/develop', after: 'abc', repository,
  }, 'one'), [
    { mode: 'trigger', purpose: 'beta', commitSha: 'abc', branch: 'develop', deliveryId: 'one' },
  ]);
  assert.equal(jobsForGitHubEvent(profile, 'push', { ref: 'refs/heads/main', after: 'def', repository }, 'two')[0].purpose, 'production');
  assert.deepEqual(jobsForGitHubEvent(profile, 'push', { ref: 'refs/heads/feature', after: 'ghi', repository }, 'three'), []);
});

test('does not enqueue API build starts for provider-native trigger purposes', () => {
  const nativeProfile = {
    ...profile,
    build: { ...profile.build, trigger_mode: 'native' },
  };
  const repository = { full_name: 'example/ios' };
  const pull_request = {
    number: 42,
    base: { ref: 'develop' },
    head: { ref: 'feature', sha: 'abc123' },
  };

  assert.deepEqual(jobsForGitHubEvent(nativeProfile, 'pull_request', {
    action: 'opened', pull_request, repository,
  }, 'native-pr'), []);
  assert.deepEqual(jobsForGitHubEvent(nativeProfile, 'push', {
    ref: 'refs/heads/develop', after: 'abc', repository,
  }, 'native-push'), []);
});

test('enqueues only dry-run build observations for shadow trigger purposes', () => {
  const shadowProfile = {
    ...profile,
    build: { ...profile.build, trigger_mode: 'shadow' },
  };
  const repository = { full_name: 'example/ios' };

  assert.deepEqual(jobsForGitHubEvent(shadowProfile, 'push', {
    ref: 'refs/heads/main', after: 'def', repository,
  }, 'shadow-push'), [{
    mode: 'trigger',
    purpose: 'production',
    commitSha: 'def',
    branch: 'main',
    deliveryId: 'shadow-push',
    dryRun: true,
  }]);
});

test('allows profiles to enable automatic pull request rebasing', () => {
  const enabledProfile = { ...profile, auto_rebase_pull_requests: true };
  const repository = { full_name: 'example/ios' };
  assert.deepEqual(jobsForGitHubEvent(enabledProfile, 'push', {
    ref: 'refs/heads/develop', after: 'abc', repository,
  }, 'one'), [
    { mode: 'rebase-prs', deliveryId: 'one' },
    { mode: 'trigger', purpose: 'beta', commitSha: 'abc', branch: 'develop', deliveryId: 'one' },
  ]);
});

test('reconciles a configured release PR on beta and production pushes', () => {
  const releaseProfile = {
    ...profile,
    release_pull_request: true,
    auto_rebase_pull_requests: true,
  };
  const repository = { full_name: 'example/ios' };
  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'push', {
    ref: 'refs/heads/develop', after: 'abc', repository,
  }, 'beta-push'), [
    { mode: 'rebase-prs', deliveryId: 'beta-push' },
    { mode: 'release-pr', deliveryId: 'beta-push' },
    { mode: 'trigger', purpose: 'beta', commitSha: 'abc', branch: 'develop', deliveryId: 'beta-push' },
  ]);
  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'push', {
    ref: 'refs/heads/main', after: 'def', repository,
  }, 'production-push'), [
    { mode: 'release-pr', deliveryId: 'production-push' },
    { mode: 'trigger', purpose: 'production', commitSha: 'def', branch: 'main', deliveryId: 'production-push' },
  ]);
});

test('deploys metadata-only production pushes without starting a new build', () => {
  const metadataProfile = { ...profile, metadata: { path: 'AppStore' } };
  const repository = { full_name: 'example/ios' };
  const basePayload = {
    ref: 'refs/heads/main', after: 'def', repository, size: 1,
    commits: [{ added: [], modified: ['AppStore/en-US/description.txt', 'AppStore/en-US/screenshots/APP_IPHONE_69/01.png'], removed: [] }],
  };

  assert.deepEqual(jobsForGitHubEvent(metadataProfile, 'push', basePayload, 'metadata'), [
    { mode: 'deploy', reconcileMetadata: true, deliveryId: 'metadata' },
  ]);
  assert.equal(jobsForGitHubEvent(metadataProfile, 'push', {
    ...basePayload,
    commits: [{ added: [], modified: ['AppStore/en-US/description.txt', 'Sources/App.swift'], removed: [] }],
  }, 'mixed')[0].purpose, 'production');
  assert.equal(jobsForGitHubEvent(metadataProfile, 'push', {
    ...basePayload, size: 2,
  }, 'truncated')[0].purpose, 'production');
  assert.equal(jobsForGitHubEvent({ ...profile, metadata: { path: 'metadata.json' } }, 'push', {
    ...basePayload,
    commits: [{ added: [], modified: ['metadata.json'], removed: [] }],
  }, 'file-path')[0].purpose, 'production');
});

test('settles a webhook job when its child process cannot start', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const result = runJob(
    { profile, profilePath: '/tmp/example.yml' },
    { mode: 'trigger', purpose: 'pull_request' },
    () => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    },
  );

  assert.equal(await result, 1);
});

test('keeps a child terminated by a signal retryable', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const result = runJob(
    { profile, profilePath: '/tmp/example.yml' },
    { mode: 'trigger', purpose: 'pull_request' },
    () => {
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return child;
    },
  );

  assert.equal(await result, 1);
});

test('forced shutdown terminates the complete webhook job process tree', async t => {
  if (process.platform === 'win32') {
    t.skip('Unix process-group regression');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-job-tree-'));
  const marker = path.join(directory, 'grandchild-survived');
  const ready = path.join(directory, 'ready');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'job-process-tree.js');
  const runner = createJobRunner({
    termTimeoutMs: 50,
    killTimeoutMs: 500,
    spawnProcess: (_executable, _args, options) => spawn(
      process.execPath,
      [fixture, marker, ready],
      options,
    ),
  });

  const result = runner(
    { profile, profilePath: '/tmp/example.yml' },
    { mode: 'trigger', purpose: 'production' },
  );
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(ready), true);
  assert.equal(runner.activeChildren, 1);

  await runner.terminateChildren();
  assert.equal(await result, 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(runner.activeChildren, 0);
});

test('forced shutdown kills descendants after their process-group leader exits', async t => {
  if (process.platform === 'win32') {
    t.skip('Unix process-group regression');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-orphan-tree-'));
  const marker = path.join(directory, 'grandchild-survived');
  const ready = path.join(directory, 'ready');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'job-process-tree.js');
  const runner = createJobRunner({
    termTimeoutMs: 50,
    killTimeoutMs: 500,
    spawnProcess: (_executable, _args, options) => spawn(
      process.execPath,
      [fixture, marker, ready, 'leader-exits-on-term'],
      options,
    ),
  });

  const result = runner(
    { profile, profilePath: '/tmp/example.yml' },
    { mode: 'trigger', purpose: 'production' },
  );
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(ready), true);
  await runner.terminateChildren();
  assert.equal(await result, 143);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(runner.activeChildren, 0);
});

test('execution deadline terminates a stalled webhook job process tree', async t => {
  if (process.platform === 'win32') {
    t.skip('Unix process-group regression');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-timeout-tree-'));
  const marker = path.join(directory, 'grandchild-survived');
  const ready = path.join(directory, 'ready');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'job-process-tree.js');
  const runner = createJobRunner({
    jobTimeoutMs: 50,
    termTimeoutMs: 50,
    killTimeoutMs: 500,
    spawnProcess: (_executable, _args, options) => spawn(
      process.execPath,
      [fixture, marker, ready],
      options,
    ),
  });

  const result = await runner(
    { profile, profilePath: '/tmp/example.yml' },
    { mode: 'trigger', purpose: 'production' },
  );
  assert.equal(result, 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(runner.activeChildren, 0);
});

test('does not complete a durable delivery whose child is interrupted', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const deliveryStore = new MemoryDeliveryStore();
  const dispatch = (entry, job) => runJob(entry, job, () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return child;
  });
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    recoveryIntervalMs: 60_000,
    retryDelayMs: 60_000,
    dispatch,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/webhooks/xcode-cloud/example-ios/xcode-secret`,
    {
      method: 'POST',
      body: JSON.stringify({
        metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
        ciWorkflow: { id: 'wf-prod' },
        ciBuildRun: {
          id: 'interrupted-build',
          attributes: { completionStatus: 'FAILED' },
        },
      }),
    },
  );
  assert.equal(response.status, 202);
  await server.waitForBackground();
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 1, failed: 0, corrupt: 0 });
});

test('passes metadata reconciliation intent only to its deploy process', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let environment;
  const result = runJob(
    { profile, profilePath: '/tmp/example.yml' },
    { mode: 'deploy', reconcileMetadata: true },
    (_executable, _args, options) => {
      environment = options.env;
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  );

  assert.equal(await result, 0);
  assert.equal(environment.RECONCILE_METADATA, 'true');
});

test('forces a shadow trigger child into dry-run mode', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let environment;
  const result = runJob(
    { profile, profilePath: '/tmp/example.yml' },
    { mode: 'trigger', purpose: 'production', dryRun: true },
    (_executable, _args, options) => {
      environment = options.env;
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  );

  assert.equal(await result, 0);
  assert.equal(environment.DRY_RUN, 'true');
});

test('passes Xcode completion status fields to the notification process', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let environment;
  const result = runJob(
    { profile, profilePath: '/tmp/example.yml' },
    {
      mode: 'build-status',
      purpose: 'production',
      buildStatus: 'FAILED',
      workflowId: 'workflow-production',
      runId: 'run-42',
      buildNumber: 42,
      commitSha: COMMIT_SHA,
      completedAt: '2026-08-31T10:00:00Z',
    },
    (_executable, _args, options) => {
      environment = options.env;
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  );

  assert.equal(await result, 0);
  assert.equal(environment.BUILD_STATUS, 'FAILED');
  assert.equal(environment.BUILD_PURPOSE, 'production');
  assert.equal(environment.BUILD_WORKFLOW_ID, 'workflow-production');
  assert.equal(environment.BUILD_RUN_ID, 'run-42');
  assert.equal(environment.BUILD_NUMBER, '42');
  assert.equal(environment.BUILD_COMMIT_SHA, COMMIT_SHA);
  assert.equal(environment.BUILD_COMPLETED_AT, '2026-08-31T10:00:00Z');
});

test('serializes simultaneous webhook jobs for one repository', async () => {
  const events = [];
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const dispatch = createSerialDispatcher(async (_entry, job) => {
    events.push(`start:${job.mode}`);
    if (job.mode === 'expire') await firstBlocked;
    events.push(`end:${job.mode}`);
  });
  const entry = { profile, profilePath: '/tmp/example.yml' };

  const first = dispatch(entry, { mode: 'expire' });
  await new Promise(resolve => setImmediate(resolve));
  const second = dispatch(entry, { mode: 'trigger' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:expire']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    'start:expire',
    'end:expire',
    'start:trigger',
    'end:trigger',
  ]);
});

test('publishes notes for every successful build and deploys only production', () => {
  const payload = {
    metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
    ciWorkflow: { id: 'wf-prod' },
    ciBuildRun: {
      id: 'build-1',
      attributes: { completionStatus: 'SUCCEEDED', finishedDate: '2026-08-31T10:00:00Z' },
    },
  };
  assert.deepEqual(jobsForXcodeCloudEvent(profile, payload), [{
    mode: 'build-status',
    purpose: 'production',
    buildStatus: 'SUCCEEDED',
    workflowId: 'wf-prod',
    runId: 'build-1',
    buildNumber: null,
    commitSha: null,
    completedAt: '2026-08-31T10:00:00Z',
    deliveryId: 'build-1',
  }, {
    mode: 'notes',
    purpose: 'production',
    runId: 'build-1',
    commitSha: null,
    deliveryId: 'build-1',
  }, { mode: 'deploy', deliveryId: 'build-1' }]);
  payload.ciBuildRun.attributes.completionStatus = 'FAILED';
  assert.deepEqual(jobsForXcodeCloudEvent(profile, payload), [{
    mode: 'build-status',
    purpose: 'production',
    buildStatus: 'FAILED',
    workflowId: 'wf-prod',
    runId: 'build-1',
    buildNumber: null,
    commitSha: null,
    completedAt: '2026-08-31T10:00:00Z',
    deliveryId: 'build-1',
  }]);
  payload.ciWorkflow.id = 'wf-pr';
  assert.deepEqual(jobsForXcodeCloudEvent(profile, payload), [{
    mode: 'build-status',
    purpose: 'pull_request',
    buildStatus: 'FAILED',
    workflowId: 'wf-pr',
    runId: 'build-1',
    buildNumber: null,
    commitSha: null,
    completedAt: '2026-08-31T10:00:00Z',
    deliveryId: 'build-1',
  }]);
  payload.ciWorkflow.id = 'wf-beta';
  assert.equal(jobsForXcodeCloudEvent(profile, payload)[0].purpose, 'beta');

  payload.ciBuildRun.id = 42;
  assert.equal(jobsForXcodeCloudEvent(profile, payload)[0].runId, '42');
  payload.ciBuildRun.id = '';
  payload.webhook = { id: 'webhook-build-1' };
  assert.equal(jobsForXcodeCloudEvent(profile, payload)[0].runId, 'webhook-build-1');
  delete payload.ciBuildRun.id;
  delete payload.webhook;
  assert.deepEqual(jobsForXcodeCloudEvent(profile, payload), []);
  payload.webhook = { id: '   ' };
  assert.deepEqual(jobsForXcodeCloudEvent(profile, payload), []);
});

test('reports the running deployment identity from the health endpoint', async t => {
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deploymentSha: 'deployed-commit',
    workerId: 17,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/health`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    ok: true,
    degraded: false,
    profiles: ['example-ios'],
    deployment_sha: 'deployed-commit',
    worker_id: 17,
    delivery_queue: {
      pending: 0, failed: 0, corrupt: 0, oldest_pending_age_ms: null,
    },
    deployment_state: { active: 0, incomplete: 0 },
    delivery_paused_until: null,
    delivery_paused: false,
  });
});

test('serves a profile-scoped version without repository or App Store lookups', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'version-secret';
  t.after(() => delete process.env[environmentName]);
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/builds/version/example-ios?workflow_id=wf-beta`;

  const denied = await fetch(url);
  assert.equal(denied.status, 401);
  const accepted = await fetch(url, {
    headers: { authorization: 'Bearer version-secret' },
  });

  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.equal(accepted.headers.get('x-merge4appstore-purpose'), 'beta');
  assert.equal(accepted.headers.get('x-merge4appstore-generation'), '1');
  assert.equal((await accepted.text()).trim(), '1.1');
});

test('serves purpose-specific versions immediately after a durable transition', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'version-secret';
  t.after(() => delete process.env[environmentName]);
  const store = new MemoryVersionStateStore();
  await store.recordSubmitted('example-ios', '1.1', '1.1', { sourceId: 'version-11' });
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    version: createVersionRequest({ store }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const request = workflowId => fetch(
    `http://127.0.0.1:${server.address().port}/v1/builds/version/example-ios?workflow_id=${workflowId}`,
    { headers: { authorization: 'Bearer version-secret' } },
  );

  assert.equal((await (await request('wf-prod')).text()).trim(), '1.1');
  assert.equal((await (await request('wf-pr')).text()).trim(), '1.2');
  assert.equal((await (await request('wf-beta')).text()).trim(), '1.2');
});

test('rejects missing and unconfigured workflow identifiers without external work', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'version-secret';
  t.after(() => delete process.env[environmentName]);
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1/builds/version/example-ios`;
  const headers = { authorization: 'Bearer version-secret' };

  for (const url of [base, `${base}?workflow_id=unknown`]) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 400);
  }
});

test('fails retryably instead of guessing when durable version state is unavailable', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'version-secret';
  t.after(() => delete process.env[environmentName]);
  const storeFailure = new Error('private storage detail');
  storeFailure.retryAfter = 9;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    version: createVersionRequest({
      store: { getOrInitialize: async () => { throw storeFailure; } },
    }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/v1/builds/version/example-ios?workflow_id=wf-beta`,
    { headers: { authorization: 'Bearer version-secret' } },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '9');
  assert.deepEqual(await response.json(), { error: 'Version state is unavailable' });
});

test('does not expose the removed preparation endpoint', async t => {
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/v1/builds/prepare/example-ios`,
    { method: 'POST', body: '{}' },
  );
  assert.equal(response.status, 404);
});

test('persists responsibility before acknowledging a webhook', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  let releaseClaim;
  let claimStarted;
  const started = new Promise(resolve => { claimStarted = resolve; });
  const underlying = new MemoryDeliveryStore();
  const deliveryStore = {
    ...underlying,
    initialize: () => underlying.initialize(),
    queueStatus: () => underlying.queueStatus(),
    claimPending: () => underlying.claimPending(),
    complete: claim => underlying.complete(claim),
    advance: (claim, cursor) => underlying.advance(claim, cursor),
    retry: (claim, error, options) => underlying.retry(claim, error, options),
    fail: (claim, error) => underlying.fail(claim, error),
    claim: async (...args) => {
      claimStarted();
      await new Promise(resolve => { releaseClaim = resolve; });
      return underlying.claim(...args);
    },
  };
  let dispatched = 0;
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    dispatch: async () => { dispatched += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const request = fetch(`http://127.0.0.1:${port}/webhooks/xcode-cloud/example-ios/xcode-secret`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
      ciWorkflow: { id: 'wf-prod' },
      ciBuildRun: { id: 'build-persisted', attributes: { completionStatus: 'SUCCEEDED' } },
    }),
  });
  await started;
  assert.equal(dispatched, 0);
  releaseClaim();
  assert.equal((await request).status, 202);
  await server.waitForBackground();
  assert.equal(dispatched, 3);
});

test('deduplicates retried Xcode payloads by the stable build identity', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  let dispatches = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    dispatch: async () => { dispatches += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/webhooks/xcode-cloud/example-ios/xcode-secret`;
  const payload = {
    metadata: { attributes: { eventType: 'BUILD_COMPLETED', createdDate: '2026-08-31T10:00:00Z' } },
    ciWorkflow: { id: 'wf-pr' },
    ciBuildRun: { id: 'stable-run', attributes: { completionStatus: 'FAILED', number: 12 } },
  };

  const first = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.status, 202);
  await server.waitForBackground();
  const second = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ ...payload, webhook: { id: 'different-envelope' } }),
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(dispatches, 1);
});

test('does not revive a dead letter through ordinary provider redelivery', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const deliveryStore = new MemoryDeliveryStore();
  const key = webhookDeliveryKey(
    'xcode',
    'example-ios',
    'wf-prod:dead-letter-run:BUILD_COMPLETED:FAILED',
  );
  const failed = await deliveryStore.claim(key, {
    instance: 'example-ios',
    jobs: [{ mode: 'build-status', purpose: 'production' }],
  });
  await deliveryStore.fail(failed, new Error('manual recovery required'));
  let dispatches = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    dispatch: async () => { dispatches += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/webhooks/xcode-cloud/example-ios/xcode-secret`,
    {
      method: 'POST',
      body: JSON.stringify({
        metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
        ciWorkflow: { id: 'wf-prod' },
        ciBuildRun: { id: 'dead-letter-run', attributes: { completionStatus: 'FAILED' } },
      }),
    },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  assert.equal(dispatches, 0);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
});

test('waits for acknowledged background jobs during graceful drain', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    dispatch: async () => { await blocked; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/xcode-cloud/example-ios/xcode-secret`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
      ciWorkflow: { id: 'wf-prod' },
      ciBuildRun: { id: 'build-drain', attributes: { completionStatus: 'FAILED' } },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal(server.backgroundWorkCount, 1);
  let drained = false;
  const draining = server.waitForBackground().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(drained, false);
  release();
  await draining;
  assert.equal(server.backgroundWorkCount, 0);
});

test('retries from the first unfinished job and dead-letters bounded failures', async t => {
  process.env.GH_WEBHOOK_SECRET = 'github-secret';
  t.after(() => delete process.env.GH_WEBHOOK_SECRET);
  const retryProfile = { ...profile, release_pull_request: true, auto_rebase_pull_requests: true };
  const deliveryStore = new MemoryDeliveryStore();
  const calls = [];
  let releaseFailures = 0;
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile: retryProfile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    recoveryIntervalMs: 1,
    retryDelayMs: 1,
    maxDeliveryAttempts: 3,
    dispatch: async (_entry, job) => {
      calls.push(job.mode);
      if (job.mode === 'release-pr' && releaseFailures++ === 0) return 1;
      return 0;
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const body = JSON.stringify({
    ref: 'refs/heads/develop',
    after: COMMIT_SHA,
    repository: { full_name: 'example/ios' },
    commits: [],
  });
  const signature = `sha256=${crypto.createHmac('sha256', 'github-secret').update(body).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/github/example-ios`, {
    method: 'POST',
    headers: {
      'x-hub-signature-256': signature,
      'x-github-event': 'push',
      'x-github-delivery': 'retry-cursor',
    },
    body,
  });
  assert.equal(response.status, 202);
  const deadline = Date.now() + 2_000;
  while ((await deliveryStore.queueStatus()).pending > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(calls, ['rebase-prs', 'release-pr', 'release-pr', 'trigger']);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });

  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const failedStore = new MemoryDeliveryStore();
  const failedServer = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore: failedStore,
    recoveryIntervalMs: 1,
    retryDelayMs: 1,
    maxDeliveryAttempts: 2,
    dispatch: async () => 1,
  });
  await new Promise(resolve => failedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => failedServer.close());
  const failedPort = failedServer.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${failedPort}/webhooks/xcode-cloud/example-ios/xcode-secret`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
      ciWorkflow: { id: 'wf-prod' },
      ciBuildRun: { id: 'build-dead-letter', attributes: { completionStatus: 'FAILED' } },
    }),
  })).status, 202);
  const failedDeadline = Date.now() + 2_000;
  while ((await failedStore.queueStatus()).failed === 0 && Date.now() < failedDeadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const health = await fetch(`http://127.0.0.1:${failedPort}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.degraded, true);
  assert.deepEqual(healthBody.delivery_queue, {
    pending: 0, failed: 1, corrupt: 0, oldest_pending_age_ms: null,
  });
});

test('retains a successful-build delivery when deployment reconciliation exits nonzero', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const deliveryStore = new MemoryDeliveryStore();
  const calls = [];
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    recoveryIntervalMs: 1,
    retryDelayMs: 1,
    maxDeliveryAttempts: 2,
    dispatch: async (_entry, job) => {
      calls.push(job.mode);
      return job.mode === 'deploy' ? 1 : 0;
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/webhooks/xcode-cloud/example-ios/xcode-secret`,
    {
      method: 'POST',
      body: JSON.stringify({
        metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
        ciWorkflow: { id: 'wf-prod' },
        ciBuildRun: {
          id: 'build-recovery-outage',
          attributes: { completionStatus: 'SUCCEEDED' },
        },
      }),
    },
  );
  assert.equal(response.status, 202);

  const deadline = Date.now() + 2_000;
  while ((await deliveryStore.queueStatus()).failed === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(calls, ['build-status', 'notes', 'deploy', 'deploy']);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
  const health = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
  assert.equal(health.degraded, true);
});

test('reports delivery storage initialization failures as unready', async t => {
  const storageError = new Error('permission denied');
  const deliveryStore = {
    initialize: async () => { throw storageError; },
    claimPending: async () => [],
    queueStatus: async () => { throw storageError; },
  };
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
  });
  t.after(() => server.stopBackgroundRecovery());
  await assert.rejects(server.waitUntilReady(), /permission denied/);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Webhook runtime state is unavailable');
});

test('reports corrupt durable receipts as degraded', async t => {
  const deliveryStore = {
    initialize: async () => {},
    claimPending: async () => [],
    queueStatus: async () => ({ pending: 0, failed: 0, corrupt: 1 }),
  };
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.degraded, true);
  assert.equal(health.delivery_queue.corrupt, 1);
});

test('reports an over-age pending delivery as degraded before its job deadline', async t => {
  let now = 10_000;
  const deliveryStore = new MemoryDeliveryStore({ now: () => now });
  await deliveryStore.claim('github:example:stalled', {
    instance: 'example-ios', jobs: [{ mode: 'trigger' }],
  });
  now += 101;
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    pendingStaleAfterMs: 100,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.stopBackgroundRecovery();
    server.close();
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.degraded, true);
  assert.equal(health.delivery_queue.oldest_pending_age_ms, 101);
});

test('reports an incomplete durable deployment transaction as degraded', async t => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-transaction-health-'));
  const transaction = path.join(stateDirectory, 'transactions', 'run-1');
  fs.mkdirSync(transaction, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(transaction, '.merge4appstore-transaction'),
    'merge4appstore-deployment-transaction-v1\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(transaction, 'phase'), 'cron-configured\n', { mode: 0o600 });
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  assert.deepEqual(
    await inspectDeploymentTransactions(stateDirectory, { staleAfterMs: 60_000 }),
    { active: 1, incomplete: 0 },
  );
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore: new MemoryDeliveryStore(),
    version: createVersionRequest({ store: new MemoryVersionStateStore() }),
    deploymentProbe: () => inspectDeploymentTransactions(stateDirectory, { staleAfterMs: 0 }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.degraded, true);
  assert.deepEqual(health.deployment_state, { active: 1, incomplete: 1 });

  fs.writeFileSync(path.join(transaction, 'phase'), 'complete\n', { mode: 0o600 });
  assert.deepEqual(
    await inspectDeploymentTransactions(stateDirectory, { staleAfterMs: 0 }),
    { active: 0, incomplete: 0 },
  );
});

test('marks the worker unhealthy and requests a restart when delivery persistence fails', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const storageError = new Error('disk full');
  class FailingRetryStore extends MemoryDeliveryStore {
    async retry() { throw storageError; }
  }
  const fatalErrors = [];
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore: new FailingRetryStore(),
    dispatch: async () => 1,
    onFatalDeliveryError: error => fatalErrors.push(error),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/webhooks/xcode-cloud/example-ios/xcode-secret`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
      ciWorkflow: { id: 'wf-prod' },
      ciBuildRun: { id: 'build-storage-error', attributes: { completionStatus: 'FAILED' } },
    }),
  });
  assert.equal(response.status, 202);
  await server.waitForBackground();
  assert.deepEqual(fatalErrors, [storageError]);

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).error, 'Webhook runtime state is unavailable');
});

test('marks recovery ownership failures fatal instead of leaving pending work stuck', async t => {
  const storageError = new Error('storage read-only');
  class FailingRecoveryStore extends MemoryDeliveryStore {
    async claimPending() { throw storageError; }
  }
  let reportFatal;
  const fatal = new Promise(resolve => { reportFatal = resolve; });
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore: new FailingRecoveryStore(),
    recoveryIntervalMs: 1,
    onFatalDeliveryError: reportFatal,
  });
  t.after(() => server.close());
  assert.equal(await fatal, storageError);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(health.status, 503);
});

test('durably defers deliveries until a migration drain deadline expires', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const deliveryStore = new MemoryDeliveryStore();
  let dispatched = 0;
  const pausedUntil = Date.now() + 40;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    deliveryPausedUntil: pausedUntil,
    recoveryIntervalMs: 1,
    dispatch: async () => { dispatched += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/xcode-cloud/example-ios/xcode-secret`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
      ciWorkflow: { id: 'wf-prod' },
      ciBuildRun: { id: 'build-migration', attributes: { completionStatus: 'SUCCEEDED' } },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal(dispatched, 0);
  assert.equal((await deliveryStore.queueStatus()).pending, 1);

  const deadline = Date.now() + 1_000;
  while (dispatched < 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(dispatched, 3);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });
});

test('durably defers deliveries behind a migration gate until it is removed', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-pause-'));
  const pauseFile = path.join(directory, 'delivery.pause');
  fs.writeFileSync(pauseFile, 'first-migration\n', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deliveryStore = new MemoryDeliveryStore();
  let dispatched = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    deliveryPauseFile: pauseFile,
    recoveryIntervalMs: 1,
    dispatch: async () => { dispatched += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/xcode-cloud/example-ios/xcode-secret`, {
    method: 'POST',
    body: JSON.stringify({
      metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
      ciWorkflow: { id: 'wf-prod' },
      ciBuildRun: { id: 'build-migration-gate', attributes: { completionStatus: 'SUCCEEDED' } },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal(dispatched, 0);
  assert.equal((await deliveryStore.queueStatus()).pending, 1);
  const pausedHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(pausedHealth.delivery_paused, true);
  assert.equal(pausedHealth.degraded, true);

  fs.unlinkSync(pauseFile);
  const deadline = Date.now() + 1_000;
  while (dispatched < 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(dispatched, 3);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });
});

test('rejects malformed Xcode webhook token encoding without a server error', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/webhooks/xcode-cloud/example-ios/%E0%A4%A`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 401);
});

test('rejects malformed instance encoding as a bad request', async t => {
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/webhooks/github/%E0%A4%A`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(response.status, 400);
});

test('rejects duplicate profile instances instead of silently replacing one', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-profiles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = `
version: 1
instance: duplicate
repository: { owner: example, name: ios }
versioning: { initial_version: "1.1" }
apps:
  prod: { app_id: "1", bundle_id: com.example, name: Example, workflows: { pr: workflow-1 } }
build:
  purposes:
    pull_request: { workflow: pr }
`;
  fs.writeFileSync(path.join(directory, 'one.yml'), source);
  fs.writeFileSync(path.join(directory, 'two.yaml'), source);
  assert.throws(() => loadProfiles(directory), /Duplicate profile instance duplicate/);
});

test('loads reserved profile instance names without Object prototype collisions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-profiles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'reserved.yml'), `
version: 1
instance: __proto__
repository: { owner: example, name: ios }
versioning: { initial_version: "1.1" }
apps:
  prod: { app_id: "1", bundle_id: com.example, name: Example, workflows: { pr: workflow-1 } }
build:
  purposes:
    pull_request: { workflow: pr }
`);

  const profiles = loadProfiles(directory);
  assert.equal(Object.getPrototypeOf(profiles), null);
  assert.equal(profiles.__proto__.profile.instance, '__proto__');
});
