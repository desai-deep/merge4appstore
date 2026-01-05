import { execFileSync } from 'child_process';

export class GitHubTags {
  constructor(repoOwner, repoName) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.repo = `${repoOwner}/${repoName}`;
  }

  exec(args) {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 60000,
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
}
