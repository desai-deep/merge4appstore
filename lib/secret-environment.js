import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import dotenv from 'dotenv';

export const ENCODED_SECRET_FORMAT = 'base64-v1';
export const WEBHOOK_SECRET_NAMES = Object.freeze([
  'GH_WEBHOOK_SECRET',
  'XCODE_CLOUD_WEBHOOK_TOKEN',
  'MERGE4APPSTORE_BUILD_TOKEN_JAMSONTOAST',
  'MERGE4APPSTORE_BUILD_TOKEN_RUNNINGORDER_IOS',
]);
export const GITHUB_APP_AUTH_SECRET_NAMES = Object.freeze([
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_BASE64',
]);
export const GITHUB_APP_AUTH_OPTIONAL_NAMES = Object.freeze([
  'GITHUB_INSTALLATION_ID',
]);
export const GITHUB_APP_WEBHOOK_SECRET_NAMES = Object.freeze([
  'GITHUB_APP_WEBHOOK_SECRET',
  'GITHUB_APP_WEBHOOK_MODE',
  'GITHUB_CLASSIC_WEBHOOKS_ENABLED',
]);
export const WEBHOOK_ENVIRONMENT_NAMES = Object.freeze([
  ...WEBHOOK_SECRET_NAMES,
  ...GITHUB_APP_AUTH_SECRET_NAMES,
  ...GITHUB_APP_AUTH_OPTIONAL_NAMES,
  ...GITHUB_APP_WEBHOOK_SECRET_NAMES,
]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeBase64(value, name) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid base64 encoding for ${name}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`Non-canonical base64 encoding for ${name}`);
  return utf8Decoder.decode(bytes);
}

