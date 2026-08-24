import { execFileSync } from 'child_process';

export class GitHubAPI {
  constructor(repoOwner, repoName, productionBranch = 'main') {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.repo = `${repoOwner}/${repoName}`;
    this.productionBranch = productionBranch;
  }

  findPRFromCommit(commitSha) {
    try {
      const result = execFileSync('gh', [
        'pr', 'list',
        '--repo', this.repo,
        '--state', 'merged',
        '--base', this.productionBranch,
        '--json', 'number,mergeCommit',
        '--jq', `.[] | select(.mergeCommit.oid == "${commitSha}") | .number`
      ], { encoding: 'utf8', timeout: 30000 }).trim();

      if (result) {
        return result.split('\n')[0];
      }
    } catch (e) {
      // Fallback: try to extract from commit message
      try {
        const commitMsg = execFileSync('gh', [
          'api', `repos/${this.repo}/commits/${commitSha}`,
          '--jq', '.commit.message'
        ], { encoding: 'utf8', timeout: 30000 }).trim();

        const match = commitMsg.match(/\(#(\d+)\)/);
        if (match) return match[1];

        const mergeMatch = commitMsg.match(/pull request #(\d+)/);
        if (mergeMatch) return mergeMatch[1];
      } catch (e2) {
        // Ignore
      }
    }

    return null;
  }

  getPRDetails(prNumber) {
    try {
      const result = execFileSync('gh', [
        'pr', 'view', String(prNumber),
        '--repo', this.repo,
        '--json', 'title'
      ], { encoding: 'utf8', timeout: 30000 });
      return JSON.parse(result);
    } catch (e) {
      return null;
    }
  }

  extractReleaseNotes(prDetails = {}) {
    return prDetails.title || 'Bug fixes and improvements';
  }

  addPRComment(prNumber, comment) {
    try {
      execFileSync('gh', [
        'pr', 'comment', String(prNumber),
        '--repo', this.repo,
        '--body', comment
      ], { encoding: 'utf8', timeout: 30000 });
      return true;
    } catch (e) {
      return false;
    }
  }
}
