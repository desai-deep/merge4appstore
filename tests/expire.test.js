import test from 'node:test';
import assert from 'node:assert/strict';

import { runClosedPRBuildExpiry, runPublishedBetaBuildExpiry } from '../lib/expire.js';

test('expires published release-branch builds but keeps the next beta version', async () => {
  const expiredBuilds = [];
  const asc = {
    getTestFlightCleanupCandidates: async () => ([
      { buildId: 'old-beta', buildNumber: '1401', version: '1.4' },
      { buildId: 'live-beta', buildNumber: '1501', version: '1.5' },
      { buildId: 'next-beta', buildNumber: '1601', version: '1.6' },
      { buildId: 'feature-build', buildNumber: '1502', version: '1.5' },
    ]),
    getBuildSource: async buildId => ({
      found: true,
      commitSha: buildId,
      sourceBranch: buildId === 'feature-build' ? 'feature/player' : 'develop',
      workflowId: buildId === 'feature-build' ? 'pr-workflow' : 'beta-workflow',
      workflowName: buildId === 'feature-build' ? 'Pull Requests' : 'Make Beta',
    }),
    expireBuild: async buildId => { expiredBuilds.push(buildId); },
  };

  assert.deepEqual(await runPublishedBetaBuildExpiry(asc, false, {
    liveVersion: '1.5',
    workflowId: 'beta-workflow',
    betaBranch: 'develop',
  }), { checked: 3, expired: 2 });
  assert.deepEqual(expiredBuilds, ['old-beta', 'live-beta']);
});

test('uses the exact beta workflow when Apple omits source branch metadata', async () => {
  const expiredBuilds = [];
  const asc = {
    getTestFlightCleanupCandidates: async () => ([
      { buildId: 'source-less-beta', buildNumber: '1501', version: '1.5.0' },
    ]),
    getBuildSource: async () => ({
      found: true,
      commitSha: 'abc123',
      sourceBranch: null,
      workflowId: 'beta-workflow',
      workflowName: 'Make Beta',
    }),
    expireBuild: async buildId => { expiredBuilds.push(buildId); },
  };

  assert.deepEqual(await runPublishedBetaBuildExpiry(asc, false, {
    liveVersion: '1.5',
    workflowId: 'beta-workflow',
    betaBranch: 'develop',
  }), { checked: 1, expired: 1 });
  assert.deepEqual(expiredBuilds, ['source-less-beta']);
});

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

async function withExpiryWorkflow(workflowId, fn) {
  const previous = process.env.EXPIRE_XCODE_WORKFLOW_ID;
  process.env.EXPIRE_XCODE_WORKFLOW_ID = workflowId;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.EXPIRE_XCODE_WORKFLOW_ID;
    else process.env.EXPIRE_XCODE_WORKFLOW_ID = previous;
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
      findClosedPRForBuild: (commit, base, head) => {
        assert.deepEqual([commit, base, head], ['abc123', null, 'feature/player']);
        return { number: 41, headBranch: 'feature/player', mergedAt: '2026-08-21T10:00:00Z' };
      },
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

test('expires only builds from the configured pull-request workflow', async () => {
  await withBranches(async () => withExpiryWorkflow('pr-workflow', async () => {
    const expiredBuilds = [];
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'pr-build', buildNumber: '201', version: '3.0' },
        { buildId: 'beta-build', buildNumber: '202', version: '3.0' },
      ]),
      getBuildSource: async buildId => ({
        found: true,
        commitSha: buildId,
        sourceBranch: 'feature/closed',
        workflowId: buildId === 'pr-build' ? 'pr-workflow' : 'beta-workflow',
        workflowName: buildId === 'pr-build' ? 'Pull Requests' : 'Public Beta',
      }),
      expireBuild: async buildId => { expiredBuilds.push(buildId); },
    };
    const github = {
      findClosedPRForBuild: () => ({ number: 51, mergedAt: '2026-08-25T10:00:00Z' }),
    };

    assert.deepEqual(await runClosedPRBuildExpiry(asc, github, false), {
      checked: 2,
      expired: 1,
    });
    assert.deepEqual(expiredBuilds, ['pr-build']);
  }));
});

test('expires a PR-workflow build by exact commit when Apple omits its source branch', async () => {
  await withBranches(async () => withExpiryWorkflow('pr-workflow', async () => {
    const expiredBuilds = [];
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'source-less', buildNumber: '556', version: '1.1' },
      ]),
      getBuildSource: async () => ({
        found: true,
        commitSha: 'abc123',
        sourceBranch: null,
        workflowId: 'pr-workflow',
        workflowName: 'Pull Requests',
      }),
      expireBuild: async buildId => { expiredBuilds.push(buildId); },
    };
    const github = {
      findClosedPRForBuild: (commit, base, head) => {
        assert.deepEqual([commit, base, head], ['abc123', null, null]);
        return { number: 131, headBranch: 'codex/thin-xcode-cloud-ci', mergedAt: '2026-08-27T20:08:08Z' };
      },
    };

    assert.deepEqual(await runClosedPRBuildExpiry(asc, github, false), {
      checked: 1,
      expired: 1,
    });
    assert.deepEqual(expiredBuilds, ['source-less']);
  }));
});

