import { execFileSync } from 'child_process';
import { githubProcessEnvironment } from './github-process-environment.js';

export class GitHubTags {
  constructor(repoOwner, repoName, {
    environment = process.env,
    environmentProvider = null,
    execFile = execFileSync,
  } = {}) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.repo = `${repoOwner}/${repoName}`;
    this.environment = githubProcessEnvironment(environment);
    this.environmentProvider = environmentProvider || (async () => ({ ...environment }));
    this.execFile = execFile;
  }

  async refreshEnvironment({ signal = null } = {}) {
    this.environment = githubProcessEnvironment(await this.environmentProvider({ signal }));
    return this.environment;
  }

  exec(args) {
    return this.execFile('gh', args, {
      encoding: 'utf8',
      timeout: 60000,
      env: this.environment,
    }).trim();
  }

  tagExists(tagName) {
    try {
      this.exec(['api', `repos/${this.repo}/git/refs/tags/${tagName}`, '--silent']);
      return true;
    } catch (e) {
      return false;
    }
  }

  commitExists(commitSha) {
    try {
      this.exec(['api', `repos/${this.repo}/commits/${commitSha}`, '--silent']);
      return true;
    } catch (e) {
      return false;
    }
  }

  getCommitMessage(commitSha) {
    try {
      const message = this.exec([
        'api', `repos/${this.repo}/commits/${commitSha}`,
        '--jq', '.commit.message'
      ]);
      return message.split('\n')[0];
    } catch (e) {
      return '';
    }
  }

  createTag(tagName, commitSha, message) {
    // Create annotated tag object
    const tagResponse = this.exec([
      'api', `repos/${this.repo}/git/tags`,
      '-f', `tag=${tagName}`,
      '-f', `message=${message}`,
      '-f', `object=${commitSha}`,
      '-f', 'type=commit',
      '--jq', '.sha'
    ]);
    const tagSha = tagResponse.trim();

    // Create the ref pointing to the tag
    this.exec([
      'api', `repos/${this.repo}/git/refs`,
      '-f', `ref=refs/tags/${tagName}`,
      '-f', `sha=${tagSha}`
    ]);
  }

  /**
   * Push an empty commit to a branch to trigger CI
   * @param {string} branch - Branch name (e.g., 'develop')
   * @param {string} message - Commit message
   * @param {string} repoPath - Local path to the repository
   */
  pushEmptyCommit(branch, message, repoPath) {
    const gitExec = (args) => this.execFile('git', args, {
      encoding: 'utf8',
      cwd: repoPath,
      timeout: 60000,
      env: this.environment,
    }).trim();

    // Fetch latest
    gitExec(['fetch', 'origin', branch]);

    // Checkout the branch
    gitExec(['checkout', branch]);

    // Pull latest changes
    gitExec(['pull', 'origin', branch]);

    // Create empty commit
    gitExec(['commit', '--allow-empty', '-m', message]);

    // Push
    gitExec(['push', 'origin', branch]);
  }
}
