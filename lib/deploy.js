import { CONFIG, log } from './config.js';
import { formatAppStoreErrorDetail } from './app-store-connect.js';
import { syncLocalizedMetadata } from './metadata.js';

export function releaseIssueMarker(versionId) {
  return `<!-- merge4appstore:release-issue:${versionId} -->`;
}

export function submissionFailureComment({ buildNumber, version, versionId, buildSelected, error, issue }) {
  const marker = `<!-- merge4appstore:submission-failure:${versionId}:${buildNumber} -->`;
  const details = Array.isArray(error?.appStoreErrors) && error.appStoreErrors.length > 0
    ? error.appStoreErrors.map(item => `- ${formatAppStoreErrorDetail(item)}`).join('\n')
    : `- ${error?.message || 'App Store Connect rejected the submission.'}`;
  const buildState = buildSelected
    ? `Build #${buildNumber} remains selected for version ${version}. `
    : '';
  const tracking = issue
    ? `\n\nTrack remediation in [#${issue.number}](${issue.url}).`
    : '';

  return `${marker}\n## Release blocked\n\nBuild #${buildNumber} could not be submitted to App Store review.\n\n**App Store Connect requirements**\n${details}\n\n${buildState}Fix the App Store Connect requirements, then rerun deployment reconciliation. A new build is not required unless App Store Connect reports a build-specific problem.${tracking}`;
}

function submissionFailureIssue({ buildNumber, version, versionId, buildSelected, error, prNumber }) {
  const details = Array.isArray(error?.appStoreErrors) && error.appStoreErrors.length > 0
    ? error.appStoreErrors.map(item => `- ${formatAppStoreErrorDetail(item)}`).join('\n')
    : `- ${error?.message || 'App Store Connect rejected the submission.'}`;
  const selected = buildSelected ? ' The build remains selected in App Store Connect.' : '';
  return {
    marker: releaseIssueMarker(versionId),
    title: `Release blocked: version ${version}`,
    body: `App Store submission for build #${buildNumber} failed. Source release PR: #${prNumber}.${selected}\n\n## Required action\n\n${details}\n\nFix the requirement and rerun deployment reconciliation. A new build is not required unless App Store Connect reports a build-specific problem.`,
  };
}

async function surfaceBlockedRelease(asc, github, blockedStatus, blockReason) {
  try {
    const commitInfo = await asc.getBuildSource(
      blockedStatus.buildId || null,
      blockedStatus.buildNumber,
    );
    const prNumber = commitInfo?.found && commitInfo.commitSha
      ? github.findPRFromCommit(commitInfo.commitSha)
      : null;
    const marker = releaseIssueMarker(blockedStatus.versionId);
    const reason = blockReason === 'an unresolved App Store review submission'
      ? 'App Store Connect reports unresolved review issues.'
      : `App Store Connect reports the version as ${blockedStatus.state}.`;
    const issue = github.upsertIssue(
      marker,
      `Release blocked: version ${blockedStatus.version}`,
      `Build #${blockedStatus.buildNumber} cannot progress. ${prNumber ? `Source release PR: #${prNumber}.` : ''}\n\n## Required action\n\n- ${reason}`,
    );
    if (!issue) {
      log(`Warning: Could not create a tracking issue for blocked version ${blockedStatus.version}`);
      return;
    }
    log(`${issue.action === 'created' ? 'Created' : 'Updated'} release issue #${issue.number}`);
    if (prNumber) {
      const prMarker = `<!-- merge4appstore:release-blocked:${blockedStatus.versionId} -->`;
      github.upsertPRComment(
        prNumber,
        prMarker,
        `${prMarker}\n## Release blocked\n\nBuild #${blockedStatus.buildNumber} is blocked in App Store Connect (${blockedStatus.state}). Track remediation in [#${issue.number}](${issue.url}).`,
      );
    }
  } catch (error) {
    log(`Warning: Could not surface blocked release: ${error.message}`);
  }
}

