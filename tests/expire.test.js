import test from 'node:test';
import assert from 'node:assert/strict';

import { runMergedBuildExpiry } from '../lib/expire.js';

async function withBranches(fn) {
  const previousBeta = process.env.BETA_BRANCH;
  const previousProduction = process.env.PRODUCTION_BRANCH;
  process.env.BETA_BRANCH = 'develop';
  process.env.PRODUCTION_BRANCH = 'main';
  try {
    await fn();
  } finally {
    if (previousBeta === undefined) delete process.env.BETA_BRANCH;
    else process.env.BETA_BRANCH = previousBeta;
    if (previousProduction === undefined) delete process.env.PRODUCTION_BRANCH;
    else process.env.PRODUCTION_BRANCH = previousProduction;
  }
}

test('dry run reports merged feature builds without expiring them', async () => {
  await withBranches(async () => {
    let expireCalls = 0;
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'build-101', buildNumber: '101', version: '2.4' },
      ]),
      getBuildSource: async () => ({
        found: true,
        commitSha: 'abc123',
        sourceBranch: 'feature/player',
      }),
      expireBuild: async () => { expireCalls += 1; },
    };
    const github = {
      findMergedPRForCommit: () => ({ number: 41, headBranch: 'feature/player' }),
    };

    const result = await runMergedBuildExpiry(asc, github, true);

    assert.deepEqual(result, { checked: 1, expired: 1 });
    assert.equal(expireCalls, 0);
  });
});

test('expires builds from feature branches merged to develop', async () => {
  await withBranches(async () => {
    const expiredBuilds = [];
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'build-101', buildNumber: '101', version: '2.4' },
      ]),
      getBuildSource: async () => ({
        found: true,
        commitSha: 'abc123',
        sourceBranch: 'feature/player',
      }),
      expireBuild: async buildId => { expiredBuilds.push(buildId); },
    };
    const github = {
      findMergedPRForCommit: () => ({ number: 41, headBranch: 'feature/player' }),
    };

    const result = await runMergedBuildExpiry(asc, github, false);

    assert.deepEqual(result, { checked: 1, expired: 1 });
    assert.deepEqual(expiredBuilds, ['build-101']);
  });
});

test('keeps protected branch builds and builds without a merged PR', async () => {
  await withBranches(async () => {
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'develop-build', buildNumber: '101', version: '2.4' },
        { buildId: 'open-build', buildNumber: '102', version: '2.4' },
      ]),
      getBuildSource: async buildId => ({
        found: true,
        commitSha: buildId,
        sourceBranch: buildId === 'develop-build' ? 'develop' : 'feature/open',
      }),
      expireBuild: async () => assert.fail('no build should be expired'),
    };
    const github = { findMergedPRForCommit: () => null };

    assert.deepEqual(await runMergedBuildExpiry(asc, github, false), {
      checked: 2,
      expired: 0,
    });
  });
});
