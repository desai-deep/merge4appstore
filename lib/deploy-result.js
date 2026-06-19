// Structured outcomes returned by runDeployCheck so callers (cron CLI and the
// webhook server) can react - in particular, decide whether a later retry could
// still succeed. When a webhook fires, the freshly built TestFlight build is
// usually still processing on Apple's side, so the first deploy check often
// finds nothing eligible yet and should be retried.

export const DEPLOY_STATUS = {
  SUBMITTED: 'submitted',
  NO_BUILD: 'no-build',
  NO_ELIGIBLE_BUILD: 'no-eligible-build',
  WAITING_FOR_NEWER_BUILD: 'waiting-for-newer-build',
  BUILD_NOT_FOUND: 'build-not-found',
  ALREADY_IN_REVIEW: 'already-in-review',
  NOT_SUBMITTABLE: 'not-submittable',
  SKIPPED: 'skipped',
  DRY_RUN: 'dry-run',
};

// Outcomes where the desired build may simply not be ready in TestFlight yet, so
// running the check again after a short delay can succeed without any change.
const RETRYABLE_STATUSES = new Set([
  DEPLOY_STATUS.NO_BUILD,
  DEPLOY_STATUS.NO_ELIGIBLE_BUILD,
  DEPLOY_STATUS.WAITING_FOR_NEWER_BUILD,
  DEPLOY_STATUS.BUILD_NOT_FOUND,
]);

export function isRetryable(status) {
  return RETRYABLE_STATUSES.has(status);
}