async function closeResolvedReleaseIssues(github, versionIds, message) {
  for (const versionId of new Set(versionIds.filter(Boolean))) {
    try {
      const closedIssue = await github.closeIssueByMarker(
        releaseIssueMarker(versionId),
        message,
      );
      if (closedIssue) log(`Closed resolved release issue #${closedIssue.number}`);
    } catch (error) {
      // App Store state is authoritative and must never be repeated just to
      // clean up GitHub. A later reconciliation observes the same state and
      // retries this idempotent issue closure.
      log(`Warning: Could not close the resolved release issue for ${versionId}: ${error.message}`);
    }
  }
}

function recoveryUnavailable(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = 503;
  error.retryAfter = 5;
  return error;
}

export async function recoverMissedProductionBuild(asc, github, DRY_RUN) {
  if (!CONFIG.recoverMissedBuilds || !CONFIG.workflowId) {
    return { waiting: false };
  }

  try {
    const commitSha = typeof github.getProductionHeadAsync === 'function'
      ? await github.getProductionHeadAsync({ strict: true })
      : github.getProductionHead({ strict: true });
    if (!commitSha) {
      throw recoveryUnavailable('Could not resolve the production branch head');
    }

    const prNumber = typeof github.findPRFromCommitAsync === 'function'
      ? await github.findPRFromCommitAsync(commitSha, { strict: true })
      : github.findPRFromCommit(commitSha, { strict: true });
    if (!prNumber) {
      log(`Production head ${commitSha.substring(0, 7)} is not a merged PR; skipping Xcode Cloud trigger recovery`);
      return { waiting: false, commitSha };
    }

    const sourceReference = await asc.getWorkflowBranchReference(
      CONFIG.workflowId,
      CONFIG.productionBranch,
    );

    const status = await asc.getWorkflowRunStatus(
      CONFIG.workflowId,
      commitSha,
      CONFIG.productionBranch,
      prNumber,
      null,
      sourceReference?.id || null,
    );

    if (status.found) {
      if (status.executionProgress !== 'COMPLETE') {
        log(`Production build #${status.number || status.runId} for PR #${prNumber} is ${status.executionProgress}`);
        return { waiting: true };
      }

      if (status.completionStatus !== 'SUCCEEDED') {
        log(`Production build #${status.number || status.runId} for PR #${prNumber} completed with ${status.completionStatus}; not submitting an older build`);
        return { waiting: true };
      }

      return { waiting: false, commitSha };
    }

    const unknownActiveRun = status.unknownActivePullRequestRun
      || status.unknownActiveBranchRun;
    if (unknownActiveRun) {
      const active = unknownActiveRun;
      log(`Production build #${active.number || active.runId} is ${active.executionProgress} before its commit is available; waiting to avoid a duplicate`);
      return { waiting: true };
    }
    if (status.uncertainActivePullRequestRun) {
      const active = status.uncertainActivePullRequestRun;
      log(`Xcode Cloud build #${active.number || active.runId} is active before its pull-request identity is available; waiting for the next reconciliation`);
      return { waiting: true };
    }
    if (status.uncertainActiveBranchRun) {
      const active = status.uncertainActiveBranchRun;
      log(`Xcode Cloud build #${active.number || active.runId} is active before its branch identity is available; waiting for the next reconciliation`);
      return { waiting: true };
    }
    if (!sourceReference) {
      throw recoveryUnavailable(`Xcode Cloud branch reference not found for ${CONFIG.productionBranch}`);
    }

    if (DRY_RUN) {
      log(`[DRY RUN] Would start the production workflow for PR #${prNumber} at ${commitSha.substring(0, 7)}`);
      return { waiting: true };
    }

    const run = await asc.startWorkflowBuild(CONFIG.workflowId, sourceReference.id);
    log(`Recovered missed Xcode Cloud trigger: started build #${run.number || run.runId} for PR #${prNumber}`);
    return { waiting: true };
  } catch (error) {
    log(`Warning: Xcode Cloud trigger recovery failed: ${error.message}`);
    // A recovery outage is fail-closed for App Store submission, but it must
    // also fail visibly. Let the webhook worker retain/retry the durable
    // receipt instead of acknowledging an inconclusive reconciliation.
    throw error;
  }
}

