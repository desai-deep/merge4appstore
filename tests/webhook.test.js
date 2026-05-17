import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWebhookPath,
  DeliveryDeduper,
  shouldTriggerDeploy,
} from '../lib/webhook.js';

test('buildWebhookPath appends a token suffix when configured', () => {
  assert.equal(
    buildWebhookPath('/webhooks/xcode-cloud', 'secret-token'),
    '/webhooks/xcode-cloud/secret-token'
  );
});

test('shouldTriggerDeploy accepts a successful completed build for the expected workflow', () => {
  const decision = shouldTriggerDeploy({
    metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
    ciWorkflow: { id: 'workflow-123', attributes: { name: 'Publish to App Store' } },
    ciBuildRun: {
      id: 'run-1',
      attributes: {
        number: 42,
        executionProgress: 'COMPLETE',
        completionStatus: 'SUCCEEDED',
      },
    },
  }, 'workflow-123');

  assert.equal(decision.accepted, true);
  assert.equal(decision.event.buildNumber, '42');
});

test('shouldTriggerDeploy rejects non-succeeded build completions', () => {
  const decision = shouldTriggerDeploy({
    metadata: { attributes: { eventType: 'BUILD_COMPLETED' } },
    ciWorkflow: { id: 'workflow-123' },
    ciBuildRun: {
      id: 'run-2',
      attributes: {
        number: 43,
        executionProgress: 'COMPLETE',
        completionStatus: 'FAILED',
      },
    },
  }, 'workflow-123');

  assert.equal(decision.accepted, false);
  assert.match(decision.reason, /FAILED/);
});

test('DeliveryDeduper suppresses duplicate run ids', () => {
  const deduper = new DeliveryDeduper(60_000);
  const event = {
    deliveryId: 'delivery-1',
    buildRunId: 'run-1',
    workflowId: 'workflow-123',
    buildNumber: '44',
  };

  assert.equal(deduper.remember(event), false);
  assert.equal(deduper.remember(event), true);
});
