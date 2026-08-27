const ACTIVE_VERSION_STATES = new Set([
  'READY_FOR_SALE',
  'PENDING_DEVELOPER_RELEASE',
  'IN_REVIEW',
  'WAITING_FOR_REVIEW',
  'PREPARE_FOR_SUBMISSION',
]);

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
  if (payload.purpose) return payload.purpose;
  if (payload.pull_request) return 'pull_request';

  const betaBranch = profile.repository.beta_branch || 'develop';
  const productionBranch = profile.repository.production_branch || 'main';
  if (payload.branch === betaBranch) return 'beta';
  if (payload.branch === productionBranch) return 'production';
  throw new Error(`Cannot infer build purpose from branch: ${payload.branch || '(missing)'}`);
}

export async function prepareBuild({ profile, build, payload, asc, github }) {
  const expectedRepository = `${profile.repository.owner}/${profile.repository.name}`;
  if (payload.repository !== expectedRepository) throw new Error('Repository does not match profile');
  if (payload.workflow_id && payload.workflow_id !== build.workflowId) throw new Error('Workflow does not match build purpose');
  const betaBranch = profile.repository.beta_branch || 'develop';
  const productionBranch = profile.repository.production_branch || 'main';
  if (build.purpose === 'pull_request' && (!payload.pull_request || payload.target_branch !== betaBranch)) {
    throw new Error(`Pull-request builds must target ${betaBranch}`);
  }
  if (build.purpose === 'beta' && (payload.pull_request || payload.branch !== betaBranch)) {
    throw new Error(`Beta builds must use ${betaBranch}`);
  }
  if (build.purpose === 'production' && (payload.pull_request || payload.branch !== productionBranch)) {
    throw new Error(`Production builds must use ${productionBranch}`);
  }
  const commitSubject = payload.commit ? github.getCommitSubject(payload.commit) : null;
  if (!commitSubject) throw new Error('Commit is not accessible in the configured repository');

  asc.appId = build.appId;
  const versions = await asc.getAppStoreVersions();
  const marketingVersion = selectMarketingVersion(payload.current_marketing_version, versions, build.purpose);

  let notes = '';
  if (payload.pull_request) notes = github.getPRDetails(payload.pull_request)?.title || '';
  if (!notes) notes = github.findPullRequestTitleForCommit(payload.commit, payload.branch) || '';
  if (!notes) notes = commitSubject || 'Bug fixes and improvements';

  return {
    role: build.appRole,
    purpose: build.purpose,
    marketing_version: marketingVersion,
    testflight_notes: notes,
    warnings: [],
  };
}
