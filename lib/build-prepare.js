const ACTIVE_VERSION_STATES = new Set([
  'READY_FOR_SALE',
  'PENDING_DEVELOPER_RELEASE',
  'IN_REVIEW',
  'WAITING_FOR_REVIEW',
  'PREPARE_FOR_SUBMISSION',
]);
const BUILD_PURPOSES = new Set(['pull_request', 'beta', 'production']);

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parts(version) {
  if (!/^\d+(\.\d+){1,2}$/.test(version || '')) throw new Error(`Invalid marketing version: ${version}`);
  return version.split('.').map(Number);
}

export function compareVersions(left, right) {
  const a = parts(left);
  const b = parts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function nextMinorVersion(reference) {
  const value = parts(reference);
  const next = [value[0], (value[1] || 0) + 1];
  if (value.length === 3) next.push(0);
  return next.join('.');
}

export function selectMarketingVersion(currentVersion, versions, purpose) {
  parts(currentVersion);
  const allowed = purpose === 'production' ? new Set(['READY_FOR_SALE']) : ACTIVE_VERSION_STATES;
  const references = (versions.data || [])
    .filter(version => allowed.has(version.attributes?.appStoreState))
    .map(version => version.attributes?.versionString)
    .filter(Boolean)
    .sort((a, b) => compareVersions(b, a));
  if (references.length === 0 || compareVersions(currentVersion, references[0]) > 0) return currentVersion;
  return nextMinorVersion(references[0]);
}

export function inferBuildPurpose(profile, payload) {
  if (payload.purpose !== undefined && payload.purpose !== null) {
    if (!BUILD_PURPOSES.has(payload.purpose)) {
      throw badRequest(`Unsupported build purpose: ${payload.purpose}`);
    }
    return payload.purpose;
  }
  if (payload.pull_request) return 'pull_request';

  const betaBranch = profile.repository.beta_branch || 'develop';
  const productionBranch = profile.repository.production_branch || 'main';
  if (payload.branch === betaBranch) return 'beta';
  if (payload.branch === productionBranch) return 'production';
  throw badRequest(`Cannot infer build purpose from branch: ${payload.branch || '(missing)'}`);
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

  let pullRequest = payload.pull_request
    ? await callGitHub(github, 'getPRDetailsAsync', 'getPRDetails', payload.pull_request)
    : null;
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
      pullRequest = await callGitHub(
        github,
        'getPRDetailsAsync',
        'getPRDetails',
        releasePullRequest.number,
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
    if (subjects.length === 0 && payload.pull_request && pullRequest) {
      subjects = await callGitHub(
        github,
        'getPullRequestCommitSubjectsAsync',
        'getPullRequestCommitSubjects',
        payload.pull_request,
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

export async function prepareBuild({ profile, build, payload, asc, signal = null }) {
  throwIfAborted(signal);
  const expectedRepository = `${profile.repository.owner}/${profile.repository.name}`;
  if (payload.repository !== expectedRepository) throw badRequest('Repository does not match profile');
  if (payload.workflow_id && payload.workflow_id !== build.workflowId) throw badRequest('Workflow does not match build purpose');
  if (!payload.commit) throw badRequest('Commit is required');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(payload.commit)) {
    throw badRequest('Commit must be a full Git object ID');
  }
  try { parts(payload.current_marketing_version); }
  catch (error) { throw badRequest(error.message); }
  const betaBranch = profile.repository.beta_branch || 'develop';
  const productionBranch = profile.repository.production_branch || 'main';
  if (build.purpose === 'pull_request' && (!payload.pull_request || payload.target_branch !== betaBranch)) {
    throw badRequest(`Pull-request builds must target ${betaBranch}`);
  }
  if (build.purpose === 'beta' && (payload.pull_request || payload.branch !== betaBranch)) {
    throw badRequest(`Beta builds must use ${betaBranch}`);
  }
  if (build.purpose === 'production' && (payload.pull_request || payload.branch !== productionBranch)) {
    throw badRequest(`Production builds must use ${productionBranch}`);
  }
  asc.appId = build.appId;
  const previousSignal = asc.signal;
  if (signal) asc.signal = signal;
  let versions;
  try {
    versions = await asc.getAppStoreVersions();
  } finally {
    asc.signal = previousSignal;
  }
  throwIfAborted(signal);
  const marketingVersion = selectMarketingVersion(payload.current_marketing_version, versions, build.purpose);

  return {
    schema_version: 2,
    role: build.appRole,
    purpose: build.purpose,
    marketing_version: marketingVersion,
    warnings: [],
  };
}
