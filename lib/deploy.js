import { CONFIG, log } from './config.js';
import { DEPLOY_STATUS } from './deploy-result.js';

// App Store version states that a new build can be (re)submitted into. REJECTED,
// DEVELOPER_REJECTED and METADATA_REJECTED are all editable again, so a newer
// build with the same version string can be attached and resubmitted.
const REJECTED_STATES = ['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED'];
const SUBMITTABLE_STATES = ['PREPARE_FOR_SUBMISSION', ...REJECTED_STATES];

export async function runDeployCheck(asc, github, DRY_RUN) {
  log('--- Deploy Check ---');

  // Step 1: Check if a build is already in review
  log('Checking if a build is already in review...');
  const reviewStatus = await asc.checkBuildInReview();
  const rejectedStatus = await asc.checkRejectedVersion();
  const unresolvedStatus = await asc.checkVersionWithUnresolvedIssues();

  if (reviewStatus.inReview) {
    log(`Build #${reviewStatus.buildNumber} (v${reviewStatus.version}) is currently ${reviewStatus.state}`);
  }

  if (rejectedStatus.rejected) {
    log(`Build #${rejectedStatus.buildNumber} (v${rejectedStatus.version}) is currently ${rejectedStatus.state}`);
  }

  if (unresolvedStatus.hasUnresolvedIssues) {
    log(
      `Build #${unresolvedStatus.buildNumber} (v${unresolvedStatus.version}) has unresolved App Store review issues in ${unresolvedStatus.state}`
    );
  }

  // Step 2: Fetch live production build and all eligible TestFlight builds
  log('Fetching live production build...');
  const liveStatus = await asc.getLiveProductionBuild();

  log('Checking for TestFlight builds...');
  const candidateBuilds = await asc.getTestFlightReadyBuilds();

  if (candidateBuilds.length === 0) {
    log('No TestFlight builds ready for App Store submission');
    return { status: DEPLOY_STATUS.NO_BUILD };
  }

  let latestBuild = null;
  let commitInfo = null;

  for (const build of candidateBuilds) {
    log(`Evaluating build #${build.buildNumber} (v${build.version})...`);

    if (liveStatus.live && liveStatus.buildId === build.buildId) {
      log(`Build #${build.buildNumber} (v${build.version}) is already live in production - skipping`);
      continue;
    }

    // Step 3: Get commit SHA for this build from Xcode Cloud
    log(`Getting commit SHA for build #${build.buildNumber}...`);
    const info = await asc.getBuildCommitSHA(build.buildNumber);

    if (!info.found || !info.commitSha) {
      log(`No commit SHA found for build #${build.buildNumber} - skipping`);
      continue;
    }

    // Step 4: Check which workflow built this
    if (CONFIG.workflowId && info.workflowId !== CONFIG.workflowId) {
      log(`Build #${build.buildNumber} is from '${info.workflowName}' (${info.workflowId}), not target workflow ${CONFIG.workflowId} - skipping`);
      continue;
    }

    latestBuild = build;
    commitInfo = info;
    break;
  }

  if (!latestBuild || !commitInfo) {
    log('No eligible build found among available TestFlight builds');
    return { status: DEPLOY_STATUS.NO_ELIGIBLE_BUILD };
  }

  log(`Build #${latestBuild.buildNumber} is from '${commitInfo.workflowName}' workflow`);
  log(`Build #${latestBuild.buildNumber} is from commit: ${commitInfo.commitSha.substring(0, 7)}`);

  const blockedStatus = [rejectedStatus, unresolvedStatus]
    .filter(status => status.rejected || status.hasUnresolvedIssues)
    .reduce((latest, status) => {
      if (!latest) return status;

      const currentBuildNum = parseInt(status.buildNumber, 10);
      const latestBuildNum = parseInt(latest.buildNumber, 10);

      if (isNaN(currentBuildNum)) return latest;
      if (isNaN(latestBuildNum) || currentBuildNum > latestBuildNum) return status;
      return latest;
    }, null);

  if (blockedStatus) {
    const blockedBuildNum = parseInt(blockedStatus.buildNumber, 10);
    const latestBuildNum = parseInt(latestBuild.buildNumber, 10);
    const blockReason = blockedStatus.blockReason === 'unresolved_review'
      ? 'an unresolved App Store review submission'
      : 'a rejected App Store version';

    log(
      `Blocked submission context: candidate build #${latestBuild.buildNumber} (v${latestBuild.version}), blocked by ${blockReason} on build #${blockedStatus.buildNumber} (v${blockedStatus.version}, state: ${blockedStatus.state}, versionId: ${blockedStatus.versionId})`
    );

    if (isNaN(blockedBuildNum) || isNaN(latestBuildNum)) {
      log('Blocked or candidate build number is non-numeric, skipping to avoid resubmitting a rejected build');
      return { status: DEPLOY_STATUS.WAITING_FOR_NEWER_BUILD, reason: 'non-numeric-build' };
    }

    if (latestBuildNum <= blockedBuildNum) {
      log(
        `Latest eligible build #${latestBuild.buildNumber} is not newer than blocked App Store build #${blockedStatus.buildNumber} - waiting for the next Xcode Cloud build`
      );
      return { status: DEPLOY_STATUS.WAITING_FOR_NEWER_BUILD, buildNumber: latestBuild.buildNumber };
    }
  }

  // Step 5: Find the PR that introduced this commit
  const prNumber = github.findPRFromCommit(commitInfo.commitSha);
  let releaseNotes = 'Bug fixes and improvements';

  if (prNumber) {
    log(`Found PR #${prNumber} for this build`);

    const prDetails = github.getPRDetails(prNumber);
    if (prDetails) {
      releaseNotes = github.extractReleaseNotes(prDetails);
      log(`Release notes from PR #${prNumber}: ${releaseNotes}`);
    }

    // Step 6: Handle existing review
    if (reviewStatus.inReview) {
      const reviewBuildNum = parseInt(reviewStatus.buildNumber, 10);
      const latestBuildNum = parseInt(latestBuild.buildNumber, 10);

      if (isNaN(reviewBuildNum) || isNaN(latestBuildNum)) {
        log('Non-numeric build number detected, skipping to avoid conflicts');
        return { status: DEPLOY_STATUS.SKIPPED, reason: 'non-numeric-build' };
      }

      if (latestBuildNum <= reviewBuildNum) {
        if (latestBuildNum === reviewBuildNum) {
          log(`Build #${reviewStatus.buildNumber} is already in review - no newer build available`);
        } else {
          log(`Warning: Build #${reviewStatus.buildNumber} in review is newer than latest main branch build #${latestBuild.buildNumber}`);
        }
        return { status: DEPLOY_STATUS.ALREADY_IN_REVIEW, buildNumber: reviewStatus.buildNumber };
      }

      // Newer build available - cancel current review
      log(`Newer build #${latestBuild.buildNumber} from PR #${prNumber} available (current in review: #${reviewStatus.buildNumber})`);

      if (DRY_RUN) {
        log(`[DRY RUN] Would cancel review for build #${reviewStatus.buildNumber} (v${reviewStatus.version})`);
        log(`[DRY RUN] Would look up cancelled build's PR to notify`);
      } else {
        log('Cancelling current review to submit newer build...');
        const cancelResult = await asc.cancelReview(reviewStatus.versionId);

        if (cancelResult.success) {
          log(`Successfully cancelled review for build #${reviewStatus.buildNumber}`);

          // Try to find and comment on the cancelled build's PR
          try {
            const cancelledCommitInfo = await asc.getBuildCommitSHA(reviewStatus.buildNumber);
            if (cancelledCommitInfo.found && cancelledCommitInfo.commitSha) {
              const cancelledPrNumber = github.findPRFromCommit(cancelledCommitInfo.commitSha);
              if (cancelledPrNumber && cancelledPrNumber !== prNumber) {
                const cancelComment = `Build #${reviewStatus.buildNumber} has been withdrawn from App Store review.\n\nA newer build #${latestBuild.buildNumber} from PR #${prNumber} has been submitted instead.`;
                if (github.addPRComment(cancelledPrNumber, cancelComment)) {
                  log(`Added cancellation notice to PR #${cancelledPrNumber}`);
                }
              }
            }
          } catch (e) {
            log(`Warning: Could not notify cancelled build's PR: ${e.message}`);
          }
        } else {
          log(`Failed to cancel review: ${cancelResult.error}`);
          return { status: DEPLOY_STATUS.SKIPPED, reason: 'cancel-failed' };
        }
      }
    }
  } else {
    // No PR found
    if (reviewStatus.inReview) {
      log(`Build #${latestBuild.buildNumber} is not from a merged PR, skipping (build #${reviewStatus.buildNumber} already in review)`);
      return { status: DEPLOY_STATUS.ALREADY_IN_REVIEW, buildNumber: reviewStatus.buildNumber };
    }
    log('No PR found for commit, using default release notes');
  }

  // Step 7: Submit build for review
  if (DRY_RUN) {
    log(`[DRY RUN] Would submit build #${latestBuild.buildNumber} for review`);
    log(`[DRY RUN] Release notes: ${releaseNotes}`);
    log('Deploy check complete');
    return {
      status: DEPLOY_STATUS.DRY_RUN,
      buildNumber: latestBuild.buildNumber,
      version: latestBuild.version,
      releaseNotes,
    };
  }

  log(`Submitting build #${latestBuild.buildNumber} for review...`);

  // Get the build details
  const buildDetails = await asc.getBuildByNumber(latestBuild.buildNumber);
  if (!buildDetails) {
    log(`ERROR: Build #${latestBuild.buildNumber} not found`);
    return { status: DEPLOY_STATUS.BUILD_NOT_FOUND, buildNumber: latestBuild.buildNumber };
  }

  // Get or create the version
  const versionInfo = await asc.getOrCreateAppStoreVersion(buildDetails.version);
  log(`Version ${buildDetails.version}: ${versionInfo.exists ? 'exists' : 'created'} (state: ${versionInfo.state})`);

  // Check if we can submit
  if (!SUBMITTABLE_STATES.includes(versionInfo.state)) {
    if (versionInfo.state === 'WAITING_FOR_REVIEW' || versionInfo.state === 'IN_REVIEW') {
      log(`Version ${buildDetails.version} is already in ${versionInfo.state} state`);
      return { status: DEPLOY_STATUS.ALREADY_IN_REVIEW, version: buildDetails.version, state: versionInfo.state };
    }
    log(`ERROR: Cannot submit version in state: ${versionInfo.state}`);
    return { status: DEPLOY_STATUS.NOT_SUBMITTABLE, version: buildDetails.version, state: versionInfo.state };
  }

  // Detect a resubmission of a newer build onto a version that was previously
  // rejected at the SAME version number. The blockedStatus guard above already
  // ensured this build number is strictly newer than the rejected one.
  const isResubmitOverRejected = versionInfo.exists && REJECTED_STATES.includes(versionInfo.state);
  if (isResubmitOverRejected) {
    log(
      `Version ${buildDetails.version} was previously ${versionInfo.state} - resubmitting build #${latestBuild.buildNumber} over the same version number`
    );

    // Clear any leftover review submission still attached to this version
    // (e.g. a stuck CANCELING / UNRESOLVED_ISSUES submission) so a clean draft
    // can be created instead of colliding with the old one.
    try {
      const cleared = await asc.cancelReview(versionInfo.versionId);
      if (cleared.success) {
        log(`Cleared a lingering review submission on version ${buildDetails.version} before resubmitting`);
      }
    } catch (e) {
      log(`Warning: Could not clear stale review submission: ${e.message}`);
    }
  }

  // Select the build
  log(`Selecting build ${latestBuild.buildNumber}...`);
  await asc.selectBuildForVersion(versionInfo.versionId, buildDetails.buildId);

  // Update release notes
  log('Updating release notes...');
  await asc.updateReleaseNotes(versionInfo.versionId, releaseNotes);

  // Submit for review
  log('Submitting for review...');
  await asc.submitForReview(versionInfo.versionId);

  log(`Successfully submitted build #${latestBuild.buildNumber} for App Store review!`);
  log(`Release notes: ${releaseNotes}`);

  // Add comment to PR
  if (prNumber) {
    const resubmitNote = isResubmitOverRejected
      ? `\n\nThis build replaces a previously rejected submission for version ${buildDetails.version}.`
      : '';
    const comment = `Build #${latestBuild.buildNumber} has been submitted to App Store for review.\n\n**Release Notes:**\n${releaseNotes}${resubmitNote}`;
    if (github.addPRComment(prNumber, comment)) {
      log(`Added comment to PR #${prNumber}`);
    }
  }

  log('Deploy check complete');
  return {
    status: DEPLOY_STATUS.SUBMITTED,
    buildNumber: latestBuild.buildNumber,
    version: buildDetails.version,
    releaseNotes,
    resubmittedOverRejected: isResubmitOverRejected,
  };
}
