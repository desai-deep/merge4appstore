import { log } from './config.js';
import { generateTestFlightNotes } from './build-prepare.js';
import { getManagedWhatsNewLocales } from './metadata.js';

const PUBLISHED_OR_SUPERSEDED_APP_STORE_STATES = new Set([
  'READY_FOR_DISTRIBUTION',
  'READY_FOR_SALE',
  'REPLACED_WITH_NEW_VERSION',
]);

function retryableReleaseNotesError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.retryAfter = 5;
  return error;
}

function isReleaseNotesStateConflict(error) {
  if (error?.statusCode !== 409) return false;
  const flattenedErrors = Array.isArray(error.appStoreErrors) ? error.appStoreErrors : [];
  const rawErrors = Array.isArray(error.apiResponse?.errors) ? error.apiResponse.errors : [];
  return [...flattenedErrors, ...rawErrors].some(item => (
    item?.code === 'STATE_ERROR' || item?.code?.startsWith('STATE_ERROR.')
  ));
}

async function findPullRequestForCommit(github, commitSha) {
  if (typeof github.findPRFromCommitAsync === 'function') {
    return github.findPRFromCommitAsync(commitSha, { strict: true });
  }
  return github.findPRFromCommit(commitSha, { strict: true });
}

async function getPullRequestDetails(github, pullRequest) {
  if (typeof github.getPRDetailsAsync === 'function') {
    return github.getPRDetailsAsync(pullRequest);
  }
  return github.getPRDetails(pullRequest);
}

async function getProductionMetadataRef(github, fallback) {
  if (typeof github.getProductionHeadAsync === 'function') {
    const ref = await github.getProductionHeadAsync({ strict: true });
    if (!ref) throw retryableReleaseNotesError('Could not resolve the production branch head');
    return ref;
  }
  if (typeof github.getProductionHead === 'function') {
    const ref = github.getProductionHead({ strict: true });
    if (!ref) throw retryableReleaseNotesError('Could not resolve the production branch head');
    return ref;
  }
  return fallback;
}

export async function refreshAppStoreReleaseNotes(asc, github, {
  workflowId,
  commitSha,
  pullRequest,
  metadataPath = '',
  dryRun = false,
} = {}) {
  if (!workflowId) throw new Error('App Store release-note refresh requires workflowId');
  if (!commitSha) throw new Error('App Store release-note refresh requires commitSha');
  if (!pullRequest) throw new Error('App Store release-note refresh requires pullRequest');

  const expectedPullRequest = String(pullRequest);
  const currentPullRequest = await findPullRequestForCommit(github, commitSha);
  if (!currentPullRequest) {
    throw retryableReleaseNotesError(
      `GitHub has not associated production commit ${commitSha.substring(0, 7)} with a merged pull request`,
    );
  }
  if (String(currentPullRequest) !== expectedPullRequest) {
    log(`Release-note refresh for PR #${expectedPullRequest} no longer matches production commit ${commitSha.substring(0, 7)}; skipping`);
    return { updated: 0, reason: 'pull_request_mismatch' };
  }

  const builds = await asc.getBuildsForWorkflowCommit(workflowId, commitSha);
  const buildIds = new Set(builds.map(build => build.buildId).filter(Boolean));
  if (buildIds.size === 0) {
    log(`No ${workflowId} build found for production commit ${commitSha.substring(0, 7)}; release notes will be set during submission`);
    return { updated: 0, reason: 'build_not_found' };
  }

  const versions = await asc.getAppStoreVersions();
  const matchingVersions = (versions.data || []).filter(version => {
    const buildId = version.relationships?.build?.data?.id;
    const state = version.attributes?.appStoreState;
    return buildIds.has(buildId) && !PUBLISHED_OR_SUPERSEDED_APP_STORE_STATES.has(state);
  });
  if (matchingVersions.length === 0) {
    log(`No non-live App Store version selects the ${workflowId} build for ${commitSha.substring(0, 7)}; skipping`);
    return { updated: 0, reason: 'version_not_found' };
  }
  if (matchingVersions.length > 1) {
    throw retryableReleaseNotesError(
      `Multiple non-live App Store versions select ${workflowId} builds for ${commitSha.substring(0, 7)}`,
    );
  }
  const version = matchingVersions[0];

  if (metadataPath) {
    const metadataRef = await getProductionMetadataRef(github, commitSha);
    const managedLocales = await getManagedWhatsNewLocales(asc, github, {
      metadataPath,
      ref: metadataRef,
    });
    if (managedLocales.has('en-US')) {
      log('Repository-managed en-US release notes take precedence over the release PR title');
      return { updated: 0, reason: 'repository_managed', versionId: version.id };
    }
  }

  const details = await getPullRequestDetails(github, expectedPullRequest);
  if (!details) {
    throw retryableReleaseNotesError(
      `Could not load current details for release PR #${expectedPullRequest}`,
    );
  }
  const notes = github.extractReleaseNotes(details);
  const localizations = await asc.getAppStoreVersionLocalizations(version.id);
  const localization = localizations.find(item => item.attributes?.locale === 'en-US');
  if (!localization) {
    log(`App Store version ${version.attributes?.versionString || version.id} has no existing en-US localization; refusing to create one after submission`);
    return { updated: 0, reason: 'localization_not_found', versionId: version.id, notes };
  }
  if (localization.attributes?.whatsNew === notes) {
    log(`App Store release notes for version ${version.attributes?.versionString || version.id} already match PR #${expectedPullRequest}`);
    return { updated: 0, reason: 'unchanged', versionId: version.id, notes };
  }
  if (dryRun) {
    log(`[DRY RUN] Would update App Store release notes for version ${version.attributes?.versionString || version.id} from PR #${expectedPullRequest}`);
    return { updated: 0, reason: 'dry_run', versionId: version.id, notes };
  }

  try {
    await asc.updateAppStoreVersionLocalization(localization.id, { whatsNew: notes });
  } catch (error) {
    if (!isReleaseNotesStateConflict(error)) throw error;
    log(`App Store version ${version.attributes?.versionString || version.id} is no longer editable; release notes were left unchanged`);
    return { updated: 0, reason: 'not_editable', versionId: version.id, notes };
  }

  log(`Updated App Store release notes for version ${version.attributes?.versionString || version.id} from PR #${expectedPullRequest}`);
  return { updated: 1, reason: 'updated', versionId: version.id, notes };
}

