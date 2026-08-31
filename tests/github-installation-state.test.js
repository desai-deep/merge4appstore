import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileGitHubInstallationState } from '../lib/github-installation-state.js';

function temporaryState(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merge4appstore-github-installation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('persists private installation suspension state across worker restarts', async t => {
  const stateDirectory = temporaryState(t);
  const firstWorker = new FileGitHubInstallationState({ stateDirectory });
  await firstWorker.initialize();
  await firstWorker.setSuspended('456', true, {
    eventAt: '2026-08-31T10:00:00Z',
    deliveryId: 'suspend-one',
  });

  const restartedWorker = new FileGitHubInstallationState({ stateDirectory });
  await restartedWorker.initialize();
  assert.equal(await restartedWorker.isSuspended(456), true);
  const directory = path.join(stateDirectory, 'github-installations');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, '456.json')).mode & 0o777, 0o600);
});

test('coordinates workers and ignores an older installation lifecycle event', async t => {
  const stateDirectory = temporaryState(t);
  const firstWorker = new FileGitHubInstallationState({ stateDirectory });
  const secondWorker = new FileGitHubInstallationState({ stateDirectory });
  await Promise.all([firstWorker.initialize(), secondWorker.initialize()]);

  await Promise.all([
    firstWorker.setSuspended(456, false, {
      eventAt: '2026-08-31T10:02:00Z',
      deliveryId: 'newer-unsuspend',
    }),
    secondWorker.setSuspended(456, true, {
      eventAt: '2026-08-31T10:01:00Z',
      deliveryId: 'older-suspend',
    }),
  ]);

  const state = await firstWorker.state(456);
  assert.equal(state.status, 'active');
  assert.equal(state.delivery_id, 'newer-unsuspend');
});

test('fails closed for a writable or corrupt installation state file', async t => {
  const stateDirectory = temporaryState(t);
  const state = new FileGitHubInstallationState({ stateDirectory });
  await state.initialize();
  await state.setSuspended(456, true);
  const file = path.join(stateDirectory, 'github-installations', '456.json');

  fs.chmodSync(file, 0o644);
  await assert.rejects(() => state.isSuspended(456), /Unsafe GitHub installation state file/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, '{not-json\n', { mode: 0o600 });
  await assert.rejects(
    () => state.isSuspended(456),
    error => error.code === 'ECORRUPTINSTALLATIONSTATE',
  );
});
