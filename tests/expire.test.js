import test from 'node:test';
import assert from 'node:assert/strict';

import { runClosedPRBuildExpiry } from '../lib/expire.js';

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
      findClosedPRForBuild: () => ({ number: 41, headBranch: 'feature/player', mergedAt: '2026-08-21T10:00:00Z' }),
    };

    const result = await runClosedPRBuildExpiry(asc, github, true);

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
      findClosedPRForBuild: () => ({ number: 41, headBranch: 'feature/player', mergedAt: '2026-08-21T10:00:00Z' }),
    };

    const result = await runClosedPRBuildExpiry(asc, github, false);

    assert.deepEqual(result, { checked: 1, expired: 1 });
    assert.deepEqual(expiredBuilds, ['build-101']);
  });
});

test('expires builds from PRs closed without merging', async () => {
  await withBranches(async () => {
    const expiredBuilds = [];
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'build-102', buildNumber: '102', version: '2.4' },
      ]),
      getBuildSource: async () => ({
        found: true,
        commitSha: 'def456',
        sourceBranch: 'feature/abandoned',
      }),
      expireBuild: async buildId => { expiredBuilds.push(buildId); },
    };
    const github = {
      findClosedPRForBuild: () => ({ number: 42, headBranch: 'feature/abandoned', mergedAt: null }),
    };

    assert.deepEqual(await runClosedPRBuildExpiry(asc, github, false), {
      checked: 1,
      expired: 1,
    });
    assert.deepEqual(expiredBuilds, ['build-102']);
  });
});

test('keeps protected branch builds and builds without a closed PR', async () => {
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
    const github = { findClosedPRForBuild: () => null };

    assert.deepEqual(await runClosedPRBuildExpiry(asc, github, false), {
      checked: 2,
      expired: 0,
    });
  });
});
