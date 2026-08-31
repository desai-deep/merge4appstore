import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  serializeWebhookEnvironment,
  writeWebhookEnvironment,
} from '../scripts/write-webhook-env.js';
import {
  GITHUB_APP_AUTH_OPTIONAL_NAMES,
  GITHUB_APP_AUTH_SECRET_NAMES,
  GITHUB_APP_WEBHOOK_SECRET_NAMES,
  loadWebhookEnvironment,
  loadEnvironmentFile,
  parseEnvironment,
  serializeEncodedEnvironment,
  validateWebhookEnvironment,
  WEBHOOK_ENVIRONMENT_NAMES,
  WEBHOOK_SECRET_NAMES,
} from '../lib/secret-environment.js';

const writerSource = fs.readFileSync(new URL('../scripts/write-webhook-env.js', import.meta.url), 'utf8');

const values = {
  FIRST: 'dollar$ quote" apostrophe\' slash\\ equals= hash# spaces ',
  SECOND: 'plain-token',
};

const requiredWebhookEnvironment = Object.fromEntries(
  WEBHOOK_SECRET_NAMES.map(name => [name, `${name}-value`]),
);
const githubAppEnvironment = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from('private-key-fixture').toString('base64'),
  GITHUB_INSTALLATION_ID: '456',
  GITHUB_APP_WEBHOOK_SECRET: 'app-webhook-secret',
  GITHUB_APP_WEBHOOK_MODE: 'shadow',
  GITHUB_CLASSIC_WEBHOOKS_ENABLED: 'true',
};

test('round-trips webhook secrets through a dotenv-safe serialization', () => {
  assert.deepEqual(
    parseEnvironment(serializeWebhookEnvironment(values, ['FIRST', 'SECOND'])),
    values,
  );
});

test('rejects empty and multiline values instead of producing ambiguous dotenv', () => {
  assert.throws(() => serializeWebhookEnvironment({ FIRST: '' }, ['FIRST']), /Missing required/);
  assert.throws(() => serializeWebhookEnvironment({ FIRST: 'one\ntwo' }, ['FIRST']), /forbidden/);
  assert.throws(() => serializeWebhookEnvironment({ FIRST: 'one\0two' }, ['FIRST']), /forbidden/);
});

test('writes only to an existing regular file with private permissions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-env-'));
  const output = path.join(directory, 'webhook.env');
  fs.writeFileSync(output, 'placeholder', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  writeWebhookEnvironment(output, {
    GH_WEBHOOK_SECRET: 'github',
    XCODE_CLOUD_WEBHOOK_TOKEN: 'xcode',
    MERGE4APPSTORE_BUILD_TOKEN_JAMSONTOAST: 'jams',
    MERGE4APPSTORE_BUILD_TOKEN_RUNNINGORDER_IOS: 'running',
  });

  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const contents = fs.readFileSync(output);
  assert.equal(parseEnvironment(contents).GH_WEBHOOK_SECRET, 'github');
  assert.doesNotMatch(contents.toString('utf8'), /GH_WEBHOOK_SECRET=github/);
});

test('serializes complete optional GitHub App groups with the mandatory webhook secrets', () => {
  const complete = { ...requiredWebhookEnvironment, ...githubAppEnvironment };
  const parsed = parseEnvironment(serializeWebhookEnvironment(complete));
  assert.deepEqual(parsed, complete);
  assert.deepEqual(WEBHOOK_ENVIRONMENT_NAMES, [
    ...WEBHOOK_SECRET_NAMES,
    ...GITHUB_APP_AUTH_SECRET_NAMES,
    ...GITHUB_APP_AUTH_OPTIONAL_NAMES,
    ...GITHUB_APP_WEBHOOK_SECRET_NAMES,
  ]);
});

