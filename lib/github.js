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
    return this.getBranchHead(this.productionBranch);
  }

  getBranchHead(branch) {
    try {
      return this.exec([
        'api', `repos/${this.repo}/commits/${encodeURIComponent(branch)}`,
        '--jq', '.sha'
      ]);
    } catch (e) {
      return null;
    }
  }

  getPullRequestHead(prNumber) {
    try {
      return this.exec([
        'pr', 'view', String(prNumber),
        '--repo', this.repo,
        '--json', 'headRefOid',
        '--jq', '.headRefOid',
      ]);
    } catch (e) {
      return null;
    }
  }

  findOpenPullRequestForCommit(commitSha, baseBranch, headBranch) {
    try {
      const result = this.exec([
        'pr', 'list',
        '--repo', this.repo,
        '--state', 'open',
        '--base', baseBranch,
        '--head', headBranch,
        '--json', 'number,headRefOid,headRefName,baseRefName',
      ]);
      const pulls = JSON.parse(result || '[]');
      const pull = pulls.find(candidate => (
        candidate.headRefOid === commitSha
        && candidate.headRefName === headBranch
        && candidate.baseRefName === baseBranch
      ));
      return pull ? {
        number: String(pull.number),
        headBranch: pull.headRefName,
        baseBranch: pull.baseRefName,
      } : null;
    } catch (e) {
      return null;
    }
  }

  findClosedPRForBuild(commitSha, baseBranch, headBranch) {
    try {
      if (!headBranch) {
        const commitResult = this.exec([
          'api',
          `repos/${this.repo}/commits/${commitSha}/pulls`,
          '-H', 'Accept: application/vnd.github+json',
        ]);
        const commitPulls = JSON.parse(commitResult || '[]');
        const matches = commitPulls.filter(candidate => (
          candidate.base?.ref === baseBranch
        ));

        // An exact commit may be associated with multiple PRs. Expire only
        // when one closed PR targeting the configured branch is unambiguous.
        if (matches.some(candidate => candidate.state?.toUpperCase() === 'OPEN')) return null;
        const closed = matches.filter(candidate => (
          candidate.state?.toUpperCase() === 'CLOSED'
        ));
        if (closed.length !== 1) return null;
        const [pull] = closed;
        return {
          number: pull.number,
          headBranch: pull.head?.ref || null,
          baseBranch: pull.base?.ref,
          mergedAt: pull.merged_at || null,
          closedAt: pull.closed_at || null,
        };
      }

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
        '--json', 'title,body'
      ]);
      return JSON.parse(result);
    } catch (e) {
      return null;
    }
  }

  getCommitSubject(commitSha) {
    try {
      return this.exec([
        'api', `repos/${this.repo}/commits/${commitSha}`,
        '--jq', '.commit.message | split("\\n")[0]',
      ]);
    } catch (e) {
      return null;
    }
  }

  getCommitSubjectsSince(publishedCommits, headCommit, candidateLimit = 20) {
    const candidates = publishedCommits
      .map(candidate => typeof candidate === 'string' ? candidate : candidate?.commitSha)
      .filter(commit => commit && commit !== headCommit)
      .slice(0, candidateLimit);

    for (const baseCommit of candidates) {
      try {
        const result = this.exec([
          'api', '--paginate', '--slurp',
          `repos/${this.repo}/compare/${baseCommit}...${headCommit}?per_page=100`,
        ]);
        const pages = JSON.parse(result || '[]');
        const status = pages[0]?.status;
        if (status !== 'ahead' && status !== 'identical') continue;
        const subjects = pages.flatMap(page => page.commits || [])
          .map(commit => commit.commit?.message?.split('\n')[0]?.trim())
          .filter(Boolean);
        return { baseCommit, subjects };
      } catch (e) {
        // A build from another PR branch will normally be divergent. Keep
        // searching older published builds for the newest ancestor.
      }
    }

    return null;
  }

  getPullRequestCommitSubjects(prNumber) {
    try {
      const result = this.exec([
        'api', '--paginate', '--slurp',
        `repos/${this.repo}/pulls/${prNumber}/commits?per_page=100`,
      ]);
      const pages = JSON.parse(result || '[]');
      return pages.flatMap(page => Array.isArray(page) ? page : [])
        .map(commit => commit.commit?.message?.split('\n')[0]?.trim())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  findPullRequestTitleForCommit(commitSha, baseBranch) {
    try {
      const result = this.exec([
        'api', `repos/${this.repo}/commits/${commitSha}/pulls`,
        '-H', 'Accept: application/vnd.github+json',
      ]);
      const pulls = JSON.parse(result || '[]');
      const pull = pulls.find(candidate => !baseBranch || candidate.base?.ref === baseBranch) || pulls[0];
      return pull?.title || null;
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
