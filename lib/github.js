import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

import { getGitMirror } from './git-mirror.js';

const execFileAsync = promisify(execFile);

export class GitHubAPI {
  constructor(repoOwner, repoName, productionBranch = 'main', {
    mirror,
    signal = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.repo = `${repoOwner}/${repoName}`;
    this.productionBranch = productionBranch;
    this.mirror = mirror === undefined ? getGitMirror(repoOwner, repoName) : mirror;
    this.signal = signal;
    this.fetchImpl = fetchImpl;
  }

  async requestJson(endpoint, { timeoutMs = 15_000 } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new Error('GitHub HTTP client is unavailable');
    const controller = new AbortController();
    const timeoutError = new Error(`GitHub request timed out after ${timeoutMs}ms`);
    timeoutError.name = 'TimeoutError';
    timeoutError.statusCode = 503;
    timeoutError.retryAfter = 5;
    const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    const onAbort = () => controller.abort(this.signal.reason);
    if (this.signal?.aborted) onAbort();
    else this.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const token = process.env.GH_TOKEN;
      const response = await this.fetchImpl(`https://api.github.com${endpoint}`, {
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'user-agent': 'merge4appstore',
          'x-github-api-version': '2022-11-28',
        },
      });
      const body = typeof response.text === 'function'
        ? await response.text()
        : JSON.stringify(await response.json());
      let data = null;
      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        // The bounded response excerpt below is sufficient diagnostics.
      }
      if (!response.ok) {
        const detail = typeof data?.message === 'string'
          ? data.message
          : body.slice(0, 500) || 'empty response';
        const error = new Error(`GitHub API ${response.status}: ${detail}`);
        error.statusCode = response.status;
        if (response.status === 429 || response.status >= 500) error.retryAfter = 5;
        throw error;
      }
      if (data === null) {
        const error = new Error('GitHub returned malformed JSON');
        error.statusCode = 503;
        error.retryAfter = 5;
        throw error;
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted && !this.signal?.aborted) throw timeoutError;
      if (error.name === 'TypeError' && /fetch|network/i.test(error.message)) {
        error.statusCode = 503;
        error.retryAfter = 5;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.signal?.removeEventListener('abort', onAbort);
    }
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

