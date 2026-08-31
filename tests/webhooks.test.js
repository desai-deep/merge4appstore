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
import { FileDeliveryStore } from '../lib/file-delivery-store.js';
import {
  FileGitHubInstallationState,
  MemoryGitHubInstallationState,
} from '../lib/github-installation-state.js';
import { GitHubAPI } from '../lib/github.js';
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
  createJobRunner,
  createSerialDispatcher,
  createVersionRequest,
  createWebhookServer,
  githubWebhookLogMetadata,
  entriesForGitHubAppEvent,
  githubEventDeliveryKey,
  inspectDeploymentTransactions,
  jobEnvironment,
  loadProfiles,
  runJob,
  singleHeader,
  webhookDeliveryKey,
  xcodeWebhookLogMetadata,
} from '../webhook-server.js';

const profile = {
  instance: 'example-ios',
  repository: { owner: 'example', name: 'ios', github_id: 11, beta_branch: 'develop', production_branch: 'main' },
  versioning: { initial_version: '1.1' },
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

test('builds bounded webhook log metadata without request secrets or bodies', () => {
  const github = githubWebhookLogMetadata('pull_request', 'delivery-1', {
    action: 'synchronize',
    pull_request: {
      number: 67,
      head: { ref: 'feature', sha: COMMIT_SHA },
      base: { ref: 'develop' },
    },
    secret: 'must-not-appear',
  });
  assert.deepEqual(github, {
    provider: 'github',
    event: 'pull_request',
    delivery_id: 'delivery-1',
    action: 'synchronize',
    ref: null,
    before_sha: null,
    after_sha: null,
    pull_request: 67,
    source_branch: 'feature',
    target_branch: 'develop',
    head_sha: COMMIT_SHA,
  });
  assert.doesNotMatch(JSON.stringify(github), /must-not-appear/);

  const xcode = xcodeWebhookLogMetadata({
    metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
    ciWorkflow: { id: 'wf-pr' },
    ciBuildRun: {
      id: 'run-1',
      attributes: {
        completionStatus: 'SUCCEEDED',
        sourceCommit: { commitSha: COMMIT_SHA },
      },
    },
  }, 'wf-pr:run-1:BUILD_COMPLETED:SUCCEEDED');
  assert.deepEqual(xcode, {
    provider: 'xcode_cloud',
    delivery_id: 'wf-pr:run-1:BUILD_COMPLETED:SUCCEEDED',
    event: 'BUILD_COMPLETED',
    workflow_id: 'wf-pr',
    run_id: 'run-1',
    completion_status: 'SUCCEEDED',
    commit_sha: COMMIT_SHA,
  });
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

test('builds ordinary pull requests targeting any branch', () => {
  const pull_request = { number: 75, base: { ref: 'staging' }, head: { ref: 'feature', sha: 'def456' } };
  const repository = { full_name: 'example/ios' };

  for (const action of ['opened', 'reopened', 'synchronize']) {
    assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
      action, pull_request, repository,
    }, action), [{
      mode: 'trigger', purpose: 'pull_request', commitSha: 'def456', branch: 'feature', pullRequest: '75', deliveryId: action,
    }]);
  }

  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { body: { from: 'Old notes' } },
  }, 'notes'), [{
    mode: 'notes', purpose: 'pull_request', commitSha: 'def456', branch: 'feature', pullRequest: '75', deliveryId: 'notes',
  }]);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { base: { ref: { from: 'another-branch' } } },
  }, 'base'), [{
    mode: 'trigger', purpose: 'pull_request', commitSha: 'def456', branch: 'feature', pullRequest: '75', deliveryId: 'base',
  }]);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'closed', pull_request, repository,
  }, 'closed'), [{ mode: 'expire', deliveryId: 'closed' }]);
});

test('does not treat the configured release pull request as an ordinary production-target pull request', () => {
  const pull_request = { number: 73, base: { ref: 'main' }, head: { ref: 'develop', sha: 'release123' } };
  const repository = { full_name: 'example/ios' };
  const releaseProfile = { ...profile, release_pull_request: true };

  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'opened', pull_request, repository,
  }, 'opened'), []);
  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'closed', pull_request, repository,
  }, 'closed'), []);
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
  }, 'disabled-release-edit'), [{
    mode: 'notes', purpose: 'pull_request', commitSha: 'release123', branch: 'develop', pullRequest: '65', deliveryId: 'disabled-release-edit',
  }]);
});

test('refreshes App Store release notes when a merged automated release pull request title changes', () => {
  const pull_request = {
    number: 65,
    merged: true,
    merge_commit_sha: 'production123',
    base: { ref: 'main' },
    head: { ref: 'develop', sha: 'release123' },
  };
  const repository = { full_name: 'example/ios' };
  const releaseProfile = { ...profile, release_pull_request: true };

  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { title: { from: 'Old title' } },
  }, 'release-title-edit'), [{
    mode: 'release-notes',
    commitSha: 'production123',
    pullRequest: '65',
    deliveryId: 'release-title-edit',
  }]);

  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'edited',
    pull_request,
    repository,
    changes: {
      body: { from: 'Old release notes' },
      title: { from: 'Old title' },
    },
  }, 'release-body-title-edit'), [{
    mode: 'release-notes',
    commitSha: 'production123',
    pullRequest: '65',
    deliveryId: 'release-body-title-edit',
  }, {
    mode: 'notes',
    purpose: 'beta',
    commitSha: 'release123',
    branch: 'develop',
    pullRequest: '65',
    deliveryId: 'release-body-title-edit',
  }]);
});

