import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { FileDeliveryStore, MemoryDeliveryStore } from '../lib/delivery-store.js';

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/delivery-worker.js', import.meta.url));

async function temporaryState(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-deliveries-'));
  const stateDirectory = path.join(parent, 'state');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return stateDirectory;
}

test('reports the age of the oldest pending durable receipt on demand', async t => {
  const stateDirectory = await temporaryState(t);
  let now = 1_000;
  const store = new FileDeliveryStore({ stateDirectory, now: () => now });
  const claim = await store.claim('github:example:aged', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  now += 750;
  assert.deepEqual(await store.queueStatus({ includeAge: true }), {
    pending: 1,
    failed: 0,
    corrupt: 0,
    oldest_pending_age_ms: 750,
  });
  await store.complete(claim);
  assert.deepEqual(await store.queueStatus({ includeAge: true }), {
    pending: 0,
    failed: 0,
    corrupt: 0,
    oldest_pending_age_ms: null,
  });
});

test('persists duplicate receipts, retry cursors, and completion retention', async t => {
  const stateDirectory = await temporaryState(t);
  let now = 100_000;
  const store = new FileDeliveryStore({
    stateDirectory,
    retentionMs: 10,
    now: () => now,
  });
  const intent = { instance: 'example-ios', jobs: [{ mode: 'one' }, { mode: 'two' }] };
  const claim = await store.claim('github:example:delivery-1', intent);
  assert.ok(claim);
  assert.equal(await store.claim('github:example:delivery-1', intent), null);
  assert.equal(await store.advance(claim, 1), true);
  assert.equal(await store.retry(claim, new Error('temporary'), { delayMs: 50 }), true);
  assert.deepEqual(await store.claimPending(), []);
  now += 50;
  const [retry] = await store.claimPending();
  assert.equal(retry.cursor, 1);
  assert.equal(retry.attempts, 2);
  assert.equal(await store.complete(retry), true);
  assert.equal(await store.claim('github:example:delivery-1', intent), null);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });

  const completedReceipt = store.receiptFile('github:example:delivery-1');
  await fs.access(completedReceipt);
  now += 60_001;
  await store.claim('github:example:delivery-2', intent);
  await assert.rejects(fs.lstat(completedReceipt), error => error.code === 'ENOENT');
});

test('requires explicit recovery for dead letters and resets an expired completion cursor', async t => {
  const stateDirectory = await temporaryState(t);
  let now = 10_000;
  const store = new FileDeliveryStore({
    stateDirectory,
    retentionMs: 10,
    now: () => now,
  });
  const intent = { instance: 'example-ios', jobs: [{ mode: 'one' }, { mode: 'two' }] };

  const failed = await store.claim('github:example:dead-letter', intent);
  await store.fail(failed, new Error('bounded attempts exhausted'));
  assert.equal(await store.claim('github:example:dead-letter', intent), null);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
  assert.equal(await store.requeueFailed(), 1);
  const [requeued] = await store.claimPending();
  assert.deepEqual(requeued.intent, intent);
  assert.equal(requeued.attempts, 1);
  await store.complete(requeued);

  const completed = await store.claim('github:example:expired-completion', intent);
  await store.advance(completed, intent.jobs.length);
  await store.complete(completed);
  now += 11;
  const redelivery = await store.claim('github:example:expired-completion', intent);
  assert.ok(redelivery);
  assert.equal(redelivery.cursor, 0);
});

