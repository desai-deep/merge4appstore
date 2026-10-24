import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rebaseBetaBranch } from '../lib/rebase-beta.js';

async function fixture(t, { conflict = false, diverged = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beta-rebase-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const git = (args, cwd = work) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git(['init', '--bare', remote], root);
  git(['clone', remote, work], root);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['checkout', '-b', 'main']);
  await fs.writeFile(path.join(work, 'shared'), 'original\n');
  git(['add', '.']); git(['commit', '-m', 'base']);
  git(['branch', 'develop']);
  await fs.writeFile(path.join(work, 'shared'), 'hotfix\n');
  git(['commit', '-am', 'hotfix']);
  git(['checkout', 'develop']);
  if (diverged) {
    await fs.writeFile(path.join(work, conflict ? 'shared' : 'feature'), 'feature\n');
    git(['add', '.']); git(['commit', '-m', 'feature']);
  }
  git(['push', 'origin', 'main', 'develop']);
  const issues = [];
  const github = {
    repo: 'example/ios', refreshEnvironment: async () => process.env,
    upsertIssue: (...args) => { issues.push(args); return { number: 1 }; },
  };
  const rebase = (dryRun = false, extra = {}) => rebaseBetaBranch(github, 'main', 'develop', dryRun, () => {}, { remoteUrl: remote, ...extra });
  const tip = branch => git(['rev-parse', `refs/heads/${branch}`], remote);
  return { git, remote, work, github, issues, rebase, tip };
}

test('rebases diverged beta onto production, preserving the feature and hotfix', async t => {
  const f = await fixture(t);
  const main = f.tip('main');
  assert.deepEqual(await f.rebase(), { action: 'rebased' });
  assert.equal(f.tip('main'), main);
  assert.equal(f.git(['show', 'develop:shared'], f.remote), 'hotfix');
  assert.equal(f.git(['show', 'develop:feature'], f.remote), 'feature');
  assert.equal(f.git(['merge-base', 'main', 'develop'], f.remote), main);
  assert.deepEqual(await f.rebase(), { action: 'noop' });
});

test('fast-forwards beta when only production advanced', async t => {
  const f = await fixture(t, { diverged: false });
  assert.deepEqual(await f.rebase(), { action: 'rebased' });
  assert.equal(f.tip('main'), f.tip('develop'));
});

test('conflicts leave both remote branches untouched and publish an actionable issue', async t => {
  const f = await fixture(t, { conflict: true });
  const before = [f.tip('main'), f.tip('develop')];
  assert.deepEqual(await f.rebase(), { action: 'conflicted' });
  assert.deepEqual([f.tip('main'), f.tip('develop')], before);
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0][2], /shared/);
});

test('dry run neither pushes nor reports conflict issues', async t => {
  for (const conflict of [false, true]) {
    const f = await fixture(t, { conflict });
    const before = f.tip('develop');
    assert.deepEqual(await f.rebase(true), { action: conflict ? 'conflicted' : 'would_rebase' });
    assert.equal(f.tip('develop'), before);
    assert.deepEqual(f.issues, []);
  }
});

test('a concurrent beta push rejects the lease and preserves the new work', async t => {
  const f = await fixture(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  let concurrent;
  await assert.rejects(f.rebase(false, {
    runGit: async (command, args, options) => {
      if (args.includes('push')) {
        await fs.writeFile(path.join(f.work, 'concurrent'), 'another change\n');
        f.git(['add', '.']); f.git(['commit', '-m', 'concurrent']);
        f.git(['push', 'origin', 'develop']);
        concurrent = f.tip('develop');
      }
      return run(command, args, options);
    },
  }), /stale info/);
  assert.equal(f.tip('develop'), concurrent);
});

test('failure to report conflicts remains retryable', async t => {
  const f = await fixture(t, { conflict: true });
  f.github.upsertIssue = () => false;
  await assert.rejects(f.rebase(), /Could not report/);
});

test('preserves merge topology while replaying development commits', async t => {
  const f = await fixture(t);
  f.git(['checkout', '-b', 'feature-branch']);
  await fs.writeFile(path.join(f.work, 'second-feature'), 'second feature\n');
  f.git(['add', '.']); f.git(['commit', '-m', 'second feature']);
  f.git(['checkout', 'develop']);
  f.git(['merge', '--no-ff', 'feature-branch', '-m', 'Merge feature']);
  f.git(['push', 'origin', 'develop']);
  assert.deepEqual(await f.rebase(), { action: 'rebased' });
  assert.equal(f.git(['rev-list', '--count', '--merges', 'main..develop'], f.remote), '1');
  assert.equal(f.git(['show', 'develop:second-feature'], f.remote), 'second feature');
});

test('cleans up the isolated checkout when a push is rejected', async t => {
  const f = await fixture(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  let checkout;
  await assert.rejects(f.rebase(false, {
    runGit: async (command, args, options) => {
      checkout = options.cwd;
      if (args.includes('push')) throw new Error('Branch protection rejected push');
      return run(command, args, options);
    },
  }), /Branch protection/);
  await assert.rejects(fs.stat(checkout), { code: 'ENOENT' });
});

test('closes a previous conflict issue after the branches are synchronized', async t => {
  const f = await fixture(t);
  const closed = [];
  f.github.closeIssueByMarker = (...args) => closed.push(args);
  await f.rebase();
  await f.rebase();
  assert.equal(closed.length, 2);
  assert.match(closed[0][0], /beta-rebase:develop/);
});
