import crypto from 'crypto';
import {
  resolveAutoRebasePullRequests,
  resolveBuildPurpose,
  resolveReleasePullRequest,
} from './profile.js';

function buffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || '');
}

export function safeEqual(left, right) {
  const a = buffer(left);
  const b = buffer(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyGitHubSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expected);
}

export function secretEnvironmentName(prefix, instance) {
  const suffix = instance.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${prefix}_${suffix}`;
}

export function githubAppWebhookMode(environment = process.env) {
  const mode = environment.GITHUB_APP_WEBHOOK_MODE || 'shadow';
  if (!['shadow', 'managed'].includes(mode)) {
    throw new Error('GITHUB_APP_WEBHOOK_MODE must be shadow or managed');
  }
  return mode;
}

export function githubClassicWebhooksEnabled(environment = process.env) {
  const configured = environment.GITHUB_CLASSIC_WEBHOOKS_ENABLED;
  if (configured === undefined || configured === '') return true;
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  throw new Error('GITHUB_CLASSIC_WEBHOOKS_ENABLED must be true or false');
}

export function xcodeRunId(payload = {}) {
  for (const value of [payload.ciBuildRun?.id, payload.webhook?.id]) {
    if (!['string', 'number'].includes(typeof value)) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return null;
}

function buildTriggerJob(profile, purpose, details) {
  if (!profile.build?.purposes?.[purpose]) return null;
  const { triggerMode } = resolveBuildPurpose(profile, purpose);
  if (triggerMode === 'native') return null;
  return {
    mode: 'trigger',
    purpose,
    ...details,
    ...(triggerMode === 'shadow' ? { dryRun: true } : {}),
  };
}

export function jobsForGitHubEvent(
  profile,
  event,
  payload,
  deliveryId,
  { requireRepositoryId = false } = {},
) {
  const jobs = [];
  const repository = payload.repository?.full_name;
  const expectedRepository = `${profile.repository.owner}/${profile.repository.name}`;
  const configuredRepositoryId = profile.repository.github_id;
  const payloadRepositoryId = payload.repository?.id;
  if (requireRepositoryId) {
    if (
      !configuredRepositoryId
      || !payloadRepositoryId
      || String(configuredRepositoryId) !== String(payloadRepositoryId)
    ) return jobs;
  } else if (configuredRepositoryId && payloadRepositoryId) {
    if (String(configuredRepositoryId) !== String(payloadRepositoryId)) return jobs;
  } else if (repository !== expectedRepository) return jobs;

  if (event === 'pull_request') {
    const pull = payload.pull_request;
    const action = payload.action;
    if (!pull) return jobs;
    const betaBranch = profile.repository.beta_branch || 'develop';
    const releasePullRequest = resolveReleasePullRequest(profile);

    if (action === 'closed' && pull.base?.ref === betaBranch) {
      jobs.push({ mode: 'expire', deliveryId });
      return jobs;
    }

    if (action === 'edited' && payload.changes?.body
      && pull.base?.ref === betaBranch) {
      jobs.push({
        mode: 'notes',
        purpose: 'pull_request',
        commitSha: pull.head.sha,
        branch: pull.head.ref,
        pullRequest: String(pull.number),
        deliveryId,
      });
      return jobs;
    }

    if (action === 'edited' && payload.changes?.body
      && releasePullRequest.enabled
      && pull.base?.ref === releasePullRequest.baseBranch
      && pull.head?.ref === releasePullRequest.headBranch) {
      jobs.push({
        mode: 'notes',
        purpose: 'beta',
        commitSha: pull.head.sha,
        branch: pull.head.ref,
        pullRequest: String(pull.number),
        deliveryId,
      });
      return jobs;
    }

    if (action === 'edited' && payload.changes?.base) {
      if (pull.base?.ref === betaBranch) {
        const job = buildTriggerJob(profile, 'pull_request', {
          commitSha: pull.head.sha,
          branch: pull.head.ref,
          pullRequest: String(pull.number),
          deliveryId,
        });
        if (job) jobs.push(job);
      } else if (releasePullRequest.enabled
        && pull.base?.ref === releasePullRequest.baseBranch
        && pull.head?.ref === releasePullRequest.headBranch) {
        const job = buildTriggerJob(profile, 'beta', {
          commitSha: pull.head.sha,
          branch: pull.head.ref,
          deliveryId,
        });
        if (job) jobs.push(job);
      }
      return jobs;
    }

    if (['opened', 'reopened', 'synchronize'].includes(action)
      && pull.base?.ref === betaBranch) {
      const job = buildTriggerJob(profile, 'pull_request', {
        commitSha: pull.head.sha,
        branch: pull.head.ref,
        pullRequest: String(pull.number),
        deliveryId,
      });
      if (job) jobs.push(job);
    }
    return jobs;
  }

  if (event === 'push' && payload.deleted !== true) {
    const branch = payload.ref?.replace(/^refs\/heads\//, '');
    const betaBranch = profile.repository.beta_branch || 'develop';
    const productionBranch = profile.repository.production_branch || 'main';
    const purpose = branch === betaBranch ? 'beta' : branch === productionBranch ? 'production' : null;
    if (purpose && payload.after && !/^0+$/.test(payload.after)) {
      if (branch === betaBranch && resolveAutoRebasePullRequests(profile).enabled) {
        jobs.push({ mode: 'rebase-prs', deliveryId });
      }
      if (resolveReleasePullRequest(profile).enabled) {
        jobs.push({ mode: 'release-pr', deliveryId });
      }
      const metadataPath = profile.metadata?.path?.replace(/\/+$/, '');
      const changedPaths = (payload.commits || []).flatMap(commit => [
        ...(commit.added || []),
        ...(commit.modified || []),
        ...(commit.removed || []),
      ]);
      const metadataDirectory = metadataPath || '';
      const metadataOnly = branch === productionBranch
        && metadataPath
        && changedPaths.length > 0
        && Number(payload.size) === (payload.commits || []).length
        && changedPaths.every(file => file.startsWith(`${metadataDirectory}/`));
      if (metadataOnly) jobs.push({ mode: 'deploy', reconcileMetadata: true, deliveryId });
      else {
        const job = buildTriggerJob(profile, purpose, {
          commitSha: payload.after,
          branch,
          deliveryId,
        });
        if (job) jobs.push(job);
      }
    }
  }

  return jobs;
}

export function jobsForXcodeCloudEvent(profile, payload) {
  if (payload.metadata?.attributes?.eventType !== 'BUILD_COMPLETED') return [];

  const workflowId = payload.ciWorkflow?.id;
  if (!workflowId) return [];
  const purpose = ['pull_request', 'beta', 'production']
    .filter(candidate => profile.build?.purposes?.[candidate])
    .map(candidate => resolveBuildPurpose(profile, candidate))
    .find(candidate => candidate.workflowId === workflowId)?.purpose;
  if (!purpose) return [];
  const runId = xcodeRunId(payload);
  if (!runId) return [];
  const attributes = payload.ciBuildRun?.attributes || {};
  const status = attributes.completionStatus || 'UNKNOWN';
  const statusJob = {
    mode: 'build-status',
    purpose,
    buildStatus: status,
    workflowId,
    runId,
    buildNumber: attributes.number || null,
    commitSha: attributes.sourceCommit?.commitSha || null,
    completedAt: attributes.finishedDate || payload.metadata?.attributes?.createdDate || null,
    deliveryId: runId,
  };
  return status === 'SUCCEEDED' && purpose === 'production'
    ? [statusJob, { mode: 'deploy', deliveryId: runId }]
    : [statusJob];
}

export function webhookSettings(profile, environment = process.env) {
  const githubSecretEnv = profile.webhooks?.github?.secret_env
    || 'GH_WEBHOOK_SECRET';
  const xcodeTokenEnv = profile.webhooks?.xcode_cloud?.token_env
    || 'XCODE_CLOUD_WEBHOOK_TOKEN';
  const buildTokenEnv = profile.ci?.prepare?.token_env
    || secretEnvironmentName('MERGE4APPSTORE_BUILD_TOKEN', profile.instance);
  return {
    githubSecretEnv,
    githubSecret: environment[githubSecretEnv] || '',
    xcodeTokenEnv,
    xcodeToken: environment[xcodeTokenEnv] || '',
    buildTokenEnv,
    buildToken: environment[buildTokenEnv] || '',
  };
}
