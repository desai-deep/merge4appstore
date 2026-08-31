import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareMarketingVersions,
  FileVersionStateStore,
  MemoryVersionStateStore,
  nextMinorMarketingVersion,
  versionForPurpose,
} from '../lib/version-state.js';

test('compares and advances two- and three-part marketing versions', () => {
  assert.equal(compareMarketingVersions('1.4', '1.4.0'), 0);
  assert.equal(compareMarketingVersions('1.5', '1.4.9'), 1);
  assert.equal(nextMinorMarketingVersion('1.4'), '1.5');
  assert.equal(nextMinorMarketingVersion('1.4.2'), '1.5.0');
});

test('advances development at submission and production at release', async () => {
  let time = Date.parse('2026-08-31T12:00:00Z');
  const store = new MemoryVersionStateStore({ now: () => time });

  const initial = await store.getOrInitialize('example-ios', '1.5');
  assert.equal(versionForPurpose(initial, 'production'), '1.5');
  assert.equal(versionForPurpose(initial, 'pull_request'), '1.5');

  time += 1_000;
  const submitted = await store.recordSubmitted('example-ios', '1.5', '1.5', {
    sourceId: 'version-15',
  });
  assert.equal(submitted.productionVersion, '1.5');
  assert.equal(submitted.developmentVersion, '1.6');
  assert.equal(submitted.generation, 2);
  assert.equal(submitted.reason, 'app_review_submitted');

  time += 1_000;
  const released = await store.recordReleased('example-ios', '1.5', '1.5', {
    sourceId: 'build-150',
  });
  assert.equal(released.productionVersion, '1.6');
  assert.equal(released.developmentVersion, '1.6');
  assert.equal(released.generation, 3);
  assert.equal(versionForPurpose(released, 'beta'), '1.6');
});

test('repeated and stale lifecycle observations never advance or regress twice', async () => {
  const store = new MemoryVersionStateStore();
  const first = await store.recordSubmitted('example-ios', '1.5', '1.5', {
    sourceId: 'version-15',
  });
  const duplicate = await store.recordSubmitted('example-ios', '1.5', '1.5', {
    sourceId: 'version-15',
  });
  const staleRelease = await store.recordReleased('example-ios', '1.5', '1.4', {
    sourceId: 'build-140',
  });

  assert.deepEqual(duplicate, first);
  assert.deepEqual(staleRelease, first);
});

test('a raised profile floor advances state but cannot lower it', async () => {
  const store = new MemoryVersionStateStore();
  await store.getOrInitialize('example-ios', '1.5');
  const raised = await store.getOrInitialize('example-ios', '2.0');
  const lower = await store.getOrInitialize('example-ios', '1.0');

  assert.equal(raised.productionVersion, '2.0');
  assert.equal(raised.developmentVersion, '2.0');
  assert.deepEqual(lower, raised);
});

test('persists version state atomically across file-store instances', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'version-state-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const first = new FileVersionStateStore({ stateDirectory });
  const second = new FileVersionStateStore({ stateDirectory });

  await first.getOrInitialize('example-ios', '1.5');
  const submitted = await second.recordSubmitted('example-ios', '1.5', '1.5');
  const visible = await first.getOrInitialize('example-ios', '1.5');

  assert.equal(submitted.developmentVersion, '1.6');
  assert.deepEqual(visible, submitted);
});

test('rejects malformed marketing versions and unknown purposes', async () => {
  const store = new MemoryVersionStateStore();
  await assert.rejects(store.getOrInitialize('example-ios', 'version one'), /Invalid marketing version/);
  const state = await store.getOrInitialize('example-ios', '1.5');
  assert.throws(() => versionForPurpose(state, 'nightly'), /Unsupported build purpose/);
});
