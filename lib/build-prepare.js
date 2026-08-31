function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function formatTestFlightNotes(subjects, maxLength = 4000) {
  const lines = subjects
    .map(subject => subject?.trim())
    .filter(Boolean)
    .map(subject => `• ${subject}`);
  if (lines.length === 0) return { text: '• Bug fixes and improvements', omitted: 0 };

  const complete = lines.join('\n');
  if (complete.length <= maxLength) return { text: complete, omitted: 0 };

  const included = [];
  for (let index = 0; index < lines.length; index += 1) {
    const next = [...included, lines[index]];
    const omitted = lines.length - next.length;
    const suffix = `• … ${omitted} more commit${omitted === 1 ? '' : 's'}`;
    const candidate = omitted > 0 ? [...next, suffix].join('\n') : next.join('\n');
    if (candidate.length > maxLength) break;
    included.push(lines[index]);
  }
  const omitted = lines.length - included.length;
  const suffix = `• … ${omitted} more commit${omitted === 1 ? '' : 's'}`;
  return { text: [...included, suffix].join('\n').slice(0, maxLength), omitted };
}

function releasePullRequestNotes(body) {
  const text = body?.trim() || '';
  const section = text.match(/^## Release Notes[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m);
  return section ? section[1].trim() : text;
}

function commitHeading(commitRange, firstPullRequestBuild, manualNotes) {
  if (commitRange?.baseMarketingVersion && commitRange?.baseBuildNumber) {
    return `Commits since ${commitRange.baseMarketingVersion} (${commitRange.baseBuildNumber}):`;
  }
  if (commitRange?.baseBuildNumber) return `Commits since build #${commitRange.baseBuildNumber}:`;
  if (firstPullRequestBuild) return 'Commits in this pull request:';
  return manualNotes ? 'Commits since the last published build:' : '';
}

async function callGitHub(github, asynchronousName, synchronousName, ...args) {
  const method = github[asynchronousName] || github[synchronousName];
  if (typeof method !== 'function') return null;
  return method.call(github, ...args);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

export async function generateTestFlightNotes({
  profile = null,
  build,
  payload,
  asc,
  github,
  signal = null,
  excludeBuildIds = [],
}) {
  throwIfAborted(signal);
  const warnings = [];
  const excludedBuildIds = new Set(excludeBuildIds);
  let publishedHistoryError = null;
  const publishedCommitsPromise = build.includeCommits
    ? asc.getPublishedWorkflowCommits(build.workflowId)
      .then(commits => commits.filter(commit => !excludedBuildIds.has(commit.buildId)))
      .catch(error => {
        throwIfAborted(signal);
        publishedHistoryError = error;
        return [];
      })
    : null;
  const [commitSubject, publishedCommits] = await Promise.all([
    payload.commit
      ? callGitHub(github, 'getCommitSubjectAsync', 'getCommitSubject', payload.commit)
      : null,
    publishedCommitsPromise,
  ]);
  if (!commitSubject) throw badRequest('Commit is not accessible in the configured repository');

  let pullRequestNumber = payload.pull_request ? String(payload.pull_request) : null;
  let pullRequest = pullRequestNumber
    ? await callGitHub(github, 'getPRDetailsAsync', 'getPRDetails', pullRequestNumber)
    : null;
  if (build.purpose === 'pull_request' && !pullRequestNumber && payload.branch) {
    const targetBranch = payload.target_branch
      || profile?.repository?.beta_branch
      || 'develop';
    const recoveredPullRequest = await callGitHub(
      github,
      'findOpenPullRequestForCommitAsync',
      'findOpenPullRequestForCommit',
      payload.commit,
      targetBranch,
      payload.branch,
    );
    if (recoveredPullRequest?.number) {
      pullRequestNumber = String(recoveredPullRequest.number);
      pullRequest = await callGitHub(
        github,
        'getPRDetailsAsync',
        'getPRDetails',
        pullRequestNumber,
      );
    }
  }
  if (build.purpose === 'beta' && !pullRequest) {
    const betaBranch = profile?.repository?.beta_branch || 'develop';
    const productionBranch = profile?.repository?.production_branch || 'main';
    const releasePullRequest = await callGitHub(
      github,
      'findOpenPullRequestForCommitAsync',
      'findOpenPullRequestForCommit',
      payload.commit,
      productionBranch,
      betaBranch,
    );
    if (releasePullRequest?.number) {
      pullRequestNumber = String(releasePullRequest.number);
      pullRequest = await callGitHub(
        github,
        'getPRDetailsAsync',
        'getPRDetails',
        pullRequestNumber,
      );
    }
  }
  let pullRequestHeadChanged = false;
  if (pullRequest && pullRequest.headRefOid !== payload.commit) {
    pullRequestHeadChanged = true;
    warnings.push('Pull-request head changed; ignored its current title, description, and commits');
    pullRequest = null;
  }
  const manualNotes = build.purpose === 'beta'
    ? releasePullRequestNotes(pullRequest?.body)
    : pullRequest?.body?.trim() || '';
  let subjects = [];
  let firstPullRequestBuild = false;
  let commitRange = null;

  if (build.includeCommits) {
    if (publishedHistoryError) {
      warnings.push('Published build history unavailable; using pull-request commits');
    } else try {
      commitRange = await github.getCommitSubjectsSince(
        publishedCommits,
        payload.commit,
        { branch: payload.branch, signal },
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error.statusCode === 400) throw error;
      warnings.push('Git history mirror unavailable; using pull-request commits');
    }
    firstPullRequestBuild = build.purpose === 'pull_request' && !commitRange;
    subjects = commitRange?.subjects || [];
    if (subjects.length === 0 && pullRequestNumber && pullRequest) {
      subjects = await callGitHub(
        github,
        'getPullRequestCommitSubjectsAsync',
        'getPullRequestCommitSubjects',
        pullRequestNumber,
      ) || [];
      if (subjects.length > 0) warnings.push('No ancestor published build found; using all pull-request commits');
    }
    if (subjects.length === 0) {
      subjects = [commitSubject];
      warnings.push('No ancestor published build found; using the current commit');
    }
  }

  let generated;
  if (build.includeCommits) {
    const heading = commitHeading(commitRange, firstPullRequestBuild, manualNotes);
    const fixedSections = [manualNotes, heading].filter(Boolean).join('\n\n');
    const available = Math.max(1, 4000 - (fixedSections ? fixedSections.length + 2 : 0));
    const commits = formatTestFlightNotes(subjects, available);
    const sections = manualNotes && !firstPullRequestBuild
      ? [heading, commits.text, manualNotes]
      : [manualNotes, heading, commits.text];
    generated = sections.filter(Boolean).join('\n\n');
    if (commits.omitted > 0) warnings.push(`${commits.omitted} commits omitted to fit the TestFlight notes limit`);
  } else {
    const associatedPullRequestTitle = build.purpose === 'beta'
      || pullRequest?.title
      || pullRequestHeadChanged
      ? null
      : await callGitHub(
        github,
        'findPullRequestTitleForCommitAsync',
        'findPullRequestTitleForCommit',
        payload.commit,
        payload.target_branch || payload.branch,
      );
    const summary = pullRequest?.title
      || associatedPullRequestTitle
      || commitSubject
      || 'Bug fixes and improvements';
    generated = manualNotes || summary;
  }

  if (generated.length > 4000) {
    generated = `${generated.slice(0, 3984).trimEnd()}\n\n… truncated`;
    warnings.push('TestFlight notes truncated to 4000 characters');
  }
  throwIfAborted(signal);
  return { text: generated, warnings };
}
