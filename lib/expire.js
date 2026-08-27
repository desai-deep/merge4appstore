import { CONFIG, log } from './config.js';

export async function runClosedPRBuildExpiry(asc, github, DRY_RUN) {
  log('--- Closed PR TestFlight Expiry ---');
  log(`Checking active TestFlight builds against closed PRs targeting ${CONFIG.betaBranch}...`);

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

    if (CONFIG.expireWorkflowId && source.workflowId !== CONFIG.expireWorkflowId) {
      log(`${label}: workflow ${source.workflowName || source.workflowId || 'unknown'} is not the configured PR workflow - keeping`);
      continue;
    }

    if (source.sourceBranch && [CONFIG.betaBranch, CONFIG.productionBranch].includes(source.sourceBranch)) {
      log(`${label}: source branch is protected (${source.sourceBranch}) - skipping`);
      continue;
    }

    const pull = github.findClosedPRForBuild(
      source.commitSha,
      CONFIG.betaBranch,
      source.sourceBranch,
    );
    if (!pull) {
      const sourceLabel = source.sourceBranch || `commit ${source.commitSha.slice(0, 7)}`;
      log(`${label}: ${sourceLabel} has no unambiguous closed PR targeting ${CONFIG.betaBranch} - keeping`);
      continue;
    }

    const reason = pull.mergedAt ? 'merged' : 'closed without merge';
    const branch = source.sourceBranch || pull.headBranch || `commit ${source.commitSha.slice(0, 7)}`;

    if (DRY_RUN) {
      log(`[DRY RUN] Would expire ${label} from ${branch} (${reason}, PR #${pull.number})`);
    } else {
      await asc.expireBuild(build.buildId);
      log(`Expired ${label} from ${branch} (${reason}, PR #${pull.number})`);
    }
    expired += 1;
  }

  log(`${DRY_RUN ? 'Dry run' : 'Cleanup'} complete: checked ${builds.length}, ${DRY_RUN ? 'would expire' : 'expired'} ${expired}`);
  return { checked: builds.length, expired };
}
