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
import { FileDeliveryStore } from '../lib/file-delivery-store.js';
import {
  FileGitHubInstallationState,
  MemoryGitHubInstallationState,
} from '../lib/github-installation-state.js';
import { AsyncTtlCache } from '../lib/async-cache.js';
import { GitHubAPI } from '../lib/github.js';
import { MemoryPrepareCache } from '../lib/prepare-cache.js';
import { serializeEncodedEnvironment } from '../lib/secret-environment.js';
import {
  jobsForGitHubEvent,
  jobsForXcodeCloudEvent,
  githubAppWebhookMode,
  githubClassicWebhooksEnabled,
  verifyGitHubSignature,
  webhookSettings,
} from '../lib/webhooks.js';
import {
  createPrepareRequest,
  createJobRunner,
  createSerialDispatcher,
  createWebhookServer,
  entriesForGitHubAppEvent,
  githubEventDeliveryKey,
  inspectDeploymentTransactions,
  jobEnvironment,
  loadProfiles,
  normalizePreparePayload,
  runJob,
  singleHeader,
  webhookDeliveryKey,
} from '../webhook-server.js';

const profile = {
  instance: 'example-ios',
  repository: { owner: 'example', name: 'ios', github_id: 11, beta_branch: 'develop', production_branch: 'main' },
  apps: { prod: { app_id: '1', bundle_id: 'com.example', name: 'Example', workflows: { pr: 'wf-pr', beta: 'wf-beta', production: 'wf-prod' } } },
  build: {
    trigger_mode: 'managed',
    purposes: { pull_request: { workflow: 'pr' }, beta: { workflow: 'beta' }, production: { workflow: 'production' } },
  },
};
const COMMIT_SHA = 'a'.repeat(40);

function signedGitHubAppRequest(server, secret, event, delivery, payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return fetch(`http://127.0.0.1:${server.address().port}/webhooks/github-app`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': signature,
    },
    body,
  });
}

