import { CONFIG, log } from './config.js';

export async function runReleaseSync(asc, tags, github, DRY_RUN, triggerNextBuild = true) {
  log('--- Release Sync ---');

  // Step 1: Get live production build
  log('Checking for live production build...');
  const liveStatus = await asc.getLiveProductionBuild();

  if (!liveStatus.live || liveStatus.buildNumber === '0') {
    log('No live production build found (app may not be released yet)');
    return;
  }

  log(`Live production build: #${liveStatus.buildNumber} (v${liveStatus.version})`);

  // Validate version format
  if (!/^\d+\.\d+(\.\d+)?$/.test(liveStatus.version)) {
    log(`ERROR: Invalid version format: ${liveStatus.version}`);
    return;
  }

  // Step 2: Check if tag already exists
  const tagName = `v${liveStatus.version}-${liveStatus.buildNumber}`;
  log(`Checking if tag ${tagName} already exists...`);

  await tags.refreshEnvironment?.();
  if (tags.tagExists(tagName)) {
    log(`Tag ${tagName} already exists - build already synced`);
    return;
  }

  log(`New production release detected: build #${liveStatus.buildNumber}`);

  // Step 3: Resolve the exact App Store build through its Xcode Cloud
  // relationship. Run numbers can collide across workflows.
  log(`Getting commit SHA for build #${liveStatus.buildNumber}...`);
  const commitInfo = await asc.getBuildSource(
    liveStatus.buildId || null,
    liveStatus.buildNumber,
  );

  if (!commitInfo.found || !commitInfo.commitSha) {
    log(`No commit SHA found for build #${liveStatus.buildNumber}`);
    log('This build may have been submitted before commit tracking was implemented');
    return;
  }

  if (CONFIG.workflowId && commitInfo.workflowId !== CONFIG.workflowId) {
    log(`Build #${liveStatus.buildNumber} came from workflow ${commitInfo.workflowId || 'unknown'}, not target workflow ${CONFIG.workflowId}; not creating a release tag`);
    return;
  }

  const commitSha = commitInfo.commitSha;
  log(`Found commit: ${commitSha.substring(0, 7)}`);

  // Step 4: Verify commit exists on GitHub
  await Promise.all([
    tags.refreshEnvironment?.(),
    github.refreshEnvironment?.(),
  ]);
  if (!tags.commitExists(commitSha)) {
    log(`ERROR: Commit ${commitSha} not found in repository`);
    return;
  }

  const commitMsg = tags.getCommitMessage(commitSha);
  log(`Commit message: ${commitMsg}`);

  // Step 5: Create tag
  if (DRY_RUN) {
    log(`[DRY RUN] Would create tag ${tagName} on commit ${commitSha.substring(0, 7)}`);
  } else {
    log(`Creating tag ${tagName}...`);
    tags.createTag(tagName, commitSha, `Production release: version ${liveStatus.version}, build ${liveStatus.buildNumber}`);
    log(`Created tag ${tagName}`);
  }

  // Step 6: Comment on the PR
  const prNumber = github.findPRFromCommit(commitSha);

  if (prNumber) {
    if (DRY_RUN) {
      log(`[DRY RUN] Would add release comment to PR #${prNumber}`);
    } else {
      const comment = `Build #${liveStatus.buildNumber} has been released to the App Store as version ${liveStatus.version}.`;
      if (github.addPRComment(prNumber, comment)) {
        log(`Added release comment to PR #${prNumber}`);
      }
    }
  }

  log(`Successfully synced build #${liveStatus.buildNumber} and tagged as ${tagName}`);

  // Step 7: Trigger the next TestFlight build on the configured beta branch
  if (triggerNextBuild && CONFIG.iosRepoPath) {
    log('Triggering next TestFlight build...');
    const nextVersion = calculateNextVersion(liveStatus.version);
    const commitMessage = `Trigger v${nextVersion} TestFlight build\n\nAutomatically triggered after v${liveStatus.version} went live.`;

    if (DRY_RUN) {
      log(`[DRY RUN] Would push empty commit to ${CONFIG.betaBranch}: "${commitMessage.split('\n')[0]}"`);
    } else {
      try {
        tags.pushEmptyCommit(CONFIG.betaBranch, commitMessage, CONFIG.iosRepoPath);
        log(`Pushed empty commit to ${CONFIG.betaBranch} - v${nextVersion} build will start shortly`);
      } catch (e) {
        log(`Warning: Failed to trigger next build: ${e.message}`);
      }
    }
  }

  log('Release sync complete');
}

/**
 * Calculate the next minor version
 * @param {string} currentVersion - e.g., "1.4" or "1.4.0"
 * @returns {string} - e.g., "1.5" or "1.5.0"
 */
function calculateNextVersion(currentVersion) {
  const parts = currentVersion.split('.').map(Number);
  parts[1] = (parts[1] || 0) + 1;
  if (parts.length >= 3) {
    parts[2] = 0;
  }
  return parts.join('.');
}
