import test from 'node:test';
import assert from 'node:assert/strict';

import { DeployRunner } from '../lib/runner.js';

// A controllable timer queue so retry scheduling can be driven deterministically.
function makeClock() {
  let queue = [];
  let id = 1;

  const setTimeoutFn = (fn, delay) => {
    const entry = { id: id++, fn, delay };
    queue.push(entry);
    return { id: entry.id, unref() {} };
  };
  const clearTimeoutFn = t => {
    if (t) queue = queue.filter(e => e.id !== t.id);
  };

  // Let pending microtasks (the async #run) settle.
  async function flush() {
    for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
  }
  // Fire every currently-queued timer once, awaiting each run.
  async function tick() {
    const due = queue;
    queue = [];
    for (const entry of due) {
      entry.fn();
      await flush();
    }
  }

  return { setTimeoutFn, clearTimeoutFn, tick, pending: () => queue.length };
}

test('runs once and stops on a terminal status', async () => {
  const clock = makeClock();
  let calls = 0;
  const runner = new DeployRunner({
    runOnce: async () => {
      calls++;
      return { status: 'submitted' };
    },
    log: () => {},
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  runner.trigger('test');
  await clock.tick();

  assert.equal(calls, 1);
  assert.equal(clock.pending(), 0);
});

test('retries while the build is not ready, then submits', async () => {
  const clock = makeClock();
  const results = ['no-build', 'no-eligible-build', 'submitted'];
  let i = 0;
  const runner = new DeployRunner({
    runOnce: async () => ({ status: results[i++] }),
    intervalMs: 1000,
    maxAttempts: 10,
    log: () => {},
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  runner.trigger('t');
  await clock.tick(); // no-build -> schedule retry
  assert.equal(clock.pending(), 1);
  await clock.tick(); // no-eligible-build -> schedule retry
  assert.equal(clock.pending(), 1);
  await clock.tick(); // submitted -> stop
  assert.equal(clock.pending(), 0);
  assert.equal(i, 3);
});

test('gives up after maxAttempts', async () => {
  const clock = makeClock();
  let calls = 0;
  const runner = new DeployRunner({
    runOnce: async () => {
      calls++;
      return { status: 'no-build' };
    },
    intervalMs: 1000,
    maxAttempts: 3,
    log: () => {},
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  runner.trigger('t');
  await clock.tick();
  await clock.tick();
  await clock.tick();

  assert.equal(calls, 3);
  assert.equal(clock.pending(), 0);
});

test('treats busy and error statuses as retryable', async () => {
  const clock = makeClock();
  const results = ['busy', 'error', 'submitted'];
  let i = 0;
  const runner = new DeployRunner({
    runOnce: async () => ({ status: results[i++] }),
    intervalMs: 1000,
    maxAttempts: 10,
    log: () => {},
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  runner.trigger('t');
  await clock.tick();
  assert.equal(clock.pending(), 1);
  await clock.tick();
  assert.equal(clock.pending(), 1);
  await clock.tick();
  assert.equal(clock.pending(), 0);
  assert.equal(i, 3);
});