function signedClassicGitHubRequest(server, secret, instance, event, delivery, payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return fetch(`http://127.0.0.1:${server.address().port}/webhooks/github/${instance}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': signature,
    },
    body,
  });
}

const matchingAuthenticator = {
  verifyRepositoryInstallation: async () => '456',
};

function createTestWebhookServer(options) {
  const server = createWebhookServer({
    deliveryStore: new MemoryDeliveryStore(),
    prepareCache: new MemoryPrepareCache(),
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

test('uses one provider-neutral identity for paired classic and App events', () => {
  const classic = {
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    before: 'b'.repeat(40),
    after: COMMIT_SHA,
  };
  const app = { ...classic, installation: { id: 456 } };
  assert.equal(
    githubEventDeliveryKey('example-ios', 'push', classic, 'classic-id', 11),
    githubEventDeliveryKey('example-ios', 'push', app, 'app-id', 11),
  );
});

test('validates GitHub App rollout modes and classic webhook gating', () => {
  assert.equal(githubAppWebhookMode({}), 'shadow');
  assert.equal(githubAppWebhookMode({ GITHUB_APP_WEBHOOK_MODE: 'managed' }), 'managed');
  assert.throws(
    () => githubAppWebhookMode({ GITHUB_APP_WEBHOOK_MODE: 'active' }),
    /shadow or managed/,
  );
  assert.equal(githubClassicWebhooksEnabled({}), true);
  assert.equal(githubClassicWebhooksEnabled({ GITHUB_CLASSIC_WEBHOOKS_ENABLED: 'false' }), false);
  assert.throws(
    () => githubClassicWebhooksEnabled({ GITHUB_CLASSIC_WEBHOOKS_ENABLED: 'yes' }),
    /true or false/,
  );
});

test('routes shared GitHub App deliveries only by immutable repository id', () => {
  const renamed = {
    repository: { id: 11, full_name: 'renamed-owner/renamed-repository' },
  };
  const profiles = { 'example-ios': { profile, profilePath: '/tmp/example.yml' } };
  assert.deepEqual(entriesForGitHubAppEvent(profiles, renamed), [profiles['example-ios']]);
  assert.deepEqual(entriesForGitHubAppEvent(profiles, {
    repository: { id: 12, full_name: 'example/ios' },
  }), []);
  assert.deepEqual(entriesForGitHubAppEvent({ missing: {
    profile: { ...profile, repository: { ...profile.repository, github_id: undefined } },
    profilePath: '/tmp/missing.yml',
  } }, { repository: { id: 11, full_name: 'example/ios' } }), []);
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

test('webhook startup loads the validated GitHub App secret schema', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-webhook-startup-'));
  const environmentFile = path.join(directory, 'webhook.env');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = {
    GH_WEBHOOK_SECRET: 'classic',
    XCODE_CLOUD_WEBHOOK_TOKEN: 'xcode',
    MERGE4APPSTORE_BUILD_TOKEN_JAMSONTOAST: 'jams',
    MERGE4APPSTORE_BUILD_TOKEN_RUNNINGORDER_IOS: 'running',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from('private-key-fixture').toString('base64'),
    GITHUB_APP_WEBHOOK_SECRET: 'app-webhook',
    GITHUB_APP_WEBHOOK_MODE: 'shadow',
    GITHUB_CLASSIC_WEBHOOKS_ENABLED: 'true',
  };
  fs.writeFileSync(
    environmentFile,
    serializeEncodedEnvironment(environment, Object.keys(environment)),
    { mode: 0o600 },
  );
  const moduleUrl = new URL('../webhook-server.js', import.meta.url).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify({ id: process.env.GITHUB_APP_ID, mode: process.env.GITHUB_APP_WEBHOOK_MODE, secret: process.env.GITHUB_APP_WEBHOOK_SECRET }));`,
  ], {
    env: { ...process.env, MERGE4APPSTORE_WEBHOOK_ENV: environmentFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { id: '123', mode: 'shadow', secret: 'app-webhook' });
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

test('keeps loaded service secrets out of webhook job initial environments', () => {
  const environment = jobEnvironment({
    mode: 'trigger',
    purpose: 'beta',
    installationId: 456,
    repositoryId: 11,
  }, {
    PATH: '/bin',
    MERGE4APPSTORE_ENV: '/private/control.env',
    MERGE4APPSTORE_WEBHOOK_ENV: '/private/webhook.env',
    APP_STORE_CONNECT_API_KEY_CONTENT: 'asc-secret',
    GH_TOKEN: 'pat',
    GH_WEBHOOK_SECRET: 'classic-secret',
    GITHUB_APP_PRIVATE_KEY_BASE64: 'app-key',
    GITHUB_APP_WEBHOOK_SECRET: 'app-webhook-secret',
    MERGE4APPSTORE_JOB_GITHUB_INSTALLATION_ID: 'stale-installation',
    MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS: 'build-secret',
    XCODE_CLOUD_WEBHOOK_TOKEN: 'xcode-secret',
  });

  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.MERGE4APPSTORE_ENV, '/private/control.env');
  assert.equal(environment.MERGE4APPSTORE_WEBHOOK_ENV, '/private/webhook.env');
  assert.equal(environment.BUILD_PURPOSE, 'beta');
  assert.equal(environment.GITHUB_REPOSITORY_ID, '11');
  assert.equal(environment.MERGE4APPSTORE_JOB_GITHUB_INSTALLATION_ID, '456');
  for (const name of [
    'APP_STORE_CONNECT_API_KEY_CONTENT',
    'GH_TOKEN',
    'GH_WEBHOOK_SECRET',
    'GITHUB_APP_PRIVATE_KEY_BASE64',
    'GITHUB_APP_WEBHOOK_SECRET',
    'GITHUB_INSTALLATION_ID',
    'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS',
    'XCODE_CLOUD_WEBHOOK_TOKEN',
  ]) assert.equal(environment[name], undefined, name);
  assert.equal(jobEnvironment({ mode: 'expire' }, {
    PATH: '/bin',
    MERGE4APPSTORE_JOB_GITHUB_INSTALLATION_ID: 'stale-installation',
  }).MERGE4APPSTORE_JOB_GITHUB_INSTALLATION_ID, undefined);
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

test('reports every production completion and deploys only a successful build', () => {
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
    github_app_mode: 'shadow',
    github_app_ready: false,
    github_classic_webhooks_enabled: true,
  });
});

test('protects the build preparation endpoint with its repository token', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'build-secret';
  t.after(() => delete process.env[environmentName]);
  const server = createTestWebhookServer({
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
  const malformed = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
    body: 'null',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /must be an object/);
});

test('deduplicates a managed GitHub App delivery durably across two workers', async t => {
  const secret = 'shared-app-secret';
  const deliveryStore = new MemoryDeliveryStore();
  const installationState = new MemoryGitHubInstallationState();
  let dispatches = 0;
  const servers = [0, 1].map(() => createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    installationState,
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: secret,
    dispatch: async () => { dispatches += 1; return 0; },
  }));
  for (const server of servers) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
  }
  const payload = {
    installation: { id: 456 },
    repository: { id: 11, full_name: 'renamed/repository' },
    ref: 'refs/heads/develop',
    after: COMMIT_SHA,
  };

  const responses = await Promise.all(servers.map(server => (
    signedGitHubAppRequest(server, secret, 'push', 'shared-delivery', payload)
  )));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 202]);
  await Promise.all(servers.map(server => server.waitForBackground()));
  assert.equal(dispatches, 1);
  assert.equal(
    deliveryStore.receipts.get(
      githubEventDeliveryKey('example-ios', 'push', payload, 'shared-delivery', 11),
    ).state,
    'complete',
  );
});

