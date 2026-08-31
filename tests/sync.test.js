import assert from 'node:assert/strict';
import test from 'node:test';

import { runReleaseSync } from '../lib/sync.js';

test('tags the commit attributed to the exact live App Store build id', async () => {
  let sourceArguments = null;
  let createdTag = null;
  const asc = {
    getLiveProductionBuild: async () => ({
      live: true,
      version: '1.2.3',
      buildNumber: '101',
      buildId: 'build-target',
    }),
    getBuildSource: async (...args) => {
      sourceArguments = args;
      return {
        found: true,
        commitSha: 'a'.repeat(40),
        workflowId: 'workflow-production',
        workflowName: 'Production',
      };
    },
  };
  const tags = {
    tagExists: () => false,
    commitExists: commitSha => commitSha === 'a'.repeat(40),
    getCommitMessage: () => 'Release commit',
    createTag: (...args) => { createdTag = args; },
  };
  const github = {
    findPRFromCommit: () => null,
  };

  await runReleaseSync(asc, tags, github, false, false);

  assert.deepEqual(sourceArguments, ['build-target', '101']);
  assert.deepEqual(createdTag, [
    'v1.2.3-101',
    'a'.repeat(40),
    'Production release: version 1.2.3, build 101',
  ]);
});

test('does not tag a number-only attribution from another workflow', async t => {
  process.env.XCODE_WORKFLOW_ID = 'workflow-production';
  t.after(() => delete process.env.XCODE_WORKFLOW_ID);
  let created = false;
  const asc = {
    getLiveProductionBuild: async () => ({
      live: true,
      version: '1.2.3',
      buildNumber: '101',
      buildId: 'build-target',
    }),
    getBuildSource: async () => ({
      found: true,
      commitSha: 'b'.repeat(40),
      workflowId: 'workflow-internal',
    }),
  };
  const tags = {
    tagExists: () => false,
    commitExists: () => true,
    createTag: () => { created = true; },
  };

  await runReleaseSync(asc, tags, { findPRFromCommit: () => null }, false, false);

  assert.equal(created, false);
});

test('records a live version before returning for an existing release tag', async () => {
  const releases = [];
  const asc = {
    getLiveProductionBuild: async () => ({
      live: true,
      version: '1.2.3',
      buildNumber: '101',
      buildId: 'build-target',
    }),
  };

  await runReleaseSync(
    asc,
    { tagExists: () => true },
    {},
    false,
    false,
    { onVersionReleased: details => releases.push(details) },
  );

  assert.deepEqual(releases, [{ version: '1.2.3', buildId: 'build-target' }]);
});
