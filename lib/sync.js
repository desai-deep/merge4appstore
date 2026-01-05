import { CONFIG, log } from './config.js';

export async function runReleaseSync(asc, tags, github, DRY_RUN) {
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

  if (tags.tagExists(tagName)) {
    log(`Tag ${tagName} already exists - build already synced`);
    return;
  }

  log(`New production release detected: build #${liveStatus.buildNumber}`);

  // Step 3: Get commit SHA for this build
  log(`Getting commit SHA for build #${liveStatus.buildNumber}...`);
  const commitInfo = await asc.getBuildCommitSHA(liveStatus.buildNumber);

  if (!commitInfo.found || !commitInfo.commitSha) {
    log(`No commit SHA found for build #${liveStatus.buildNumber}`);
    log('This build may have been submitted before commit tracking was implemented');
    return;
  }

  const commitSha = commitInfo.commitSha;
  log(`Found commit: ${commitSha.substring(0, 7)}`);

  // Step 4: Verify commit exists on GitHub
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
  log('Release sync complete');
}