export async function refreshTestFlightNotes(
  asc,
  github,
  build,
  payload,
  dryRun = false,
  profile = null,
) {
  asc.appId = build.appId;
  const notes = await generateTestFlightNotes({ profile, build, payload, asc, github });
  const builds = await asc.getBuildsForWorkflowCommit(build.workflowId, payload.commit);
  if (builds.length === 0) {
    log(`No published ${build.purpose} build found for ${payload.commit.substring(0, 7)}; notes will be generated when it builds`);
    return { updated: 0, notes: notes.text, warnings: notes.warnings };
  }

  for (const candidate of builds) {
    if (dryRun) {
      log(`[DRY RUN] Would refresh TestFlight notes for build #${candidate.buildNumber || candidate.buildId}`);
    } else {
      await asc.updateBetaBuildNotes(candidate.buildId, notes.text);
      log(`Refreshed TestFlight notes for build #${candidate.buildNumber || candidate.buildId}`);
    }
  }
  return { updated: dryRun ? 0 : builds.length, notes: notes.text, warnings: notes.warnings };
}

export async function publishTestFlightNotesForRun(
  asc,
  github,
  profile,
  build,
  runId,
  dryRun = false,
  {
    intervalMs = 15_000,
    timeoutMs = 15 * 60_000,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {},
) {
  asc.appId = build.appId;
  const deadline = now() + timeoutMs;
  let run;
  while (true) {
    run = await asc.getBuildRunNotesContext(runId);
    if (run.workflowId !== build.workflowId) {
      throw new Error(`Xcode Cloud build run ${runId} does not belong to the configured ${build.purpose} workflow`);
    }
    if (run.completionStatus !== 'SUCCEEDED') {
      throw new Error(`Xcode Cloud build run ${runId} did not succeed`);
    }
    if (!run.commitSha) {
      throw new Error(`Xcode Cloud build run ${runId} has no source commit`);
    }
    const unavailable = (run.builds || []).filter(
      candidate => candidate.processingState !== 'VALID'
    );
    if ((run.builds || []).length > 0 && unavailable.length === 0) break;
    if (now() >= deadline) {
      const states = unavailable.length > 0
        ? unavailable.map(candidate => candidate.processingState || 'UNKNOWN').join(', ')
        : 'no uploaded build';
      throw new Error(`Timed out waiting for Xcode Cloud build run ${runId} to become valid (${states})`);
    }
    const states = unavailable.length > 0
      ? unavailable.map(candidate => candidate.processingState || 'UNKNOWN').join(', ')
      : 'upload not visible';
    log(`Waiting for Xcode Cloud build run ${runId} before publishing TestFlight notes (${states})`);
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  const notes = await generateTestFlightNotes({
    profile,
    build,
    payload: {
      commit: run.commitSha,
      branch: run.branch,
      target_branch: run.targetBranch,
      pull_request: run.pullRequest,
    },
    asc,
    github,
    excludeBuildIds: run.builds.map(candidate => candidate.buildId),
  });
  for (const warning of notes.warnings) log(`TestFlight notes warning: ${warning}`);

  for (const candidate of run.builds) {
    if (dryRun) {
      log(`[DRY RUN] Would publish TestFlight notes for build #${candidate.buildNumber || candidate.buildId}`);
    } else {
      await asc.updateBetaBuildNotes(candidate.buildId, notes.text);
      log(`Published TestFlight notes for build #${candidate.buildNumber || candidate.buildId}`);
    }
  }
  return {
    updated: dryRun ? 0 : run.builds.length,
    notes: notes.text,
    warnings: notes.warnings,
  };
}
