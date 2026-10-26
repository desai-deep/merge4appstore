import test from 'node:test';
import assert from 'node:assert/strict';
import { runManagedBuildTrigger } from '../lib/trigger.js';

test('a queued trigger cannot build the wrong track after a PR retarget', async () => {
  const result = await runManagedBuildTrigger({ trigger: async () => { throw new Error('must not trigger'); } }, {
    getPullRequestHead: () => 'head', getPullRequestTarget: () => 'main',
  }, { purpose: 'pull_request', workflowId: 'uat', branch: 'fix', commitSha: 'head', pullRequest: '147', targetBranch: 'develop' });
  assert.deepEqual(result, { action: 'superseded', reason: 'target_changed' });
});
