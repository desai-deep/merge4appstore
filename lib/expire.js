import { CONFIG, log } from './config.js';

export async function runMergedBuildExpiry(asc, github, DRY_RUN) {
  log('--- Merged Branch TestFlight Expiry ---');
  log(`Checking active TestFlight builds against PRs merged to ${CONFIG.betaBranch}...`);

  const builds = await asc.getTestFlightCleanupCandidates();
  if (builds.length === 0) {
    log('No unexpired TestFlight builds are eligible for cleanup');
    return { checked: 0, expired: 0 };
  }

  let expired = 0;

  for (const build of builds) {
    const label = `Build #${build.buildNumber} (v${build.version})`;
    const source = await asc.getBuildSource(build.buildId, build.buildNumber);

    if (!source.found || !source.commitSha) {
      log(`${label}: no matching Xcode Cloud source found - skipping`);
      continue;
    }

    if (!source.sourceBranch) {
      log(`${label}: source branch is unknown - skipping`);
      continue;
    }

    if ([CONFIG.betaBranch, CONFIG.productionBranch].includes(source.sourceBranch)) {
      log(`${label}: source branch is protected (${source.sourceBranch}) - skipping`);
      continue;
    }

    const pull = github.findMergedPRForCommit(
      source.commitSha,
      CONFIG.betaBranch,
      source.sourceBranch,
    );
    if (!pull) {
      log(`${label}: ${source.sourceBranch} has no PR merged to ${CONFIG.betaBranch} - keeping`);
      continue;
    }

    if (DRY_RUN) {
      log(`[DRY RUN] Would expire ${label} from ${source.sourceBranch} (merged PR #${pull.number})`);
    } else {
      await asc.expireBuild(build.buildId);
      log(`Expired ${label} from ${source.sourceBranch} (merged PR #${pull.number})`);
    }
    expired += 1;
  }

  log(`${DRY_RUN ? 'Dry run' : 'Cleanup'} complete: checked ${builds.length}, ${DRY_RUN ? 'would expire' : 'expired'} ${expired}`);
  return { checked: builds.length, expired };
}
