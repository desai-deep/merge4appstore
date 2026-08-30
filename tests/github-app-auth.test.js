import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  GitHubAppAuthenticator,
  assertGitHubAppPermissions,
  githubAuthenticationSettings,
  githubEnvironmentForRepository,
} from '../lib/github-app-auth.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('accepts either a raw or base64-encoded GitHub App private key', () => {
  const raw = githubAuthenticationSettings({
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: privateKeyPem.replace(/\n/g, '\\n'),
  });
  const encoded = githubAuthenticationSettings({
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKeyPem).toString('base64'),
  });
  assert.equal(raw.privateKey, privateKeyPem);
  assert.equal(encoded.privateKey, privateKeyPem);
});

test('rejects partial GitHub App configuration instead of falling back to a PAT', () => {
  assert.throws(
    () => githubAuthenticationSettings({ GITHUB_APP_ID: '123' }),
    /PRIVATE_KEY/,
  );
  assert.throws(
    () => githubAuthenticationSettings({ GITHUB_INSTALLATION_ID: '456' }),
    /GITHUB_APP_ID/,
  );
  assert.throws(
    () => githubAuthenticationSettings({ GITHUB_APP_ID: '0', GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
    /positive integer/,
  );
  assert.throws(
    () => githubAuthenticationSettings({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'not-a-key' }),
    /private key is invalid/,
  );
  assert.throws(
    () => githubAuthenticationSettings({
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      GITHUB_API_URL: 'http://api.github.test',
    }),
    /HTTPS URL/,
  );
});

test('validates direct authenticator construction', () => {
  assert.throws(() => new GitHubAppAuthenticator({
    appId: '0',
    privateKey: privateKeyPem,
  }), /positive integer/);
  assert.throws(() => new GitHubAppAuthenticator({
    appId: '123',
    privateKey: 'not-a-key',
  }), /private key is invalid/);
  assert.throws(() => new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    requestTimeoutMs: 0,
  }), /timeout must be a positive number/);
});

test('fails permission preflight when an installation cannot perform current mutations', () => {
  assert.throws(() => assertGitHubAppPermissions(
    { metadata: 'read', contents: 'read', pull_requests: 'write' },
    { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' },
  ), /contents=write.*issues=write/);
  assert.equal(assertGitHubAppPermissions(
    { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' },
    { metadata: 'read', contents: 'read', pull_requests: 'read' },
  ), true);
});

test('creates a short-lived RS256 JWT with the App ID as issuer', () => {
  const now = Date.parse('2026-08-30T00:00:00Z');
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    now: () => now,
    fetchImpl: () => { throw new Error('not called'); },
  });
  const [header, payload, signature] = auth.createJWT().split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540,
    iss: '123',
  });
  assert.equal(
    crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
});

test('discovers an installation and requests a repository-scoped token', async () => {
  const calls = [];
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    now: () => Date.parse('2026-08-30T00:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/repos/example/ios/installation')) return jsonResponse({ id: 456 });
      return jsonResponse({
        token: 'installation-token',
        expires_at: '2026-08-30T01:00:00Z',
        permissions: { contents: 'read', pull_requests: 'write' },
        repository_selection: 'selected',
      });
    },
  });

  const credential = await auth.installationToken('example', 'ios');
  assert.equal(credential.token, 'installation-token');
  assert.equal(credential.installationId, '456');
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  assert.deepEqual(JSON.parse(calls[1].options.body), { repositories: ['ios'] });
});

test('single-flights installation discovery for concurrent token requests', async () => {
  let discoveryRequests = 0;
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    now: () => Date.parse('2026-08-30T00:00:00Z'),
    fetchImpl: async url => {
      if (url.endsWith('/installation')) {
        discoveryRequests += 1;
        await new Promise(resolve => setImmediate(resolve));
        return jsonResponse({ id: 456 });
      }
      return jsonResponse({ token: 'token', expires_at: '2026-08-30T01:00:00Z' });
    },
  });
  await Promise.all([
    auth.installationToken('example', 'ios'),
    auth.installationToken('example', 'ios'),
  ]);
  assert.equal(discoveryRequests, 1);
});

test('times out a stalled GitHub API request', async () => {
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    requestTimeoutMs: 1,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(auth.request('/app'), /timed out after 1ms/);
});

test('single-flights and caches installation token refreshes', async () => {
  let requests = 0;
  let now = Date.parse('2026-08-30T00:00:00Z');
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    installationId: '456',
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({
        token: `token-${requests}`,
        expires_at: new Date(now + (60 * 60 * 1000)).toISOString(),
      });
    },
  });

  const [first, concurrent] = await Promise.all([
    auth.installationToken('example', 'ios'),
    auth.installationToken('example', 'ios'),
  ]);
  assert.equal(first.token, 'token-1');
  assert.equal(concurrent.token, 'token-1');
  assert.equal((await auth.installationToken('example', 'ios')).token, 'token-1');
  assert.equal(requests, 1);

  now += 56 * 60 * 1000;
  assert.equal((await auth.installationToken('example', 'ios')).token, 'token-2');
  assert.equal(requests, 2);
});

test('injects the installation token only into the repository client environment', async () => {
  const authenticator = {
    environmentForRepository: async (owner, repository, environment) => ({
      ...environment,
      GH_TOKEN: `${owner}/${repository}-token`,
      GITHUB_INSTALLATION_ID: '456',
    }),
  };
  const original = { GH_TOKEN: 'pat', KEEP: 'value' };
  const result = await githubEnvironmentForRepository('example', 'ios', original, { authenticator });
  assert.deepEqual(result, {
    GH_TOKEN: 'example/ios-token',
    GITHUB_INSTALLATION_ID: '456',
    KEEP: 'value',
  });
  assert.equal(original.GH_TOKEN, 'pat');
});

test('preserves the existing PAT environment when App credentials are absent', async () => {
  const environment = { GH_TOKEN: 'pat', KEEP: 'value' };
  assert.deepEqual(
    await githubEnvironmentForRepository('example', 'ios', environment),
    environment,
  );
});
