import { log } from './config.js';
import { generateTestFlightNotes } from './build-prepare.js';

export async function refreshTestFlightNotes(asc, github, build, payload, dryRun = false) {
  asc.appId = build.appId;
  const notes = await generateTestFlightNotes({ build, payload, asc, github });
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
