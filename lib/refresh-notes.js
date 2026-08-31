import { log } from './config.js';
import { generateTestFlightNotes } from './build-prepare.js';

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
