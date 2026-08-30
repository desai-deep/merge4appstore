function failureMessage(error) {
  return error?.stderr ? String(error.stderr).trim() : (error?.message || String(error));
}

export function rebaseOpenPullRequests(github, baseBranch, dryRun = false, logger = () => {}) {
  const pulls = github.listOpenPullRequests(baseBranch);
  const results = [];

  for (const pull of pulls) {
    if (pull.mergeable === 'CONFLICTING' || pull.mergeStateStatus === 'DIRTY') {
      logger(`Skipping conflicted pull request #${pull.number}`);
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
      results.push({ number: pull.number, action: 'skipped', reason: 'not_updatable' });
    }
  }

  return results;
}
