const IDENTIFIER_FIELDS = [
  ['deliveryId', 'delivery_id'],
  ['commitSha', 'commit_sha'],
  ['branch', 'branch'],
  ['pullRequest', 'pull_request'],
  ['workflowId', 'workflow_id'],
  ['runId', 'run_id'],
  ['buildNumber', 'build_number'],
  ['buildStatus', 'build_status'],
  ['completedAt', 'completed_at'],
];

function boundedIdentifier(value) {
  if (!['string', 'number'].includes(typeof value)) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 256) : null;
}

export function summarizeDeliveryJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return null;
  const summary = {
    mode: job.mode,
    purpose: typeof job.purpose === 'string' ? job.purpose : null,
  };
  for (const [source, target] of IDENTIFIER_FIELDS) {
    const value = boundedIdentifier(job[source]);
    if (value !== null) summary[target] = value;
  }
  for (const [source, target] of [
    ['dryRun', 'dry_run'],
    ['reconcileMetadata', 'reconcile_metadata'],
  ]) {
    if (typeof job[source] === 'boolean') summary[target] = job[source];
  }
  return summary;
}
