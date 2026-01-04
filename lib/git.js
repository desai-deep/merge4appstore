import { execSync } from 'child_process';

export class GitOperations {
  constructor(repoPath) {
    this.repoPath = repoPath;
  }

  exec(command) {
    return execSync(command, {
      cwd: this.repoPath,
      encoding: 'utf8',
      timeout: 60000,
    }).trim();
  }

  fetch() {
    this.exec('git fetch origin main develop --tags --force');
  }

  tagExists(tagName) {
    try {
      this.exec(`git rev-parse ${tagName}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  commitExists(commitSha) {
    try {
      this.exec(`git cat-file -e ${commitSha}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  resolveRef(ref) {
    try {
      return this.exec(`git rev-parse ${ref}`);
    } catch (e) {
      try {
        return this.exec(`git rev-parse origin/${ref}`);
      } catch (e2) {
        return null;
      }
    }
  }

  getCommitMessage(commitSha) {
    try {
      return this.exec(`git log -1 --pretty=%s ${commitSha}`);
    } catch (e) {
      return '';
    }
  }

  createTag(tagName, commitSha, message) {
    this.exec(`git tag -a "${tagName}" ${commitSha} -m "${message.replace(/"/g, '\\"')}"`);
  }

  pushTag(tagName) {
    this.exec(`git push origin ${tagName}`);
  }
}
