import crypto from 'node:crypto';
import { log } from './config.js';

function markerFor(intent) {
  const source = intent.pullRequest ? `pr:${intent.pullRequest}` : `branch:${intent.branch}`;
  const key = crypto.createHash('sha256')
    .update(JSON.stringify([intent.purpose, intent.workflowId, source])).digest('hex');
  return `<!-- merge4appstore:build-trigger:${key} -->`;
}

// Publish a bounded diagnosis, never raw exception text: provider responses can
// contain credentials, request URLs or untrusted source content.
function diagnosis(error) {
  if (error.statusCode === 403 && /agreement.*(missing|expired|signed)|in-effect agreement/i.test(error.message || '')) {
    return 'Apple rejected the request because a required agreement is missing or expired. The Account Holder must review pending agreements in [Apple Developer](https://developer.apple.com/account/) and [App Store Connect](https://appstoreconnect.apple.com/).';
  }
  const status = Number(error.statusCode || error.httpStatus);
  const detail = Number.isInteger(status) && status >= 400 && status <= 599 ? ` (HTTP ${status})` : '';
  return `The build provider could not confirm a build run${detail}. Inspect the merge4appstore worker logs and the provider's workflow configuration, credentials and availability.`;
}

export async function reportTriggerAlert(github, intent, { error = null, result = null } = {}) {
  const marker = markerFor(intent);
  const context = `Purpose: \`${intent.purpose}\` · Workflow: \`${intent.workflowId}\`\n\nCommit: \`${intent.commitSha}\``;
  const body = error
    ? `### Build trigger blocked\n\n${diagnosis(error)}\n\n${context}\n\nThe trigger has failed; a build has not been confirmed. Retryable failures are retried automatically within the service's retry limit. After fixing the cause, retry the managed build trigger if retries have exhausted. This alert resolves when a later trigger starts or finds a build for this source.`
    : `### Build trigger recovered\n\nA build run was ${result.action === 'started' ? 'started' : 'found'} for this source. This confirms the trigger recovered; the build may still be running or may have failed.\n\n${context}\n\nRun: \`${result.runId}\``;

  try {
    let published;
    if (intent.pullRequest) {
      published = await github.upsertPRComment(intent.pullRequest, marker, `${marker}\n${body}`, { create: Boolean(error), ownedOnly: true });
    } else if (await github.repositoryIssuesEnabled()) {
      published = error
        ? await github.upsertIssue(marker, `Build trigger blocked (${intent.purpose}: ${intent.branch})`, body, { ownedOnly: true })
        : await github.closeIssueByMarker(marker, body, { ownedOnly: true });
    } else {
      log('Warning: Build trigger alerts unavailable because repository issues are disabled');
      return;
    }
    if (published === false) log('Warning: Could not publish the GitHub build trigger alert');
  } catch {
    log('Warning: Could not publish the GitHub build trigger alert');
  }
}
