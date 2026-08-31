#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serializeEncodedEnvironment,
  WEBHOOK_SECRET_NAMES,
} from '../lib/secret-environment.js';

export { WEBHOOK_SECRET_NAMES } from '../lib/secret-environment.js';

export function serializeWebhookEnvironment(environment, names = WEBHOOK_SECRET_NAMES) {
  return serializeEncodedEnvironment(environment, names);
}

export function writeWebhookEnvironment(outputPath, environment = process.env) {
  if (!path.isAbsolute(outputPath)) throw new Error('Webhook environment output path must be absolute');
  const contents = serializeWebhookEnvironment(environment);
  const descriptor = fs.openSync(
    outputPath,
    fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('Webhook environment output must be an existing regular file');
    fs.fchmodSync(descriptor, 0o600);
    // Validate the opened inode before making an irreversible change. Opening
    // with O_TRUNC would destroy a mistakenly supplied non-regular target before
    // fstat had a chance to reject it.
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  writeWebhookEnvironment(process.argv[2] || '');
}