test('reclaims a crashed process and gives simultaneous recovery and redelivery one owner', async t => {
  const stateDirectory = await temporaryState(t);
  const key = 'github:example:two-process';
  const first = await execFileAsync(process.execPath, [worker, 'claim', stateDirectory, key, '0', '0']);
  assert.equal(JSON.parse(first.stdout).claimed, true);

  const store = new FileDeliveryStore({ stateDirectory });
  const [recovered] = await store.claimPending();
  assert.ok(recovered);
  assert.equal(recovered.attempts, 2);
  assert.equal(await store.advance(recovered, 1), true);
  assert.equal(await store.retry(recovered, new Error('retry'), { delayMs: 0 }), true);

  const startAt = Date.now() + 300;
  const [redelivery, recovery] = await Promise.all([
    execFileAsync(process.execPath, [worker, 'claim', stateDirectory, key, String(startAt), '300']),
    execFileAsync(process.execPath, [worker, 'recover', stateDirectory, key, String(startAt), '300']),
  ]);
  const results = [redelivery, recovery].map(result => JSON.parse(result.stdout));
  assert.equal(results.filter(result => result.claimed).length, 1);

  const [afterCrash] = await store.claimPending();
  assert.ok(afterCrash);
  assert.equal(afterCrash.cursor, 1);
  assert.equal(await store.complete(afterCrash), true);
});

test('does not let a recycled live PID strand a receipt indefinitely', async t => {
  const stateDirectory = await temporaryState(t);
  let now = 10_000;
  const original = new FileDeliveryStore({
    stateDirectory,
    now: () => now,
    isProcessAlive: () => true,
    processIdentity: async () => null,
    ownerLeaseMs: 100,
  });
  const claim = await original.claim('github:example:recycled-pid', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  assert.ok(claim);

  now += 101;
  const recovered = new FileDeliveryStore({
    stateDirectory,
    now: () => now,
    isProcessAlive: () => true,
    processIdentity: async () => null,
    ownerLeaseMs: 100,
  });
  const [reclaimed] = await recovered.claimPending();
  assert.ok(reclaimed);
  assert.equal(reclaimed.attempts, 2);
});

test('releases the kernel lock when persisting ownership fails', async t => {
  const stateDirectory = await temporaryState(t);
  let now = 10_000;
  const store = new FileDeliveryStore({ stateDirectory, now: () => now });
  const claim = await store.claim('github:example:write-failure', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  await store.retry(claim, new Error('retry'), { delayMs: 0 });
  const writeReceipt = store.writeReceipt.bind(store);
  let failed = false;
  store.writeReceipt = async (...args) => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    }
    return writeReceipt(...args);
  };

  await assert.rejects(store.claimPending(), /injected rename failure/);
  now += 1;
  const [recovered] = await store.claimPending();
  assert.ok(recovered);
});

