import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const required = {
  MERGE4APPSTORE_STATE_DIR: '/private/state', MERGE4APPSTORE_DELIVERY_PAUSE_FILE: '/private/state/delivery.pause',
  MERGE4APPSTORE_DEPLOY_SHA: 'a'.repeat(40), MERGE4APPSTORE_DRAIN_TIMEOUT_MS: '60000',
  MERGE4APPSTORE_ENV: '/private/control/.env', MERGE4APPSTORE_WEBHOOK_ENV: '/private/state/current-webhook.env',
  WEBHOOK_HOST: '127.0.0.1', WEBHOOK_PORT: '8788', MERGE2FLY_SERVICE_SHA: 'b'.repeat(40),
};
const config = workers => spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./ecosystem.config.cjs').apps[0]))"], {
  encoding: 'utf8', env: { ...process.env, ...required, MERGE4APPSTORE_WEBHOOK_WORKERS: workers },
});
test('one worker uses fork mode with release provenance and a graceful drain margin', () => {
  const result = config('1');
  assert.equal(result.status, 0, result.stderr);
  const app = JSON.parse(result.stdout);
  assert.equal(app.instances, 1);
  assert.equal(app.exec_mode, 'fork');
  assert.equal(app.kill_timeout, 70000);
  assert.equal(app.wait_ready, true);
  assert.equal(app.env.MERGE2FLY_SERVICE_SHA, required.MERGE2FLY_SERVICE_SHA);
});
test('retains the default two-worker cluster and rejects unintended process counts', () => {
  const app = JSON.parse(config('').stdout);
  assert.equal(app.instances, 2);
  assert.equal(app.exec_mode, 'cluster');
  for (const count of ['0', '3', '-1', 'one']) assert.notEqual(config(count).status, 0);
});
