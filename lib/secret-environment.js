import fs from 'node:fs';
import { TextDecoder } from 'node:util';
import dotenv from 'dotenv';

export const ENCODED_SECRET_FORMAT = 'base64-v1';
export const WEBHOOK_SECRET_NAMES = Object.freeze([
  'GH_WEBHOOK_SECRET',
  'XCODE_CLOUD_WEBHOOK_TOKEN',
  'MERGE4APPSTORE_BUILD_TOKEN_JAMSONTOAST',
  'MERGE4APPSTORE_BUILD_TOKEN_RUNNINGORDER_IOS',
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
