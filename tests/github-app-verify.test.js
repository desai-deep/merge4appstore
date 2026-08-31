import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyGitHubAppInstallation } from '../lib/github-app-verify.js';

function fakeAuthenticator(permissions) {
  const calls = [];
  return {
    calls,
    installationToken: async () => ({
      token: 'installation-token',
      expiresAt: Date.parse('2026-08-30T01:00:00Z'),
      installationId: '456',
      permissions,
      repositorySelection: 'selected',
    }),
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === '/repos/example/ios') {
        return { data: { id: 11, full_name: 'example/ios', default_branch: 'main' } };
      }
      if (path.endsWith('/pulls?state=all&per_page=1')) return { data: [{ number: 42 }] };
      if (path.endsWith('/commits/main')) return { data: { sha: 'abc123' } };
      if (path.endsWith('/git/tags')) return { data: { sha: 'tag-object' } };
      return { data: {} };
    },
  };
}

test('verifies immutable repository identity and permissions without exposing a token', async () => {
  const auth = fakeAuthenticator({
    metadata: 'read',
    contents: 'read',
    pull_requests: 'read',
  });
  const result = await verifyGitHubAppInstallation(auth, 'example', 'ios', { repositoryId: 11 });
  assert.deepEqual(result, {
    ok: true,
    repository: 'example/ios',
    repository_id: 11,
    installation_id: '456',
    token_expires_at: '2026-08-30T01:00:00.000Z',
    repository_selection: 'selected',
    permissions: { metadata: 'read', contents: 'read', pull_requests: 'read' },
    sampled_pull_request: 42,
    permission_preflight: 'read',
    write_tag_check: 'not-requested',
  });
  assert.equal(JSON.stringify(result).includes('installation-token'), false);
  assert.deepEqual(auth.calls[0].options, {
    token: 'installation-token',
    signal: null,
  });
});

test('fails closed when GitHub returns a different immutable repository id', async () => {
  const auth = fakeAuthenticator({
    metadata: 'read',
    contents: 'read',
    pull_requests: 'read',
  });
  await assert.rejects(
    verifyGitHubAppInstallation(auth, 'example', 'ios', { repositoryId: 12 }),
    /returned repository id 11; expected 12/,
  );
});

test('creates and deletes a unique verification tag only when explicitly requested', async () => {
  const auth = fakeAuthenticator({
    metadata: 'read',
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
  });
  const result = await verifyGitHubAppInstallation(auth, 'example', 'ios', {
    full: true,
    writeTag: true,
    now: () => 123456789,
    uniqueSuffix: () => 'unique',
  });
  assert.equal(result.write_tag_check, 'created-and-deleted');
  const mutations = auth.calls.filter(call => call.options.method && call.options.method !== 'GET');
  assert.deepEqual(mutations.map(call => [call.options.method, call.path]), [
    ['POST', '/repos/example/ios/git/tags'],
    ['POST', '/repos/example/ios/git/refs'],
    ['DELETE', '/repos/example/ios/git/refs/tags/merge4appstore-app-verification-123456789-unique'],
  ]);
  assert.deepEqual(mutations[1].options.body, {
    ref: 'refs/tags/merge4appstore-app-verification-123456789-unique',
    sha: 'tag-object',
  });
});

test('refuses the write check before making a mutation when permissions are insufficient', async () => {
  const auth = fakeAuthenticator({
    metadata: 'read',
    contents: 'read',
    pull_requests: 'write',
  });
  await assert.rejects(
    verifyGitHubAppInstallation(auth, 'example', 'ios', { writeTag: true }),
    /contents=write.*issues=write/,
  );
  assert.equal(auth.calls.some(call => call.options.method === 'POST'), false);
});
