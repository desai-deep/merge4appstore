import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProductionPromotion, isApprovedProductionBuild } from '../lib/production-promotion.js';

function github({ merged = true, headTree = 'merged-tree' } = {}) {
  return {
    productionBranch: 'main',
    getBranchSnapshot: ref => ref === 'main'
      ? { sha: 'merge-sha', treeSha: 'merged-tree' }
      : { sha: ref, treeSha: headTree },
    findPRFromCommitAsync: async () => merged ? '147' : null,
    getPRDetailsAsync: async () => ({ headRefOid: 'tested-head' }),
  };
}

test('approves a merged PR head only when its contents equal current production', async () => {
  const promotion = await resolveProductionPromotion(github());
  assert.equal(promotion.pullRequest, '147');
  assert.equal(isApprovedProductionBuild(promotion, 'tested-head'), true);
  assert.equal(isApprovedProductionBuild(promotion, 'merge-sha'), true);
  assert.equal(isApprovedProductionBuild(promotion, 'other-open-pr'), false);
});

test('does not approve unmerged production PRs or heads changed during a merge', async () => {
  for (const config of [{ merged: false }, { headTree: 'conflict-resolution-tree' }]) {
    const promotion = await resolveProductionPromotion(github(config));
    assert.equal(isApprovedProductionBuild(promotion, 'tested-head'), false);
  }
});

test('fails closed when GitHub cannot identify the merged PR head', async () => {
  const source = github();
  source.getPRDetailsAsync = async () => null;
  await assert.rejects(resolveProductionPromotion(source), /Could not resolve/);
});

test('historical promotions resolve against their merge commit after production advances', async () => {
  const source = github();
  source.getBranchSnapshot = ref => ref === 'main'
    ? { sha: 'new-production', treeSha: 'new-tree' }
    : { sha: ref, treeSha: 'old-tree' };
  const promotion = await resolveProductionPromotion(source, 'older-merge');
  assert.equal(promotion.commitSha, 'older-merge');
  assert.equal(promotion.previewCommitSha, 'tested-head');
});
