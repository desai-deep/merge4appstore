import crypto from 'crypto';
import { CONFIG, log } from './config.js';

const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AppStoreConnectAPI {
  constructor(keyId, issuerId, privateKeyContent) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = Buffer.from(privateKeyContent, 'base64').toString('utf8');
    this.token = null;
    this.tokenExpiry = null;
    this.appId = null;
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

    let lastError;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      try {
        const token = this.generateToken();

        const response = await fetch(url, {
          ...options,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });

        if (response.status === 204) {
          return null;
        }

        // Handle rate limiting with Retry-After header
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
          if (attempt < opts.maxRetries) {
            const delay = retryAfter > 0 ? retryAfter * 1000 : this.calculateBackoff(attempt, opts);
            log(`Rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
            await sleep(delay);
            continue;
          }
        }

        // Retry on server errors
        if (opts.retryableStatusCodes.includes(response.status) && attempt < opts.maxRetries) {
          const delay = this.calculateBackoff(attempt, opts);
          log(`Request failed with ${response.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
          await sleep(delay);
          continue;
        }

        const data = await response.json();

        if (!response.ok) {
          const errorDetail = data.errors?.[0]?.detail || JSON.stringify(data);
          throw new Error(`API Error ${response.status}: ${errorDetail}`);
        }

        return data;
      } catch (error) {
        lastError = error;

        // Retry on network errors
        if (error.name === 'TypeError' && error.message.includes('fetch') && attempt < opts.maxRetries) {
          const delay = this.calculateBackoff(attempt, opts);
          log(`Network error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${opts.maxRetries})`);
          await sleep(delay);
          continue;
        }

        throw error;
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
          versionId: version.id,
        };
      }
    }

    return { inReview: false };
  }

  async checkRejectedVersion() {
    const versions = await this.getAppStoreVersions();
    const rejectedStates = ['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED'];

    for (const version of versions.data || []) {
      if (rejectedStates.includes(version.attributes.appStoreState)) {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = 'unknown';

        if (buildId && versions.included) {
          const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || 'unknown';
        }

        return {
          rejected: true,
          version: version.attributes.versionString,
          state: version.attributes.appStoreState,
          buildNumber,
          versionId: version.id,
        };
      }
    }

    return { rejected: false };
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
        };
      }
    }

    return { live: false, buildNumber: '0' };
  }

  async getLatestTestFlightReadyBuild() {
    const appId = await this.getAppId();

    const data = await this.request(
      `/builds?filter[app]=${appId}&sort=-uploadedDate&limit=50&include=preReleaseVersion,buildBetaDetail`
    );

    const versions = await this.getAppStoreVersions();
    const liveVersion = versions.data?.find(v => v.attributes.appStoreState === 'READY_FOR_SALE');
    const liveBuildId = liveVersion?.relationships?.build?.data?.id;

    const reviewStates = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PREPARE_FOR_SUBMISSION'];
    const inProgressVersion = versions.data?.find(v => reviewStates.includes(v.attributes.appStoreState));
    const inProgressBuildId = inProgressVersion?.relationships?.build?.data?.id;

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

      return {
        found: true,
        buildNumber: build.attributes.version,
        version: versionString,
        betaState,
        buildId: build.id,
      };
    }

    return { found: false };
  }

  async getCIProducts() {
    const data = await this.request('/ciProducts');
    return data.data || [];
  }

  async getWorkflows(productId) {
    const data = await this.request(`/ciProducts/${productId}/workflows`);
    return data.data || [];
  }

  async getBuildRuns(workflowId, limit = 50) {
    const data = await this.request(
      `/ciWorkflows/${workflowId}/buildRuns?limit=${limit}&sort=-number&fields[ciBuildRuns]=number,sourceCommit,executionProgress,completionStatus`
    );
    return data;
  }

  async getBuildCommitSHA(buildNumber) {
    const products = await this.getCIProducts();

    for (const product of products) {
      const workflows = await this.getWorkflows(product.id);

      for (const workflow of workflows) {
        const workflowId = workflow.id;
        const workflowName = workflow.attributes?.name;
        const runsData = await this.getBuildRuns(workflow.id, 200);

        for (const run of runsData.data || []) {
          if (run.attributes?.number?.toString() === buildNumber.toString()) {
            const sourceCommit = run.attributes?.sourceCommit;
            let commitSha = null;

            if (typeof sourceCommit === 'string') {
              commitSha = sourceCommit;
            } else if (sourceCommit && typeof sourceCommit === 'object') {
              commitSha = sourceCommit.commitSha || sourceCommit.hash || sourceCommit.canonicalHash || sourceCommit.id;
            }

            return {
              found: true,
              commitSha,
              workflowId,
              workflowName,
            };
          }
        }
      }
    }

    return { found: false };
  }

  async cancelReview(versionId) {
    const submissionData = await this.request(`/appStoreVersions/${versionId}/appStoreVersionSubmission`);

    if (!submissionData?.data?.id) {
      return { success: false, error: 'No submission found' };
    }

    await this.request(`/appStoreVersionSubmissions/${submissionData.data.id}`, {
      method: 'DELETE',
    });

    return { success: true };
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

  async submitForReview(versionId) {
    await this.request('/appStoreVersionSubmissions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersionSubmissions',
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
