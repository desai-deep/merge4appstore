import { CONFIG, log } from './config.js';

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function runPublishedBetaBuildExpiry(asc, DRY_RUN, {
  liveVersion,
  workflowId,
  betaBranch = CONFIG.betaBranch,
} = {}) {
  if (!liveVersion || !workflowId) return { checked: 0, expired: 0 };

  log('--- Published Beta TestFlight Expiry ---');
  log(`Expiring ${betaBranch} builds at or before live version ${liveVersion}...`);

  const builds = await asc.getTestFlightCleanupCandidates();
  let checked = 0;
  let expired = 0;

  for (const build of builds) {
    if (!/^\d+(?:\.\d+)*$/.test(build.version)
      || compareVersions(build.version, liveVersion) > 0) continue;

    checked += 1;
    const label = `Build #${build.buildNumber} (v${build.version})`;
    const source = await asc.getBuildSource(build.buildId, build.buildNumber);

    if (!source.found || !source.commitSha) {
      log(`${label}: no matching Xcode Cloud source found - skipping`);
      continue;
    }

    if (source.workflowId !== workflowId) {
      log(`${label}: workflow ${source.workflowName || source.workflowId || 'unknown'} is not the configured beta workflow - keeping`);
      continue;
    }

    // The exact workflow is authoritative when App Store Connect omits source
    // branch metadata. When it does provide a branch, require the release
    // branch as an additional guard against a repurposed workflow.
    if (source.sourceBranch && source.sourceBranch !== betaBranch) {
      log(`${label}: source branch is ${source.sourceBranch}, not ${betaBranch} - keeping`);
      continue;
    }

    if (DRY_RUN) {
      log(`[DRY RUN] Would expire published beta ${label}`);
    } else {
      await asc.expireBuild(build.buildId);
      log(`Expired published beta ${label}`);
    }
    expired += 1;
  }

  log(`${DRY_RUN ? 'Dry run' : 'Cleanup'} complete: checked ${checked}, ${DRY_RUN ? 'would expire' : 'expired'} ${expired}`);
  return { checked, expired };
}

export async function runClosedPRBuildExpiry(asc, github, DRY_RUN) {
  log('--- Closed PR TestFlight Expiry ---');
  log('Checking active TestFlight builds against closed PRs...');

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

    if (!source.sourceBranch && !CONFIG.expireWorkflowId) {
      log(`${label}: source branch is unknown and no exact PR workflow is configured - keeping`);
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
      null,
      source.sourceBranch,
    );
    if (!pull) {
      const sourceLabel = source.sourceBranch || `commit ${source.commitSha.slice(0, 7)}`;
      log(`${label}: ${sourceLabel} has no unambiguous closed PR - keeping`);
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
