import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FilePrepareCache, MemoryPrepareCache } from '../lib/prepare-cache.js';

test('shares a cached preparation result across cache instances', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-cache-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  let loads = 0;
  const first = new FilePrepareCache({ stateDirectory });
  const second = new FilePrepareCache({ stateDirectory });
  const value = await first.get('example:same', async () => {
    loads += 1;
    return { marketing_version: '1.5' };
  });
  const reused = await second.get('example:same', async () => {
    loads += 1;
    return { marketing_version: 'wrong' };
  });
  assert.deepEqual(value, reused);
  assert.equal(loads, 1);
});

test('coalesces independent processes through the kernel lock and durable cache', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-cache-process-'));
  const counter = path.join(stateDirectory, 'counter');
  const fixture = fileURLToPath(new URL('./fixtures/prepare-cache-worker.js', import.meta.url));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, stateDirectory, counter], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });

  const [first, second] = await Promise.all([run(), run()]);
  assert.deepEqual(first, second);
  assert.equal((await fs.readFile(counter, 'utf8')).trim(), '1');
});

test('removes a temporary record when serialization fails', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-cache-write-failure-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const cache = new FilePrepareCache({ stateDirectory });

  await assert.rejects(
    cache.get('example:invalid', async () => ({ unsupported: 1n })),
    /BigInt/,
  );
  assert.deepEqual(
    (await fs.readdir(cache.directory)).filter(name => name.endsWith('.tmp')),
    [],
  );
  assert.deepEqual(
    await cache.get('example:invalid', async () => ({ recovered: true })),
    { recovered: true },
  );
});

test('enforces the durable entry limit after every successful write', async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-cache-bound-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const cache = new FilePrepareCache({ stateDirectory, maxEntries: 3 });

  for (let index = 0; index < 8; index += 1) {
    await cache.get(`example:${index}`, async () => ({ index }));
    assert.ok(
      (await fs.readdir(cache.directory)).filter(name => name.endsWith('.json')).length <= 3,
    );
  }
});

test('bounds in-memory preparation flights as well as resolved values', async () => {
  const cache = new MemoryPrepareCache({ maxEntries: 2 });
  const releases = [];
  const blockedLoad = value => new Promise(resolve => {
    releases.push(() => resolve(value));
  });
  const first = cache.get('a', () => blockedLoad('first'));
  const second = cache.get('b', () => blockedLoad('second'));
  await Promise.resolve();

  await assert.rejects(cache.get('c', () => 'must-not-run'), error => (
    error.code === 'ECACHECAPACITY' && error.statusCode === 503
  ));
  releases.forEach(release => release());
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(cache.values.size + cache.flights.size, 2);
});
