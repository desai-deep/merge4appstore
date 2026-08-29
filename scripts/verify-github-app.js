#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  assertGitHubAppPermissions,
  createGitHubAuthenticator,
} from '../lib/github-app-auth.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(root, '.env') });
dotenv.config({ path: path.join(root, '.webhook.env'), quiet: true });

const argumentsList = process.argv.slice(2);
const full = argumentsList.includes('--full');
const repositoryArgument = argumentsList.find(argument => !argument.startsWith('--'));
if (!repositoryArgument || !/^[^/]+\/[^/]+$/.test(repositoryArgument)) {
  console.error('Usage: npm run verify:github-app -- OWNER/REPOSITORY [--full]');
  process.exit(2);
}
const [owner, repository] = repositoryArgument.split('/');
const authenticator = createGitHubAuthenticator();
if (!authenticator) {
  console.error('GitHub App credentials are not configured');
  process.exit(2);
}

try {
  const credential = await authenticator.installationToken(owner, repository);
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepository = encodeURIComponent(repository);
  const [{ data: repositoryData }, { data: pulls }] = await Promise.all([
    authenticator.request(`/repos/${encodedOwner}/${encodedRepository}`, { token: credential.token }),
    authenticator.request(`/repos/${encodedOwner}/${encodedRepository}/pulls?state=all&per_page=1`, { token: credential.token }),
  ]);
  const required = full
    ? { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' }
    : { metadata: 'read', contents: 'read', pull_requests: 'read' };
  assertGitHubAppPermissions(credential.permissions, required);
  console.log(JSON.stringify({
    ok: true,
    repository: repositoryData.full_name,
    repository_id: repositoryData.id,
    installation_id: credential.installationId,
    token_expires_at: new Date(credential.expiresAt).toISOString(),
    repository_selection: credential.repositorySelection,
    permissions: credential.permissions,
    sampled_pull_request: pulls?.[0]?.number || null,
    permission_preflight: full ? 'full-current-automation' : 'read',
  }, null, 2));
} catch (error) {
  console.error(`GitHub App verification failed: ${error.message}`);
  process.exit(1);
}