test('persists GitHub App installation state once across every target', async t => {
  const secret = 'shared-app-secret';
  const otherProfile = {
    ...profile,
    instance: 'other-ios',
    repository: { ...profile.repository, name: 'other', github_id: 12 },
  };
  const deliveryStore = new MemoryDeliveryStore();
  const server = createTestWebhookServer({
    profiles: {
      'example-ios': { profile, profilePath: '/tmp/example.yml' },
      'other-ios': { profile: otherProfile, profilePath: '/tmp/other.yml' },
    },
    deliveryStore,
    installationState: new MemoryGitHubInstallationState(),
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: secret,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await signedGitHubAppRequest(
    server,
    secret,
    'installation',
    'suspend-every-target',
    {
      action: 'suspend',
      installation: { id: 456, updated_at: '2026-08-31T10:00:00Z' },
      repositories: [{ id: 11 }, { id: 12 }],
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).repositories.sort(), ['example-ios', 'other-ios']);
  await server.waitForBackground();
  assert.equal(
    deliveryStore.receipts.get(
      webhookDeliveryKey('github-installation', '456', 'suspend-every-target'),
    ).state,
    'complete',
  );
  assert.equal(deliveryStore.receipts.size, 1);
});

test('persists repository-less GitHub App installation lifecycle state before acknowledgement', async t => {
  const secret = 'shared-app-secret';
  const deliveryStore = new MemoryDeliveryStore();
  const installationState = new MemoryGitHubInstallationState();
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    installationState,
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: secret,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await signedGitHubAppRequest(
    server,
    secret,
    'installation',
    'repository-less-suspend',
    {
      action: 'suspend',
      installation: { id: 456, updated_at: '2026-08-31T10:00:00Z' },
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    mode: 'managed',
    installation: '456',
    suspended: true,
    repositories: [],
    jobs: [],
  });
  assert.equal(await installationState.isSuspended(456), true);
  await server.waitForBackground();
  assert.equal(
    deliveryStore.receipts.get(
      webhookDeliveryKey('github-installation', '456', 'repository-less-suspend'),
    ).state,
    'complete',
  );

  const duplicate = await signedGitHubAppRequest(
    server,
    secret,
    'installation',
    'repository-less-suspend',
    {
      action: 'suspend',
      installation: { id: 456, updated_at: '2026-08-31T10:00:00Z' },
    },
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
});

test('applies App suspension state before paused repository work can recover', async t => {
  const secret = 'paused-installation-secret';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-paused-installation-'));
  const pauseFile = path.join(directory, 'delivery.pause');
  fs.writeFileSync(pauseFile, 'deployment\n', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deliveryStore = new MemoryDeliveryStore();
  const installationState = new MemoryGitHubInstallationState();
  let dispatches = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    installationState,
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: secret,
    deliveryPauseFile: pauseFile,
    recoveryIntervalMs: 1,
    suspendedRetryDelayMs: 60_000,
    dispatch: async () => { dispatches += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const suspend = await signedGitHubAppRequest(server, secret, 'installation', 'paused-suspend', {
    action: 'suspend',
    installation: { id: 456, updated_at: '2026-08-31T10:00:00Z' },
  });
  assert.equal(suspend.status, 202);
  assert.equal((await suspend.json()).suspended, true);
  assert.equal(await installationState.isSuspended(456), true);

  const push = await signedGitHubAppRequest(server, secret, 'push', 'paused-push', {
    installation: { id: 456 },
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    before: 'b'.repeat(40),
    after: COMMIT_SHA,
  });
  assert.equal(push.status, 202);
  fs.unlinkSync(pauseFile);
  const blockedDeadline = Date.now() + 1_000;
  while (
    ![...deliveryStore.receipts.values()].some(
      receipt => receipt.retryReason === 'installation-suspended:456',
    )
    && Date.now() < blockedDeadline
  ) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(dispatches, 0);
  assert.ok([...deliveryStore.receipts.values()].some(
    receipt => receipt.retryReason === 'installation-suspended:456',
  ));

  const unsuspend = await signedGitHubAppRequest(server, secret, 'installation', 'paused-unsuspend', {
    action: 'unsuspend',
    installation: { id: 456, updated_at: '2026-08-31T10:01:00Z' },
  });
  assert.equal(unsuspend.status, 202);
  const dispatchDeadline = Date.now() + 1_000;
  while (dispatches === 0 && Date.now() < dispatchDeadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(dispatches, 1);
});

test('shadow GitHub App deliveries are observed and deduplicated without dispatch', async t => {
  const secret = 'shadow-app-secret';
  let dispatches = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    githubAppMode: 'shadow',
    githubAppSecret: secret,
    dispatch: async () => { dispatches += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const payload = {
    installation: { id: 456 },
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    after: COMMIT_SHA,
  };

  const response = await signedGitHubAppRequest(
    server, secret, 'push', 'shadow-delivery', payload,
  );
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.mode, 'shadow');
  assert.deepEqual(body.jobs, ['trigger:beta']);
  await server.waitForBackground();
  assert.equal(dispatches, 0);
  const duplicate = await signedGitHubAppRequest(
    server, secret, 'push', 'shadow-delivery', payload,
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
});

test('managed mode suppresses the classic endpoint at request time', async t => {
  const classicSecret = 'classic-secret';
  const appSecret = 'app-secret';
  process.env.GH_WEBHOOK_SECRET = classicSecret;
  t.after(() => delete process.env.GH_WEBHOOK_SECRET);
  let dispatches = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: appSecret,
    dispatch: async () => { dispatches += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const payload = JSON.stringify({
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    after: COMMIT_SHA,
  });
  const signature = `sha256=${crypto.createHmac('sha256', classicSecret).update(payload).digest('hex')}`;
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/webhooks/github/example-ios`,
    {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-github-delivery': 'classic-managed',
        'x-hub-signature-256': signature,
      },
      body: payload,
    },
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).suppressed, true);
  assert.equal(dispatches, 0);
});

test('defers a managed App delivery when the migration gate appears during claim', async t => {
  const appSecret = 'claim-race-app-secret';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-claim-pause-'));
  const pauseFile = path.join(directory, 'delivery.pause');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  class GateOnClaimStore extends MemoryDeliveryStore {
    async claim(...args) {
      const claim = await super.claim(...args);
      if (claim && !fs.existsSync(pauseFile)) {
        fs.writeFileSync(pauseFile, 'cutover\n', { mode: 0o600 });
      }
      return claim;
    }
  }
  const deliveryStore = new GateOnClaimStore();
  let dispatches = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: appSecret,
    deliveryPauseFile: pauseFile,
    recoveryIntervalMs: 1,
    dispatch: async () => { dispatches += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await signedGitHubAppRequest(server, appSecret, 'push', 'claim-race', {
    installation: { id: 456 },
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    before: 'b'.repeat(40),
    after: COMMIT_SHA,
  });
  assert.equal(response.status, 202);
  await server.waitForBackground();
  assert.equal(dispatches, 0);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 1, failed: 0, corrupt: 0 });

  fs.unlinkSync(pauseFile);
  const deadline = Date.now() + 1_000;
  while (dispatches === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(dispatches, 1);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });
});

test('deduplicates both mixed-generation GitHub cutover handler orderings', async t => {
  const classicSecret = 'cutover-classic-secret';
  const appSecret = 'cutover-app-secret';
  process.env.GH_WEBHOOK_SECRET = classicSecret;
  t.after(() => delete process.env.GH_WEBHOOK_SECRET);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-github-cutover-'));
  const pauseFile = path.join(directory, 'delivery.pause');
  fs.writeFileSync(pauseFile, 'cutover\n', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deliveryStore = new MemoryDeliveryStore();
  const installationState = new MemoryGitHubInstallationState();
  let dispatches = 0;
  const common = {
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    installationState,
    authenticator: matchingAuthenticator,
    githubAppSecret: appSecret,
    deliveryPauseFile: pauseFile,
    dispatch: async () => { dispatches += 1; return 0; },
  };
  const shadow = createTestWebhookServer({
    ...common,
    githubAppMode: 'shadow',
    classicGitHubWebhooksEnabled: true,
    recoveryIntervalMs: 10_000,
  });
  const managed = createTestWebhookServer({
    ...common,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    recoveryIntervalMs: 1,
  });
  for (const server of [shadow, managed]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
  }

  const payload = after => ({
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    before: 'b'.repeat(40),
    after,
  });
  const first = payload('a'.repeat(40));
  const appOnShadow = await signedGitHubAppRequest(
    shadow,
    appSecret,
    'push',
    'app-on-shadow',
    { ...first, installation: { id: 456 } },
  );
  const classicOnManaged = await signedClassicGitHubRequest(
    managed,
    classicSecret,
    'example-ios',
    'push',
    'classic-on-managed',
    first,
  );
  assert.deepEqual([appOnShadow.status, classicOnManaged.status], [202, 200]);

  const second = payload('c'.repeat(40));
  const classicOnShadow = await signedClassicGitHubRequest(
    shadow,
    classicSecret,
    'example-ios',
    'push',
    'classic-on-shadow',
    second,
  );
  const appOnManaged = await signedGitHubAppRequest(
    managed,
    appSecret,
    'push',
    'app-on-managed',
    { ...second, installation: { id: 456 } },
  );
  assert.deepEqual([classicOnShadow.status, appOnManaged.status], [202, 200]);
  assert.equal(dispatches, 0);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 2, failed: 0, corrupt: 0 });

  shadow.stopBackgroundRecovery();
  fs.unlinkSync(pauseFile);
  const deadline = Date.now() + 1_000;
  while (dispatches < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await managed.waitForBackground();
  assert.equal(dispatches, 2);
  assert.deepEqual(await deliveryStore.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });

  const appDuplicate = await signedGitHubAppRequest(
    managed,
    appSecret,
    'push',
    'app-after-cutover',
    { ...first, installation: { id: 456 } },
  );
  assert.equal(appDuplicate.status, 200);
  assert.equal((await appDuplicate.json()).duplicate, true);
  const classicSuppressed = await signedClassicGitHubRequest(
    managed,
    classicSecret,
    'example-ios',
    'push',
    'classic-after-cutover',
    first,
  );
  assert.equal(classicSuppressed.status, 202);
  assert.equal((await classicSuppressed.json()).suppressed, true);
  assert.equal(dispatches, 2);
});

test('managed GitHub App mode fails closed for missing credentials or repository ids', async t => {
  const missingAuth = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    authenticator: null,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: 'app-secret',
  });
  await new Promise(resolve => missingAuth.listen(0, '127.0.0.1', resolve));
  t.after(() => missingAuth.close());
  const health = await fetch(`http://127.0.0.1:${missingAuth.address().port}/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).github_app_ready, false);
  const denied = await signedGitHubAppRequest(
    missingAuth,
    'app-secret',
    'push',
    'missing-auth',
    {
      installation: { id: 456 },
      repository: { id: 11 },
      ref: 'refs/heads/develop',
      after: COMMIT_SHA,
    },
  );
  assert.equal(denied.status, 503);

  const profileWithoutId = {
    ...profile,
    repository: { ...profile.repository, github_id: undefined },
  };
  const missingId = createTestWebhookServer({
    profiles: { 'example-ios': { profile: profileWithoutId, profilePath: '/tmp/example.yml' } },
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: 'app-secret',
  });
  await new Promise(resolve => missingId.listen(0, '127.0.0.1', resolve));
  t.after(() => missingId.close());
  assert.equal((await fetch(`http://127.0.0.1:${missingId.address().port}/health`)).status, 503);
});

test('fails health closed for unsafe shadow and managed cutover combinations', async t => {
  const shadowServer = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    githubAppMode: 'shadow',
    githubAppSecret: 'app-secret',
    classicGitHubWebhooksEnabled: false,
  });
  const managedServer = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    githubAppSecret: 'app-secret',
    classicGitHubWebhooksEnabled: true,
  });
  for (const server of [shadowServer, managedServer]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(health.status, 503);
    assert.match((await health.json()).error, /routing/i);
  }
});

test('durably accepts a signed App delivery without a fallible pre-claim API lookup', async t => {
  const secret = 'app-secret';
  let verifierCalls = 0;
  let dispatches = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    authenticator: {
      verifyRepositoryInstallation: async () => {
        verifierCalls += 1;
        throw new Error('GitHub API unavailable');
      },
    },
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: secret,
    dispatch: async () => { dispatches += 1; return 0; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await signedGitHubAppRequest(server, secret, 'push', 'signed-installation', {
    installation: { id: 456 },
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    after: COMMIT_SHA,
  });
  assert.equal(response.status, 202);
  await server.waitForBackground();
  assert.equal(verifierCalls, 0);
  assert.equal(dispatches, 1);
});

test('keeps suspended jobs pending across workers and dispatches them after restart recovery', async t => {
  const secret = 'app-secret';
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-installation-restart-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const deliveryStore = new FileDeliveryStore({ stateDirectory });
  let dispatches = 0;
  const options = () => ({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deliveryStore,
    installationState: new FileGitHubInstallationState({ stateDirectory }),
    authenticator: matchingAuthenticator,
    githubAppMode: 'managed',
    classicGitHubWebhooksEnabled: false,
    githubAppSecret: secret,
    recoveryIntervalMs: 10_000,
    suspendedRetryDelayMs: 60_000,
    dispatch: async () => { dispatches += 1; return 0; },
  });
  const firstWorker = createTestWebhookServer(options());
  await firstWorker.waitUntilReady();
  await new Promise(resolve => firstWorker.listen(0, '127.0.0.1', resolve));
  const suspended = await signedGitHubAppRequest(
    firstWorker,
    secret,
    'installation',
    'installation-suspended',
    {
      action: 'suspend',
      installation: { id: 456, updated_at: '2026-08-31T10:00:00Z' },
      repositories: [{ id: 11 }],
    },
  );
  assert.equal(suspended.status, 202);
  await firstWorker.waitForBackground();
  await new Promise(resolve => firstWorker.close(resolve));

  const secondWorker = createTestWebhookServer(options());
  await secondWorker.waitUntilReady();
  await new Promise(resolve => secondWorker.listen(0, '127.0.0.1', resolve));
  t.after(() => secondWorker.close());
  const blocked = await signedGitHubAppRequest(secondWorker, secret, 'push', 'blocked-push', {
    installation: { id: 456 },
    repository: { id: 11, full_name: 'example/ios' },
    ref: 'refs/heads/develop',
    after: COMMIT_SHA,
  });
  assert.equal(blocked.status, 202);
  assert.equal((await blocked.json()).suspended, true);
  await secondWorker.waitForBackground();
  assert.equal(dispatches, 0);
  assert.equal((await deliveryStore.queueStatus()).pending, 1);
  const pendingReceiptFiles = fs.readdirSync(path.join(stateDirectory, 'deliveries', 'pending'));
  assert.equal(pendingReceiptFiles.length, 1);
  const deferred = JSON.parse(fs.readFileSync(
    path.join(stateDirectory, 'deliveries', 'pending', pendingReceiptFiles[0]),
    'utf8',
  ));
  assert.equal(deferred.ownerPid, null);
  assert.equal(deferred.retryReason, 'installation-suspended:456');
  assert.ok(deferred.nextAttemptAt > Date.now());

  const active = await signedGitHubAppRequest(
    secondWorker,
    secret,
    'installation',
    'installation-unsuspended',
    {
      action: 'unsuspend',
      installation: { id: 456, updated_at: '2026-08-31T10:01:00Z' },
      repositories: [{ id: 11 }],
    },
  );
  assert.equal(active.status, 202);
  const deadline = Date.now() + 2_000;
  while (dispatches === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await secondWorker.waitForBackground();
  assert.equal(dispatches, 1);
  assert.equal((await deliveryStore.queueStatus()).pending, 0);
});

test('keeps an authoritative pull-request lookup outage retryable', async () => {
  const github = new GitHubAPI('example', 'ios', 'main', { mirror: null });
  github.execAsync = async () => { throw new Error('GitHub unavailable'); };
  const prepare = createPrepareRequest({
    githubFactory: () => github,
    ascFactory: () => { throw new Error('App Store Connect should not be reached'); },
  });
  await assert.rejects(
    () => prepare({ profile, profilePath: '/tmp/example.yml' }, {
      repository: 'example/ios',
      commit: COMMIT_SHA,
      branch: 'feature/player',
      current_marketing_version: '1.0',
    }),
    error => error.statusCode === 503 && error.retryAfter === 5,
  );
});

test('cancels an asynchronous repository-authentication factory at the prepare deadline', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const prepare = createPrepareRequest({
    authenticator: null,
    repositoryAuthenticationFactory: (_profile, { signal }) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
    ascFactory: () => { throw new Error('App Store Connect should not be reached'); },
  });
  const request = prepare(
    { profile, profilePath: '/tmp/example.yml' },
    { purpose: 'beta', branch: 'develop', commit: COMMIT_SHA },
    { signal: controller.signal },
  );
  const deadline = new Error('prepare deadline');
  controller.abort(deadline);
  await assert.rejects(request, error => error === deadline);
  assert.equal(receivedSignal, controller.signal);
});

test('does not replace an explicit build purpose during pull-request recovery', async () => {
  let pullRequestLookups = 0;
  let appStoreCalls = 0;
  const prepare = createPrepareRequest({
    githubFactory: () => ({
      findOpenPullRequestForCommitAsync: async () => {
        pullRequestLookups += 1;
        return { number: '42', baseBranch: 'develop' };
      },
    }),
    ascFactory: () => ({
      getAppStoreVersions: async () => {
        appStoreCalls += 1;
        return { data: [] };
      },
      getPublishedWorkflowCommits: async () => {
        appStoreCalls += 1;
        return [];
      },
    }),
  });

  await assert.rejects(
    () => prepare({ profile, profilePath: '/tmp/example.yml' }, {
      repository: 'example/ios',
      purpose: 'beta',
      commit: COMMIT_SHA,
      branch: 'feature/player',
      current_marketing_version: '1.0',
    }),
    error => error.statusCode === 400 && /Beta builds must use develop/.test(error.message),
  );
  assert.equal(pullRequestLookups, 0);
  assert.equal(appStoreCalls, 0);
});

test('coalesces identical build preparation requests while they are in flight', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'build-secret';
  t.after(() => delete process.env[environmentName]);
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    prepare: async () => {
      calls += 1;
      await blocked;
      return { purpose: 'beta', marketing_version: '1.5', testflight_notes: 'Notes' };
    },
  });
  let receivedRequests = 0;
  server.on('request', () => { receivedRequests += 1; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const request = () => fetch(`http://127.0.0.1:${port}/v1/builds/prepare/example-ios`, {
    method: 'POST',
    headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'beta', commit: 'same' }),
  });

  const first = request();
  const second = request();
  while (receivedRequests < 2 || calls === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();

  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(calls, 1);
});

test('does not reuse a preparation result across immutable releases', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'build-secret';
  t.after(() => delete process.env[environmentName]);
  const prepareCache = new MemoryPrepareCache();
  let calls = 0;
  const prepare = async () => {
    calls += 1;
    return { purpose: 'beta', marketing_version: String(calls), testflight_notes: 'Notes' };
  };
  const servers = ['release-one', 'release-two'].map(deploymentSha => createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    deploymentSha,
    prepareCache,
    prepare,
  }));
  for (const server of servers) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
  }
  const request = server => fetch(
    `http://127.0.0.1:${server.address().port}/v1/builds/prepare/example-ios`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'beta', commit: 'same' }),
    },
  );

  const first = await request(servers[0]);
  const second = await request(servers[1]);

  assert.equal((await first.json()).marketing_version, '1');
  assert.equal((await second.json()).marketing_version, '2');
  assert.equal(calls, 2);
});

