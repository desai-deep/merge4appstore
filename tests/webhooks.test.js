import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  jobsForGitHubEvent,
  jobsForXcodeCloudEvent,
  verifyGitHubSignature,
} from '../lib/webhooks.js';

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
});

test('maps pull request lifecycle events to trigger and expiry jobs', () => {
  const pull_request = { number: 42, base: { ref: 'develop' }, head: { ref: 'feature', sha: 'abc123' } };
  const repository = { full_name: 'example/ios' };
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', { action: 'opened', pull_request, repository }, 'one'), [{
    mode: 'trigger', purpose: 'pull_request', commitSha: 'abc123', branch: 'feature', pullRequest: '42', deliveryId: 'one',
  }]);
  assert.deepEqual(jobsForGitHubEvent(profile, 'pull_request', { action: 'closed', pull_request, repository }, 'two'), [{ mode: 'expire', deliveryId: 'two' }]);
});

test('maps beta and production pushes to their managed build purposes', () => {
  const repository = { full_name: 'example/ios' };
  assert.equal(jobsForGitHubEvent(profile, 'push', { ref: 'refs/heads/develop', after: 'abc', repository }, 'one')[0].purpose, 'beta');
  assert.equal(jobsForGitHubEvent(profile, 'push', { ref: 'refs/heads/main', after: 'def', repository }, 'two')[0].purpose, 'production');
  assert.deepEqual(jobsForGitHubEvent(profile, 'push', { ref: 'refs/heads/feature', after: 'ghi', repository }, 'three'), []);
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