test('does not acknowledge a duplicate before the first receipt is durable', async t => {
  const stateDirectory = await temporaryState(t);
  const first = new FileDeliveryStore({ stateDirectory });
  const second = new FileDeliveryStore({ stateDirectory });
  const writeReceipt = first.writeReceipt.bind(first);
  let releaseWrite;
  let writingStarted;
  const started = new Promise(resolve => { writingStarted = resolve; });
  first.writeReceipt = async (...args) => {
    writingStarted();
    await new Promise(resolve => { releaseWrite = resolve; });
    return writeReceipt(...args);
  };
  const intent = { instance: 'example-ios', jobs: [{ mode: 'one' }] };
  const initial = first.claim('github:example:initializing', intent);
  await started;
  let duplicateSettled = false;
  const duplicate = second.claim('github:example:initializing', intent)
    .then(value => { duplicateSettled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(duplicateSettled, false);
  releaseWrite();
  assert.ok(await initial);
  assert.equal(await duplicate, null);
});

test('surfaces corrupt receipts and can explicitly requeue dead letters', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const failed = await store.claim('github:example:failed', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  await store.fail(failed, new Error('permanent failure'));
  assert.equal(await store.requeueFailed(), 1);
  assert.deepEqual(await store.queueStatus(), { pending: 1, failed: 0, corrupt: 0 });

  const corrupt = await store.claim('github:example:corrupt', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  await fs.writeFile(corrupt.receiptFile, '{not-json', { mode: 0o600 });
  assert.deepEqual(await store.queueStatus(), { pending: 1, failed: 1, corrupt: 1 });
  await store.initialize();
  const claims = await store.claimPending();
  assert.equal(claims.length, 1);
  const quarantined = await store.quarantineCorrupt();
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0], /[/\\]corrupt[/\\]pending-/);
  assert.equal(await fs.readFile(quarantined[0], 'utf8'), '{not-json');
  assert.deepEqual(await store.queueStatus(), { pending: 1, failed: 0, corrupt: 0 });
});

test('inspects and selectively requeues reviewed dead letters with recovery history', async t => {
  const stateDirectory = await temporaryState(t);
  let now = 10_000;
  const store = new FileDeliveryStore({ stateDirectory, now: () => now });
  const intent = {
    instance: 'example-ios',
    jobs: [
      { mode: 'notes', purpose: 'beta' },
      {
        mode: 'deploy',
        purpose: 'production',
        deliveryId: 'delivery-123',
        commitSha: 'abcdef1234567890',
        branch: 'main',
        pullRequest: '65',
        workflowId: 'workflow-production',
        runId: 'build-run-42',
        buildNumber: 42,
        buildStatus: 'FAILED',
        completedAt: '2026-09-07T08:00:00Z',
        reconcileMetadata: true,
        untrustedDetail: 'must not be exposed',
      },
    ],
  };
  const first = await store.claim('github:example:selective-first', intent);
  await store.advance(first, 1);
  await store.fail(first, new Error('first delivery exhausted'));
  const second = await store.claim('github:example:selective-second', intent);
  await store.fail(second, new Error('second delivery exhausted'));

  const inspection = await store.inspectFailedReceipts();
  assert.deepEqual(inspection.corrupt, []);
  assert.equal(inspection.failed.length, 2);
  assert.deepEqual(
    inspection.failed.find(receipt => receipt.hash === first.receiptHash),
    {
      hash: first.receiptHash,
      instance: 'example-ios',
      cursor: 1,
      next_job: {
        mode: 'deploy',
        purpose: 'production',
        delivery_id: 'delivery-123',
        commit_sha: 'abcdef1234567890',
        branch: 'main',
        pull_request: '65',
        workflow_id: 'workflow-production',
        run_id: 'build-run-42',
        build_number: '42',
        build_status: 'FAILED',
        completed_at: '2026-09-07T08:00:00Z',
        reconcile_metadata: true,
      },
      attempts: 1,
      last_error: 'first delivery exhausted',
      updated_at: new Date(10_000).toISOString(),
    },
  );
  assert.equal('intent' in inspection.failed[0], false);

  await assert.rejects(
    store.requeueFailed({ expectedCount: 3 }),
    error => error.code === 'ECOUNTMISMATCH',
  );
  await assert.rejects(
    store.requeueFailed({ receiptHashes: [first.receiptHash, first.receiptHash] }),
    /must be unique/,
  );
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 2, corrupt: 0 });

  now = 20_000;
  assert.equal(await store.requeueFailed({ receiptHashes: [first.receiptHash] }), 1);
  assert.deepEqual(await store.queueStatus(), { pending: 1, failed: 1, corrupt: 0 });
  const requeuedReceipt = JSON.parse(await fs.readFile(
    store.receiptFileForHash(first.receiptHash, 'pending'),
    'utf8',
  ));
  assert.equal(requeuedReceipt.cursor, 1);
  assert.equal(requeuedReceipt.attempts, 0);
  assert.equal(requeuedReceipt.lastError, 'Manually requeued');
  assert.deepEqual(requeuedReceipt.recoveryHistory, [{
    failedAt: 10_000,
    attempts: 1,
    lastError: 'first delivery exhausted',
    requeuedAt: 20_000,
  }]);
  assert.deepEqual(
    (await store.inspectFailedReceipts()).failed.map(receipt => receipt.hash),
    [second.receiptHash],
  );
  const [recovered] = await store.claimPending();
  assert.deepEqual(recovered.recoveryHistory, requeuedReceipt.recoveryHistory);
  await store.fail(recovered, new Error('failed after manual recovery'));
  const recoveredReceipt = JSON.parse(await fs.readFile(
    store.receiptFileForHash(first.receiptHash, 'failed'),
    'utf8',
  ));
  assert.deepEqual(recoveredReceipt.recoveryHistory, requeuedReceipt.recoveryHistory);
});