test('cancels timed-out preparation and lets a retry start fresh work', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'build-secret';
  t.after(() => delete process.env[environmentName]);
  let calls = 0;
  let aborts = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    prepare: (_entry, _payload, { signal }) => new Promise((resolve, reject) => {
      calls += 1;
      signal.addEventListener('abort', () => {
        aborts += 1;
        reject(signal.reason);
      }, { once: true });
    }),
    prepareTimeoutMs: 20,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/v1/builds/prepare/example-ios`, {
    method: 'POST',
    headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'beta' }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.match((await response.json()).error, /retry/i);
  const retry = await fetch(`http://127.0.0.1:${port}/v1/builds/prepare/example-ios`, {
    method: 'POST',
    headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'beta' }),
  });
  assert.equal(retry.status, 503);
  assert.equal(calls, 2);
  assert.equal(aborts, 2);
});

test('bounds unique in-flight preparation requests and asks excess clients to retry', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'build-secret';
  t.after(() => delete process.env[environmentName]);
  const releases = [];
  let calls = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    maxPrepareFlights: 2,
    prepare: () => new Promise(resolve => {
      calls += 1;
      releases.push(() => resolve({ purpose: 'beta', marketing_version: String(calls) }));
    }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const request = commit => fetch(
    `http://127.0.0.1:${server.address().port}/v1/builds/prepare/example-ios`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'beta', commit }),
    },
  );

  const first = request('first');
  const second = request('second');
  while (calls < 2) await new Promise(resolve => setImmediate(resolve));
  const excess = await request('third');
  assert.equal(excess.status, 503);
  assert.equal(excess.headers.get('retry-after'), '1');
  assert.match((await excess.json()).error, /capacity/i);
  assert.equal(calls, 2);

  releases.forEach(release => release());
  assert.deepEqual(
    (await Promise.all([first, second])).map(response => response.status),
    [200, 200],
  );
});

