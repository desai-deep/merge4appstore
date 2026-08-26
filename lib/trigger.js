import { log } from './config.js';

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function buildIntentFromEnvironment(build, environment = process.env) {
  return {
    provider: build.provider,
    purpose: build.purpose,
    appRole: build.appRole,
    workflowId: build.workflowId,
    commitSha: required(environment.BUILD_COMMIT_SHA, 'BUILD_COMMIT_SHA'),
    branch: required(environment.BUILD_BRANCH, 'BUILD_BRANCH').replace(/^refs\/heads\//, ''),
    pullRequest: environment.BUILD_PULL_REQUEST || null,
    sourceDeliveryId: environment.BUILD_SOURCE_DELIVERY_ID || null,
  };
}

export async function runManagedBuildTrigger(provider, github, intent, dryRun = false) {
  log(`--- Managed Build Trigger (${intent.purpose}) ---`);
  log(`Provider: ${provider.name}; workflow: ${intent.workflowId}; branch: ${intent.branch}; commit: ${intent.commitSha.substring(0, 7)}`);

  const currentCommit = intent.pullRequest
    ? github.getPullRequestHead(intent.pullRequest)
    : github.getBranchHead(intent.branch);
  if (!currentCommit) {
    throw new Error(`Could not verify the current GitHub source commit for ${intent.pullRequest ? `PR #${intent.pullRequest}` : intent.branch}`);
  }
  if (currentCommit !== intent.commitSha) {
    log(`Build intent is superseded by ${currentCommit.substring(0, 7)}; not starting the older commit`);
    return {
      action: 'superseded',
      provider: provider.name,
      expectedCommitSha: intent.commitSha,
      currentCommitSha: currentCommit,
    };
  }

  const result = await provider.trigger(intent, { dryRun });
  if (result.action === 'existing') {
    log(`Build #${result.number || result.runId} already exists for this commit (${result.executionProgress})`);
  } else if (result.action === 'waiting') {
    log(`Build #${result.number || result.runId} is active before Apple exposes its commit; not starting a duplicate`);
  } else if (result.action === 'would_start') {
    log(`[DRY RUN] Would start ${intent.purpose} build for ${intent.branch} at ${intent.commitSha.substring(0, 7)}`);
  } else {
    log(`Started ${intent.purpose} build #${result.number || result.runId} for ${intent.branch} at ${intent.commitSha.substring(0, 7)}`);
  }
  return result;
}
