import { execFileSync } from 'child_process';

export class GitHubAPI {
  constructor(repoOwner, repoName, productionBranch = 'main') {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.repo = `${repoOwner}/${repoName}`;
    this.productionBranch = productionBranch;
  }

  exec(args) {
    return execFileSync('gh', args, { encoding: 'utf8', timeout: 30000 }).trim();
  }

  findPRFromCommit(commitSha) {
    try {
      const result = this.exec([
        'pr', 'list',
        '--repo', this.repo,
        '--state', 'merged',
        '--base', this.productionBranch,
        '--json', 'number,mergeCommit',
        '--jq', `.[] | select(.mergeCommit.oid == "${commitSha}") | .number`
      ]);

      if (result) {
        return result.split('\n')[0];
      }
    } catch (e) {
      // Fallback: try to extract from commit message
      try {
        const commitMsg = this.exec([
          'api', `repos/${this.repo}/commits/${commitSha}`,
          '--jq', '.commit.message'
        ]);

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

  getProductionHead() {
    try {
      return this.exec([
        'api', `repos/${this.repo}/commits/${this.productionBranch}`,
        '--jq', '.sha'
      ]);
    } catch (e) {
      return null;
    }
  }

  findClosedPRForBuild(commitSha, baseBranch, headBranch) {
    try {
      const result = this.exec([
        'pr', 'list',
        '--repo', this.repo,
        '--state', 'all',
        '--base', baseBranch,
        '--head', headBranch,
        '--json', 'number,state,closedAt,mergedAt,headRefName,baseRefName',
      ]);
      const pulls = JSON.parse(result || '[]');
      const matches = pulls.filter(candidate => (
        candidate.baseRefName === baseBranch
        && candidate.headRefName === headBranch
      ));

      // A reused branch with a currently open PR may contain newer builds.
      if (matches.some(candidate => candidate.state === 'OPEN')) return null;

      const closed = matches.filter(candidate => (
        candidate.state === 'CLOSED' || candidate.state === 'MERGED'
      ));
      if (closed.length === 0) return null;

      let pull;
      if (closed.length === 1) {
        [pull] = closed;
      } else {
        // If a branch name was reused, require GitHub's commit association to
        // identify one closed PR. Otherwise the build is ambiguous and stays.
        const commitResult = this.exec([
          'api',
          `repos/${this.repo}/commits/${commitSha}/pulls`,
          '-H', 'Accept: application/vnd.github+json',
        ]);
        const commitPulls = JSON.parse(commitResult || '[]');
        const closedNumbers = new Set(closed.map(candidate => candidate.number));
        const commitMatches = commitPulls.filter(candidate => closedNumbers.has(candidate.number));
        if (commitMatches.length !== 1) return null;
        const number = commitMatches[0].number;
        pull = closed.find(candidate => candidate.number === number);
      }

      return {
        number: pull.number,
        headBranch: pull.headRefName,
        baseBranch: pull.baseRefName,
        mergedAt: pull.mergedAt,
        closedAt: pull.closedAt,
      };
    } catch (e) {
      return null;
    }
  }

  getPRDetails(prNumber) {
    try {
      const result = this.exec([
        'pr', 'view', String(prNumber),
        '--repo', this.repo,
        '--json', 'title'
      ]);
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
      this.exec([
        'pr', 'comment', String(prNumber),
        '--repo', this.repo,
        '--body', comment
      ]);
      return true;
    } catch (e) {
      return false;
    }
  }
}