test('keeps timed-out abort-ignoring preparation work charged against capacity', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  process.env[environmentName] = 'build-secret';
  t.after(() => delete process.env[environmentName]);
  let calls = 0;
  let releaseStalled;
  const stalled = new Promise(resolve => { releaseStalled = resolve; });
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    maxPrepareFlights: 1,
    prepareTimeoutMs: 10,
    prepare: async () => {
      calls += 1;
      if (calls === 1) return stalled;
      return { purpose: 'beta', marketing_version: '2.0' };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const request = commit => fetch(
    `http://127.0.0.1:${server.address().port}/v1/builds/prepare/example-ios`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer build-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'beta', commit }),
    },
  );

  assert.equal((await request('stalled')).status, 503);
  const atCapacity = await request('new-work');
  assert.equal(atCapacity.status, 503);
  assert.equal(atCapacity.headers.get('retry-after'), '1');
  assert.equal(calls, 1);

  releaseStalled({ purpose: 'beta', marketing_version: '1.0' });
  await server.waitForBackground();
  const recovered = await request('new-work');
  assert.equal(recovered.status, 200);
  assert.equal(calls, 2);
});

test('caches published build history across preparation clients', async () => {
  let historyLoads = 0;
  const prepare = createPrepareRequest({
    githubFactory: () => ({
      getCommitSubject: () => 'Current commit',
      getPRDetails: () => ({ title: 'Improve player', body: '' }),
      getCommitSubjectsSince: async () => ({
        baseCommit: 'previous',
        baseBuildNumber: '1',
        baseMarketingVersion: '1.0',
        subjects: ['Current commit'],
      }),
    }),
    ascFactory: () => ({
      appId: null,
      getAppStoreVersions: async () => ({ data: [] }),
      getPublishedWorkflowCommits: async () => {
        historyLoads += 1;
        return [{ commitSha: 'previous', sourceBranch: 'feature/player' }];
      },
    }),
  });
  const entry = { profile, profilePath: '/tmp/example.yml' };
  const payload = {
    repository: 'example/ios',
    commit: COMMIT_SHA,
    branch: 'feature/player',
    target_branch: 'develop',
    pull_request: 42,
    current_marketing_version: '1.0',
  };

  await prepare(entry, payload);
  await prepare(entry, payload);

  assert.equal(historyLoads, 1);
});

