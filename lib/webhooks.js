import crypto from 'crypto';

function buffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || '');
}

export function safeEqual(left, right) {
  const a = buffer(left);
  const b = buffer(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyGitHubSignature(rawBody, signature, secret) {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expected);
}

export function secretEnvironmentName(prefix, instance) {
  const suffix = instance.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${prefix}_${suffix}`;
}

export function jobsForGitHubEvent(profile, event, payload, deliveryId) {
  const jobs = [];
  const repository = payload.repository?.full_name;
  const expectedRepository = `${profile.repository.owner}/${profile.repository.name}`;
  if (repository !== expectedRepository) return jobs;

  if (event === 'pull_request') {
    const pull = payload.pull_request;
    const action = payload.action;
    if (!pull) return jobs;

    if (action === 'closed' && pull.base?.ref === (profile.repository.beta_branch || 'develop')) {
      jobs.push({ mode: 'expire', deliveryId });
      return jobs;
    }

    if (action === 'edited' && payload.changes?.body
      && pull.base?.ref === (profile.repository.beta_branch || 'develop')) {
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

    if (['opened', 'reopened', 'synchronize'].includes(action)
      && pull.base?.ref === (profile.repository.beta_branch || 'develop')) {
      jobs.push({
        mode: 'trigger',
        purpose: 'pull_request',
        commitSha: pull.head.sha,
        branch: pull.head.ref,
        pullRequest: String(pull.number),
        deliveryId,
      });
    }
    return jobs;
  }

  if (event === 'push' && payload.deleted !== true) {
    const branch = payload.ref?.replace(/^refs\/heads\//, '');
    const betaBranch = profile.repository.beta_branch || 'develop';
    const productionBranch = profile.repository.production_branch || 'main';
    const purpose = branch === betaBranch ? 'beta' : branch === productionBranch ? 'production' : null;
    if (purpose && payload.after && !/^0+$/.test(payload.after)) {
      jobs.push({ mode: 'trigger', purpose, commitSha: payload.after, branch, deliveryId });
    }
  }

  return jobs;
}

export function jobsForXcodeCloudEvent(profile, payload) {
  if (payload.metadata?.attributes?.eventType !== 'BUILD_COMPLETED') return [];
  if (payload.ciBuildRun?.attributes?.completionStatus !== 'SUCCEEDED') return [];

  const workflowId = payload.ciWorkflow?.id;
  const production = profile.build?.purposes?.production;
  const appRole = production?.app || 'prod';
  const app = profile.apps?.[appRole];
  const productionWorkflowId = production?.workflow_id
    || (production?.workflow ? app?.workflows?.[production.workflow] : null);
  if (!workflowId || workflowId !== productionWorkflowId) return [];
  return [{ mode: 'deploy', deliveryId: payload.ciBuildRun?.id || payload.webhook?.id }];
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
