import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  jobsForGitHubEvent,
  jobsForXcodeCloudEvent,
  verifyGitHubSignature,
  webhookSettings,
} from '../lib/webhooks.js';
import {
  createSerialDispatcher,
  createWebhookServer,
  loadProfiles,
  normalizePreparePayload,
  runJob,
  singleHeader,
  webhookDeliveryKey,
} from '../webhook-server.js';

const profile = {
  instance: 'example-ios',
  repository: { owner: 'example', name: 'ios', beta_branch: 'develop', production_branch: 'main' },
  apps: { prod: { app_id: '1', bundle_id: 'com.example', name: 'Example', workflows: { pr: 'wf-pr', beta: 'wf-beta', production: 'wf-prod' } } },
  build: { purposes: { pull_request: { workflow: 'pr' }, beta: { workflow: 'beta' }, production: { workflow: 'production' } } },
};

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

test('defaults to deployed shared webhook secrets and a repository-scoped build token', () => {
  const profileWithoutOverrides = { ...profile, webhooks: undefined, ci: undefined };
  const settings = webhookSettings(profileWithoutOverrides, {
    GH_WEBHOOK_SECRET: 'github',
    XCODE_CLOUD_WEBHOOK_TOKEN: 'xcode',
    MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS: 'build',
  });

  assert.equal(settings.githubSecret, 'github');
  assert.equal(settings.xcodeToken, 'xcode');
  assert.equal(settings.buildToken, 'build');
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
});

test('maps beta and production pushes to their managed build purposes', () => {
  const repository = { full_name: 'example/ios' };
  assert.deepEqual(jobsForGitHubEvent(profile, 'push', {
    ref: 'refs/heads/develop', after: 'abc', repository,
  }, 'one'), [
    { mode: 'rebase-prs', deliveryId: 'one' },
    { mode: 'trigger', purpose: 'beta', commitSha: 'abc', branch: 'develop', deliveryId: 'one' },
  ]);
  assert.equal(jobsForGitHubEvent(profile, 'push', { ref: 'refs/heads/main', after: 'def', repository }, 'two')[0].purpose, 'production');
  assert.deepEqual(jobsForGitHubEvent(profile, 'push', { ref: 'refs/heads/feature', after: 'ghi', repository }, 'three'), []);
});

test('allows profiles to disable automatic pull request rebasing', () => {
  const disabledProfile = { ...profile, auto_rebase_pull_requests: false };
  const repository = { full_name: 'example/ios' };
  assert.deepEqual(jobsForGitHubEvent(disabledProfile, 'push', {
    ref: 'refs/heads/develop', after: 'abc', repository,
  }, 'one'), [
    { mode: 'trigger', purpose: 'beta', commitSha: 'abc', branch: 'develop', deliveryId: 'one' },
  ]);
});

test('reconciles a configured release PR on beta and production pushes', () => {
  const releaseProfile = { ...profile, release_pull_request: true };
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

test('normalizes full Git refs in build preparation payloads', () => {
  assert.deepEqual(normalizePreparePayload({
    branch: 'refs/heads/feature/player',
    target_branch: 'refs/heads/develop',
    commit: 'abc123',
  }), {
    branch: 'feature/player',
    target_branch: 'develop',
    commit: 'abc123',
  });
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

test('runs deploy only for a successful completed production workflow', () => {
  const payload = {
    metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
    ciWorkflow: { id: 'wf-prod' },
    ciBuildRun: { id: 'build-1', attributes: { completionStatus: 'SUCCEEDED' } },
  };
  assert.deepEqual(jobsForXcodeCloudEvent(profile, payload), [{ mode: 'deploy', deliveryId: 'build-1' }]);
  payload.ciWorkflow.id = 'wf-pr';
  assert.deepEqual(jobsForXcodeCloudEvent(profile, payload), []);
});

test('protects the build preparation endpoint with its repository token', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'build-secret';
  t.after(() => delete process.env[environmentName]);
  const server = createWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    prepare: async (_entry, payload) => ({ purpose: payload.purpose, marketing_version: '1.5', testflight_notes: 'Notes' }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/v1/builds/prepare/example-ios`;
  const denied = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  const accepted = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'beta' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).marketing_version, '1.5');
});

test('rejects malformed Xcode webhook token encoding without a server error', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const server = createWebhookServer({
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
  const server = createWebhookServer({
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