test('does not renew stale published history indefinitely during an outage', async () => {
  let now = 1_000;
  let historyLoads = 0;
  let failHistory = false;
  const prepare = createPrepareRequest({
    historyCache: new AsyncTtlCache({ ttlMs: 10, maxEntries: 10, now: () => now }),
    githubFactory: () => ({
      getCommitSubjectAsync: async () => 'Current commit',
      getPRDetailsAsync: async () => ({ title: 'Improve player', body: '', headRefOid: COMMIT_SHA }),
      getCommitSubjectsSince: async () => ({
        baseCommit: 'previous',
        baseBuildNumber: '1',
        baseMarketingVersion: '1.0',
        subjects: ['Current commit'],
      }),
      getPullRequestCommitSubjectsAsync: async () => ['Current commit'],
    }),
    ascFactory: () => ({
      appId: null,
      getAppStoreVersions: async () => ({ data: [] }),
      getPublishedWorkflowCommits: async () => {
        historyLoads += 1;
        if (failHistory) throw new Error('App Store Connect history unavailable');
        return [{ commitSha: 'previous', sourceBranch: 'feature/player' }];
      },
    }),
  });
  const entry = { profile, profilePath: '/tmp/example.yml' };
  const payload = {
    repository: 'example/ios',
    commit: COMMIT_SHA,
    branch: 'feature/player',
    target_branch: 'develop',
    pull_request: 42,
    current_marketing_version: '1.0',
  };

  assert.deepEqual((await prepare(entry, payload)).warnings, []);
  now += 11;
  failHistory = true;
  assert.deepEqual((await prepare(entry, payload)).warnings, [
    'Published build history unavailable; using pull-request commits',
    'No ancestor published build found; using all pull-request commits',
  ]);
  assert.equal(historyLoads, 2);
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
  assert.equal(dispatched, 2);
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
  assert.deepEqual(calls, ['build-status', 'deploy', 'deploy']);
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
    prepareCache: new MemoryPrepareCache(),
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
  while (dispatched < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(dispatched, 2);
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
  while (dispatched < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(dispatched, 2);
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
