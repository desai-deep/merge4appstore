import test from 'node:test';
import assert from 'node:assert/strict';
import { AppStoreConnectAPI } from '../lib/app-store-connect.js';
import { runClosedPRBuildExpiry } from '../lib/expire.js';

function api() {
  return new AppStoreConnectAPI('key', 'issuer', Buffer.from('unused').toString('base64'));
}
function record({ branch = null, buildIds = [], number = 603, reference = 'deleted-ref' } = {}) {
  return {
    workflowId: 'pr-workflow', workflowName: 'Pull Requests', sourceBranch: branch,
    run: {
      id: 'run-603', attributes: { number, sourceCommit: { commitSha: 'original-before-rebase' } },
      relationships: {
        sourceBranchOrTag: { data: { type: 'scmGitReferences', id: reference } },
        builds: { data: buildIds.map(id => ({ id })) },
      },
    },
  };
}
function deletedRef(name = 'codex/merged') {
  return { data: { type: 'scmGitReferences', id: 'deleted-ref', attributes: { name, isDeleted: true } } };
}

test('recovers the deleted branch for exact-build and unique-number lookups and caches its ID', async () => {
  for (const buildIds of [['build-603'], []]) {
    const asc = api(); let requests = 0;
    asc.loadCIBuildRuns = async () => [record({ buildIds })];
    asc.request = async endpoint => {
      assert.equal(endpoint, '/scmGitReferences/deleted-ref'); requests += 1;
      return deletedRef();
    };
    for (let repeat = 0; repeat < 2; repeat += 1) {
      assert.deepEqual(await asc.getBuildSource('build-603', '603'), {
        found: true, commitSha: 'original-before-rebase', sourceBranch: 'codex/merged',
        workflowId: 'pr-workflow', workflowName: 'Pull Requests',
      });
    }
    assert.equal(requests, 1);
  }
});

test('uses included branch metadata without an extra source request', async () => {
  const asc = api(); asc.loadCIBuildRuns = async () => [record({ branch: 'refs/heads/develop' })];
  asc.request = async () => assert.fail('included branch should be sufficient');
  assert.equal((await asc.getBuildSource('build-603', '603')).sourceBranch, 'develop');
});

test('retains unknown branches after a missing reference and never hides transient failures', async () => {
  const asc = api(); asc.loadCIBuildRuns = async () => [record()];
  asc.request = async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); };
  assert.equal((await asc.getBuildSource('build-603', '603')).sourceBranch, null);
  const retry = api(); retry.loadCIBuildRuns = asc.loadCIBuildRuns;
  retry.request = async () => { throw Object.assign(new Error('rate limited'), { statusCode: 429 }); };
  await assert.rejects(retry.getBuildSource('build-603', '603'), /rate limited/);
  retry.request = async () => deletedRef();
  assert.equal((await retry.getBuildSource('build-603', '603')).sourceBranch, 'codex/merged');
});

test('rejects a mismatched reference and recovers PR-only source relationships', async () => {
  const asc = api(); const row = record();
  asc.loadCIBuildRuns = async () => [row];
  asc.request = async () => ({ data: { ...deletedRef().data, id: 'wrong' } });
  await assert.rejects(asc.getBuildSource('build-603', '603'), /mismatched/);
  delete row.run.relationships.sourceBranchOrTag;
  row.run.relationships.pullRequest = { data: { id: 'pr-12', type: 'scmPullRequests' } };
  asc.request = async endpoint => {
    assert.equal(endpoint, '/scmPullRequests/pr-12');
    return { data: { id: 'pr-12', type: 'scmPullRequests', attributes: { sourceBranchName: 'feature/closed' } } };
  };
  assert.equal((await asc.getBuildSource('build-603', '603')).sourceBranch, 'feature/closed');
});