export function serializeEncodedEnvironment(environment, names) {
  const lines = [`MERGE4APPSTORE_SECRET_FORMAT=${ENCODED_SECRET_FORMAT}`];
  for (const name of names) {
    const value = environment[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing required webhook secret ${name}`);
    }
    if (/[\0\r\n]/.test(value)) {
      throw new Error(`Webhook secret ${name} contains a forbidden line break or NUL byte`);
    }
    lines.push(`${name}_BASE64=${Buffer.from(value, 'utf8').toString('base64')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseEnvironment(source) {
  const parsed = dotenv.parse(source);
  const format = parsed.MERGE4APPSTORE_SECRET_FORMAT;
  if (!format) return parsed;
  if (format !== ENCODED_SECRET_FORMAT) throw new Error(`Unsupported secret environment format: ${format}`);

  const decoded = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (name === 'MERGE4APPSTORE_SECRET_FORMAT') continue;
    if (!name.endsWith('_BASE64')) {
      throw new Error(`Unexpected unencoded value ${name} in encoded secret environment`);
    }
    const decodedName = name.slice(0, -'_BASE64'.length);
    if (!decodedName) throw new Error('Encoded secret name is empty');
    decoded[decodedName] = decodeBase64(value, decodedName);
  }
  return decoded;
}

export function readEnvironmentFile(file) {
  return parseEnvironment(fs.readFileSync(file));
}

export function validateEnvironmentNames(parsed, allowedNames, { requireAll = false } = {}) {
  const allowed = new Set(allowedNames);
  const unexpected = Object.keys(parsed).filter(name => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Environment contains unexpected keys: ${unexpected.join(', ')}`);
  }
  if (requireAll) {
    const missing = [...allowed].filter(name => typeof parsed[name] !== 'string' || !parsed[name]);
    if (missing.length > 0) throw new Error(`Environment is missing required keys: ${missing.join(', ')}`);
  }
  return parsed;
}

function present(parsed, name) {
  return typeof parsed[name] === 'string' && parsed[name].length > 0;
}

function validateAllOrNone(parsed, names, label) {
  const configured = names.filter(name => present(parsed, name));
  if (configured.length !== 0 && configured.length !== names.length) {
    const missing = names.filter(name => !present(parsed, name));
    throw new Error(`${label} must be configured all-or-none; missing: ${missing.join(', ')}`);
  }
  return configured.length === names.length;
}

function validatePositiveInteger(parsed, name) {
  if (!present(parsed, name)) return;
  if (!/^\d+$/.test(parsed[name]) || BigInt(parsed[name]) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validateNestedBase64(parsed, name) {
  if (!present(parsed, name)) return;
  const value = parsed[name];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      || Buffer.from(value, 'base64').toString('base64') !== value
      || Buffer.from(value, 'base64').length === 0) {
    throw new Error(`${name} must contain canonical non-empty base64`);
  }
}

export function validateWebhookEnvironment(parsed) {
  validateEnvironmentNames(parsed, WEBHOOK_ENVIRONMENT_NAMES);
  const missing = WEBHOOK_SECRET_NAMES.filter(name => !present(parsed, name));
  if (missing.length > 0) {
    throw new Error(`Environment is missing required keys: ${missing.join(', ')}`);
  }

  const appAuthenticationConfigured = validateAllOrNone(
    parsed,
    GITHUB_APP_AUTH_SECRET_NAMES,
    'GitHub App authentication',
  );
  const appWebhookConfigured = validateAllOrNone(
    parsed,
    GITHUB_APP_WEBHOOK_SECRET_NAMES,
    'GitHub App webhook cutover',
  );
  if (present(parsed, 'GITHUB_INSTALLATION_ID') && !appAuthenticationConfigured) {
    throw new Error('GITHUB_INSTALLATION_ID requires complete GitHub App authentication');
  }
  if (appWebhookConfigured && !appAuthenticationConfigured) {
    throw new Error('GitHub App webhook cutover requires complete GitHub App authentication');
  }

  validatePositiveInteger(parsed, 'GITHUB_APP_ID');
  validatePositiveInteger(parsed, 'GITHUB_INSTALLATION_ID');
  validateNestedBase64(parsed, 'GITHUB_APP_PRIVATE_KEY_BASE64');

  if (appWebhookConfigured) {
    const mode = parsed.GITHUB_APP_WEBHOOK_MODE;
    const classic = parsed.GITHUB_CLASSIC_WEBHOOKS_ENABLED;
    if (!['shadow', 'managed'].includes(mode)) {
      throw new Error('GITHUB_APP_WEBHOOK_MODE must be shadow or managed');
    }
    if (!['true', 'false'].includes(classic)) {
      throw new Error('GITHUB_CLASSIC_WEBHOOKS_ENABLED must be true or false');
    }
    if (mode === 'shadow' && classic !== 'true') {
      throw new Error('GitHub App shadow mode requires classic webhooks to remain enabled');
    }
    if (mode === 'managed' && classic !== 'false') {
      throw new Error('GitHub App managed mode requires classic webhooks to be disabled');
    }
  }
  return parsed;
}

export function selectWebhookEnvironment(environment = process.env) {
  const selected = Object.fromEntries(WEBHOOK_ENVIRONMENT_NAMES
    .filter(name => present(environment, name))
    .map(name => [name, environment[name]]));
  return validateWebhookEnvironment(selected);
}

export function loadEnvironmentFile(file, {
  override = false,
  environment = process.env,
  allowedNames = null,
  requireAll = false,
} = {}) {
  const parsed = readEnvironmentFile(file);
  if (allowedNames) validateEnvironmentNames(parsed, allowedNames, { requireAll });
  for (const [name, value] of Object.entries(parsed)) {
    if (override || environment[name] === undefined) environment[name] = value;
  }
  return parsed;
}

export function loadWebhookEnvironment(file, {
  override = true,
  environment = process.env,
  required = false,
} = {}) {
  if (!file) {
    if (required) throw new Error('MERGE4APPSTORE_WEBHOOK_ENV is required');
    return {};
  }
  if (!path.isAbsolute(file)) {
    throw new Error('MERGE4APPSTORE_WEBHOOK_ENV must be an absolute path');
  }
  const parsed = validateWebhookEnvironment(readEnvironmentFile(file));
  for (const [name, value] of Object.entries(parsed)) {
    if (override || environment[name] === undefined) environment[name] = value;
  }
  return parsed;
}
