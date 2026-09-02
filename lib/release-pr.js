import { log } from './config.js';

export const RELEASE_PULL_REQUEST_LABEL = {
  name: 'automated release',
  color: '1D76DB',
  description: 'Maintained automatically from the development branch',
};

function labelReleasePullRequest(github, pull) {
  try {
    github.labelPullRequest(pull.number, RELEASE_PULL_REQUEST_LABEL);
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    const message = stderr || (error instanceof Error ? error.message : String(error));
    log(`Warning: Could not label release PR #${pull.number}: ${message}`);
  }
}

export function releasePullRequestBody(pullRequests, {
  baseBranch,
  headBranch,
  noteLimit = 100,
  compareUrl,
} = {}) {
  const shown = pullRequests.slice(-noteLimit);
  const notes = shown.length > 0
    ? shown.map(pull => `- #${pull.number} ${pull.title}`)
    : ['- Release branch includes changes not captured by merged pull request summarization.'];
  const omitted = pullRequests.length - shown.length;
  if (omitted > 0) {
    notes.push(`- ...and ${omitted} more pull requests. See ${compareUrl}`);
  }

  return `## Release Notes
${notes.join('\n')}

## Automation
This pull request is maintained automatically from \`${headBranch}\` to \`${baseBranch}\`.
Merging it triggers the configured production release path for this repository.
`;
}

export function mergedPullRequestsInComparison(comparison, mergedPullRequests, {
  mergedAfter,
} = {}) {
  const cutoff = Date.parse(mergedAfter);
  const byMergeCommit = new Map();
  const byNumber = new Map();
  for (const pull of mergedPullRequests) {
    const mergedAt = Date.parse(pull.mergedAt);
    if (Number.isFinite(cutoff) && Number.isFinite(mergedAt) && mergedAt <= cutoff) continue;
    if (pull.mergeCommit?.oid) byMergeCommit.set(pull.mergeCommit.oid, pull);
    byNumber.set(String(pull.number), pull);
  }

  const found = [];
  const seen = new Set();
  for (const commit of comparison.commits) {
    let pull = byMergeCommit.get(commit.sha);
    if (!pull) {
      const subject = commit.message?.split('\n')[0] || '';
      const number = subject.match(/^Merge pull request #(\d+)/)?.[1]
        || subject.match(/\(#(\d+)\)$/)?.[1];
      if (number) pull = byNumber.get(number);
    }
    if (pull && !seen.has(pull.number)) {
      seen.add(pull.number);
      found.push(pull);
    }
  }
  return found;
}

export function reconcileReleasePullRequest(github, policy, dryRun = false) {
  const existing = github.findOpenPullRequest(policy.baseBranch, policy.headBranch);
  const finishWithoutRelease = reason => {
    if (!existing) return { action: 'noop', reason };
    if (dryRun) {
      log(`[DRY RUN] Would close stale release PR #${existing.number}`);
      return { action: 'would_close', reason, number: existing.number };
    }
    const pull = github.closePullRequest(existing.number);
    log(`Closed stale release PR #${pull.number}`);
    return { action: 'closed', reason, ...pull };
  };

  const base = github.getBranchSnapshot(policy.baseBranch);
  const head = github.getBranchSnapshot(policy.headBranch);
  if (!base || !head) throw new Error('Could not resolve both release pull request branches');
  if (base.sha === head.sha || base.treeSha === head.treeSha) {
    log(`${policy.headBranch} has no content changes from ${policy.baseBranch}; release PR is not needed`);
    return finishWithoutRelease('contents_match');
  }

  const comparison = github.compareBranches(policy.baseBranch, policy.headBranch);
  if (comparison.commits.length === 0) {
    log(`${policy.headBranch} has no commits ahead of ${policy.baseBranch}; release PR is not needed`);
    return finishWithoutRelease('head_not_ahead');
  }
  const merged = github.listMergedPullRequests(policy.headBranch);
  const pullRequests = mergedPullRequestsInComparison(comparison, merged, {
    mergedAfter: base.committedAt,
  });
  const compareUrl = `https://github.com/${github.repo}/compare/${encodeURIComponent(policy.baseBranch)}...${encodeURIComponent(policy.headBranch)}`;
  const body = releasePullRequestBody(pullRequests, { ...policy, compareUrl });
  if (dryRun) {
    const action = existing ? 'would_update' : 'would_create';
    log(`[DRY RUN] Would ${existing ? 'update' : 'create'} release PR from ${policy.headBranch} to ${policy.baseBranch}`);
    return { action, number: existing?.number || null, title: policy.title, body, pullRequests };
  }

  if (existing) {
    const pull = github.updatePullRequest(existing.number, body);
    labelReleasePullRequest(github, pull);
    log(`Updated release PR #${pull.number}`);
    return { action: 'updated', ...pull, pullRequests };
  }

  const pull = github.createPullRequest(policy.baseBranch, policy.headBranch, policy.title, body);
  labelReleasePullRequest(github, pull);
  log(`Created release PR #${pull.number}`);
  return { action: 'created', ...pull, pullRequests };
}