test('sparse deleted-branch metadata expires a merged PR but still protects develop and open PRs', async t => {
  const previous = process.env.EXPIRE_XCODE_WORKFLOW_ID;
  process.env.EXPIRE_XCODE_WORKFLOW_ID = 'pr-workflow';
  t.after(() => { if (previous === undefined) delete process.env.EXPIRE_XCODE_WORKFLOW_ID; else process.env.EXPIRE_XCODE_WORKFLOW_ID = previous; });
  for (const dryRun of [true, false]) {
    const asc = api(); const expired = [];
    const rows = [record({ number: 603 }), record({ number: 604, reference: 'develop-ref' }), record({ number: 605, reference: 'open-ref' })];
    asc.loadCIBuildRuns = async () => rows;
    asc.getTestFlightCleanupCandidates = async () => rows.map(row => ({ buildId: `build-${row.run.attributes.number}`, buildNumber: String(row.run.attributes.number), version: '1.12' }));
    asc.request = async endpoint => {
      const id = endpoint.split('/').at(-1);
      return { data: { id, type: 'scmGitReferences', attributes: { name: id === 'deleted-ref' ? 'codex/merged' : id === 'open-ref' ? 'feature/open' : 'develop', isDeleted: id === 'deleted-ref' } } };
    };
    asc.expireBuild = async id => { expired.push(id); };
    const github = { findClosedPRForBuild: (commit, _base, branch) => {
      assert.equal(commit, 'original-before-rebase');
      assert.notEqual(branch, 'develop');
      return branch === 'codex/merged' ? { number: 146, mergedAt: '2026-10-17T11:52:26Z' } : null;
    } };
    assert.deepEqual(await runClosedPRBuildExpiry(asc, github, dryRun), { checked: 3, expired: 1 });
    assert.deepEqual(expired, dryRun ? [] : ['build-603']);
  }
});

test('follows history pagination only when requested and rejects another workflow or origin', async () => {
  const asc = api(); const calls = [];
  const next = 'https://api.appstoreconnect.apple.com/v1/ciWorkflows/workflow/buildRuns?cursor=older';
  asc.request = async endpoint => {
    calls.push(endpoint);
    return endpoint.includes('cursor=older')
      ? { data: [{ id: 'old-run' }], included: [{ id: 'old-reference' }] }
      : { data: [{ id: 'new-run' }], included: [], links: { next } };
  };
  assert.deepEqual((await asc.getBuildRuns('workflow', 200)).data.map(x => x.id), ['new-run']);
  assert.equal(calls.length, 1);
  const history = await asc.getBuildRuns('workflow', 200, { allPages: true });
  assert.deepEqual(history.data.map(x => x.id), ['new-run', 'old-run']);
  assert.equal(history.included[0].id, 'old-reference');
  for (const invalid of ['https://evil.example/v1/ciWorkflows/workflow/buildRuns', 'https://api.appstoreconnect.apple.com/v1/ciWorkflows/foreign/buildRuns']) {
    asc.request = async () => ({ data: [], links: { next: invalid } });
    await assert.rejects(asc.getBuildRuns('workflow', 200, { allPages: true }), /Invalid Apple/);
  }
  asc.request = async () => ({ data: [], links: { next } });
  await assert.rejects(asc.getBuildRuns('workflow', 200, { allPages: true }), /repeated a page/);
});

test('a failed history request cannot poison the cached source history', async () => {
  const asc = api(); let first = true;
  asc.getConfiguredCIProducts = async () => [{ id: 'app-product' }];
  asc.getWorkflows = async () => [{ id: 'workflow-1' }, { id: 'workflow-2' }];
  asc.getBuildRuns = async (id, _limit, options) => {
    assert.equal(options.allPages, true);
    if (id === 'workflow-2' && first) { first = false; throw new Error('temporary failure'); }
    return { data: [{ id: `${id}-run` }] };
  };
  await assert.rejects(asc.loadCIBuildRuns(), /temporary failure/);
  assert.equal((await asc.loadCIBuildRuns()).length, 2);
});
