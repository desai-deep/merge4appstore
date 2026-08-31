import crypto from 'crypto';
import { CONFIG, log } from './config.js';

const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
  requestTimeoutMs: 15000,
};
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const DEFAULT_ASSET_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

function ambiguousRequestError(method, endpoint, detail, cause = null) {
  const error = new Error(
    `App Store Connect ${method} ${endpoint} may have succeeded, but ${detail}; the result is ambiguous and must be reconciled before retrying`,
    cause ? { cause } : undefined,
  );
  error.statusCode = 503;
  error.retryAfter = 5;
  error.code = 'EAMBIGUOUSRESULT';
  error.ambiguousResult = true;
  return error;
}

async function sleep(ms, signal = null) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createRequestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error(`App Store Connect request timed out after ${timeoutMs}ms`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  const onAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function sourceBranchForRun(run, runsData) {
  const sourceRefId = run.relationships?.sourceBranchOrTag?.data?.id;
  const sourceRef = runsData.included?.find(
    item => item.type === 'scmGitReferences' && item.id === sourceRefId
  );
  const sourceBranch = sourceRef?.attributes?.name || sourceRef?.attributes?.canonicalName;
  if (sourceBranch) return sourceBranch;
  const pullRequestId = run.relationships?.pullRequest?.data?.id;
  const pullRequest = runsData.included?.find(
    item => item.type === 'scmPullRequests' && item.id === pullRequestId
  );
  return pullRequest?.attributes?.sourceBranchName || null;
}

async function readResponseData(response) {
  if (typeof response.text !== 'function') {
    return { data: await response.json(), validJson: true, rawResponse: '' };
  }
  const text = await response.text();
  if (!text) return { data: null, validJson: false, rawResponse: '' };
  try {
    return { data: JSON.parse(text), validJson: true, rawResponse: text };
  } catch {
    return { data: null, validJson: false, rawResponse: text.slice(0, 2_000) };
  }
}

async function consumeRetryResponse(response) {
  if (typeof response.arrayBuffer === 'function') await response.arrayBuffer();
  else if (typeof response.text === 'function') await response.text();
  else if (typeof response.json === 'function') await response.json();
}

export function appStoreErrorDetails(responseBody = {}) {
  const errors = Array.isArray(responseBody.errors) ? responseBody.errors : [];
  const source = errors.flatMap(error => {
    const associatedErrors = Object.values(error?.meta?.associatedErrors || {}).flat();
    return associatedErrors.length > 0 ? associatedErrors : [error];
  });

  return source.map(error => ({
    code: error?.code || null,
    title: error?.title || null,
    detail: error?.detail || null,
  })).filter(error => error.code || error.title || error.detail);
}

export function formatAppStoreErrorDetail(error = {}) {
  const label = error.title || error.code || 'App Store Connect error';
  if (!error.detail || error.detail === label) return label;
  return `${label}: ${error.detail}`;
}

export class AppStoreConnectAPI {
  constructor(keyId, issuerId, privateKeyContent) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = Buffer.from(privateKeyContent, 'base64').toString('utf8');
    this.token = null;
    this.tokenExpiry = null;
    this.appId = null;
    this.ciWorkflowBuildRuns = new Map();
  }

  generateToken() {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 20 * 60; // 20 minutes

    if (this.token && this.tokenExpiry && now < this.tokenExpiry - 60) {
      return this.token;
    }

    const header = {
      alg: 'ES256',
      kid: this.keyId,
      typ: 'JWT'
    };

    const payload = {
      iss: this.issuerId,
      iat: now,
      exp: expiry,
      aud: 'appstoreconnect-v1'
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${headerB64}.${payloadB64}`;

    const sign = crypto.createSign('SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(this.privateKey);

    // Convert DER signature to raw r||s format for ES256
    const rawSignature = this.derToRaw(signature);
    const signatureB64 = rawSignature.toString('base64url');

    this.token = `${signatureInput}.${signatureB64}`;
    this.tokenExpiry = expiry;
    return this.token;
  }

  derToRaw(derSignature) {
    // Parse DER signature and extract r and s values
    let offset = 0;
    if (derSignature[offset++] !== 0x30) throw new Error('Invalid DER signature');

    let length = derSignature[offset++];
    if (length & 0x80) offset += (length & 0x7f);

    if (derSignature[offset++] !== 0x02) throw new Error('Invalid DER signature');
    let rLength = derSignature[offset++];
    let r = derSignature.slice(offset, offset + rLength);
    offset += rLength;

    if (derSignature[offset++] !== 0x02) throw new Error('Invalid DER signature');
    let sLength = derSignature[offset++];
    let s = derSignature.slice(offset, offset + sLength);

    // Remove leading zeros and pad to 32 bytes
    while (r.length > 32 && r[0] === 0) r = r.slice(1);
    while (s.length > 32 && s[0] === 0) s = s.slice(1);
    while (r.length < 32) r = Buffer.concat([Buffer.from([0]), r]);
    while (s.length < 32) s = Buffer.concat([Buffer.from([0]), s]);

    return Buffer.concat([r, s]);
  }

  async request(endpoint, options = {}, retryOptions = {}) {
    const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
    const url = endpoint.startsWith('http') ? endpoint : `${CONFIG.apiBaseUrl}${endpoint}`;
    const method = String(options.method || 'GET').toUpperCase();

    let lastError;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      const parentSignal = options.signal || this.signal || null;
      const requestDeadline = createRequestSignal(parentSignal, opts.requestTimeoutMs);
      try {
        const token = this.generateToken();

        const signal = requestDeadline.signal;
        const response = await fetch(url, {
          ...options,
          signal,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });

        if (response.status === 204) {
          // App Store Connect create endpoints return the created resource. A
          // body-less POST may therefore mean that an intermediary lost the
          // representation after Apple committed the mutation. Never let the
          // durable delivery retry that create as though it definitely failed.
          if (method === 'POST') {
            throw ambiguousRequestError(method, endpoint, 'it returned HTTP 204 without the created resource');
          }
          if (method === 'PATCH' || method === 'DELETE') return null;
          // GET callers require a JSON representation. Let the normal
          // malformed-success handling retry or surface a retryable failure.
        }

        // Handle rate limiting with Retry-After header
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
          if (attempt < opts.maxRetries && IDEMPOTENT_METHODS.has(method)) {
            const delay = retryAfter > 0
              ? Math.min(retryAfter * 1000, opts.maxDelayMs)
              : this.calculateBackoff(attempt, opts);
            log(`Rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
            await consumeRetryResponse(response);
            requestDeadline.dispose();
            await sleep(delay, parentSignal);
            continue;
          }
        }

        // Retry on server errors
        if (
          opts.retryableStatusCodes.includes(response.status)
          && attempt < opts.maxRetries
          && IDEMPOTENT_METHODS.has(method)
        ) {
          const delay = this.calculateBackoff(attempt, opts);
          log(`Request failed with ${response.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
          await consumeRetryResponse(response);
          requestDeadline.dispose();
          await sleep(delay, parentSignal);
          continue;
        }

        const parsedResponse = await readResponseData(response);
        const data = parsedResponse.data;

        if (
          response.ok
          && (
            !parsedResponse.validJson
            || !data
            || typeof data !== 'object'
            || Array.isArray(data)
          )
        ) {
          if (attempt < opts.maxRetries && IDEMPOTENT_METHODS.has(method)) {
            const delay = this.calculateBackoff(attempt, opts);
            log(`App Store Connect returned malformed JSON, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
            requestDeadline.dispose();
            await sleep(delay, parentSignal);
            continue;
          }
          const ambiguous = !IDEMPOTENT_METHODS.has(method);
          const error = ambiguous
            ? ambiguousRequestError(method, endpoint, 'it returned malformed JSON')
            : Object.assign(
              new Error(`App Store Connect returned malformed JSON for HTTP ${response.status}`),
              { statusCode: 503, retryAfter: 5 },
            );
          throw error;
        }

        if (!response.ok) {
          const responseBody = data && typeof data === 'object' ? data : {};
          const appStoreErrors = appStoreErrorDetails(responseBody);
          const errorDetail = appStoreErrors.length > 0
            ? appStoreErrors.map(formatAppStoreErrorDetail).join('; ')
            : parsedResponse.rawResponse || JSON.stringify(data);
          if (
            !IDEMPOTENT_METHODS.has(method)
            && (response.status === 429 || opts.retryableStatusCodes.includes(response.status))
          ) {
            const ambiguous = ambiguousRequestError(
              method,
              endpoint,
              `it returned retryable HTTP ${response.status}${errorDetail ? ` (${errorDetail})` : ''}`,
            );
            ambiguous.httpStatus = response.status;
            ambiguous.appStoreErrors = appStoreErrors;
            ambiguous.apiResponse = responseBody;
            throw ambiguous;
          }
          const error = new Error(`API Error ${response.status}: ${errorDetail}`);
          error.statusCode = response.status;
          if (opts.retryableStatusCodes.includes(response.status) || response.status === 429) {
            error.retryAfter = 5;
          }
          error.appStoreErrors = appStoreErrors;
          error.apiResponse = responseBody;
          throw error;
        }

        return data;
      } catch (error) {
        lastError = error;

        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          if (!IDEMPOTENT_METHODS.has(method)) {
            throw ambiguousRequestError(method, endpoint, 'the request was interrupted after it may have been sent', error);
          }
          if (error.name === 'TimeoutError' && attempt < opts.maxRetries && !parentSignal?.aborted) {
            const delay = this.calculateBackoff(attempt, opts);
            log(`Request timed out, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
            requestDeadline.dispose();
            await sleep(delay, parentSignal);
            continue;
          }
          error.statusCode = 503;
          error.retryAfter = 5;
          throw error;
        }

        // Retry on network errors
        if (
          error.name === 'TypeError'
          && error.message.includes('fetch')
          && !IDEMPOTENT_METHODS.has(method)
        ) {
          throw ambiguousRequestError(method, endpoint, 'the network response was lost', error);
        }
        if (error.name === 'TypeError' && error.message.includes('fetch') && attempt < opts.maxRetries) {
          const delay = this.calculateBackoff(attempt, opts);
          log(`Network error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
          requestDeadline.dispose();
          await sleep(delay, parentSignal);
          continue;
        }

        if (error.name === 'TypeError' && error.message.includes('fetch')) {
          error.statusCode = 503;
          error.retryAfter = 5;
        }

        throw error;
      } finally {
        requestDeadline.dispose();
      }
    }

    throw lastError;
  }

  calculateBackoff(attempt, opts) {
    const delay = opts.initialDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * delay; // Add up to 30% jitter
    return Math.min(delay + jitter, opts.maxDelayMs);
  }

  async getAppId() {
    if (this.appId) return this.appId;

    // Use APP_ID if provided, otherwise lookup by bundle ID
    if (CONFIG.appId) {
      this.appId = CONFIG.appId;
      return this.appId;
    }

    const data = await this.request(`/apps?filter[bundleId]=${CONFIG.appIdentifier}`);
    if (!data.data?.[0]) {
      throw new Error(`App not found: ${CONFIG.appIdentifier}`);
    }
    // If multiple apps match, prefer the one with the exact name
    const exactMatch = data.data.find(app => app.attributes?.name === CONFIG.appName);
    this.appId = exactMatch?.id || data.data[0].id;
    return this.appId;
  }

  async getAppStoreVersions() {
    const appId = await this.getAppId();
    const data = await this.request(`/apps/${appId}/appStoreVersions?include=build`);
    return data;
  }

  async getAppPrimaryLocale() {
    const appId = await this.getAppId();
    const response = await this.request(`/apps/${appId}?fields[apps]=primaryLocale`);
    const locale = response.data?.attributes?.primaryLocale;
    if (!locale) throw new Error('App Store Connect did not return the app primary locale');
    return locale;
  }

  async checkBuildInReview() {
    const versions = await this.getAppStoreVersions();
    const reviewStates = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'];

    for (const version of versions.data || []) {
      if (reviewStates.includes(version.attributes.appStoreState)) {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = 'unknown';

        if (buildId && versions.included) {
          const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || 'unknown';
        }

        return {
          inReview: true,
          version: version.attributes.versionString,
          state: version.attributes.appStoreState,
          buildNumber,
          buildId: buildId || null,
          versionId: version.id,
        };
      }
    }

    return { inReview: false };
  }

  async checkRejectedVersion() {
    const versions = await this.getAppStoreVersions();
    const rejectedStates = ['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED'];
    let latestRejected = null;

    for (const version of versions.data || []) {
      if (rejectedStates.includes(version.attributes.appStoreState)) {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = 'unknown';

        if (buildId && versions.included) {
          const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || 'unknown';
        }

        const rejectedVersion = {
          rejected: true,
          blockReason: 'rejected',
          version: version.attributes.versionString,
          state: version.attributes.appStoreState,
          buildNumber,
          buildId: buildId || null,
          versionId: version.id,
        };

        const currentBuildNum = parseInt(buildNumber, 10);
        const latestBuildNum = latestRejected ? parseInt(latestRejected.buildNumber, 10) : NaN;

        if (!latestRejected) {
          latestRejected = rejectedVersion;
          continue;
        }

        if (!isNaN(currentBuildNum) && (isNaN(latestBuildNum) || currentBuildNum > latestBuildNum)) {
          latestRejected = rejectedVersion;
        }
      }
    }

    return latestRejected || { rejected: false };
  }

  async checkVersionWithUnresolvedIssues() {
    const versions = await this.getAppStoreVersions();
    const appId = await this.getAppId();
    const data = await this.request(
      `/apps/${appId}/reviewSubmissions?filter[state]=UNRESOLVED_ISSUES&include=items&limit=200&limit[items]=50&fields[reviewSubmissionItems]=appStoreVersion,state`
    );

    const includedItems = data.included?.filter(item => item.type === 'reviewSubmissionItems') || [];
    const versionIds = new Set();

    for (const submission of data.data || []) {
      const itemIds = new Set((submission.relationships?.items?.data || []).map(item => item.id));

      for (const item of includedItems) {
        if (!itemIds.has(item.id)) continue;
        if (item.attributes?.state !== 'UNRESOLVED_ISSUES') continue;

        const versionId = item.relationships?.appStoreVersion?.data?.id;
        if (versionId) {
          versionIds.add(versionId);
        }
      }
    }

    let latestVersion = null;

    for (const version of versions.data || []) {
      if (!versionIds.has(version.id)) continue;

      const buildId = version.relationships?.build?.data?.id;
      let buildNumber = 'unknown';

      if (buildId && versions.included) {
        const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
        buildNumber = build?.attributes?.version || 'unknown';
      }

      const unresolvedVersion = {
        hasUnresolvedIssues: true,
        blockReason: 'unresolved_review',
        version: version.attributes.versionString,
        state: version.attributes.appStoreState,
        buildNumber,
        buildId: buildId || null,
        versionId: version.id,
      };

      const currentBuildNum = parseInt(buildNumber, 10);
      const latestBuildNum = latestVersion ? parseInt(latestVersion.buildNumber, 10) : NaN;

      if (!latestVersion) {
        latestVersion = unresolvedVersion;
        continue;
      }

      if (!isNaN(currentBuildNum) && (isNaN(latestBuildNum) || currentBuildNum > latestBuildNum)) {
        latestVersion = unresolvedVersion;
      }
    }

    return latestVersion || { hasUnresolvedIssues: false };
  }

  async getLiveProductionBuild() {
    const versions = await this.getAppStoreVersions();

    for (const version of versions.data || []) {
      if (version.attributes.appStoreState === 'READY_FOR_SALE') {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = '0';

        if (buildId && versions.included) {
          const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || '0';
        }

        return {
          live: true,
          version: version.attributes.versionString,
          buildNumber,
          buildId: buildId || null,
        };
      }
    }

    return { live: false, buildNumber: '0', buildId: null };
  }

  async getTestFlightReadyBuilds() {
    const appId = await this.getAppId();

    const data = await this.request(
      `/builds?filter[app]=${appId}&sort=-uploadedDate&limit=50&include=preReleaseVersion,buildBetaDetail`
    );

    const versions = await this.getAppStoreVersions();
    const liveVersion = versions.data?.find(v => v.attributes.appStoreState === 'READY_FOR_SALE');
    const liveBuildId = liveVersion?.relationships?.build?.data?.id;

    // PREPARE_FOR_SUBMISSION is submittable and may already have the correct build selected.
    // Do not exclude it here or deploy will never pick that build up for submission.
    const reviewStates = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'];
    const inProgressVersion = versions.data?.find(v => reviewStates.includes(v.attributes.appStoreState));
    const inProgressBuildId = inProgressVersion?.relationships?.build?.data?.id;

    const builds = [];
    for (const build of data.data || []) {
      if (build.attributes.processingState !== 'VALID') continue;
      if (build.attributes.expired) continue;
      if (build.id === liveBuildId) continue;
      if (build.id === inProgressBuildId) continue;

      const preReleaseVersionId = build.relationships?.preReleaseVersion?.data?.id;
      let versionString = 'unknown';
      if (preReleaseVersionId && data.included) {
        const preRelease = data.included.find(i => i.type === 'preReleaseVersions' && i.id === preReleaseVersionId);
        versionString = preRelease?.attributes?.version || 'unknown';
      }

      const betaDetailId = build.relationships?.buildBetaDetail?.data?.id;
      let betaState = 'unknown';
      if (betaDetailId && data.included) {
        const betaDetail = data.included.find(i => i.type === 'buildBetaDetails' && i.id === betaDetailId);
        betaState = betaDetail?.attributes?.externalBuildState || 'unknown';
      }

      builds.push({
        buildNumber: build.attributes.version,
        version: versionString,
        betaState,
        buildId: build.id,
      });
    }

    return builds;
  }

  async getTestFlightCleanupCandidates() {
    const appId = await this.getAppId();
    const data = await this.request(
      `/builds?filter[app]=${appId}&filter[expired]=false&filter[processingState]=VALID&sort=-uploadedDate&limit=200&include=preReleaseVersion,appStoreVersion`
    );

    const builds = [];
    for (const build of data.data || []) {
      if (build.attributes?.expired || build.attributes?.processingState !== 'VALID') continue;

      // A build selected for any App Store version is never cleanup material.
      if (build.relationships?.appStoreVersion?.data) continue;

      const preReleaseVersionId = build.relationships?.preReleaseVersion?.data?.id;
      const preReleaseVersion = data.included?.find(
        item => item.type === 'preReleaseVersions' && item.id === preReleaseVersionId
      );

      builds.push({
        buildId: build.id,
        buildNumber: build.attributes.version,
        version: preReleaseVersion?.attributes?.version || 'unknown',
        uploadedDate: build.attributes.uploadedDate || null,
      });
    }

    return builds;
  }

  async expireBuild(buildId) {
    return this.request(`/builds/${buildId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'builds',
          id: buildId,
          attributes: { expired: true },
        },
      }),
    });
  }

  async getCIProducts() {
    const data = await this.request('/ciProducts?include=app');
    return data.data || [];
  }

  async getConfiguredCIProducts() {
    const [products, appId] = await Promise.all([
      this.getCIProducts(),
      this.getAppId(),
    ]);

    const appProducts = products.filter(
      product => product.relationships?.app?.data?.id === appId
    );

    if (appProducts.length > 0) return appProducts;

    // Older responses may omit relationship data. Keep an exact-name fallback
    // while avoiding similarly named products such as "Running Order UAT".
    const namedProducts = products.filter(
      product => product.attributes?.name === CONFIG.appName
    );

    if (namedProducts.length > 0) return namedProducts;

    throw new Error(`Xcode Cloud product not found for app: ${CONFIG.appName}`);
  }

  async getWorkflows(productId) {
    const data = await this.request(`/ciProducts/${productId}/workflows`);
    return data.data || [];
  }

  async getBuildRuns(workflowId, limit = 50) {
    const data = await this.request(
      `/ciWorkflows/${workflowId}/buildRuns?limit=${limit}&sort=-number&include=builds,sourceBranchOrTag,pullRequest&fields[ciBuildRuns]=number,sourceCommit,isPullRequestBuild,executionProgress,completionStatus,builds,sourceBranchOrTag,pullRequest&fields[builds]=version&fields[scmGitReferences]=name,canonicalName&fields[scmPullRequests]=number,sourceBranchName,destinationBranchName`
    );
    return data;
  }

  async getBuildRun(runId) {
    const data = await this.request(`/ciBuildRuns/${runId}`);
    const run = data.data;
    return {
      runId: run.id,
      number: run.attributes?.number,
      executionProgress: run.attributes?.executionProgress,
      completionStatus: run.attributes?.completionStatus,
      sourceCommit: run.attributes?.sourceCommit || null,
    };
  }

  async getWorkflowRunStatus(
    workflowId,
    commitSha,
    branch,
    pullRequestNumber = null,
    requestedPullRequestId = null,
    requestedBranchId = null,
  ) {
    const runsData = await this.getBuildRuns(workflowId, 200);
    let unknownActiveBranchRun = null;
    let uncertainActiveBranchRun = null;
    let unknownActivePullRequestRun = null;
    let uncertainActivePullRequestRun = null;

    for (const run of runsData.data || []) {
      const sourceCommit = run.attributes?.sourceCommit;
      const runCommitSha = typeof sourceCommit === 'string'
        ? sourceCommit
        : sourceCommit?.commitSha || sourceCommit?.hash || sourceCommit?.canonicalHash || sourceCommit?.id || null;
      const sourceRefId = run.relationships?.sourceBranchOrTag?.data?.id;
      const sourceRef = runsData.included?.find(
        item => item.type === 'scmGitReferences' && item.id === sourceRefId
      );
      const sourceBranch = sourceRef?.attributes?.name
        || sourceRef?.attributes?.canonicalName?.replace(/^refs\/heads\//, '')
        || null;
      const runPullRequestId = run.relationships?.pullRequest?.data?.id;
      const pullRequest = runsData.included?.find(
        item => item.type === 'scmPullRequests' && item.id === runPullRequestId
      );
      const runPullRequestNumber = pullRequest?.attributes?.number;

      if (runCommitSha === commitSha) {
        return {
          found: true,
          runId: run.id,
          number: run.attributes?.number,
          executionProgress: run.attributes?.executionProgress,
          completionStatus: run.attributes?.completionStatus,
        };
      }

      const isActive = ['PENDING', 'RUNNING'].includes(run.attributes?.executionProgress);
      const isPullRequestBuild = run.attributes?.isPullRequestBuild === true || Boolean(runPullRequestId);
      const hasRequestedBranch = branch != null || requestedBranchId != null;
      const isRequestedBranch = !isPullRequestBuild && (
        (requestedBranchId != null && requestedBranchId === sourceRefId)
        || (
          requestedBranchId == null
          && sourceBranch != null
          && sourceBranch === branch
        )
      );
      if (
        !runCommitSha
        && isActive
        && isRequestedBranch
        && !unknownActiveBranchRun
      ) {
        unknownActiveBranchRun = {
          runId: run.id,
          number: run.attributes?.number,
          executionProgress: run.attributes?.executionProgress,
        };
      }
      const branchIdentityUnavailable = hasRequestedBranch
        && !isPullRequestBuild
        && (requestedBranchId == null || !sourceRefId)
        && sourceBranch == null;
      if (
        !runCommitSha
        && isActive
        && branchIdentityUnavailable
        && !uncertainActiveBranchRun
      ) {
        uncertainActiveBranchRun = {
          runId: run.id,
          number: run.attributes?.number,
          executionProgress: run.attributes?.executionProgress,
        };
      }
      const hasRequestedPullRequest = pullRequestNumber != null || requestedPullRequestId != null;
      const isRequestedPullRequest = isPullRequestBuild && (
        (requestedPullRequestId != null && requestedPullRequestId === runPullRequestId)
        || (
          requestedPullRequestId == null
          && pullRequestNumber != null
          && runPullRequestNumber != null
          && String(runPullRequestNumber) === String(pullRequestNumber)
        )
      );
      if (!runCommitSha && isActive && isRequestedPullRequest && !unknownActivePullRequestRun) {
        unknownActivePullRequestRun = {
          runId: run.id,
          number: run.attributes?.number,
          executionProgress: run.attributes?.executionProgress,
        };
      }
      const pullRequestIdentityUnavailable = hasRequestedPullRequest
        && isPullRequestBuild
        && (requestedPullRequestId == null || !runPullRequestId)
        && runPullRequestNumber == null;
      if (
        !runCommitSha
        && isActive
        && pullRequestIdentityUnavailable
        && !uncertainActivePullRequestRun
      ) {
        uncertainActivePullRequestRun = {
          runId: run.id,
          number: run.attributes?.number,
          executionProgress: run.attributes?.executionProgress,
        };
      }
    }

    return {
      found: false,
      unknownActiveBranchRun,
      ...(uncertainActiveBranchRun ? { uncertainActiveBranchRun } : {}),
      ...(unknownActivePullRequestRun ? { unknownActivePullRequestRun } : {}),
      ...(uncertainActivePullRequestRun ? { uncertainActivePullRequestRun } : {}),
    };
  }

  async getWorkflowBranchReference(workflowId, branch) {
    const repository = await this.getWorkflowRepository(workflowId);
    const refs = await this.request(`/scmRepositories/${repository.data.id}/gitReferences?limit=200`);
    const canonicalName = `refs/heads/${branch}`;
    const ref = (refs.data || []).find(candidate => (
      candidate.attributes?.kind === 'BRANCH'
      && !candidate.attributes?.isDeleted
      && (candidate.attributes?.name === branch || candidate.attributes?.canonicalName === canonicalName)
    ));

    return ref ? { id: ref.id, name: branch } : null;
  }

  async getWorkflowRepository(workflowId) {
    return this.request(`/ciWorkflows/${workflowId}/repository`);
  }

  async getWorkflowPullRequest(workflowId, pullRequestNumber) {
    const repository = await this.getWorkflowRepository(workflowId);
    const pullRequests = await this.request(
      `/scmRepositories/${repository.data.id}/pullRequests?limit=200`
    );
    const pullRequest = (pullRequests.data || []).find(candidate => (
      String(candidate.attributes?.number) === String(pullRequestNumber)
      && !candidate.attributes?.isClosed
    ));

    return pullRequest ? {
      id: pullRequest.id,
      number: String(pullRequest.attributes.number),
      sourceBranchName: pullRequest.attributes?.sourceBranchName || null,
      destinationBranchName: pullRequest.attributes?.destinationBranchName || null,
    } : null;
  }

  async startWorkflowBuild(workflowId, sourceReferenceId, { pullRequestId = null } = {}) {
    const sourceRelationship = pullRequestId
      ? { pullRequest: { data: { type: 'scmPullRequests', id: pullRequestId } } }
      : { sourceBranchOrTag: { data: { type: 'scmGitReferences', id: sourceReferenceId } } };
    const response = await this.request('/ciBuildRuns', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'ciBuildRuns',
          attributes: { clean: true },
          relationships: {
            workflow: {
              data: { type: 'ciWorkflows', id: workflowId },
            },
            ...sourceRelationship,
          },
        },
      }),
    });

    this.ciBuildRuns = null;
    this.ciWorkflowBuildRuns.clear();
    return {
      runId: response.data.id,
      number: response.data.attributes?.number,
      executionProgress: response.data.attributes?.executionProgress,
    };
  }

  async loadCIBuildRuns() {
    if (this.ciBuildRuns) return this.ciBuildRuns;

    this.ciBuildRuns = [];
    const products = await this.getConfiguredCIProducts();

    for (const product of products) {
      const workflows = await this.getWorkflows(product.id);

      for (const workflow of workflows) {
        const runsData = await this.getBuildRuns(workflow.id, 200);
        for (const run of runsData.data || []) {
          this.ciBuildRuns.push({
            run,
            workflowId: workflow.id,
            workflowName: workflow.attributes?.name,
            sourceBranch: sourceBranchForRun(run, runsData),
          });
        }
      }
    }

    return this.ciBuildRuns;
  }

  async loadCIBuildRunsForWorkflow(workflowId) {
    if (this.ciWorkflowBuildRuns.has(workflowId)) return this.ciWorkflowBuildRuns.get(workflowId);

    const runsData = await this.getBuildRuns(workflowId, 200);
    const runs = (runsData.data || []).map(run => {
      return {
        run,
        workflowId,
        workflowName: null,
        sourceBranch: sourceBranchForRun(run, runsData),
      };
    });
    this.ciWorkflowBuildRuns.set(workflowId, runs);
    return runs;
  }

  async getBuildCommitSHA(buildNumber) {
    const buildRuns = await this.loadCIBuildRuns();
    // CI run numbers are scoped to a workflow, not globally unique. This
    // compatibility lookup has no App Store build ID to disambiguate the run,
    // so fail closed unless exactly one configured-app run has this number.
    return this.getBuildSource(null, buildNumber, buildRuns);
  }

  async getBuildSource(buildId, buildNumber = null, scopedBuildRuns = null) {
    const buildRuns = scopedBuildRuns || await this.loadCIBuildRuns();

    for (const { run, workflowId, workflowName, sourceBranch } of buildRuns) {
      const buildIds = run.relationships?.builds?.data?.map(build => build.id) || [];
      if (!buildId || !buildIds.includes(buildId)) continue;

      const sourceCommit = run.attributes?.sourceCommit;
      const commitSha = typeof sourceCommit === 'string'
        ? sourceCommit
        : sourceCommit?.commitSha || sourceCommit?.hash || sourceCommit?.canonicalHash || sourceCommit?.id || null;

      return {
        found: true,
        commitSha,
        sourceBranch: sourceBranch?.replace(/^refs\/heads\//, '') || null,
        workflowId,
        workflowName,
      };
    }

    // Some Xcode Cloud responses expose an empty builds relationship even when
    // the run produced a TestFlight build. Build run numbers and uploaded build
    // numbers share the same counter, so use the number only when it identifies
    // exactly one run within the configured app product.
    if (buildNumber !== null) {
      const matchingRuns = buildRuns.filter(
        ({ run }) => run.attributes?.number?.toString() === buildNumber.toString()
      );

      if (matchingRuns.length === 1) {
        const { run, workflowId, workflowName, sourceBranch } = matchingRuns[0];
        const sourceCommit = run.attributes?.sourceCommit;
        const commitSha = typeof sourceCommit === 'string'
          ? sourceCommit
          : sourceCommit?.commitSha || sourceCommit?.hash || sourceCommit?.canonicalHash || sourceCommit?.id || null;

        return {
          found: true,
          commitSha,
          sourceBranch: sourceBranch?.replace(/^refs\/heads\//, '') || null,
          workflowId,
          workflowName,
        };
      }
    }

    return { found: false };
  }

  async getPublishedWorkflowCommits(workflowId, limit = 200) {
    const appId = await this.getAppId();
    const builds = await this.request(
      `/builds?filter[app]=${appId}&filter[processingState]=VALID&sort=-uploadedDate&limit=200&include=preReleaseVersion&fields[builds]=version,uploadedDate,processingState,preReleaseVersion&fields[preReleaseVersions]=version`
    );
    const commits = [];
    const seen = new Set();
    const buildRuns = await this.loadCIBuildRunsForWorkflow(workflowId);
    const marketingVersions = new Map((builds.included || [])
      .filter(item => item.type === 'preReleaseVersions')
      .map(item => [item.id, item.attributes?.version || null]));

    for (const build of builds.data || []) {
      if (build.attributes?.processingState && build.attributes.processingState !== 'VALID') continue;
      // A build-number fallback is unsafe against a workflow-scoped run list:
      // another workflow may have produced an unrelated App Store build with
      // the same number. Published history must have an exact build relation.
      const source = await this.getBuildSource(build.id, null, buildRuns);
      if (!source.found || source.workflowId !== workflowId || !source.commitSha) continue;
      const sourceBranch = source.sourceBranch?.replace(/^refs\/heads\//, '') || null;
      const sourceKey = `${sourceBranch || ''}\0${source.commitSha}`;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      commits.push({
        commitSha: source.commitSha,
        sourceBranch,
        buildId: build.id,
        buildNumber: build.attributes?.version || null,
        marketingVersion: marketingVersions.get(build.relationships?.preReleaseVersion?.data?.id) || null,
        uploadedDate: build.attributes?.uploadedDate || null,
      });
      if (commits.length >= limit) break;
    }

    return commits;
  }

  async getBuildsForWorkflowCommit(workflowId, commitSha) {
    const appId = await this.getAppId();
    const builds = await this.request(
      `/builds?filter[app]=${appId}&filter[expired]=false&filter[processingState]=VALID&sort=-uploadedDate&limit=200`
    );
    const matches = [];
    const buildRuns = await this.loadCIBuildRunsForWorkflow(workflowId);
    for (const build of builds.data || []) {
      const source = await this.getBuildSource(build.id, null, buildRuns);
      if (source.found && source.workflowId === workflowId && source.commitSha === commitSha) {
        matches.push({ buildId: build.id, buildNumber: build.attributes?.version || null });
      }
    }
    return matches;
  }

  async updateBetaBuildNotes(buildId, notes, locale = 'en-US') {
    const localizations = await this.request(`/builds/${buildId}/betaBuildLocalizations`);
    const existing = (localizations.data || []).find(
      localization => localization.attributes?.locale === locale
    );
    if (existing) {
      await this.request(`/betaBuildLocalizations/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'betaBuildLocalizations',
            id: existing.id,
            attributes: { whatsNew: notes },
          },
        }),
      });
      return { created: false, localizationId: existing.id };
    }

    const response = await this.request('/betaBuildLocalizations', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale, whatsNew: notes },
          relationships: { build: { data: { type: 'builds', id: buildId } } },
        },
      }),
    });
    return { created: true, localizationId: response.data?.id || null };
  }

  async cancelReview(versionId) {
    const submissionId = await this.getReviewSubmissionIdForVersion(versionId, [
      'READY_FOR_REVIEW',
      'WAITING_FOR_REVIEW',
      'IN_REVIEW',
      'UNRESOLVED_ISSUES',
      'CANCELING',
      'COMPLETING',
    ]);

    if (!submissionId) {
      return { success: false, error: 'No submission found' };
    }

    await this.request(`/reviewSubmissions/${submissionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissions',
          id: submissionId,
          attributes: {
            canceled: true,
          },
        },
      }),
    });

    return { success: true };
  }

  async waitForVersionEditable(
    versionId,
    { pollDelayMs = 2000, timeoutMs = 120000 } = {}
  ) {
    const editableStates = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED']);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const response = await this.request(
        `/appStoreVersions/${versionId}?fields[appStoreVersions]=appStoreState`
      );
      const state = response.data?.attributes?.appStoreState;
      if (editableStates.has(state)) return state;
      await sleep(pollDelayMs);
    }

    throw new Error(`Timed out waiting for App Store version ${versionId} to become editable after withdrawing review`);
  }

  async getOrCreateAppStoreVersion(versionString) {
    const appId = await this.getAppId();
    const versions = await this.getAppStoreVersions();

    const existingVersion = versions.data?.find(
      v => v.attributes.versionString === versionString
    );

    if (existingVersion) {
      return {
        exists: true,
        versionId: existingVersion.id,
        state: existingVersion.attributes.appStoreState,
      };
    }

    const createData = await this.request('/appStoreVersions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersions',
          attributes: {
            platform: 'IOS',
            versionString,
          },
          relationships: {
            app: {
              data: {
                type: 'apps',
                id: appId,
              },
            },
          },
        },
      }),
    });

    return {
      exists: false,
      versionId: createData.data.id,
      state: createData.data.attributes.appStoreState,
    };
  }

  async selectBuildForVersion(versionId, buildId) {
    await this.request(`/appStoreVersions/${versionId}/relationships/build`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'builds',
          id: buildId,
        },
      }),
    });
  }

  async updateReleaseNotes(versionId, releaseNotes, locale = 'en-US') {
    const localizationsData = await this.request(
      `/appStoreVersions/${versionId}/appStoreVersionLocalizations`
    );

    let localization = localizationsData.data?.find(
      l => l.attributes.locale === locale
    );

    if (localization) {
      await this.request(`/appStoreVersionLocalizations/${localization.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            id: localization.id,
            attributes: {
              whatsNew: releaseNotes,
            },
          },
        }),
      });
    } else {
      await this.request('/appStoreVersionLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: {
              locale,
              whatsNew: releaseNotes,
            },
            relationships: {
              appStoreVersion: {
                data: {
                  type: 'appStoreVersions',
                  id: versionId,
                },
              },
            },
          },
        }),
      });
    }
  }

  async getAppStoreVersionLocalizations(versionId) {
    const response = await this.request(
      `/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`
    );
    return response.data || [];
  }

  async findAppStoreVersionLocalization(versionId, locale) {
    const localizations = await this.getAppStoreVersionLocalizations(versionId);
    return localizations.find(item => item.attributes?.locale === locale) || null;
  }

  async createAppStoreVersionLocalization(versionId, locale) {
    const response = await this.request('/appStoreVersionLocalizations', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersionLocalizations',
          attributes: { locale },
          relationships: {
            appStoreVersion: {
              data: { type: 'appStoreVersions', id: versionId },
            },
          },
        },
      }),
    });
    return response.data;
  }

  async updateAppStoreVersionLocalization(localizationId, attributes) {
    await this.request(`/appStoreVersionLocalizations/${localizationId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersionLocalizations',
          id: localizationId,
          attributes,
        },
      }),
    });
  }

  async updateAppStoreVersion(versionId, attributes) {
    await this.request(`/appStoreVersions/${versionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersions',
          id: versionId,
          attributes,
        },
      }),
    });
  }

  async getEditableAppInfo() {
    const appId = await this.getAppId();
    const response = await this.request(`/apps/${appId}/appInfos?limit=200`);
    const appInfos = response.data || [];
    return appInfos.find(item => (
      (item.attributes?.state || item.attributes?.appStoreState) === 'PREPARE_FOR_SUBMISSION'
    ))
      || appInfos[0]
      || null;
  }

  async getAppInfoLocalizations(appInfoId) {
    const response = await this.request(
      `/appInfos/${appInfoId}/appInfoLocalizations?limit=200`
    );
    return response.data || [];
  }

  async createAppInfoLocalization(appInfoId, locale, attributes) {
    const response = await this.request('/appInfoLocalizations', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appInfoLocalizations',
          attributes: { locale, ...attributes },
          relationships: {
            appInfo: {
              data: { type: 'appInfos', id: appInfoId },
            },
          },
        },
      }),
    });
    return response.data;
  }

  async updateAppInfoLocalization(localizationId, attributes) {
    await this.request(`/appInfoLocalizations/${localizationId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'appInfoLocalizations',
          id: localizationId,
          attributes,
        },
      }),
    });
  }

  async getAppStoreReviewDetail(versionId) {
    try {
      const response = await this.request(
        `/appStoreVersions/${versionId}/appStoreReviewDetail`
      );
      return response.data || null;
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  async createAppStoreReviewDetail(versionId, attributes) {
    const response = await this.request('/appStoreReviewDetails', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appStoreReviewDetails',
          attributes,
          relationships: {
            appStoreVersion: {
              data: { type: 'appStoreVersions', id: versionId },
            },
          },
        },
      }),
    });
    return response.data;
  }

  async updateAppStoreReviewDetail(reviewDetailId, attributes) {
    await this.request(`/appStoreReviewDetails/${reviewDetailId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'appStoreReviewDetails',
          id: reviewDetailId,
          attributes,
        },
      }),
    });
  }

  async getScreenshotSets(localizationId) {
    const response = await this.request(
      `/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=200`
    );
    return response.data || [];
  }

  async createScreenshotSet(localizationId, displayType) {
    const response = await this.request('/appScreenshotSets', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: displayType },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: 'appStoreVersionLocalizations', id: localizationId },
            },
          },
        },
      }),
    });
    return response.data;
  }

  async getScreenshots(screenshotSetId) {
    const response = await this.request(
      `/appScreenshotSets/${screenshotSetId}/appScreenshots?limit=200`
    );
    return response.data || [];
  }

  async deleteScreenshot(screenshotId) {
    await this.request(`/appScreenshots/${screenshotId}`, { method: 'DELETE' });
  }

  async uploadScreenshot(screenshotSetId, asset, {
    maxPolls = 60,
    pollDelayMs = 2000,
    uploadTimeoutMs = DEFAULT_ASSET_UPLOAD_TIMEOUT_MS,
  } = {}) {
    const reservation = await this.request('/appScreenshots', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appScreenshots',
          attributes: {
            fileName: asset.fileName,
            fileSize: asset.bytes.length,
          },
          relationships: {
            appScreenshotSet: {
              data: { type: 'appScreenshotSets', id: screenshotSetId },
            },
          },
        },
      }),
    });
    const screenshotId = reservation.data.id;

    try {
      const operations = reservation.data.attributes?.uploadOperations || [];
      if (operations.length === 0) throw new Error(`Apple returned no upload operations for ${asset.fileName}`);
      await Promise.all(operations.map(async operation => {
        const offset = Number(operation.offset || 0);
        const requestedLength = Number(operation.length);
        const length = Number.isFinite(requestedLength) && requestedLength > 0
          ? requestedLength
          : asset.bytes.length - offset;
        const headers = Object.fromEntries(
          (operation.requestHeaders || []).map(header => [header.name, header.value])
        );
        const uploadDeadline = createRequestSignal(this.signal || null, uploadTimeoutMs);
        try {
          const response = await fetch(operation.url, {
            method: operation.method || 'PUT',
            headers,
            body: asset.bytes.subarray(offset, offset + length),
            signal: uploadDeadline.signal,
          });
          if (!response.ok) {
            throw new Error(`Screenshot upload failed with ${response.status} for ${asset.fileName}`);
          }
        } finally {
          uploadDeadline.dispose();
        }
      }));

      await this.request(`/appScreenshots/${screenshotId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'appScreenshots',
            id: screenshotId,
            attributes: {
              uploaded: true,
              sourceFileChecksum: asset.checksum,
            },
          },
        }),
      });

      for (let attempt = 0; attempt < maxPolls; attempt++) {
        const response = await this.request(`/appScreenshots/${screenshotId}`);
        const delivery = response.data?.attributes?.assetDeliveryState || {};
        if (delivery.state === 'COMPLETE') return response.data;
        if (delivery.state === 'FAILED') {
          const errors = (delivery.errors || []).map(error => error.description || error.code).filter(Boolean);
          throw new Error(`Apple could not process ${asset.fileName}${errors.length ? `: ${errors.join('; ')}` : ''}`);
        }
        await sleep(pollDelayMs, this.signal || null);
      }
      throw new Error(`Timed out waiting for Apple to process ${asset.fileName}`);
    } catch (error) {
      try { await this.deleteScreenshot(screenshotId); } catch { /* keep original upload error */ }
      throw error;
    }
  }

  async replaceScreenshotOrder(screenshotSetId, screenshotIds) {
    await this.request(`/appScreenshotSets/${screenshotSetId}/relationships/appScreenshots`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: screenshotIds.map(id => ({ type: 'appScreenshots', id })),
      }),
    });
  }

  async syncScreenshotSet(localizationId, displayType, desired, dryRun = false) {
    const maximumAssets = 10;
    if (desired.length > maximumAssets) {
      throw new Error(`Screenshot set ${displayType} has ${desired.length} files; Apple allows at most ${maximumAssets}`);
    }
    const sets = await this.getScreenshotSets(localizationId);
    let set = sets.find(item => item.attributes?.screenshotDisplayType === displayType) || null;
    if (!set && desired.length === 0) {
      return { kept: 0, uploaded: 0, removed: 0 };
    }
    if (!set && dryRun) {
      return { kept: 0, uploaded: desired.length, removed: 0 };
    }
    if (!set) set = await this.createScreenshotSet(localizationId, displayType);

    const existing = await this.getScreenshots(set.id);
    const remaining = [...existing];
    const slots = [];
    for (const asset of desired) {
      const index = remaining.findIndex(item => (
        item.attributes?.fileName === asset.fileName
        && item.attributes?.sourceFileChecksum?.toLowerCase() === asset.checksum.toLowerCase()
      ));
      if (index >= 0) slots.push({ id: remaining.splice(index, 1)[0].id });
      else slots.push({ asset });
    }
    const missing = slots.filter(slot => slot.asset);
    const removed = remaining.length;

    if (dryRun) {
      return { kept: desired.length - missing.length, uploaded: missing.length, removed };
    }

    let assetCount = existing.length;
    for (const slot of missing) {
      // Upload first whenever the set has capacity. At Apple's limit, replace
      // only one old asset at a time instead of deleting the whole old set.
      if (assetCount >= maximumAssets) {
        const screenshot = remaining.shift();
        if (!screenshot) throw new Error(`Screenshot set ${displayType} has no replaceable slot`);
        await this.deleteScreenshot(screenshot.id);
        assetCount -= 1;
      }
      const screenshot = await this.uploadScreenshot(set.id, slot.asset);
      slot.id = screenshot.id;
      assetCount += 1;
    }
    for (const screenshot of remaining) await this.deleteScreenshot(screenshot.id);
    if (slots.length > 0) await this.replaceScreenshotOrder(set.id, slots.map(slot => slot.id));
    return { kept: desired.length - missing.length, uploaded: missing.length, removed };
  }

  async getPreviewSets(localizationId) {
    const response = await this.request(
      `/appStoreVersionLocalizations/${localizationId}/appPreviewSets?limit=200`
    );
    return response.data || [];
  }

  async createPreviewSet(localizationId, previewType) {
    const response = await this.request('/appPreviewSets', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appPreviewSets',
          attributes: { previewType },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: 'appStoreVersionLocalizations', id: localizationId },
            },
          },
        },
      }),
    });
    return response.data;
  }

  async getPreviews(previewSetId) {
    const response = await this.request(
      `/appPreviewSets/${previewSetId}/appPreviews?limit=50`
    );
    return response.data || [];
  }

  async deletePreview(previewId) {
    await this.request(`/appPreviews/${previewId}`, { method: 'DELETE' });
  }

  async uploadPreview(previewSetId, asset, {
    maxPolls = 150,
    pollDelayMs = 2000,
    uploadTimeoutMs = DEFAULT_ASSET_UPLOAD_TIMEOUT_MS,
  } = {}) {
    const reservation = await this.request('/appPreviews', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appPreviews',
          attributes: { fileName: asset.fileName, fileSize: asset.bytes.length },
          relationships: {
            appPreviewSet: {
              data: { type: 'appPreviewSets', id: previewSetId },
            },
          },
        },
      }),
    });
    const previewId = reservation.data.id;

    try {
      const operations = reservation.data.attributes?.uploadOperations || [];
      if (operations.length === 0) throw new Error(`Apple returned no upload operations for ${asset.fileName}`);
      await Promise.all(operations.map(async operation => {
        const offset = Number(operation.offset || 0);
        const requestedLength = Number(operation.length);
        const length = Number.isFinite(requestedLength) && requestedLength > 0
          ? requestedLength
          : asset.bytes.length - offset;
        const headers = Object.fromEntries(
          (operation.requestHeaders || []).map(header => [header.name, header.value])
        );
        const uploadDeadline = createRequestSignal(this.signal || null, uploadTimeoutMs);
        try {
          const response = await fetch(operation.url, {
            method: operation.method || 'PUT',
            headers,
            body: asset.bytes.subarray(offset, offset + length),
            signal: uploadDeadline.signal,
          });
          if (!response.ok) {
            throw new Error(`App preview upload failed with ${response.status} for ${asset.fileName}`);
          }
        } finally {
          uploadDeadline.dispose();
        }
      }));

      await this.request(`/appPreviews/${previewId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'appPreviews',
            id: previewId,
            attributes: { uploaded: true, sourceFileChecksum: asset.checksum },
          },
        }),
      });

      for (let attempt = 0; attempt < maxPolls; attempt++) {
        const response = await this.request(`/appPreviews/${previewId}`);
        const attributes = response.data?.attributes || {};
        const deliveries = [attributes.assetDeliveryState, attributes.videoDeliveryState]
          .filter(delivery => delivery?.state);
        const failed = deliveries.find(delivery => delivery.state === 'FAILED');
        if (failed) {
          const errors = (failed.errors || []).map(error => error.description || error.code).filter(Boolean);
          throw new Error(`Apple could not process ${asset.fileName}${errors.length ? `: ${errors.join('; ')}` : ''}`);
        }
        if (deliveries.length > 0 && deliveries.every(delivery => delivery.state === 'COMPLETE')) {
          return response.data;
        }
        await sleep(pollDelayMs, this.signal || null);
      }
      throw new Error(`Timed out waiting for Apple to process ${asset.fileName}`);
    } catch (error) {
      try { await this.deletePreview(previewId); } catch { /* keep original upload error */ }
      throw error;
    }
  }

  async replacePreviewOrder(previewSetId, previewIds) {
    await this.request(`/appPreviewSets/${previewSetId}/relationships/appPreviews`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: previewIds.map(id => ({ type: 'appPreviews', id })),
      }),
    });
  }

  async syncPreviewSet(localizationId, previewType, desired, dryRun = false) {
    const maximumAssets = 3;
    if (desired.length > maximumAssets) {
      throw new Error(`App preview set ${previewType} has ${desired.length} files; Apple allows at most ${maximumAssets}`);
    }
    const sets = await this.getPreviewSets(localizationId);
    let set = sets.find(item => item.attributes?.previewType === previewType) || null;
    if (!set && desired.length === 0) return { kept: 0, uploaded: 0, removed: 0 };
    if (!set && dryRun) return { kept: 0, uploaded: desired.length, removed: 0 };
    if (!set) set = await this.createPreviewSet(localizationId, previewType);

    const existing = await this.getPreviews(set.id);
    const remaining = [...existing];
    const slots = [];
    for (const asset of desired) {
      const index = remaining.findIndex(item => (
        item.attributes?.fileName === asset.fileName
        && item.attributes?.sourceFileChecksum?.toLowerCase() === asset.checksum.toLowerCase()
      ));
      if (index >= 0) slots.push({ id: remaining.splice(index, 1)[0].id });
      else slots.push({ asset });
    }
    const missing = slots.filter(slot => slot.asset);
    const removed = remaining.length;
    if (dryRun) {
      return { kept: desired.length - missing.length, uploaded: missing.length, removed };
    }

    let assetCount = existing.length;
    for (const slot of missing) {
      if (assetCount >= maximumAssets) {
        const preview = remaining.shift();
        if (!preview) throw new Error(`App preview set ${previewType} has no replaceable slot`);
        await this.deletePreview(preview.id);
        assetCount -= 1;
      }
      const preview = await this.uploadPreview(set.id, slot.asset);
      slot.id = preview.id;
      assetCount += 1;
    }
    for (const preview of remaining) await this.deletePreview(preview.id);
    if (slots.length > 0) await this.replacePreviewOrder(set.id, slots.map(slot => slot.id));
    return { kept: desired.length - missing.length, uploaded: missing.length, removed };
  }

  async submitForReview(versionId) {
    const { submissionId, itemId } = await this.getOrCreateDraftReviewSubmission(versionId);
    try {
      await this.request(`/reviewSubmissions/${submissionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'reviewSubmissions',
            id: submissionId,
            attributes: {
              submitted: true,
            },
          },
        }),
      });
    } catch (error) {
      error.reviewSubmissionId = submissionId;
      error.reviewSubmissionItemId = itemId;
      throw error;
    }
  }

  async getOrCreateDraftReviewSubmission(versionId) {
    const existingSubmissionId = await this.getReviewSubmissionIdForVersion(versionId, [
      'READY_FOR_REVIEW',
      'WAITING_FOR_REVIEW',
      'IN_REVIEW',
      'UNRESOLVED_ISSUES',
      'CANCELING',
      'COMPLETING',
    ]);

    if (existingSubmissionId) {
      return { submissionId: existingSubmissionId, itemId: null };
    }

    let submissionId = await this.getReusableDraftReviewSubmissionId();
    if (!submissionId) {
      const appId = await this.getAppId();
      const createdSubmission = await this.request('/reviewSubmissions', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'reviewSubmissions',
            relationships: {
              app: {
                data: {
                  type: 'apps',
                  id: appId,
                },
              },
            },
          },
        }),
      });
      submissionId = createdSubmission.data.id;
    }

    try {
      const createdItem = await this.request('/reviewSubmissionItems', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'reviewSubmissionItems',
            relationships: {
              reviewSubmission: {
                data: {
                  type: 'reviewSubmissions',
                  id: submissionId,
                },
              },
              appStoreVersion: {
                data: {
                  type: 'appStoreVersions',
                  id: versionId,
                },
              },
            },
          },
        }),
      });
      return { submissionId, itemId: createdItem.data.id };
    } catch (error) {
      error.reviewSubmissionId = submissionId;
      throw error;
    }
  }

  async removeReviewSubmissionItem(itemId) {
    await this.request(`/reviewSubmissionItems/${itemId}`, { method: 'DELETE' });
  }

  async getReusableDraftReviewSubmissionId() {
    const appId = await this.getAppId();
    const data = await this.request(
      `/apps/${appId}/reviewSubmissions?filter[state]=READY_FOR_REVIEW&include=items&limit=200&limit[items]=50`
    );

    const emptyDraft = (data.data || []).find(submission => (
      (submission.relationships?.items?.data || []).length === 0
    ));
    return emptyDraft?.id || null;
  }

  async getReviewSubmissionIdForVersion(versionId, states = []) {
    const appId = await this.getAppId();
    const data = await this.request(
      `/apps/${appId}/reviewSubmissions?limit=200&include=appStoreVersionForReview&fields[reviewSubmissions]=state,appStoreVersionForReview`
    );
    const submissions = data.data || [];
    const requestedStates = new Set(states);
    let nonCompleteMatch = null;

    for (const submission of submissions) {
      if (submission.attributes?.state === 'COMPLETE') continue;
      const versionForReviewId =
        submission.relationships?.appStoreVersionForReview?.data?.id;
      if (versionForReviewId === versionId) {
        const state = submission.attributes?.state;
        if (requestedStates.size === 0 || requestedStates.has(state)) {
          return submission.id;
        }
        if (!nonCompleteMatch) {
          nonCompleteMatch = submission.id;
        }
        continue;
      }

      const items = await this.request(
        `/reviewSubmissions/${submission.id}/items?limit=200&fields[reviewSubmissionItems]=appStoreVersion,state`
      );
      const matchingItem = (items.data || []).find(item =>
        item.relationships?.appStoreVersion?.data?.id === versionId
      );

      if (matchingItem) {
        const state = submission.attributes?.state;
        if (requestedStates.size === 0 || requestedStates.has(state)) {
          return submission.id;
        }
        if (!nonCompleteMatch) {
          nonCompleteMatch = submission.id;
        }
      }
    }

    return nonCompleteMatch;
  }

  async getBuildByNumber(buildNumber) {
    const appId = await this.getAppId();
    const data = await this.request(
      `/builds?filter[app]=${appId}&filter[version]=${buildNumber}&include=preReleaseVersion&limit=1`
    );

    if (!data.data?.[0]) {
      return null;
    }

    const build = data.data[0];
    const preReleaseVersionId = build.relationships?.preReleaseVersion?.data?.id;
    let versionString = 'unknown';

    if (preReleaseVersionId && data.included) {
      const preRelease = data.included.find(i => i.type === 'preReleaseVersions' && i.id === preReleaseVersionId);
      versionString = preRelease?.attributes?.version || 'unknown';
    }

    return {
      buildId: build.id,
      buildNumber: build.attributes.version,
      version: versionString,
      processingState: build.attributes.processingState,
    };
  }
}
