import crypto from 'node:crypto';

const DEFAULT_API_URL = 'https://api.github.com';
const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000;
const INSTALLATION_CACHE_TTL_MS = 5 * 60 * 1000;
const PERMISSION_LEVEL = { none: 0, read: 1, write: 2 };

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function normalizePrivateKey(environment) {
  if (environment.GITHUB_APP_PRIVATE_KEY && environment.GITHUB_APP_PRIVATE_KEY_BASE64) {
    throw new Error(
      'Configure only one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_BASE64',
    );
  }
  if (environment.GITHUB_APP_PRIVATE_KEY) {
    return environment.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  if (environment.GITHUB_APP_PRIVATE_KEY_BASE64) {
    const encoded = environment.GITHUB_APP_PRIVATE_KEY_BASE64;
    if (
      typeof encoded !== 'string'
      || encoded.length === 0
      || encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw new Error('GITHUB_APP_PRIVATE_KEY_BASE64 is not canonical base64');
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) {
      throw new Error('GITHUB_APP_PRIVATE_KEY_BASE64 is not canonical base64');
    }
    return decoded.toString('utf8');
  }
  return '';
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function waitForSignal(promise, signal = null) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function positiveInteger(value, label) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive integer`);
  }
  return String(value);
}

function repositoryIdentifier(value) {
  const normalized = positiveInteger(value, 'GitHub repository id');
  if (BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('GitHub repository id must be a safe positive integer');
  }
  return normalized;
}

function optionalRepositoryIdentifier(value) {
  if (value === null || value === undefined || value === '') return null;
  return repositoryIdentifier(value);
}

function normalizeApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GITHUB_API_URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('GITHUB_API_URL must be an HTTPS URL without embedded credentials');
  }
  return url.toString().replace(/\/$/, '');
}

export function githubAuthenticationSettings(environment = process.env) {
  const appId = environment.GITHUB_APP_ID || '';
  const privateKey = normalizePrivateKey(environment);
  const installationId = environment.GITHUB_INSTALLATION_ID || '';
  const hasAppConfiguration = Boolean(appId || privateKey || installationId);

  if (!hasAppConfiguration) {
    return { mode: 'token', token: environment.GH_TOKEN || '' };
  }
  if (!appId) throw new Error('GITHUB_APP_ID is required when GitHub App authentication is configured');
  if (!privateKey) {
    throw new Error('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_BASE64 is required when GitHub App authentication is configured');
  }
  const normalizedAppId = positiveInteger(appId, 'GITHUB_APP_ID');
  const normalizedInstallationId = installationId
    ? positiveInteger(installationId, 'GITHUB_INSTALLATION_ID')
    : null;
  try {
    crypto.createPrivateKey(privateKey);
  } catch (error) {
    throw new Error(`GitHub App private key is invalid: ${error.message}`);
  }

  return {
    mode: 'app',
    appId: normalizedAppId,
    privateKey,
    installationId: normalizedInstallationId,
    apiUrl: normalizeApiUrl(environment.GITHUB_API_URL || DEFAULT_API_URL),
  };
}

export function assertGitHubAppPermissions(actual = {}, required = {}) {
  const missing = Object.entries(required).filter(([name, level]) => (
    (PERMISSION_LEVEL[actual[name]] ?? -1) < (PERMISSION_LEVEL[level] ?? Infinity)
  ));
  if (missing.length > 0) {
    throw new Error(`GitHub App installation lacks required permissions: ${missing.map(
      ([name, level]) => `${name}=${level} (has ${actual[name] || 'none'})`,
    ).join(', ')}`);
  }
  return true;
}

export class GitHubAppAuthenticator {
  constructor({
    appId,
    privateKey,
    installationId = null,
    apiUrl = DEFAULT_API_URL,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    refreshSafetyMs = TOKEN_REFRESH_SAFETY_MS,
    requestTimeoutMs = 30000,
    installationCacheTtlMs = INSTALLATION_CACHE_TTL_MS,
  }) {
    if (typeof fetchImpl !== 'function') throw new Error('GitHub App authentication requires fetch');
    this.appId = positiveInteger(appId, 'GitHub App id');
    try {
      crypto.createPrivateKey(privateKey);
    } catch (error) {
      throw new Error(`GitHub App private key is invalid: ${error.message}`);
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('GitHub App request timeout must be a positive number');
    }
    if (!Number.isFinite(installationCacheTtlMs) || installationCacheTtlMs <= 0) {
      throw new Error('GitHub installation cache TTL must be a positive number');
    }
    this.privateKey = privateKey;
    this.installationId = installationId
      ? positiveInteger(installationId, 'GitHub installation id')
      : null;
    this.apiUrl = normalizeApiUrl(apiUrl);
    this.fetch = fetchImpl;
    this.now = now;
    this.refreshSafetyMs = refreshSafetyMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.installationCacheTtlMs = installationCacheTtlMs;
    this.installations = new Map();
    this.installationsInFlight = new Map();
    this.tokens = new Map();
    this.inFlight = new Map();
  }

  createJWT() {
    const nowSeconds = Math.floor(this.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + (9 * 60),
      iss: this.appId,
    }));
    const unsigned = `${header}.${payload}`;
    let signature;
    try {
      signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), this.privateKey).toString('base64url');
    } catch (error) {
      throw new Error(`Could not sign GitHub App JWT: ${error.message}`);
    }
    return `${unsigned}.${signature}`;
  }

  async request(path, {
    method = 'GET',
    token = this.createJWT(),
    body,
    signal = null,
  } = {}) {
    if (signal?.aborted) throw abortReason(signal);
    const timeoutController = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    let response;
    let text;
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'merge4appstore',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
      });
      text = await waitForSignal(Promise.resolve(response.text()), requestSignal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (timeoutController.signal.aborted) {
        throw new Error(`GitHub API ${method} ${path} timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const requestId = response.headers?.get?.('x-github-request-id');
      const detail = data?.message || response.statusText || 'request failed';
      const error = new Error(`GitHub API ${method} ${path} failed (${response.status}${requestId ? `, request ${requestId}` : ''}): ${detail}`);
      error.code = 'EGITHUBAPI';
      error.githubStatus = response.status;
      if (requestId) error.githubRequestId = requestId;
      throw error;
    }
    return { data, headers: response.headers };
  }

  async discoverRepositoryInstallation(
    owner,
    repository,
    { repositoryId = null, signal = null } = {},
  ) {
    const normalizedRepositoryId = optionalRepositoryIdentifier(repositoryId);
    const cacheKey = normalizedRepositoryId
      ? `id:${normalizedRepositoryId}`
      : `name:${owner}/${repository}`.toLowerCase();
    const cached = this.installations.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.installationId;
    this.installations.delete(cacheKey);
    if (this.installationsInFlight.has(cacheKey)) {
      return waitForSignal(this.installationsInFlight.get(cacheKey), signal);
    }
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepository = encodeURIComponent(repository);
    const installationPath = normalizedRepositoryId
      ? `/repositories/${encodeURIComponent(normalizedRepositoryId)}/installation`
      : `/repos/${encodedOwner}/${encodedRepository}/installation`;
    // The shared request retains its own bounded timeout. Individual callers
    // may stop waiting without cancelling token discovery for another worker.
    const request = this.request(installationPath)
      .then(({ data }) => {
        if (!data?.id) throw new Error(`GitHub did not return an installation for ${owner}/${repository}`);
        const installationId = positiveInteger(data.id, 'GitHub installation id');
        this.installations.set(cacheKey, {
          installationId,
          expiresAt: this.now() + this.installationCacheTtlMs,
        });
        return installationId;
      }).finally(() => this.installationsInFlight.delete(cacheKey));
    this.installationsInFlight.set(cacheKey, request);
    return waitForSignal(request, signal);
  }

  async resolveInstallation(owner, repository, { repositoryId = null, signal = null } = {}) {
    if (this.installationId) return this.installationId;
    return this.discoverRepositoryInstallation(owner, repository, { repositoryId, signal });
  }

  async verifyRepositoryInstallation(
    owner,
    repository,
    {
      repositoryId = null,
      expectedInstallationId = null,
      signal = null,
    } = {},
  ) {
    const expected = expectedInstallationId
      ? positiveInteger(expectedInstallationId, 'Expected GitHub installation id')
      : null;
    const matches = discovered => (
      (!this.installationId || discovered === this.installationId)
      && (!expected || discovered === expected)
    );
    let discovered = await this.discoverRepositoryInstallation(owner, repository, {
      repositoryId, signal,
    });
    if (!matches(discovered)) {
      this.invalidateRepositoryInstallation(owner, repository, { repositoryId });
      discovered = await this.discoverRepositoryInstallation(owner, repository, {
        repositoryId, signal,
      });
    }
    if (!matches(discovered)) {
      const required = [
        this.installationId && `configured installation ${this.installationId}`,
        expected && `expected installation ${expected}`,
      ].filter(Boolean).join(' and ');
      const error = new Error(
        `GitHub repository ${owner}/${repository} belongs to installation ${discovered}, not ${required}`,
      );
      error.code = 'EINSTALLATIONMISMATCH';
      error.statusCode = 403;
      throw error;
    }
    return discovered;
  }

  invalidateRepositoryInstallation(owner, repository, { repositoryId = null } = {}) {
    const normalizedRepositoryId = optionalRepositoryIdentifier(repositoryId);
    const repositoryScope = normalizedRepositoryId
      ? `id:${normalizedRepositoryId}`
      : `name:${owner}/${repository}`.toLowerCase();
    this.installations.delete(repositoryScope);
    const tokenPrefix = `${repositoryScope}:installation:`;
    for (const key of this.tokens.keys()) {
      if (key.startsWith(tokenPrefix)) this.tokens.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(tokenPrefix)) this.inFlight.delete(key);
    }
  }

  async installationToken(owner, repository, { repositoryId = null, signal = null } = {}) {
    const normalizedRepositoryId = optionalRepositoryIdentifier(repositoryId);
    const installationId = await this.resolveInstallation(owner, repository, {
      repositoryId: normalizedRepositoryId,
      signal,
    });
    const repositoryScope = normalizedRepositoryId
      ? `id:${normalizedRepositoryId}`
      : `name:${owner}/${repository}`.toLowerCase();
    const cacheKey = `${repositoryScope}:installation:${installationId}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt - this.refreshSafetyMs > this.now()) return cached;
    if (this.inFlight.has(cacheKey)) return waitForSignal(this.inFlight.get(cacheKey), signal);

    const mint = currentInstallationId => this.request(
      `/app/installations/${encodeURIComponent(currentInstallationId)}/access_tokens`,
      {
        method: 'POST',
        body: normalizedRepositoryId
          ? { repository_ids: [Number(normalizedRepositoryId)] }
          : { repositories: [repository] },
      },
    ).then(({ data }) => {
      const expiresAt = Date.parse(data?.expires_at || '');
      if (!data?.token || !Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        throw new Error(`GitHub did not return a valid installation token for ${owner}/${repository}`);
      }
      const credential = {
        token: data.token,
        expiresAt,
        installationId: currentInstallationId,
        permissions: data.permissions || {},
        repositorySelection: data.repository_selection || null,
      };
      return credential;
    });
    const request = (async () => {
      try {
        return await mint(installationId);
      } catch (error) {
        if (
          this.installationId
          || ![404, 422].includes(error?.githubStatus)
        ) throw error;
        // The repository can move to a different installation between cached
        // discovery and token minting. Invalidate only this repository's
        // discovery/token state, rediscover by immutable ID, and retry once.
        this.invalidateRepositoryInstallation(owner, repository, {
          repositoryId: normalizedRepositoryId,
        });
        const refreshedInstallationId = await this.discoverRepositoryInstallation(
          owner,
          repository,
          { repositoryId: normalizedRepositoryId },
        );
        return mint(refreshedInstallationId);
      }
    })().then(credential => {
      const credentialKey = `${repositoryScope}:installation:${credential.installationId}`;
      this.tokens.set(credentialKey, credential);
      return credential;
    }).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, request);
    return waitForSignal(request, signal);
  }

  async environmentForRepository(
    owner,
    repository,
    environment = process.env,
    { repositoryId = null, signal = null } = {},
  ) {
    const credential = await this.installationToken(owner, repository, { repositoryId, signal });
    return {
      ...environment,
      GH_TOKEN: credential.token,
      GITHUB_INSTALLATION_ID: credential.installationId,
    };
  }
}

export function createGitHubAuthenticator(environment = process.env, options = {}) {
  const settings = githubAuthenticationSettings(environment);
  if (settings.mode !== 'app') return null;
  return new GitHubAppAuthenticator({ ...settings, ...options });
}

export async function githubEnvironmentForRepository(
  owner,
  repository,
  environment = process.env,
  {
    authenticator = createGitHubAuthenticator(environment),
    repositoryId = null,
    signal = null,
  } = {},
) {
  if (!authenticator) return { ...environment };
  return authenticator.environmentForRepository(owner, repository, environment, {
    repositoryId,
    signal,
  });
}

export function createGitHubEnvironmentProvider(
  owner,
  repository,
  options = {},
) {
  const environment = options.environment || process.env;
  const authenticator = options.authenticator === undefined
    ? createGitHubAuthenticator(environment)
    : options.authenticator;
  if (!authenticator && !String(environment.GH_TOKEN || '').trim()) {
    throw new Error('GH_TOKEN is required when GitHub App authentication is not configured');
  }
  const repositoryId = optionalRepositoryIdentifier(options.repositoryId);
  return ({ signal = null } = {}) => githubEnvironmentForRepository(
    owner,
    repository,
    environment,
    { authenticator, repositoryId, signal },
  );
}
