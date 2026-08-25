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

  findMergedPRForCommit(commitSha, baseBranch, headBranch = null) {
    try {
      const result = this.exec([
        'api',
        `repos/${this.repo}/commits/${commitSha}/pulls`,
        '-H', 'Accept: application/vnd.github+json',
      ]);
      const pulls = JSON.parse(result || '[]');
      const matches = pulls.filter(candidate => (
        candidate.merged_at
        && candidate.base?.ref === baseBranch
        && (!headBranch || candidate.head?.ref === headBranch)
      ));

      if (matches.length !== 1) return null;
      const [pull] = matches;

      return {
        number: pull.number,
        headBranch: pull.head?.ref || null,
        baseBranch: pull.base?.ref || null,
        mergedAt: pull.merged_at,
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