test('preflights duplicate active state before requeueing any dead letter', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const intent = { instance: 'example-ios', jobs: [{ mode: 'deploy' }] };
  const first = await store.claim('github:example:preflight-first', intent);
  await store.fail(first, new Error('first failed'));
  const duplicate = await store.claim('github:example:preflight-duplicate', intent);
  await store.fail(duplicate, new Error('duplicate failed'));
  const failedReceipt = JSON.parse(await fs.readFile(
    store.receiptFileForHash(duplicate.receiptHash, 'failed'),
    'utf8',
  ));
  await fs.writeFile(
    store.receiptFileForHash(duplicate.receiptHash, 'complete'),
    `${JSON.stringify({ ...failedReceipt, state: 'complete' })}\n`,
    { mode: 0o600 },
  );

  const inspection = await store.inspectFailedReceipts();
  assert.deepEqual(inspection.corrupt, [duplicate.receiptHash]);
  await assert.rejects(
    store.requeueFailed({ expectedCount: 1 }),
    error => error.code === 'ECORRUPTRECEIPT',
  );
  await fs.access(store.receiptFileForHash(first.receiptHash, 'failed'));
  await fs.access(store.receiptFileForHash(duplicate.receiptHash, 'failed'));
  await assert.rejects(
    fs.access(store.receiptFileForHash(first.receiptHash, 'pending')),
    error => error.code === 'ENOENT',
  );
});

test('memory delivery recovery supports the same selective receipt contract', async () => {
  const store = new MemoryDeliveryStore({ now: () => 10_000 });
  const intent = { instance: 'example-ios', jobs: [{ mode: 'deploy' }] };
  const first = await store.claim('github:example:memory-first', intent);
  await store.fail(first, new Error('first failed'));
  const second = await store.claim('github:example:memory-second', intent);
  await store.fail(second, new Error('second failed'));
  const inspection = await store.inspectFailedReceipts();
  const firstHash = crypto.createHash('sha256')
    .update('github:example:memory-first')
    .digest('hex');

  assert.equal(inspection.failed.length, 2);
  assert.equal(await store.requeueFailed({ receiptHashes: [firstHash] }), 1);
  assert.deepEqual(await store.queueStatus(), { pending: 1, failed: 1, corrupt: 0 });
  assert.deepEqual(
    (await store.inspectFailedReceipts()).failed.map(receipt => receipt.last_error),
    ['second failed'],
  );
});

test('memory delivery recovery rejects a receipt released across its inspection boundary', async () => {
  const store = new MemoryDeliveryStore({ now: () => 10_000 });
  const claim = await store.claim('github:example:memory-race', {
    instance: 'example-ios', jobs: [{ mode: 'deploy' }],
  });
  await store.fail(claim, new Error('failed before concurrent release'));
  const hash = crypto.createHash('sha256')
    .update('github:example:memory-race')
    .digest('hex');
  const inspectFailedReceipts = store.inspectFailedReceipts.bind(store);
  store.inspectFailedReceipts = async () => {
    const inspection = await inspectFailedReceipts();
    await store.release(claim);
    return inspection;
  };

  await assert.rejects(
    store.requeueFailed({ receiptHashes: [hash] }),
    error => error.code === 'ENOTFAILED',
  );
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });
});

test('recovery scans pending work without locking the failed backlog', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const failed = await store.claim('github:example:manual-only', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  await store.fail(failed, new Error('manual recovery required'));
  const takeOwnership = store.takeOwnership.bind(store);
  let ownershipAttempts = 0;
  store.takeOwnership = async (...args) => {
    ownershipAttempts += 1;
    return takeOwnership(...args);
  };

  assert.deepEqual(await store.claimPending(), []);
  assert.equal(ownershipAttempts, 0);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
});

