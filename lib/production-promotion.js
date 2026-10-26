// A production PR build is only approved after its exact head is merged and
// its source tree matches current production (including squash/merge commits).
export async function resolveProductionPromotion(github) {
  await github.refreshEnvironment?.();
  const production = github.getBranchSnapshot(github.productionBranch);
  const pullRequest = await github.findPRFromCommitAsync(production.sha, { strict: true });
  if (!pullRequest) return { commitSha: production.sha, previewCommitSha: null, pullRequest: null };
  const pull = await github.getPRDetailsAsync(pullRequest);
  if (!pull?.headRefOid) throw new Error('Could not resolve the merged production PR head');
  const head = github.getBranchSnapshot(pull.headRefOid);
  return {
    commitSha: production.sha,
    previewCommitSha: head.treeSha === production.treeSha ? head.sha : null,
    pullRequest,
  };
}

export function isApprovedProductionBuild(promotion, commitSha) {
  return commitSha === promotion.commitSha || commitSha === promotion.previewCommitSha;
}
