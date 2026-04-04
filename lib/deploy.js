import { CONFIG, log } from './config.js';

export async function runDeployCheck(asc, github, DRY_RUN) {
  const MAX_BUILD_SCAN_ATTEMPTS = 50;

  log('--- Deploy Check ---');

  // Step 1: Check if a build is already in review
  log('Checking if a build is already in review...');
  const reviewStatus = await asc.checkBuildInReview();

  if (reviewStatus.inReview) {
    log(`Build #${reviewStatus.buildNumber} (v${reviewStatus.version}) is currently ${reviewStatus.state}`);
  }

  // Step 2: Fetch live production build
  log('Fetching live production build...');
  const liveStatus = await asc.getLiveProductionBuild();
  const skippedBuildIds = [];
  let latestBuild = null;
  let commitInfo = null;

  while (skippedBuildIds.length < MAX_BUILD_SCAN_ATTEMPTS) {
    log('Checking for latest TestFlight build...');
    latestBuild = await asc.getLatestTestFlightReadyBuild(skippedBuildIds);

    if (!latestBuild.found) {
      log('No TestFlight builds ready for App Store submission');
      return;
    }

    log(`Latest TestFlight build: #${latestBuild.buildNumber} (v${latestBuild.version})`);

    if (liveStatus.live && liveStatus.buildId === latestBuild.buildId) {
      log(`Build #${latestBuild.buildNumber} (v${latestBuild.version}) is already live in production`);
      skippedBuildIds.push(latestBuild.buildId);
      continue;
    }

    // Step 3: Get commit SHA for this build from Xcode Cloud
    log(`Getting commit SHA for build #${latestBuild.buildNumber}...`);
    commitInfo = await asc.getBuildCommitSHA(latestBuild.buildNumber);

    if (!commitInfo.found || !commitInfo.commitSha) {
      log(`No commit SHA found for build #${latestBuild.buildNumber} - skipping`);
      skippedBuildIds.push(latestBuild.buildId);
      continue;
    }

    // Step 4: Check which workflow built this
    if (CONFIG.workflowId && commitInfo.workflowId !== CONFIG.workflowId) {
      log(`Build #${latestBuild.buildNumber} is from '${commitInfo.workflowName}' (${commitInfo.workflowId}), not target workflow ${CONFIG.workflowId} - skipping`);
      skippedBuildIds.push(latestBuild.buildId);
      continue;
    }

    break;
  }

  if (!latestBuild || !commitInfo) {
    log(`Reached max build scan attempts (${MAX_BUILD_SCAN_ATTEMPTS}) without finding an eligible build`);
    return;
  }

  log(`Build #${latestBuild.buildNumber} is from '${commitInfo.workflowName}' workflow`);
  log(`Build #${latestBuild.buildNumber} is from commit: ${commitInfo.commitSha.substring(0, 7)}`);

  // Step 5: Find the PR that introduced this commit
  const prNumber = github.findPRFromCommit(commitInfo.commitSha);
  let releaseNotes = 'Bug fixes and improvements';

  if (prNumber) {
    log(`Found PR #${prNumber} for this build`);

    const prDetails = github.getPRDetails(prNumber);
    if (prDetails) {
      releaseNotes = github.extractReleaseNotes(prDetails.body, prDetails.title);
      log(`Release notes from PR #${prNumber}: ${releaseNotes}`);
    }

    // Step 6: Handle existing review
    if (reviewStatus.inReview) {
      const reviewBuildNum = parseInt(reviewStatus.buildNumber, 10);
      const latestBuildNum = parseInt(latestBuild.buildNumber, 10);

      if (isNaN(reviewBuildNum) || isNaN(latestBuildNum)) {
        log('Non-numeric build number detected, skipping to avoid conflicts');
        return;
      }

      if (latestBuildNum <= reviewBuildNum) {
        if (latestBuildNum === reviewBuildNum) {
          log(`Build #${reviewStatus.buildNumber} is already in review - no newer build available`);
        } else {
          log(`Warning: Build #${reviewStatus.buildNumber} in review is newer than latest main branch build #${latestBuild.buildNumber}`);
        }
        return;
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
          return;
        }
      }
    }
  } else {
    // No PR found
    if (reviewStatus.inReview) {
      log(`Build #${latestBuild.buildNumber} is not from a merged PR, skipping (build #${reviewStatus.buildNumber} already in review)`);
      return;
    }
    log('No PR found for commit, using default release notes');
  }

  // Step 7: Submit build for review
  if (DRY_RUN) {
    log(`[DRY RUN] Would submit build #${latestBuild.buildNumber} for review`);
    log(`[DRY RUN] Release notes: ${releaseNotes}`);
  } else {
    log(`Submitting build #${latestBuild.buildNumber} for review...`);

    // Get the build details
    const buildDetails = await asc.getBuildByNumber(latestBuild.buildNumber);
    if (!buildDetails) {
      log(`ERROR: Build #${latestBuild.buildNumber} not found`);
      return;
    }

    // Get or create the version
    const versionInfo = await asc.getOrCreateAppStoreVersion(buildDetails.version);
    log(`Version ${buildDetails.version}: ${versionInfo.exists ? 'exists' : 'created'} (state: ${versionInfo.state})`);

    // Check if we can submit
    const submittableStates = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED'];
    if (!submittableStates.includes(versionInfo.state)) {
      if (versionInfo.state === 'WAITING_FOR_REVIEW' || versionInfo.state === 'IN_REVIEW') {
        log(`Version ${buildDetails.version} is already in ${versionInfo.state} state`);
        return;
      }
      log(`ERROR: Cannot submit version in state: ${versionInfo.state}`);
      return;
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
      const comment = `Build #${latestBuild.buildNumber} has been submitted to App Store for review.\n\n**Release Notes:**\n${releaseNotes}`;
      if (github.addPRComment(prNumber, comment)) {
        log(`Added comment to PR #${prNumber}`);
      }
    }
  }

  log('Deploy check complete');
}
