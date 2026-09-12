import crypto from 'node:crypto';
import { assertGitHubAppPermissions } from './github-app-auth.js';

function encodeRepositoryPath(owner, repository) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

export async function verifyGitHubAppInstallation(authenticator, owner, repository, {
  full = false,
  writeTag = false,
  repositoryId = null,
  signal = null,
  now = () => Date.now(),
  uniqueSuffix = () => crypto.randomUUID(),
} = {}) {
  const credential = await authenticator.installationToken(owner, repository, {
    repositoryId,
    signal,
  });
  const repositoryPath = encodeRepositoryPath(owner, repository);
  const [{ data: repositoryData }, { data: pulls }] = await Promise.all([
    authenticator.request(repositoryPath, { token: credential.token, signal }),
    authenticator.request(`${repositoryPath}/pulls?state=all&per_page=1`, {
      token: credential.token,
      signal,
    }),
  ]);
  if (repositoryId !== null && String(repositoryData?.id) !== String(repositoryId)) {
    throw new Error(
      `GitHub returned repository id ${repositoryData?.id || 'unknown'}; expected ${repositoryId}`,
    );
  }
  const required = (full || writeTag)
    ? { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' }
    : { metadata: 'read', contents: 'read', pull_requests: 'read' };
  assertGitHubAppPermissions(credential.permissions, required);

  let writeTagCheck = 'not-requested';
  if (writeTag) {
    const branch = repositoryData.default_branch;
    if (!branch) throw new Error('GitHub did not return the repository default branch');
    const { data: commit } = await authenticator.request(
      `${repositoryPath}/commits/${encodeURIComponent(branch)}`,
      { token: credential.token, signal },
    );
    if (!commit?.sha) throw new Error(`GitHub did not return the head commit for ${branch}`);
    const tagName = `merge4appstore-app-verification-${now()}-${uniqueSuffix()}`;
    let referenceCreated = false;
    try {
      const { data: tag } = await authenticator.request(`${repositoryPath}/git/tags`, {
        method: 'POST',
        token: credential.token,
        signal,
        body: {
          tag: tagName,
          message: 'Temporary GitHub App installation verification tag',
          object: commit.sha,
          type: 'commit',
        },
      });
      if (!tag?.sha) throw new Error('GitHub did not return the temporary tag object');
      await authenticator.request(`${repositoryPath}/git/refs`, {
        method: 'POST',
        token: credential.token,
        signal,
        body: { ref: `refs/tags/${tagName}`, sha: tag.sha },
      });
      referenceCreated = true;
      writeTagCheck = 'created';
    } finally {
      if (referenceCreated) {
        await authenticator.request(`${repositoryPath}/git/refs/tags/${encodeURIComponent(tagName)}`, {
          method: 'DELETE',
          token: credential.token,
          signal,
        });
        writeTagCheck = 'created-and-deleted';
      }
    }
  }

  return {
    ok: true,
    repository: repositoryData.full_name,
    repository_id: repositoryData.id,
    installation_id: credential.installationId,
    token_expires_at: new Date(credential.expiresAt).toISOString(),
    repository_selection: credential.repositorySelection,
    permissions: credential.permissions,
    sampled_pull_request: pulls?.[0]?.number || null,
    permission_preflight: (full || writeTag) ? 'full-current-automation' : 'read',
    write_tag_check: writeTagCheck,
  };
}