test('keeps a source-less build outside the configured PR workflow', async () => {
  await withBranches(async () => withExpiryWorkflow('pr-workflow', async () => {
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'beta-build', buildNumber: '1688', version: '1.1' },
      ]),
      getBuildSource: async () => ({
        found: true,
        commitSha: 'abc123',
        sourceBranch: null,
        workflowId: 'beta-workflow',
        workflowName: 'Public Beta',
      }),
      expireBuild: async () => assert.fail('beta build must remain protected'),
    };
    const github = {
      findClosedPRForBuild: () => assert.fail('wrong-workflow build must not query a PR'),
    };

    assert.deepEqual(await runClosedPRBuildExpiry(asc, github, false), {
      checked: 1,
      expired: 0,
    });
  }));
});

test('keeps a source-less build when no exact PR workflow is configured', async () => {
  await withBranches(async () => withExpiryWorkflow('', async () => {
    const asc = {
      getTestFlightCleanupCandidates: async () => ([
        { buildId: 'source-less', buildNumber: '556', version: '1.1' },
      ]),
      getBuildSource: async () => ({
        found: true,
        commitSha: 'abc123',
        sourceBranch: null,
        workflowId: 'unknown-workflow',
      }),
      expireBuild: async () => assert.fail('source-less build must remain protected'),
    };
    const github = {
      findClosedPRForBuild: () => assert.fail('unsafe source-less fallback must not query a PR'),
    };

    assert.deepEqual(await runClosedPRBuildExpiry(asc, github, false), {
      checked: 1,
      expired: 0,
    });
  }));
});

test('PR-close expiry only looks up the affected branch and requires the same PR', async () => {
  await withBranches(async () => {
    const lookedUp = [];
    const expired = [];
    const asc = {
      getTestFlightCleanupCandidates: async () => ['ours', 'unrelated', 'reused'].map(buildId => ({ buildId })),
      getBuildSource: async id => ({ found: true, commitSha: id, sourceBranch: id === 'unrelated' ? 'other' : 'feature' }),
      expireBuild: async id => expired.push(id),
    };
    const github = { findClosedPRForBuild: (commit, _base, _branch, options) => {
      assert.equal(options.strict, true);
      lookedUp.push(commit);
      return { number: commit === 'ours' ? 42 : 43 };
    } };
    await runClosedPRBuildExpiry(asc, github, false, { branch: 'feature', pullRequest: '42' });
    assert.deepEqual(lookedUp, ['ours', 'reused']);
    assert.deepEqual(expired, ['ours']);
  });
});

test('late completed build uses exact run uploads and current PR state, including dry run', async () => {
  await withExpiryWorkflow('pr-workflow', async () => {
    const expired = [];
    let closed = false;
    const asc = {
      getBuildRunNotesContext: async () => ({
        workflowId: 'pr-workflow', completionStatus: 'SUCCEEDED', commitSha: 'abc', branch: 'feature',
        builds: [{ buildId: 'late', processingState: 'VALID' }],
      }),
      getTestFlightCleanupCandidates: async options => {
        assert.deepEqual(options, { buildIds: ['late'] });
        return [{ buildId: 'late' }];
      },
      getBuildSource: async () => { throw new Error('must not scan workflow history'); },
      expireBuild: async id => expired.push(id),
    };
    const github = { findClosedPRForBuild: () => closed ? { number: 42 } : null };
    assert.equal((await runClosedPRBuildExpiry(asc, github, false, { runId: 'run' })).expired, 0);
    closed = true;
    assert.equal((await runClosedPRBuildExpiry(asc, github, true, { runId: 'run' })).expired, 1);
    assert.deepEqual(expired, []);
    await runClosedPRBuildExpiry(asc, github, false, { runId: 'run' });
    assert.deepEqual(expired, ['late']);
  });
});

test('late-build expiry retries unavailable uploads and rejects another workflow', async () => {
  await withExpiryWorkflow('pr-workflow', async () => {
    for (const run of [
      { workflowId: 'wrong', completionStatus: 'SUCCEEDED', commitSha: 'abc', builds: [{ processingState: 'VALID' }] },
      { workflowId: 'pr-workflow', completionStatus: 'SUCCEEDED', commitSha: 'abc', builds: [] },
      { workflowId: 'pr-workflow', completionStatus: 'SUCCEEDED', commitSha: 'abc', builds: [{ processingState: 'PROCESSING' }] },
    ]) {
      const asc = {
        getBuildRunNotesContext: async () => run,
        getTestFlightCleanupCandidates: async () => assert.fail('must not scan unrelated builds'),
      };
      await assert.rejects(runClosedPRBuildExpiry(asc, {}, false, { runId: 'run' }), /Expiry run/);
    }
  });
});

test('GitHub failure fails expiry so the durable delivery retries instead of acknowledging a no-op', async () => {
  const asc = {
    getTestFlightCleanupCandidates: async () => [{ buildId: 'b' }],
    getBuildSource: async () => ({ found: true, commitSha: 'abc', sourceBranch: 'feature' }),
    expireBuild: async () => assert.fail('must not expire on GitHub failure'),
  };
  await assert.rejects(runClosedPRBuildExpiry(asc, {
    findClosedPRForBuild: () => { throw new Error('GitHub unavailable'); },
  }, false), /GitHub unavailable/);
});