test('validates staged GitHub App authentication and safe webhook cutover combinations', () => {
  assert.deepEqual(validateWebhookEnvironment({ ...requiredWebhookEnvironment }), requiredWebhookEnvironment);
  assert.deepEqual(validateWebhookEnvironment({
    ...requiredWebhookEnvironment,
    GITHUB_APP_ID: githubAppEnvironment.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY_BASE64: githubAppEnvironment.GITHUB_APP_PRIVATE_KEY_BASE64,
  }).GITHUB_APP_ID, '123');

  assert.throws(() => validateWebhookEnvironment({
    ...requiredWebhookEnvironment,
    GITHUB_APP_ID: '123',
  }), /authentication must be configured all-or-none/);
  assert.throws(() => validateWebhookEnvironment({
    ...requiredWebhookEnvironment,
    GITHUB_INSTALLATION_ID: '456',
  }), /requires complete GitHub App authentication/);
  assert.throws(() => validateWebhookEnvironment({
    ...requiredWebhookEnvironment,
    ...githubAppEnvironment,
    GITHUB_APP_WEBHOOK_SECRET: '',
  }), /webhook cutover must be configured all-or-none/);
  assert.throws(() => validateWebhookEnvironment({
    ...requiredWebhookEnvironment,
    ...githubAppEnvironment,
    GITHUB_CLASSIC_WEBHOOKS_ENABLED: 'false',
  }), /shadow mode requires classic webhooks to remain enabled/);
  assert.throws(() => validateWebhookEnvironment({
    ...requiredWebhookEnvironment,
    ...githubAppEnvironment,
    GITHUB_APP_WEBHOOK_MODE: 'managed',
  }), /managed mode requires classic webhooks to be disabled/);
  assert.doesNotThrow(() => validateWebhookEnvironment({
    ...requiredWebhookEnvironment,
    ...githubAppEnvironment,
    GITHUB_APP_WEBHOOK_MODE: 'managed',
    GITHUB_CLASSIC_WEBHOOKS_ENABLED: 'false',
  }));
});

test('loads the validated webhook schema only from an explicit absolute path', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-env-explicit-'));
  const output = path.join(directory, 'webhook.env');
  const complete = { ...requiredWebhookEnvironment, ...githubAppEnvironment };
  fs.writeFileSync(output, serializeEncodedEnvironment(complete, Object.keys(complete)), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const environment = { GITHUB_APP_ID: 'stale' };
  assert.deepEqual(loadWebhookEnvironment(output, { environment }), complete);
  assert.equal(environment.GITHUB_APP_ID, '123');
  assert.deepEqual(loadWebhookEnvironment(undefined, { environment: {} }), {});
  assert.throws(
    () => loadWebhookEnvironment(undefined, { environment: {}, required: true }),
    /MERGE4APPSTORE_WEBHOOK_ENV is required/,
  );
  assert.throws(
    () => loadWebhookEnvironment('relative.env', { environment: {} }),
    /must be an absolute path/,
  );
});

test('validates the opened output inode before truncating it', () => {
  assert.doesNotMatch(writerSource, /fs\.constants\.O_TRUNC/);
  const validation = writerSource.indexOf('fs.fstatSync(descriptor)');
  const truncation = writerSource.indexOf('fs.ftruncateSync(descriptor, 0)');
  assert.ok(validation >= 0 && truncation > validation);
  assert.match(writerSource, /fs\.fsyncSync\(descriptor\)/);
});

test('loads only the complete webhook-secret allowlist', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-env-allowlist-'));
  const output = path.join(directory, 'webhook.env');
  const complete = Object.fromEntries(WEBHOOK_SECRET_NAMES.map(name => [name, `${name}-value`]));
  fs.writeFileSync(output, serializeEncodedEnvironment(complete, WEBHOOK_SECRET_NAMES), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const environment = {};
  assert.deepEqual(loadEnvironmentFile(output, {
    environment,
    allowedNames: WEBHOOK_SECRET_NAMES,
    requireAll: true,
  }), complete);
  assert.deepEqual(environment, complete);

  fs.writeFileSync(output, `${WEBHOOK_SECRET_NAMES.map(name => `${name}=value`).join('\n')}\nDRY_RUN=true\n`);
  assert.throws(() => loadEnvironmentFile(output, {
    environment: {},
    allowedNames: WEBHOOK_SECRET_NAMES,
    requireAll: true,
  }), /unexpected keys: DRY_RUN/);

  fs.writeFileSync(output, `${WEBHOOK_SECRET_NAMES.slice(1).map(name => `${name}=value`).join('\n')}\n`);
  assert.throws(() => loadEnvironmentFile(output, {
    environment: {},
    allowedNames: WEBHOOK_SECRET_NAMES,
    requireAll: true,
  }), /missing required keys: GH_WEBHOOK_SECRET/);
});
