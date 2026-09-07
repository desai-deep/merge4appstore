import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { FileDeliveryStore } from '../lib/delivery-store.js';

const execFileAsync = promisify(execFile);
const recoveryScript = fileURLToPath(
  new URL('../scripts/retry-webhook-deliveries.js', import.meta.url),
);

async function temporaryState(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-recovery-cli-'));
  const stateDirectory = path.join(parent, 'state');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return stateDirectory;
}

async function runRecovery(stateDirectory, args = []) {
  try {
    const result = await execFileAsync(process.execPath, [recoveryScript, ...args], {
      encoding: 'utf8',
      env: { ...process.env, MERGE4APPSTORE_STATE_DIR: stateDirectory },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function failDelivery(store, key, message) {
  const claim = await store.claim(key, {
    instance: 'example-ios',
    jobs: [{ mode: 'deploy', purpose: 'production' }],
  });
  await store.fail(claim, new Error(message));
  return claim.receiptHash;
}

test('delivery recovery CLI inspects without mutating by default', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const hash = await failDelivery(store, 'github:example:inspect-only', 'manual review');

  const result = await runRecovery(stateDirectory);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'inspect');
  assert.deepEqual(output.queue, { pending: 0, failed: 1, corrupt: 0 });
  assert.equal(output.failed[0].hash, hash);
  assert.equal(output.failed[0].last_error, 'manual review');
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
});

test('delivery recovery CLI selects receipts and count-guards a full retry', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const firstHash = await failDelivery(store, 'github:example:cli-first', 'first failed');
  await failDelivery(store, 'github:example:cli-second', 'second failed');

  const mismatch = await runRecovery(stateDirectory, ['--all', '--confirm-count', '1']);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /expected 1, found 2/);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 2, corrupt: 0 });

  const selected = await runRecovery(stateDirectory, ['--receipt', firstHash]);
  assert.equal(selected.code, 0);
  assert.equal(JSON.parse(selected.stdout).requeued, 1);
  assert.deepEqual(await store.queueStatus(), { pending: 1, failed: 1, corrupt: 0 });

  const remaining = await runRecovery(stateDirectory, ['--all', '--confirm-count=1']);
  assert.equal(remaining.code, 0);
  assert.equal(JSON.parse(remaining.stdout).requeued, 1);
  assert.deepEqual(await store.queueStatus(), { pending: 2, failed: 0, corrupt: 0 });
});

test('delivery recovery CLI refuses ambiguous mutation options before touching the queue', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  await failDelivery(store, 'github:example:cli-refusal', 'still failed');

  const missingConfirmation = await runRecovery(stateDirectory, ['--all']);
  assert.equal(missingConfirmation.code, 1);
  assert.match(missingConfirmation.stderr, /requires --confirm-count/);
  const malformedHash = await runRecovery(stateDirectory, ['--receipt', 'not-a-hash']);
  assert.equal(malformedHash.code, 1);
  assert.match(malformedHash.stderr, /64-character hexadecimal hash/);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
});
