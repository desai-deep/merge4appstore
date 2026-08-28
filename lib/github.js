import { execFileSync } from 'child_process';

export class GitHubAPI {
  constructor(repoOwner, repoName, productionBranch = 'main') {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.repo = `${repoOwner}/${repoName}`;
    this.productionBranch = productionBranch;
  }

  exec(args) {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30000,
      // GitHub blobs can approach 100 MiB, then grow by roughly one third when
      // base64 encoded inside JSON.
      maxBuffer: 150 * 1024 * 1024,
    }).trim();
  }

  getRepositoryFile(filePath, ref) {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const metadata = JSON.parse(this.exec([
      'api', `repos/${this.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    ]));
    if (metadata.type !== 'file' || !metadata.sha) {
      throw new Error(`${filePath} is not a repository file at ${ref}`);
    }

    const blob = JSON.parse(this.exec([
      'api', `repos/${this.repo}/git/blobs/${metadata.sha}`,
    ]));
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new Error(`GitHub returned unsupported encoding for ${filePath}`);
    }
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
  }

  getRepositoryTree(rootPath, ref) {
    const commit = JSON.parse(this.exec([
      'api', `repos/${this.repo}/commits/${encodeURIComponent(ref)}`,
    ]));
    const treeSha = commit.commit?.tree?.sha;
    if (!treeSha) throw new Error(`GitHub did not return a tree for ${ref}`);
    const tree = JSON.parse(this.exec([
      'api', `repos/${this.repo}/git/trees/${treeSha}?recursive=1`,
    ]));
    if (tree.truncated) {
      throw new Error(`GitHub truncated the repository tree for ${ref}`);
    }
    const root = rootPath.replace(/\/+$/, '');
    return (tree.tree || []).filter(entry => (
      entry.path === root || entry.path.startsWith(`${root}/`)
    ));
  }

  getRepositoryBlob(sha) {
    const blob = JSON.parse(this.exec([
      'api', `repos/${this.repo}/git/blobs/${sha}`,
    ]));
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new Error(`GitHub returned unsupported encoding for blob ${sha}`);
    }
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
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

  upsertPRComment(prNumber, marker, comment) {
    try {
      const result = this.exec([
        'api', '--paginate', '--slurp',
        `repos/${this.repo}/issues/${prNumber}/comments?per_page=100`,
      ]);
      const pages = JSON.parse(result || '[]');
      const comments = pages.flatMap(page => Array.isArray(page) ? page : []);
      const existing = comments.find(candidate => candidate.body?.includes(marker));

      if (existing) {
        this.exec([
          'api', '--method', 'PATCH',
          `repos/${this.repo}/issues/comments/${existing.id}`,
          '-f', `body=${comment}`,
        ]);
        return 'updated';
      }

      return this.addPRComment(prNumber, comment) ? 'created' : false;
    } catch (e) {
      return false;
    }
  }

  findIssueByMarker(marker) {
    const result = this.exec([
      'issue', 'list',
      '--repo', this.repo,
      '--state', 'all',
      '--limit', '1000',
      '--json', 'number,title,body,state,url',
    ]);
    const issues = JSON.parse(result || '[]');
    return issues.find(issue => issue.body?.includes(marker)) || null;
  }

  upsertIssue(marker, title, body) {
    try {
      const fullBody = `${marker}\n${body}`;
      const existing = this.findIssueByMarker(marker);
      if (existing) {
        const result = this.exec([
          'api', '--method', 'PATCH',
          `repos/${this.repo}/issues/${existing.number}`,
          '-f', `title=${title}`,
          '-f', `body=${fullBody}`,
          '-f', 'state=open',
        ]);
        const issue = JSON.parse(result || '{}');
        return {
          number: issue.number || existing.number,
          url: issue.html_url || existing.url,
          action: existing.state === 'CLOSED' ? 'reopened' : 'updated',
        };
      }

      const result = this.exec([
        'api', '--method', 'POST',
        `repos/${this.repo}/issues`,
        '-f', `title=${title}`,
        '-f', `body=${fullBody}`,
      ]);
      const issue = JSON.parse(result || '{}');
      if (!issue.number || !issue.html_url) return false;
      return { number: issue.number, url: issue.html_url, action: 'created' };
    } catch (e) {
      return false;
    }
  }

  closeIssueByMarker(marker, comment) {
    try {
      const existing = this.findIssueByMarker(marker);
      if (!existing || existing.state === 'CLOSED') return false;
      if (comment) {
        this.exec([
          'api', '--method', 'POST',
          `repos/${this.repo}/issues/${existing.number}/comments`,
          '-f', `body=${comment}`,
        ]);
      }
      this.exec([
        'api', '--method', 'PATCH',
        `repos/${this.repo}/issues/${existing.number}`,
        '-f', 'state=closed',
        '-f', 'state_reason=completed',
      ]);
      return { number: existing.number, url: existing.url };
    } catch (e) {
      return false;
    }
  }
}