export async function runDeployCheck(asc, github, DRY_RUN, {
  metadataPath = '',
  reconcileMetadata = false,
  onVersionSubmitted = async () => {},
  onVersionReleased = async () => {},
} = {}) {
  log('--- Deploy Check ---');

  const recovery = reconcileMetadata
    ? { waiting: false }
    : await recoverMissedProductionBuild(asc, github, DRY_RUN);
  if (recovery.waiting) return;

  // Step 1: Check if a build is already in review
  log('Checking if a build is already in review...');
  const reviewStatus = await asc.checkBuildInReview();
  const rejectedStatus = await asc.checkRejectedVersion();
  const unresolvedStatus = await asc.checkVersionWithUnresolvedIssues();

  if (!DRY_RUN) {
    const submittedVersions = [
      reviewStatus.inReview ? reviewStatus : null,
      rejectedStatus.rejected ? rejectedStatus : null,
      unresolvedStatus.hasUnresolvedIssues ? unresolvedStatus : null,
    ].filter(Boolean);
    for (const status of submittedVersions) {
      await onVersionSubmitted({
        version: status.version,
        versionId: status.versionId || null,
        buildId: status.buildId || null,
        state: status.state || null,
      });
    }
  }

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

  if (reviewStatus.inReview && !DRY_RUN) {
    const reviewBuildNumber = Number.parseInt(reviewStatus.buildNumber, 10);
    const supersededBlockedVersionIds = [rejectedStatus, unresolvedStatus]
      .filter(status => {
        const blockedBuildNumber = Number.parseInt(status.buildNumber, 10);
        return Number.isFinite(reviewBuildNumber)
          && Number.isFinite(blockedBuildNumber)
          && reviewBuildNumber >= blockedBuildNumber;
      })
      .map(status => status.versionId);
    await closeResolvedReleaseIssues(
      github,
      [reviewStatus.versionId, ...supersededBlockedVersionIds],
      `App Store Connect reports build #${reviewStatus.buildNumber} in ${reviewStatus.state}; closing the stale release alert.`,
    );
  }

  // Step 2: Fetch live production build and all eligible TestFlight builds
  log('Fetching live production build...');
  const liveStatus = await asc.getLiveProductionBuild();
  if (!DRY_RUN && liveStatus.live) {
    await onVersionReleased({
      version: liveStatus.version,
      buildId: liveStatus.buildId || null,
    });
  }

  log('Checking for TestFlight builds...');
  const candidateBuilds = await asc.getTestFlightReadyBuilds();

  if (candidateBuilds.length === 0) {
    log('No TestFlight builds ready for App Store submission');
    return;
  }

  let latestBuild = null;
  let commitInfo = null;

  for (const build of candidateBuilds) {
    log(`Evaluating build #${build.buildNumber} (v${build.version})...`);

    if (liveStatus.live && liveStatus.buildId === build.buildId) {
      log(`Build #${build.buildNumber} (v${build.version}) is already live in production - skipping`);
      continue;
    }

    // Step 3: Resolve this exact App Store build through its Xcode Cloud
    // relationship. Build numbers are scoped to a workflow and can collide.
    log(`Getting commit SHA for build #${build.buildNumber}...`);
    const info = await asc.getBuildSource(build.buildId, build.buildNumber);

    if (!info.found || !info.commitSha) {
      log(`No commit SHA found for build #${build.buildNumber} - skipping`);
      continue;
    }

    if (recovery.commitSha && info.commitSha !== recovery.commitSha) {
      log(`Build #${build.buildNumber} is from an older production commit - skipping`);
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
    return;
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
      return;
    }

    if (latestBuildNum < blockedBuildNum
      || (latestBuildNum === blockedBuildNum && !reconcileMetadata)) {
      log(
        `Latest eligible build #${latestBuild.buildNumber} is not newer than blocked App Store build #${blockedStatus.buildNumber} - waiting for the next Xcode Cloud build`
      );
      await surfaceBlockedRelease(asc, github, blockedStatus, blockReason);
      return;
    }
    if (latestBuildNum === blockedBuildNum) {
      log(`Retrying build #${latestBuild.buildNumber} after a repository metadata change`);
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
  } else {
    log('No PR found for commit, using default release notes');
  }

  // Step 6: A newer production build always supersedes the build in review.
  // GitHub PR attribution is useful for notes and notifications, but must not
  // control the App Store lifecycle.
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

    const source = prNumber ? `PR #${prNumber}` : `commit ${commitInfo.commitSha.substring(0, 7)}`;
    log(`Newer build #${latestBuild.buildNumber} from ${source} available (current in review: #${reviewStatus.buildNumber})`);

    if (DRY_RUN) {
      log(`[DRY RUN] Would cancel review for build #${reviewStatus.buildNumber} (v${reviewStatus.version})`);
      log(`[DRY RUN] Would look up cancelled build's PR to notify`);
    } else {
      log('Cancelling current review to submit newer build...');
      const cancelResult = await asc.cancelReview(reviewStatus.versionId);

      if (!cancelResult.success) {
        log(`Failed to cancel review: ${cancelResult.error}`);
        return;
      }

      log(`Successfully cancelled review for build #${reviewStatus.buildNumber}`);
      await asc.waitForVersionEditable(reviewStatus.versionId);

      // Try to find and comment on the cancelled build's PR.
      try {
        const cancelledCommitInfo = await asc.getBuildSource(
          reviewStatus.buildId || null,
          reviewStatus.buildNumber,
        );
        if (cancelledCommitInfo.found && cancelledCommitInfo.commitSha) {
          const cancelledPrNumber = github.findPRFromCommit(cancelledCommitInfo.commitSha);
          if (cancelledPrNumber && cancelledPrNumber !== prNumber) {
            const replacement = prNumber ? ` from PR #${prNumber}` : '';
            const cancelComment = `Build #${reviewStatus.buildNumber} has been withdrawn from App Store review.\n\nA newer build #${latestBuild.buildNumber}${replacement} has been submitted instead.`;
            if (github.addPRComment(cancelledPrNumber, cancelComment)) {
              log(`Added cancellation notice to PR #${cancelledPrNumber}`);
            }
          }
        }
      } catch (e) {
        log(`Warning: Could not notify cancelled build's PR: ${e.message}`);
      }
    }
  }

  // Step 7: Submit build for review
  if (DRY_RUN) {
    log(`[DRY RUN] Would submit build #${latestBuild.buildNumber} for review`);
    log(`[DRY RUN] Release notes: ${releaseNotes}`);
  } else {
    log(`Submitting build #${latestBuild.buildNumber} for review...`);

    // Candidate discovery already returned the exact App Store build resource.
    // Do not re-query by build number: the same number can exist in another
    // marketing-version train and select a different build ID.
    const buildDetails = latestBuild;

    // Get or create the version
    const versionInfo = await asc.getOrCreateAppStoreVersion(buildDetails.version);
    log(`Version ${buildDetails.version}: ${versionInfo.exists ? 'exists' : 'created'} (state: ${versionInfo.state})`);

    // Check if we can submit
    const submittableStates = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED'];
    if (!submittableStates.includes(versionInfo.state)) {
      if (versionInfo.state === 'WAITING_FOR_REVIEW' || versionInfo.state === 'IN_REVIEW') {
        await onVersionSubmitted({
          version: buildDetails.version,
          versionId: versionInfo.versionId,
          buildId: buildDetails.buildId,
          state: versionInfo.state,
        });
        log(`Version ${buildDetails.version} is already in ${versionInfo.state} state`);
        return;
      }
      log(`ERROR: Cannot submit version in state: ${versionInfo.state}`);
      return;
    }

    let buildSelected = false;
    try {
      let metadata = { managedWhatsNewLocales: new Set() };
      if (metadataPath) {
        const metadataRef = github.getProductionHead() || commitInfo.commitSha;
        metadata = await syncLocalizedMetadata(asc, github, {
          metadataPath,
          ref: metadataRef,
          versionId: versionInfo.versionId,
          dryRun: DRY_RUN,
        });
      }

      // Select the build
      log(`Selecting build ${latestBuild.buildNumber}...`);
      await asc.selectBuildForVersion(versionInfo.versionId, buildDetails.buildId);
      buildSelected = true;

      // Update release notes
      if (metadata.managedWhatsNewLocales.has('en-US')) {
        log('Using repository-managed en-US release notes');
      } else {
        log('Updating release notes...');
        await asc.updateReleaseNotes(versionInfo.versionId, releaseNotes);
      }

      // Submit for review
      log('Submitting for review...');
      await asc.submitForReview(versionInfo.versionId);
    } catch (error) {
      log(`ERROR: App Store submission failed: ${error.message}`);
      if (prNumber) {
        const issueSpec = submissionFailureIssue({
          buildNumber: latestBuild.buildNumber,
          version: buildDetails.version,
          versionId: versionInfo.versionId,
          buildSelected,
          error,
          prNumber,
        });
        const issue = github.upsertIssue(issueSpec.marker, issueSpec.title, issueSpec.body);
        if (issue) log(`${issue.action === 'created' ? 'Created' : 'Updated'} release issue #${issue.number}`);
        else log(`Warning: Could not create a tracking issue for version ${buildDetails.version}`);
        const marker = `<!-- merge4appstore:submission-failure:${versionInfo.versionId}:${latestBuild.buildNumber} -->`;
        const comment = submissionFailureComment({
          buildNumber: latestBuild.buildNumber,
          version: buildDetails.version,
          versionId: versionInfo.versionId,
          buildSelected,
          error,
          issue,
        });
        const result = github.upsertPRComment(prNumber, marker, comment);
        if (result) {
          log(`${result === 'updated' ? 'Updated' : 'Added'} submission failure on PR #${prNumber}`);
          if (error.reviewSubmissionItemId && !error.ambiguousResult) {
            try {
              await asc.removeReviewSubmissionItem(error.reviewSubmissionItemId);
              log(`Removed failed review submission item ${error.reviewSubmissionItemId}`);
            } catch (cleanupError) {
              log(`Warning: Could not remove failed review submission item ${error.reviewSubmissionItemId}: ${cleanupError.message}`);
            }
          } else if (error.reviewSubmissionItemId) {
            log(`Submission result is ambiguous; keeping review item ${error.reviewSubmissionItemId} for state reconciliation`);
          } else if (error.reviewSubmissionId) {
            log(`No review item was attached to failed draft ${error.reviewSubmissionId}; the empty draft will be reused`);
          }
        } else {
          log(`Warning: Could not add submission failure to PR #${prNumber}; keeping its draft review submission`);
        }
      }
      throw error;
    }

    await onVersionSubmitted({
      version: buildDetails.version,
      versionId: versionInfo.versionId,
      buildId: buildDetails.buildId,
      state: 'SUBMITTED',
    });

    log(`Successfully submitted build #${latestBuild.buildNumber} for App Store review!`);
    log(`Release notes: ${releaseNotes}`);

    // Add comment to PR
    if (prNumber) {
      const comment = `Build #${latestBuild.buildNumber} has been submitted to App Store for review.\n\n**Release Notes:**\n${releaseNotes}`;
      if (github.addPRComment(prNumber, comment)) {
        log(`Added comment to PR #${prNumber}`);
      }
    }
    const resolvedVersionIds = [
      versionInfo.versionId,
      blockedStatus?.versionId,
    ];
    const fixingPR = prNumber ? ` Fixing release PR: #${prNumber}.` : '';
    await closeResolvedReleaseIssues(
      github,
      resolvedVersionIds,
      `Build #${latestBuild.buildNumber} was successfully submitted to App Store review.${fixingPR}`,
    );
  }

  log('Deploy check complete');
}
