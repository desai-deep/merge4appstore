import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForLock } from '../lib/lock.js';

test('waits for a busy repository lock instead of dropping the job', async () => {
  let attempts = 0;
  const acquired = await waitForLock({
    timeoutMs: 100,
    retryMs: 1,
    sleep: async () => {},
    now: () => 0,
    acquire: () => {
      attempts += 1;
      return attempts === 3;
    },
  });

  assert.equal(acquired, true);
  assert.equal(attempts, 3);
});

test('reports a lock timeout as an incomplete job', async () => {
  assert.equal(await waitForLock({
    timeoutMs: 0,
    retryMs: 1,
    acquire: () => false,
  }), false);
});
