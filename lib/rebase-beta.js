import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { githubProcessEnvironment } from './github-process-environment.js';

const run = promisify(execFile);

// Use an isolated checkout: the persistent mirror is read-only repository data.
export async function rebaseBetaBranch(github, productionBranch, betaBranch, dryRun = false, logger = () => {}, {
  remoteUrl = `https://github.com/${github.repo}.git`,
  runGit = run,
} = {}) {
  if (productionBranch === betaBranch) throw new Error('Production and beta branches must differ');
  const issueMarker = `<!-- merge4appstore:beta-rebase:${betaBranch} -->`;
  const closeResolvedIssue = async () => {
    if (dryRun || !github.closeIssueByMarker) return;
    try {
      await github.refreshEnvironment();
      github.closeIssueByMarker(issueMarker, `\`${betaBranch}\` now contains \`${productionBranch}\`.`);
    } catch (error) {
      logger(`Warning: could not close the beta rebase issue: ${error.message}`);
    }
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'merge4appstore-rebase-'));
  const git = async args => {
    const environment = await github.refreshEnvironment();
    const { stdout } = await runGit('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      '-c', 'credential.https://github.com.useHttpPath=true',
      ...args,
    ], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120_000,
      signal: github.signal || undefined,
      env: {
        ...githubProcessEnvironment(environment),
        GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true',
        GIT_AUTHOR_NAME: 'merge4appstore', GIT_AUTHOR_EMAIL: 'bot@merge4appstore.local',
        GIT_COMMITTER_NAME: 'merge4appstore', GIT_COMMITTER_EMAIL: 'bot@merge4appstore.local',
      },
    });
    return stdout.trim();
  };
  try {
    await git(['init', '--template=']);
    await git(['check-ref-format', `refs/heads/${productionBranch}`]);
    await git(['check-ref-format', `refs/heads/${betaBranch}`]);
    await git(['remote', 'add', 'origin', remoteUrl]);
    await git(['fetch', '--no-tags', 'origin',
      `refs/heads/${productionBranch}:refs/remotes/origin/production`,
      `refs/heads/${betaBranch}:refs/remotes/origin/beta`,
    ]);
    const production = await git(['rev-parse', 'refs/remotes/origin/production']);
    const beta = await git(['rev-parse', 'refs/remotes/origin/beta']);
    const base = await git(['merge-base', production, beta]);
    if (base === production) {
      logger(`${betaBranch} already contains ${productionBranch}`);
      await closeResolvedIssue();
      return { action: 'noop' };
    }
    await git(['checkout', '--detach', beta]);
    try {
      await git(['-c', 'commit.gpgSign=false', 'rebase', '--rebase-merges', production]);
    } catch (error) {
      // Only content conflicts are handled here; infrastructure errors must retry.
      const conflicts = await git(['diff', '--name-only', '--diff-filter=U']);
      if (!conflicts) throw error;
      logger(`Cannot rebase ${betaBranch} onto ${productionBranch}: resolve conflicts manually`);
      if (!dryRun) {
        await github.refreshEnvironment();
        const issue = github.upsertIssue(
          issueMarker,
          `Rebase ${betaBranch} onto ${productionBranch}`,
          `Automatic rebasing found conflicts. The remote branch was left unchanged. Rebase \`${betaBranch}\` onto \`${productionBranch}\` manually and resolve the conflicts.\n\nConflicted files:\n\n\`\`\`\n${conflicts}\n\`\`\``,
        );
        if (!issue) throw new Error('Could not report beta branch rebase conflicts');
      }
      return { action: 'conflicted' };
    }
    if (dryRun) {
      logger(`Would push ${betaBranch} rebased onto ${productionBranch}`);
      return { action: 'would_rebase' };
    }
    // Never overwrite work pushed while the rebase was running.
    await git(['push', `--force-with-lease=refs/heads/${betaBranch}:${beta}`, 'origin', `HEAD:refs/heads/${betaBranch}`]);
    logger(`Rebased ${betaBranch} onto ${productionBranch}`);
    await closeResolvedIssue();
    return { action: 'rebased' };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