test('quarantines duplicate valid state files that queue health reports as corrupt', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const claim = await store.claim('github:example:duplicate-states', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  const pending = JSON.parse(await fs.readFile(claim.receiptFile, 'utf8'));
  await fs.writeFile(
    store.receiptFileForHash(claim.receiptHash, 'failed'),
    `${JSON.stringify({ ...pending, state: 'failed', ownerPid: null, ownerIdentity: null })}\n`,
    { mode: 0o600 },
  );

  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 1, corrupt: 1 });
  const quarantined = await store.quarantineCorrupt();
  assert.equal(quarantined.length, 2);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });
});

test('quarantines a valid-JSON receipt that could skip unfinished jobs', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const claim = await store.claim('github:example:invalid-cursor', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  const receipt = JSON.parse(await fs.readFile(claim.receiptFile, 'utf8'));
  await fs.writeFile(
    claim.receiptFile,
    `${JSON.stringify({ ...receipt, cursor: Number.MAX_SAFE_INTEGER })}\n`,
    { mode: 0o600 },
  );

  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 1, corrupt: 1 });
  assert.deepEqual(await store.claimPending(), []);
  const quarantined = await store.quarantineCorrupt();
  assert.equal(quarantined.length, 1);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });
});

test('surfaces an expired corrupt completion until it is explicitly quarantined', async t => {
  const stateDirectory = await temporaryState(t);
  let now = 10_000;
  const store = new FileDeliveryStore({
    stateDirectory,
    retentionMs: 10,
    now: () => now,
  });
  const key = 'github:example:corrupt-completion';
  const intent = { instance: 'example-ios', jobs: [{ mode: 'one' }] };
  const claim = await store.claim(key, intent);
  await store.complete(claim);
  await fs.writeFile(claim.receiptFile, '{not-json', { mode: 0o600 });

  now += 60_001;
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 1, corrupt: 1 });
  await assert.rejects(
    store.claim(key, intent),
    error => error.code === 'ECORRUPTRECEIPT',
  );
  await assert.rejects(fs.lstat(store.receiptFileForHash(claim.receiptHash, 'complete')), {
    code: 'ENOENT',
  });
  await fs.access(store.receiptFileForHash(claim.receiptHash, 'failed'));

  const quarantined = await store.quarantineCorrupt();
  assert.equal(quarantined.length, 1);
  assert.deepEqual(await store.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });
  assert.ok(await store.claim(key, intent));
});

test('reconstructs accepted work if its receipt vanishes before a durable disposition', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const key = 'github:example:vanished-after-202';
  const intent = { instance: 'example-ios', jobs: [{ mode: 'one' }, { mode: 'two' }] };
  const claim = await store.claim(key, intent);

  await fs.unlink(claim.receiptFile);
  assert.equal(await store.advance(claim, 1), true);
  assert.equal(JSON.parse(await fs.readFile(claim.receiptFile, 'utf8')).cursor, 1);

  await fs.unlink(claim.receiptFile);
  assert.equal(await store.retry(claim, new Error('retry'), { delayMs: 0 }), true);
  const recoveringStore = new FileDeliveryStore({ stateDirectory });
  const [recovered] = await recoveringStore.claimPending();
  assert.ok(recovered);
  assert.equal(recovered.cursor, 1);
  assert.deepEqual(recovered.intent, intent);

  await fs.unlink(recovered.receiptFile);
  assert.equal(await recoveringStore.complete(recovered), true);
  assert.equal(await recoveringStore.claim(key, intent), null);
  assert.deepEqual(await recoveringStore.queueStatus(), { pending: 0, failed: 0, corrupt: 0 });

  const failed = await recoveringStore.claim('github:example:vanished-before-fail', intent);
  await fs.unlink(failed.receiptFile);
  assert.equal(await recoveringStore.fail(failed, new Error('permanent')), true);
  assert.deepEqual(await recoveringStore.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
});