  async execAsync(args) {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      signal: this.signal || undefined,
    });
    return stdout.trim();
  }

  repositoryIssuesEnabled() {
    const value = this.exec([
      'api', `repos/${this.repo}`,
      '--jq', '.has_issues',
    ]);
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`GitHub did not report whether issues are enabled for ${this.repo}`);
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

  findPRFromCommit(commitSha, { strict = false } = {}) {
    let lookupError = null;
    try {
      const result = this.exec([
        'pr', 'list',
        '--repo', this.repo,
        '--state', 'merged',
        '--base', this.productionBranch,
        '--limit', '1000',
        '--json', 'number,mergeCommit',
        '--jq', `.[] | select(.mergeCommit.oid == "${commitSha}") | .number`
      ]);

      if (result) {
        return result.split('\n')[0];
      }
      return null;
    } catch (e) {
      lookupError = e;
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
        // The primary lookup below carries the more useful failure context.
      }
    }

    if (strict && lookupError) {
      lookupError.statusCode ||= 503;
      lookupError.retryAfter ||= 5;
      throw lookupError;
    }
    return null;
  }

  getProductionHead({ strict = false } = {}) {
    if (strict) {
      const commit = this.exec([
        'api', `repos/${this.repo}/commits/${encodeURIComponent(this.productionBranch)}`,
        '--jq', '.sha',
      ]);
      if (!commit) {
        const error = new Error(`GitHub did not return the head of ${this.productionBranch}`);
        error.statusCode = 503;
        error.retryAfter = 5;
        throw error;
      }
      return commit;
    }
    return this.getBranchHead(this.productionBranch);
  }

  async getProductionHeadAsync({ strict = false } = {}) {
    try {
      const commit = await this.requestJson(
        `/repos/${encodeURIComponent(this.repoOwner)}/${encodeURIComponent(this.repoName)}`
          + `/commits/${encodeURIComponent(this.productionBranch)}`,
      );
      if (typeof commit?.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(commit.sha)) {
        throw new Error(`GitHub did not return the head of ${this.productionBranch}`);
      }
      return commit.sha;
    } catch (error) {
      if (strict) {
        error.statusCode ||= 503;
        error.retryAfter ||= 5;
        throw error;
      }
      return null;
    }
  }

  async findPRFromCommitAsync(commitSha, { strict = false } = {}) {
    try {
      if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
        throw new Error('Commit SHA must be a full hexadecimal object ID');
      }
      const normalizedCommitSha = commitSha.toLowerCase();
      const pulls = await this.requestJson(
        `/repos/${encodeURIComponent(this.repoOwner)}/${encodeURIComponent(this.repoName)}`
          + `/commits/${encodeURIComponent(normalizedCommitSha)}/pulls?per_page=100`,
      );
      if (!Array.isArray(pulls)) throw new Error('GitHub did not return associated pull requests');
      const pull = pulls.find(candidate => (
        Number.isSafeInteger(candidate?.number)
        && candidate.number > 0
        && candidate.merged_at
        && typeof candidate.merge_commit_sha === 'string'
        && candidate.merge_commit_sha.toLowerCase() === normalizedCommitSha
        && candidate.base?.ref === this.productionBranch
      ));
      return pull ? String(pull.number) : null;
    } catch (error) {
      if (strict) {
        error.statusCode ||= 503;
        error.retryAfter ||= 5;
        throw error;
      }
      return null;
    }
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

  getBranchSnapshot(branch) {
    const result = JSON.parse(this.exec([
      'api', `repos/${this.repo}/commits/${encodeURIComponent(branch)}`,
    ]));
    if (!result.sha || !result.commit?.tree?.sha) {
      throw new Error(`GitHub did not return a commit and tree for ${branch}`);
    }
    return {
      sha: result.sha,
      treeSha: result.commit?.tree?.sha,
    };
  }

  compareBranches(baseBranch, headBranch) {
    const result = this.exec([
      'api', '--paginate', '--slurp',
      `repos/${this.repo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}?per_page=100`,
    ]);
    const pages = JSON.parse(result || '[]');
    return {
      status: pages[0]?.status || null,
      commits: pages.flatMap(page => page.commits || []).map(commit => ({
        sha: commit.sha,
        message: commit.commit?.message || '',
      })),
    };
  }

  listMergedPullRequests(baseBranch) {
    const result = this.exec([
      'pr', 'list',
      '--repo', this.repo,
      '--state', 'merged',
      '--base', baseBranch,
      '--limit', '1000',
      '--json', 'number,title,url,mergeCommit',
    ]);
    return JSON.parse(result || '[]');
  }

  listOpenPullRequests(baseBranch) {
    const result = this.exec([
      'pr', 'list',
      '--repo', this.repo,
      '--state', 'open',
      '--base', baseBranch,
      '--limit', '1000',
      '--json', 'number,url,id,headRefOid,mergeable,mergeStateStatus',
    ]);
    return JSON.parse(result || '[]');
  }

  rebasePullRequest(pullRequestId, expectedHeadOid) {
    const query = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
      updatePullRequestBranch(input: {
        pullRequestId: $pullRequestId
        expectedHeadOid: $expectedHeadOid
        updateMethod: REBASE
      }) {
        pullRequest { number url headRefOid }
      }
    }`;
    const result = JSON.parse(this.exec([
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `pullRequestId=${pullRequestId}`,
      '-f', `expectedHeadOid=${expectedHeadOid}`,
    ]) || '{}');
    const errors = Array.isArray(result.errors)
      ? result.errors.map(error => error?.message || JSON.stringify(error)).filter(Boolean)
      : [];
    if (errors.length > 0) {
      throw new Error(`GitHub could not rebase the pull request: ${errors.join('; ')}`);
    }
    const pull = result.data?.updatePullRequestBranch?.pullRequest;
    if (!pull?.number || !pull?.url) {
      throw new Error('GitHub did not return the rebased pull request');
    }
    return { number: pull.number, url: pull.url, headRefOid: pull.headRefOid };
  }

  findOpenPullRequest(baseBranch, headBranch) {
    const result = this.exec([
      'pr', 'list',
      '--repo', this.repo,
      '--state', 'open',
      '--base', baseBranch,
      '--head', headBranch,
      '--json', 'number,url',
    ]);
    return JSON.parse(result || '[]')[0] || null;
  }

  createPullRequest(baseBranch, headBranch, title, body) {
    const result = this.exec([
      'api', '--method', 'POST',
      `repos/${this.repo}/pulls`,
      '-f', `base=${baseBranch}`,
      '-f', `head=${headBranch}`,
      '-f', `title=${title}`,
      '-f', `body=${body}`,
    ]);
    const pull = JSON.parse(result || '{}');
    if (!pull.number || !pull.html_url) throw new Error('GitHub did not return the created pull request');
    return { number: pull.number, url: pull.html_url };
  }

  updatePullRequest(prNumber, body) {
    const result = this.exec([
      'api', '--method', 'PATCH',
      `repos/${this.repo}/pulls/${prNumber}`,
      '-f', `body=${body}`,
    ]);
    const pull = JSON.parse(result || '{}');
    if (!pull.number || !pull.html_url) throw new Error(`GitHub did not return updated pull request #${prNumber}`);
    return { number: pull.number, url: pull.html_url };
  }

  labelPullRequest(prNumber, { name, color, description }) {
    this.exec([
      'label', 'create', name,
      '--repo', this.repo,
      '--color', color,
      '--description', description,
      '--force',
    ]);
    this.exec([
      'api', '--method', 'POST',
      `repos/${this.repo}/issues/${prNumber}/labels`,
      '-f', `labels[]=${name}`,
    ]);
  }

  closePullRequest(prNumber) {
    const result = this.exec([
      'api', '--method', 'PATCH',
      `repos/${this.repo}/pulls/${prNumber}`,
      '-f', 'state=closed',
    ]);
    const pull = JSON.parse(result || '{}');
    if (!pull.number || !pull.html_url) throw new Error(`GitHub did not return closed pull request #${prNumber}`);
    return { number: pull.number, url: pull.html_url };
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

  async findOpenPullRequestForCommitAsync(commitSha, baseBranch, headBranch) {
    try {
      const result = await this.execAsync([
        'pr', 'list',
        '--repo', this.repo,
        '--state', 'open',
        '--base', baseBranch,
        '--head', headBranch,
        '--json', 'number,headRefOid,headRefName,baseRefName',
      ]);
      const pull = JSON.parse(result || '[]').find(candidate => (
        candidate.headRefOid === commitSha
        && candidate.headRefName === headBranch
        && candidate.baseRefName === baseBranch
      ));
      return pull ? {
        number: String(pull.number),
        headBranch: pull.headRefName,
        baseBranch: pull.baseRefName,
      } : null;
    } catch (error) {
      if (error.name !== 'AbortError') {
        error.statusCode ||= 503;
        error.retryAfter ||= 5;
      }
      throw error;
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
        '--json', 'title,body,headRefOid'
      ]);
      return JSON.parse(result);
    } catch (e) {
      return null;
    }
  }

  async getPRDetailsAsync(prNumber) {
    try {
      const result = await this.execAsync([
        'pr', 'view', String(prNumber),
        '--repo', this.repo,
        '--json', 'title,body,headRefOid',
      ]);
      return JSON.parse(result);
    } catch {
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

  async getCommitSubjectAsync(commitSha) {
    let mirrorError;
    if (this.mirror) {
      try {
        return await this.mirror.getCommitSubject(commitSha, { signal: this.signal });
      } catch (error) {
        mirrorError = error;
      }
    }
    try {
      return await this.execAsync([
        'api', `repos/${this.repo}/commits/${commitSha}`,
        '--jq', '.commit.message | split("\\n")[0]',
      ]);
    } catch (error) {
      if (mirrorError?.statusCode === 400) throw mirrorError;
      const missingCommit = /HTTP (?:404|422)|not found/i.test(error.stderr || error.message || '');
      if (mirrorError?.statusCode === 503 && !missingCommit) throw mirrorError;
      return null;
    }
  }

  async getCommitSubjectsSince(publishedCommits, headCommit, { branch = null } = {}) {
    if (!this.mirror) throw new Error('Git history mirror is not configured');
    return this.mirror.getCommitSubjectsSince(publishedCommits, headCommit, {
      branch,
      signal: this.signal,
    });
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

  async getPullRequestCommitSubjectsAsync(prNumber) {
    try {
      const result = await this.execAsync([
        'api', '--paginate', '--slurp',
        `repos/${this.repo}/pulls/${prNumber}/commits?per_page=100`,
      ]);
      const pages = JSON.parse(result || '[]');
      return pages.flatMap(page => Array.isArray(page) ? page : [])
        .map(commit => commit.commit?.message?.split('\n')[0]?.trim())
        .filter(Boolean);
    } catch {
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

  async findPullRequestTitleForCommitAsync(commitSha, baseBranch) {
    try {
      const result = await this.execAsync([
        'api', `repos/${this.repo}/commits/${commitSha}/pulls`,
        '-H', 'Accept: application/vnd.github+json',
      ]);
      const pulls = JSON.parse(result || '[]');
      const pull = pulls.find(candidate => !baseBranch || candidate.base?.ref === baseBranch) || pulls[0];
      return pull?.title || null;
    } catch {
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

  assignIssueToOwner(issueNumber) {
    try {
      this.exec([
        'api', '--method', 'POST',
        `repos/${this.repo}/issues/${issueNumber}/assignees`,
        '-f', `assignees[]=${this.repoOwner}`,
      ]);
      return true;
    } catch (e) {
      // Alert publication is more important than assignment. Assignment can
      // legitimately be unavailable when the repository owner is an org.
      return false;
    }
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
        const issueNumber = issue.number || existing.number;
        this.assignIssueToOwner(issueNumber);
        return {
          number: issueNumber,
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
      this.assignIssueToOwner(issue.number);
      return { number: issue.number, url: issue.html_url, action: 'created' };
    } catch (e) {
      return false;
    }
  }

  closeIssueByMarker(marker, comment) {
    const existing = this.findIssueByMarker(marker);
    if (!existing || existing.state === 'CLOSED') return null;
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
  }
}
