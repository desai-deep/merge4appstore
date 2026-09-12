#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createWebhookServer } from '../webhook-server.js';
import { MemoryDeliveryStore } from '../lib/delivery-store.js';

// Synthetic events exercise the real HTTP receiver without GitHub credentials.
const secret = crypto.randomBytes(32).toString('hex');
const profile = {
  instance: 'demo-ios',
  repository: {
    owner: 'demo', name: 'ios', github_id: 11,
    beta_branch: 'develop', production_branch: 'main',
  },
  apps: { prod: {
    app_id: '1', bundle_id: 'example.demo', name: 'Demo',
    workflows: { beta: 'demo-beta' },
  } },
  build: { trigger_mode: 'managed', purposes: { beta: { workflow: 'beta' } } },
};
let dispatches = 0;
const server = createWebhookServer({
  profiles: { 'demo-ios': { profile, profilePath: null } },
  deliveryStore: new MemoryDeliveryStore(),
  authenticator: null,
  githubAppMode: 'shadow',
  githubAppSecret: secret,
  classicGitHubWebhooksEnabled: true,
  dispatch: async () => { dispatches += 1; return 0; },
  version: async () => { throw new Error('Version allocation is disabled in the demo'); },
});

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/webhooks/github-app`;
  console.log('Local GitHub App demo — synthetic events, real HTTP receiver, shadow mode.');
  const body = JSON.stringify({
    installation: { id: 456 },
    repository: { id: 11, full_name: 'demo/ios' },
    ref: 'refs/heads/develop', after: 'a'.repeat(40),
  });
  async function send(delivery, signingSecret) {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': delivery,
        'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', signingSecret).update(body).digest('hex')}`,
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  }
  const accepted = await send('demo-push', secret);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.mode, 'shadow');
  assert.deepEqual(accepted.body.jobs, ['trigger:beta']);
  console.log('PASS: Signed develop push maps to trigger:beta (HTTP 202).');
  await server.waitForBackground();
  const duplicate = await send('demo-push', secret);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  console.log('PASS: Repeated delivery is recognized as a duplicate (HTTP 200).');
  const rejected = await send('demo-invalid', 'wrong-secret');
  assert.equal(rejected.status, 401);
  console.log('PASS: Invalid signature is rejected (HTTP 401).');
  await server.waitForBackground();
  assert.equal(dispatches, 0);
  console.log('PASS: No build or release jobs were dispatched.');
  console.log('Live installation authentication still requires a registered App and private key.');
} finally {
  server.stopBackgroundRecovery();
  await new Promise(resolve => server.close(resolve));
}
