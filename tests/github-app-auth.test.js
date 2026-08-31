import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  GitHubAppAuthenticator,
  assertGitHubAppPermissions,
  createGitHubEnvironmentProvider,
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
  assert.throws(() => githubAuthenticationSettings({
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKeyPem).toString('base64'),
  }), /only one/);
});

test('rejects malformed and non-canonical private-key base64', () => {
  for (const value of ['%%%', 'YQ', 'YR==', `${Buffer.from(privateKeyPem).toString('base64')}\n`]) {
    assert.throws(() => githubAuthenticationSettings({
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_BASE64: value,
    }), /canonical base64/);
  }
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

test('keeps the timeout active while reading the GitHub response body', async () => {
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    requestTimeoutMs: 1,
    fetchImpl: async (_url, options) => ({
      ok: true,
      text: async () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }),
  });
  await assert.rejects(auth.request('/app'), /timed out after 1ms/);
});

test('lets a caller cancel token acquisition without cancelling shared bounded work', async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    installationId: '456',
    fetchImpl: async () => response,
  });
  const controller = new AbortController();
  const reason = new Error('repository deadline reached');
  const pending = auth.installationToken('example', 'ios', { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  release(jsonResponse({
    token: 'eventual-token',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await auth.installationToken('example', 'ios')).token, 'eventual-token');
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

test('uses immutable repository IDs for discovery and token isolation', async () => {
  const requests = [];
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    now: () => Date.parse('2026-08-30T00:00:00Z'),
    fetchImpl: async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      if (url.endsWith('/repositories/11/installation')) return jsonResponse({ id: 456 });
      if (url.endsWith('/repositories/22/installation')) return jsonResponse({ id: 456 });
      const repositoryId = JSON.parse(options.body).repository_ids[0];
      return jsonResponse({
        token: `token-for-${repositoryId}`,
        expires_at: '2026-08-30T01:00:00Z',
      });
    },
  });

  const [first, second] = await Promise.all([
    auth.installationToken('example', 'renamed-one', { repositoryId: 11 }),
    auth.installationToken('example', 'renamed-two', { repositoryId: 22 }),
  ]);
  assert.equal(first.token, 'token-for-11');
  assert.equal(second.token, 'token-for-22');
  assert.deepEqual(
    requests.filter(request => request.body).map(request => request.body)
      .sort((left, right) => left.repository_ids[0] - right.repository_ids[0]),
    [{ repository_ids: [11] }, { repository_ids: [22] }],
  );
  assert.ok(requests.some(request => request.url.endsWith('/repositories/11/installation')));
  assert.ok(requests.some(request => request.url.endsWith('/repositories/22/installation')));
  await assert.rejects(
    auth.installationToken('example', 'unsafe', { repositoryId: '9007199254740992' }),
    /safe positive integer/,
  );
  await assert.rejects(
    auth.installationToken('example', 'unsafe', { repositoryId: 0 }),
    /positive integer/,
  );
});

test('refreshable providers rotate App tokens without changing repository scope', async () => {
  let now = Date.parse('2026-08-30T00:00:00Z');
  let requests = 0;
  const authenticator = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    installationId: '456',
    now: () => now,
    fetchImpl: async (_url, options) => {
      requests += 1;
      assert.deepEqual(JSON.parse(options.body), { repository_ids: [11] });
      return jsonResponse({
        token: `rotating-${requests}`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
      });
    },
  });
  const provider = createGitHubEnvironmentProvider('example', 'ios', {
    environment: { PATH: '/bin', GH_TOKEN: 'fallback' },
    authenticator,
    repositoryId: 11,
  });

  assert.equal((await provider()).GH_TOKEN, 'rotating-1');
  now += 56 * 60 * 1000;
  assert.equal((await provider()).GH_TOKEN, 'rotating-2');
  assert.equal(requests, 2);
});

test('repository installation verification invalidates a stale mismatch once', async () => {
  let discoveries = 0;
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    installationId: '222',
    fetchImpl: async url => {
      assert.match(url, /\/repositories\/11\/installation$/);
      discoveries += 1;
      return jsonResponse({ id: discoveries === 1 ? 111 : 222 });
    },
  });

  assert.equal(await auth.verifyRepositoryInstallation('example', 'ios', {
    repositoryId: 11,
    expectedInstallationId: 222,
  }), '222');
  assert.equal(discoveries, 2);
});