test('does not refresh App Store release notes for an unmerged or unconfigured release pull request', () => {
  const pull_request = {
    number: 65,
    merged: false,
    merge_commit_sha: 'production123',
    base: { ref: 'main' },
    head: { ref: 'develop', sha: 'release123' },
  };
  const repository = { full_name: 'example/ios' };
  const releaseProfile = { ...profile, release_pull_request: true };

  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'edited', pull_request, repository, changes: { title: { from: 'Old title' } },
  }, 'unmerged-release-title-edit'), []);

  assert.deepEqual(jobsForGitHubEvent(releaseProfile, 'pull_request', {
    action: 'edited',
    pull_request: { ...pull_request, merged: true, merge_commit_sha: null },
    repository,
    changes: { title: { from: 'Old title' } },
  }, 'missing-merge-sha-title-edit'), []);

  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', {
    action: 'edited',
    pull_request: { ...pull_request, merged: true },
    repository,
    changes: { title: { from: 'Old title' } },
  }, 'disabled-release-title-edit'), []);
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

test('passes release-note attribution to its dedicated process', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let args;
  let environment;
  const result = runJob(
    { profile, profilePath: '/tmp/example.yml' },
    {
      mode: 'release-notes',
      commitSha: 'production123',
      pullRequest: '65',
      deliveryId: 'release-title-edit',
    },
    (_executable, receivedArgs, options) => {
      args = receivedArgs;
      environment = options.env;
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  );

  assert.equal(await result, 0);
  assert.equal(args[1], 'release-notes');
  assert.equal(environment.BUILD_COMMIT_SHA, 'production123');
  assert.equal(environment.BUILD_PULL_REQUEST, '65');
  assert.equal(environment.BUILD_SOURCE_DELIVERY_ID, 'release-title-edit');
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
    github_app_mode: 'shadow',
    github_app_ready: false,
    github_classic_webhooks_enabled: true,
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

test('distinguishes a missing server token from invalid client authentication', async t => {
  const environmentName = 'MERGE4APPSTORE_BUILD_TOKEN_EXAMPLE_IOS';
  delete process.env[environmentName];
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/v1/builds/version/example-ios?workflow_id=wf-beta`,
    { headers: { authorization: 'Bearer client-token' } },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.deepEqual(await response.json(), { error: 'Version token is not configured' });
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

test('logs every authenticated webhook receipt including duplicates', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  const records = [];
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    dispatch: async () => 0,
    webhookLogger: record => records.push(record),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/webhooks/xcode-cloud/example-ios/xcode-secret`;
  const body = JSON.stringify({
    metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
    ciWorkflow: { id: 'wf-pr' },
    ciBuildRun: { id: 'logged-run', attributes: { completionStatus: 'FAILED' } },
  });

  assert.equal((await fetch(url, { method: 'POST', body })).status, 202);
  await server.waitForBackground();
  assert.equal((await fetch(url, { method: 'POST', body })).status, 200);

  assert.deepEqual(records.map(record => ({
    type: record.type,
    instance: record.instance,
    provider: record.provider,
    event: record.event,
    workflow_id: record.workflow_id,
    run_id: record.run_id,
    disposition: record.disposition,
    jobs: record.jobs,
  })), [{
    type: 'webhook_received',
    instance: 'example-ios',
    provider: 'xcode_cloud',
    event: 'BUILD_COMPLETED',
    workflow_id: 'wf-pr',
    run_id: 'logged-run',
    disposition: 'accepted',
    jobs: ['build-status:pull_request'],
  }, {
    type: 'webhook_received',
    instance: 'example-ios',
    provider: 'xcode_cloud',
    event: 'BUILD_COMPLETED',
    workflow_id: 'wf-pr',
    run_id: 'logged-run',
    disposition: 'duplicate',
    jobs: ['build-status:pull_request'],
  }]);
  assert.match(records[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('does not let a webhook log sink failure reject or strand a delivery', async t => {
  process.env.XCODE_CLOUD_WEBHOOK_TOKEN = 'xcode-secret';
  t.after(() => delete process.env.XCODE_CLOUD_WEBHOOK_TOKEN);
  let dispatched = 0;
  let logAttempts = 0;
  const server = createTestWebhookServer({
    profiles: { 'example-ios': { profile, profilePath: '/tmp/example.yml' } },
    dispatch: async () => { dispatched += 1; return 0; },
    webhookLogger: () => {
      logAttempts += 1;
      if (logAttempts === 1) throw new Error('log sink unavailable');
      return Promise.reject(new Error('async log sink unavailable'));
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/webhooks/xcode-cloud/example-ios/xcode-secret`;
  const body = JSON.stringify({
    metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
    ciWorkflow: { id: 'wf-pr' },
    ciBuildRun: { id: 'log-failure-run', attributes: { completionStatus: 'FAILED' } },
  });

  assert.equal((await fetch(url, { method: 'POST', body })).status, 202);
  await server.waitForBackground();
  assert.equal(dispatched, 1);
  assert.equal((await fetch(url, { method: 'POST', body })).status, 200);
  assert.equal(logAttempts, 2);
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
