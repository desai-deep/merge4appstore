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
      assert.deepEqual(await asc.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'pr-workflow' }), {
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
  assert.equal((await asc.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'pr-workflow' })).sourceBranch, 'develop');
});

test('retains unknown branches after a missing reference and never hides transient failures', async () => {
  const asc = api(); asc.loadCIBuildRuns = async () => [record()];
  asc.request = async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); };
  assert.equal((await asc.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'pr-workflow' })).sourceBranch, null);
  const retry = api(); retry.loadCIBuildRuns = asc.loadCIBuildRuns;
  retry.request = async () => { throw Object.assign(new Error('rate limited'), { statusCode: 429 }); };
  await assert.rejects(retry.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'pr-workflow' }), /rate limited/);
  retry.request = async () => deletedRef();
  assert.equal((await retry.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'pr-workflow' })).sourceBranch, 'codex/merged');
});

test('rejects a mismatched reference and recovers PR-only source relationships', async () => {
  const asc = api(); const row = record();
  asc.loadCIBuildRuns = async () => [row];
  asc.request = async () => ({ data: { ...deletedRef().data, id: 'wrong' } });
  await assert.rejects(asc.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'pr-workflow' }), /mismatched/);
  delete row.run.relationships.sourceBranchOrTag;
  row.run.relationships.pullRequest = { data: { id: 'pr-12', type: 'scmPullRequests' } };
  asc.request = async endpoint => {
    assert.equal(endpoint, '/scmPullRequests/pr-12');
    return { data: { id: 'pr-12', type: 'scmPullRequests', attributes: { sourceBranchName: 'feature/closed' } } };
  };
  assert.equal((await asc.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'pr-workflow' })).sourceBranch, 'feature/closed');
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

test('shared source lookups and another workflow do not request recovery metadata', async () => {
  const asc = api(); asc.loadCIBuildRuns = async () => [record()];
  asc.request = async () => assert.fail('shared or unrelated lookup must not fetch recovery metadata');
  assert.equal((await asc.getBuildSource('build-603', '603')).sourceBranch, null);
  assert.equal((await asc.getBuildSource('build-603', '603', null, { recoverSourceBranchForWorkflow: 'other-workflow' })).sourceBranch, null);
});

test('completion-context recovery is restricted to the configured workflow', async () => {
  const asc = api(); let sourceRequests = 0;
  asc.request = async endpoint => {
    if (endpoint === '/scmGitReferences/deleted-ref') { sourceRequests += 1; return deletedRef(); }
    if (endpoint.includes('/builds?')) return { data: [{ id: 'build-603', attributes: { version: '603', processingState: 'VALID' } }] };
    return { data: { ...record().run, relationships: { ...record().run.relationships, workflow: { data: { id: 'pr-workflow' } } } } };
  };
  assert.equal((await asc.getBuildRunNotesContext('run-603')).branch, null);
  assert.equal((await asc.getBuildRunNotesContext('run-603', { recoverSourceBranchForWorkflow: 'other-workflow' })).branch, null);
  assert.equal(sourceRequests, 0);
  assert.equal((await asc.getBuildRunNotesContext('run-603', { recoverSourceBranchForWorkflow: 'pr-workflow' })).branch, 'codex/merged');
  assert.equal(sourceRequests, 1);
});

test('a failed source-history request cannot poison the cached source history', async () => {
  const asc = api(); let first = true;
  asc.getConfiguredCIProducts = async () => [{ id: 'app-product' }];
  asc.getWorkflows = async () => [{ id: 'workflow-1' }, { id: 'workflow-2' }];
  asc.getBuildRuns = async id => {
    if (id === 'workflow-2' && first) { first = false; throw new Error('temporary failure'); }
    return { data: [{ id: `${id}-run` }] };
  };
  await assert.rejects(asc.loadCIBuildRuns(), /temporary failure/);
  assert.equal((await asc.loadCIBuildRuns()).length, 2);
});
