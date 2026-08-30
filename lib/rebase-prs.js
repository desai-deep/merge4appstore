function failureMessage(error) {
  return error?.stderr ? String(error.stderr).trim() : (error?.message || String(error));
}

const REBASE_FAILURE_MARKER = '<!-- merge4appstore:auto-rebase-failure -->';

function rebaseFailureComment(baseBranch, conflicted) {
  const reason = conflicted
    ? 'This pull request conflicts with the target branch.'
    : 'GitHub did not allow the branch to be updated automatically.';
  return `${REBASE_FAILURE_MARKER}
## Automatic rebase unsuccessful

merge4appstore could not rebase this pull request onto \`${baseBranch}\`.

${reason} Rebase it manually, then resolve any conflicts or branch restrictions. Automation will retry after the next update to \`${baseBranch}\`.`;
}

function commentOnFailure(github, pullNumber, baseBranch, conflicted, logger) {
  try {
    const result = github.upsertPRComment(
      pullNumber,
      REBASE_FAILURE_MARKER,
      rebaseFailureComment(baseBranch, conflicted),
    );
    if (!result) logger(`Warning: could not comment on pull request #${pullNumber}`);
  } catch (error) {
    logger(`Warning: could not comment on pull request #${pullNumber}: ${failureMessage(error)}`);
  }
}

export function rebaseOpenPullRequests(github, baseBranch, dryRun = false, logger = () => {}) {
  const pulls = github.listOpenPullRequests(baseBranch);
  const results = [];

  for (const pull of pulls) {
    if (pull.mergeable === 'CONFLICTING' || pull.mergeStateStatus === 'DIRTY') {
      logger(`Skipping conflicted pull request #${pull.number}`);
      if (!dryRun) commentOnFailure(github, pull.number, baseBranch, true, logger);
      results.push({ number: pull.number, action: 'skipped', reason: 'conflicted' });
      continue;
    }

    if (dryRun) {
      logger(`Would rebase pull request #${pull.number} onto ${baseBranch}`);
      results.push({ number: pull.number, action: 'would_rebase' });
      continue;
    }

    try {
      const rebased = github.rebasePullRequest(pull.id, pull.headRefOid);
      logger(`Rebased pull request #${pull.number} onto ${baseBranch}`);
      results.push({ number: pull.number, action: 'rebased', url: rebased.url });
    } catch (error) {
      logger(`Skipping pull request #${pull.number}: ${failureMessage(error)}`);
      commentOnFailure(github, pull.number, baseBranch, false, logger);
      results.push({ number: pull.number, action: 'skipped', reason: 'not_updatable' });
    }
  }

  return results;
}
