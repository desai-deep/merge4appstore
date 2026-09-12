#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  createGitHubAuthenticator,
} from '../lib/github-app-auth.js';
import { verifyGitHubAppInstallation } from '../lib/github-app-verify.js';
import { loadRepositoryProfile } from '../lib/profile.js';
import { loadWebhookEnvironment } from '../lib/secret-environment.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(root, '.env') });
try {
  loadWebhookEnvironment(process.env.MERGE4APPSTORE_WEBHOOK_ENV, {
    environment: process.env,
    override: true,
    required: false,
  });
} catch (error) {
  console.error(`Could not load webhook environment: ${error.message}`);
  process.exit(2);
}

const argumentsList = process.argv.slice(2);
let full = false;
let writeTag = false;
let repositoryArgument = null;
let repositoryId = null;
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === '--full') {
    full = true;
    continue;
  }
  if (argument === '--write-tag') {
    writeTag = true;
    continue;
  }
  if (argument === '--repository-id') {
    repositoryId = argumentsList[index + 1] || null;
    index += 1;
    continue;
  }
  if (argument.startsWith('--repository-id=')) {
    repositoryId = argument.slice('--repository-id='.length);
    continue;
  }
  if (argument.startsWith('-') || repositoryArgument) {
    console.error(`Unsupported argument: ${argument}`);
    process.exit(2);
  }
  repositoryArgument = argument;
}
if (!repositoryArgument || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryArgument)) {
  console.error('Usage: npm run verify:github-app -- OWNER/REPOSITORY [--repository-id ID] [--full] [--write-tag]');
  process.exit(2);
}
const [owner, repository] = repositoryArgument.split('/');
if (repositoryId !== null && (
  !/^\d+$/.test(repositoryId)
  || BigInt(repositoryId) <= 0n
  || BigInt(repositoryId) > BigInt(Number.MAX_SAFE_INTEGER)
)) {
  console.error('--repository-id must be a positive safe integer');
  process.exit(2);
}
if (repositoryId === null) {
  const profilesDirectory = path.resolve(
    process.env.MERGE4APPSTORE_PROFILES_DIR || path.join(root, 'profiles'),
  );
  const match = fs.readdirSync(profilesDirectory)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => loadRepositoryProfile(path.join(profilesDirectory, name)))
    .find(profile => (
      profile.repository.owner.toLowerCase() === owner.toLowerCase()
      && profile.repository.name.toLowerCase() === repository.toLowerCase()
    ));
  repositoryId = match?.repository.github_id || process.env.GITHUB_REPOSITORY_ID || null;
}
const authenticator = createGitHubAuthenticator();
if (!authenticator) {
  console.error('GitHub App credentials are not configured');
  process.exit(2);
}

try {
  const result = await verifyGitHubAppInstallation(authenticator, owner, repository, {
    full,
    writeTag,
    repositoryId,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`GitHub App verification failed: ${error.message}`);
  process.exit(1);
}