test('classifies a confirmed repository installation mismatch as forbidden', async () => {
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    fetchImpl: async () => jsonResponse({ id: 111 }),
  });

  await assert.rejects(
    auth.verifyRepositoryInstallation('example', 'ios', {
      repositoryId: 11,
      expectedInstallationId: 222,
    }),
    error => error.code === 'EINSTALLATIONMISMATCH' && error.statusCode === 403,
  );
});

test('repository installation discovery expires so reinstallations can converge', async () => {
  let now = 1_000;
  let discoveries = 0;
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    now: () => now,
    installationCacheTtlMs: 100,
    fetchImpl: async () => jsonResponse({ id: ++discoveries }),
  });
  assert.equal(await auth.resolveInstallation('example', 'ios', { repositoryId: 11 }), '1');
  assert.equal(await auth.resolveInstallation('example', 'ios', { repositoryId: 11 }), '1');
  now += 101;
  assert.equal(await auth.resolveInstallation('example', 'ios', { repositoryId: 11 }), '2');
  assert.equal(discoveries, 2);
});

test('does not reuse a still-valid token after repository installation ownership changes', async () => {
  let now = Date.parse('2026-08-30T00:00:00Z');
  let discoveries = 0;
  const minted = [];
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    now: () => now,
    installationCacheTtlMs: 100,
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repositories/11/installation') {
        discoveries += 1;
        return jsonResponse({ id: discoveries === 1 ? 111 : 222 });
      }
      const installationId = pathname.split('/')[3];
      minted.push(installationId);
      assert.deepEqual(JSON.parse(options.body), { repository_ids: [11] });
      return jsonResponse({
        token: `token-${installationId}`,
        expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
      });
    },
  });

  assert.equal(
    (await auth.installationToken('example', 'ios', { repositoryId: 11 })).token,
    'token-111',
  );
  now += 101;
  assert.equal(
    (await auth.installationToken('example', 'ios', { repositoryId: 11 })).token,
    'token-222',
  );
  assert.deepEqual(minted, ['111', '222']);
});

test('rediscovers once when a cached installation can no longer mint a repository token', async () => {
  const paths = [];
  let discoveries = 0;
  const auth = new GitHubAppAuthenticator({
    appId: '123',
    privateKey: privateKeyPem,
    now: () => Date.parse('2026-08-30T00:00:00Z'),
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname === '/repositories/11/installation') {
        discoveries += 1;
        return jsonResponse({ id: discoveries === 1 ? 111 : 222 });
      }
      if (pathname === '/app/installations/111/access_tokens') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      assert.equal(pathname, '/app/installations/222/access_tokens');
      return jsonResponse({
        token: 'replacement-installation-token',
        expires_at: '2026-08-30T01:00:00Z',
      });
    },
  });

  const credential = await auth.installationToken('example', 'ios', { repositoryId: 11 });
  assert.equal(credential.installationId, '222');
  assert.equal(credential.token, 'replacement-installation-token');
  assert.deepEqual(paths, [
    '/repositories/11/installation',
    '/app/installations/111/access_tokens',
    '/repositories/11/installation',
    '/app/installations/222/access_tokens',
  ]);
  assert.equal((await auth.installationToken('example', 'ios', { repositoryId: 11 })).token,
    'replacement-installation-token');
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

test('strict environment providers preserve PAT fallback and reject missing credentials', async () => {
  const provider = createGitHubEnvironmentProvider('example', 'ios', {
    environment: { GH_TOKEN: 'pat', PATH: '/bin' },
  });
  assert.deepEqual(await provider(), { GH_TOKEN: 'pat', PATH: '/bin' });
  assert.throws(
    () => createGitHubEnvironmentProvider('example', 'ios', { environment: { PATH: '/bin' } }),
    /GH_TOKEN is required/,
  );
  assert.throws(() => createGitHubEnvironmentProvider('example', 'ios', {
    environment: { GH_TOKEN: 'pat' },
    repositoryId: 0,
  }), /positive integer/);
});