test('repairs an interrupted state move from the durable state recorded in place', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const claim = await store.claim('github:example:interrupted-move', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  const moveReceiptLocked = store.moveReceiptLocked.bind(store);
  let interrupted = false;
  store.moveReceiptLocked = async (...args) => {
    if (!interrupted) {
      interrupted = true;
      throw Object.assign(new Error('simulated crash before rename'), { code: 'EIO' });
    }
    return moveReceiptLocked(...args);
  };
  await assert.rejects(store.fail(claim, new Error('permanent')), /simulated crash/);

  const recoveredStore = new FileDeliveryStore({ stateDirectory });
  assert.deepEqual(await recoveredStore.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
  assert.equal(await recoveredStore.requeueFailed(), 1);
  assert.deepEqual(await recoveredStore.queueStatus(), { pending: 1, failed: 0, corrupt: 0 });
});

test('does not strand a manual requeue interrupted after its directory move', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  const failed = await store.claim('github:example:interrupted-requeue', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  await store.fail(failed, new Error('manual recovery required'));

  const writeReceipt = store.writeReceipt.bind(store);
  let interrupted = false;
  store.writeReceipt = async (file, receipt, options) => {
    if (
      !interrupted
      && path.dirname(file) === store.pendingDirectory
      && receipt.state === 'pending'
    ) {
      interrupted = true;
      throw Object.assign(new Error('simulated crash after requeue move'), { code: 'EIO' });
    }
    return writeReceipt(file, receipt, options);
  };
  await assert.rejects(store.requeueFailed(), /simulated crash/);

  const recoveredStore = new FileDeliveryStore({ stateDirectory });
  assert.deepEqual(await recoveredStore.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
  assert.deepEqual(await recoveredStore.claimPending(), []);
  assert.deepEqual(await recoveredStore.queueStatus(), { pending: 0, failed: 1, corrupt: 0 });
  assert.equal(await recoveredStore.requeueFailed(), 1);
  const [recovered] = await recoveredStore.claimPending();
  assert.ok(recovered);
  assert.equal(recovered.cursor, 0);
});

test('health and recovery do not scan a large completed backlog', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  await store.initialize();

  const completedCount = 2_000;
  for (let offset = 0; offset < completedCount; offset += 100) {
    await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      const hash = crypto.createHash('sha256')
        .update(`github:example:completed-${offset + index}`)
        .digest('hex');
      await fs.writeFile(store.receiptFileForHash(hash, 'complete'), `${JSON.stringify({
        version: 2,
        receiptHash: hash,
        state: 'complete',
        token: crypto.randomUUID(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })}\n`, { mode: 0o600 });
    }));
  }

  const pending = await store.claim('github:example:pending-amid-backlog', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  await store.retry(pending, new Error('retry'), { delayMs: 0 });
  const failed = await store.claim('github:example:failed-amid-backlog', {
    instance: 'example-ios', jobs: [{ mode: 'one' }],
  });
  await store.fail(failed, new Error('failed'));

  const readReceipt = store.readReceipt;
  let completedReads = 0;
  store.readReceipt = async file => {
    if (path.dirname(file) === store.completeDirectory) completedReads += 1;
    return readReceipt(file);
  };

  assert.deepEqual(await store.queueStatus(), { pending: 1, failed: 1, corrupt: 0 });
  assert.equal(completedReads, 0);
  const recovered = await store.claimPending();
  assert.equal(recovered.length, 1);
  assert.ok(completedReads <= 2, `recovery read ${completedReads} completed receipts`);
});

test('initialization does not block serving readiness on retention maintenance', async t => {
  const stateDirectory = await temporaryState(t);
  const store = new FileDeliveryStore({ stateDirectory });
  let pruned = false;
  store.maybePrune = async () => {
    pruned = true;
    throw new Error('maintenance must not run during initialization');
  };

  await store.initialize();
  assert.equal(pruned, false);
});
