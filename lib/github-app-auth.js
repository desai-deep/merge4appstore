import crypto from 'node:crypto';

const DEFAULT_API_URL = 'https://api.github.com';
const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000;
const PERMISSION_LEVEL = { none: 0, read: 1, write: 2 };

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function normalizePrivateKey(environment) {
  if (environment.GITHUB_APP_PRIVATE_KEY) {
    return environment.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  if (environment.GITHUB_APP_PRIVATE_KEY_BASE64) {
    try {
      return Buffer.from(environment.GITHUB_APP_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
    } catch (error) {
      throw new Error(`GITHUB_APP_PRIVATE_KEY_BASE64 is invalid: ${error.message}`);
    }
  }
  return '';
}

function positiveInteger(value, label) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive integer`);
  }
  return String(value);
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
    this.privateKey = privateKey;
    this.installationId = installationId
      ? positiveInteger(installationId, 'GitHub installation id')
      : null;
    this.apiUrl = normalizeApiUrl(apiUrl);
    this.fetch = fetchImpl;
    this.now = now;
    this.refreshSafetyMs = refreshSafetyMs;
    this.requestTimeoutMs = requestTimeoutMs;
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

  async request(path, { method = 'GET', token = this.createJWT(), body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    let response;
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
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`GitHub API ${method} ${path} timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
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
      throw new Error(`GitHub API ${method} ${path} failed (${response.status}${requestId ? `, request ${requestId}` : ''}): ${detail}`);
    }
    return { data, headers: response.headers };
  }

  async resolveInstallation(owner, repository) {
    if (this.installationId) return this.installationId;
    const cacheKey = `${owner}/${repository}`.toLowerCase();
    if (this.installations.has(cacheKey)) return this.installations.get(cacheKey);
    if (this.installationsInFlight.has(cacheKey)) return this.installationsInFlight.get(cacheKey);
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepository = encodeURIComponent(repository);
    const request = this.request(`/repos/${encodedOwner}/${encodedRepository}/installation`)
      .then(({ data }) => {
        if (!data?.id) throw new Error(`GitHub did not return an installation for ${owner}/${repository}`);
        const installationId = positiveInteger(data.id, 'GitHub installation id');
        this.installations.set(cacheKey, installationId);
        return installationId;
      }).finally(() => this.installationsInFlight.delete(cacheKey));
    this.installationsInFlight.set(cacheKey, request);
    return request;
  }

  async installationToken(owner, repository) {
    const installationId = await this.resolveInstallation(owner, repository);
    const cacheKey = `${installationId}:${owner}/${repository}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt - this.refreshSafetyMs > this.now()) return cached;
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey);

    const request = this.request(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: 'POST',
      body: { repositories: [repository] },
    }).then(({ data }) => {
      const expiresAt = Date.parse(data?.expires_at || '');
      if (!data?.token || !Number.isFinite(expiresAt)) {
        throw new Error(`GitHub did not return a valid installation token for ${owner}/${repository}`);
      }
      const credential = {
        token: data.token,
        expiresAt,
        installationId,
        permissions: data.permissions || {},
        repositorySelection: data.repository_selection || null,
      };
      this.tokens.set(cacheKey, credential);
      return credential;
    }).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, request);
    return request;
  }

  async environmentForRepository(owner, repository, environment = process.env) {
    const credential = await this.installationToken(owner, repository);
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
  { authenticator = createGitHubAuthenticator(environment) } = {},
) {
  if (!authenticator) return { ...environment };
  return authenticator.environmentForRepository(owner, repository, environment);
}
