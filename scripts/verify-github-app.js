#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  createGitHubAuthenticator,
} from '../lib/github-app-auth.js';
import { verifyGitHubAppInstallation } from '../lib/github-app-verify.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(root, '.env') });
dotenv.config({ path: path.join(root, '.webhook.env'), quiet: true });

const argumentsList = process.argv.slice(2);
const full = argumentsList.includes('--full');
const writeTag = argumentsList.includes('--write-tag');
const repositoryArgument = argumentsList.find(argument => !argument.startsWith('--'));
if (!repositoryArgument || !/^[^/]+\/[^/]+$/.test(repositoryArgument)) {
  console.error('Usage: npm run verify:github-app -- OWNER/REPOSITORY [--full] [--write-tag]');
  process.exit(2);
}
const [owner, repository] = repositoryArgument.split('/');
const authenticator = createGitHubAuthenticator();
if (!authenticator) {
  console.error('GitHub App credentials are not configured');
  process.exit(2);
}

try {
  const result = await verifyGitHubAppInstallation(authenticator, owner, repository, {
    full,
    writeTag,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`GitHub App verification failed: ${error.message}`);
  process.exit(1);
}
