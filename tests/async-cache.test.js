import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncTtlCache } from '../lib/async-cache.js';

test('coalesces concurrent loads and reloads only after the TTL expires', async () => {
  let now = 1_000;
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const cache = new AsyncTtlCache({ ttlMs: 50, now: () => now });

  const first = cache.get('versions', async () => {
    calls += 1;
    await blocked;
    return ['1.0'];
  });
  const concurrent = cache.get('versions', () => {
    calls += 1;
    return ['should-not-run'];
  });

  assert.strictEqual(first, concurrent);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, ['1.0']);

  now += 49;
  assert.deepEqual(await cache.get('versions', () => ['should-not-run']), ['1.0']);
  assert.equal(calls, 1);

  now += 1;
  assert.deepEqual(await cache.get('versions', () => {
    calls += 1;
    return ['1.1'];
  }), ['1.1']);
  assert.equal(calls, 2);
});

test('can serve a stale value briefly when a refresh fails', async () => {
  let now = 5_000;
  let calls = 0;
  let fail = false;
  const cache = new AsyncTtlCache({
    ttlMs: 20,
    retryTtlMs: 5,
    staleIfError: true,
    now: () => now,
  });
  const load = async () => {
    calls += 1;
    if (fail) throw new Error('upstream unavailable');
    return `value-${calls}`;
  };

  assert.equal(await cache.get('published-builds', load), 'value-1');
  now += 21;
  fail = true;
  assert.equal(await cache.get('published-builds', load), 'value-1');
  assert.equal(calls, 2);

  now += 4;
  assert.equal(await cache.get('published-builds', load), 'value-1');
  assert.equal(calls, 2);

  now += 1;
  fail = false;
  assert.equal(await cache.get('published-builds', load), 'value-3');
  assert.equal(calls, 3);
});

test('does not cache an initial failure and bounds resolved entries', async () => {
  const cache = new AsyncTtlCache({ ttlMs: 60_000, maxEntries: 2 });
  await assert.rejects(cache.get('a', async () => { throw new Error('temporary'); }), /temporary/);
  assert.equal(await cache.get('a', async () => 'recovered'), 'recovered');
  assert.equal(await cache.get('b', async () => 'second'), 'second');
  assert.equal(await cache.get('c', async () => 'third'), 'third');

  let reloaded = false;
  assert.equal(await cache.get('a', async () => {
    reloaded = true;
    return 'loaded-again';
  }), 'loaded-again');
  assert.equal(reloaded, true);
});

test('rejects excess concurrent loads instead of exceeding its hard bound', async () => {
  const cache = new AsyncTtlCache({ ttlMs: 60_000, maxEntries: 2 });
  const releases = [];
  const blockedLoad = value => new Promise(resolve => {
    releases.push(() => resolve(value));
  });

  const first = cache.get('a', () => blockedLoad('first'));
  const second = cache.get('b', () => blockedLoad('second'));
  await Promise.resolve();
  await assert.rejects(cache.get('c', () => 'must-not-run'), error => (
    error.code === 'ECACHECAPACITY'
    && error.statusCode === 503
    && error.retryAfter === 1
  ));
  assert.equal(cache.entries.size, 2);

  releases.forEach(release => release());
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(cache.entries.size, 2);
  assert.equal(await cache.get('c', () => 'third'), 'third');
  assert.equal(cache.entries.size, 2);
});
