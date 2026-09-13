// Explicit credentials and app selection: no process.env mutation or global CONFIG.
import { GitHubAppAuthenticator } from './github-app-auth.js';
import { AppStoreConnectAPI } from './app-store-connect.js';
import { XcodeCloudBuildProvider } from './build-provider.js';
export { GitHubAppAuthenticator, AppStoreConnectAPI, XcodeCloudBuildProvider };

const enc = encodeURIComponent;
function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`${name} is required`);
  return value.trim();
}
export class ReleaseClient {
  constructor({ github, apple }, { authenticator, asc } = {}) {
    this.github = authenticator || new GitHubAppAuthenticator(github);
    this.asc = asc || new AppStoreConnectAPI(apple.keyId, apple.issuerId, Buffer.from(apple.privateKey).toString('base64'));
    this.provider = new XcodeCloudBuildProvider(this.asc);
  }
  async repositories() {
    const repositories = [];
    for (let page = 1; ; page++) {
      const { data: installations } = await this.github.request(`/app/installations?per_page=100&page=${page}`);
      for (const installation of installations) {
        if (installation.suspended_at) continue;
        const { data: credential } = await this.github.request(`/app/installations/${installation.id}/access_tokens`, {
          method: 'POST', body: { permissions: { contents: 'read', metadata: 'read' } },
        });
        for (let p = 1; ; p++) {
          const { data } = await this.github.request(`/installation/repositories?per_page=100&page=${p}`, { token: credential.token });
          repositories.push(...data.repositories.map(repo => ({ id: repo.id, name: repo.full_name, defaultBranch: repo.default_branch, installationId: String(installation.id) })));
          if (data.repositories.length < 100) break;
        }
      }
      if (installations.length < 100) break;
    }
    return repositories;
  }
  async catalogue() {
    const products = [];
    let endpoint = '/ciProducts?include=app&limit=200';
    while (endpoint) {
      const response = await this.asc.request(endpoint);
      for (const product of response.data || []) {
        const appId = product.relationships?.app?.data?.id;
        if (!appId) continue;
        const app = response.included?.find(item => item.type === 'apps' && item.id === appId);
        const workflows = await this.asc.getWorkflows(product.id);
        products.push({ id: product.id, appId, name: app?.attributes?.name || product.attributes.name, bundleId: app?.attributes?.bundleId || '', workflows: workflows.map(w => ({ id: w.id, name: w.attributes.name, enabled: w.attributes.isEnabled !== false, internalOnly: (w.attributes.actions || []).some(a => a.actionType === 'ARCHIVE') && (w.attributes.actions || []).filter(a => a.actionType === 'ARCHIVE').every(a => a.buildDistributionAudience === 'INTERNAL_ONLY') })) });
      }
      endpoint = response.links?.next ? new URL(response.links.next).pathname.replace(/^\/v1/, '') + new URL(response.links.next).search : null;
    }
    return products;
  }
  async source(selection) {
    const repository = required(selection.repository, 'Repository');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
    const [owner, repo] = repository.split('/');
    const credential = await this.github.installationToken(owner, repo);
    const ref = selection.pullRequest ? `pulls/${enc(String(selection.pullRequest))}` : `commits/${enc(required(selection.branch, 'Branch'))}`;
    const { data } = await this.github.request(`/repos/${owner}/${repo}/${ref}`, { token: credential.token });
    if (selection.pullRequest && (data.state !== 'open' || data.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase())) throw new Error('Use an open pull request from this repository');
    return { commitSha: data.head?.sha || data.sha, branch: data.head?.ref || selection.branch };
  }
  async validate(selection) {
    const products = await this.catalogue();
    const product = products.find(p => p.appId === selection.appId && p.workflows.some(w => w.id === selection.workflowId && w.enabled && w.internalOnly));
    if (!product) throw new Error('Choose an enabled internal-testing archive workflow belonging to the selected Apple app');
    const { data: repository } = await this.asc.getWorkflowRepository(selection.workflowId);
    const repoUrl = repository.attributes?.repositoryUrl || repository.attributes?.httpCloneUrl || '';
    const normalized = repoUrl.replace(/^git@github.com:/, 'https://github.com/').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();
    if (normalized !== `https://github.com/${selection.repository}`.toLowerCase()) throw new Error('Xcode Cloud workflow repository does not match the selected GitHub repository');
    const source = await this.source(selection);
    return { ...selection, branch: source.branch, appName: product.name, workflowName: product.workflows.find(w => w.id === selection.workflowId).name, commitSha: source.commitSha };
  }
  async trigger(selection) {
    const verified = await this.validate(selection);
    return this.provider.trigger({ ...verified, purpose: 'internal_testing', provider: 'xcode_cloud' });
  }
  async status(runId, selection) {
    const { data: run } = await this.asc.request(`/ciBuildRuns/${enc(runId)}?include=workflow`);
    if (run.relationships?.workflow?.data?.id !== selection.workflowId) throw new Error('Build does not belong to the configured workflow');
    const { data: builds } = await this.asc.request(`/ciBuildRuns/${enc(runId)}/builds`);
    const result = [];
    for (const build of builds || []) {
      let beta = null;
      try { beta = (await this.asc.request(`/builds/${build.id}/buildBetaDetail`)).data?.attributes; }
      catch (error) { if (error.statusCode !== 404) throw error; }
      result.push({ id: build.id, version: build.attributes.version, processingState: build.attributes.processingState, audience: build.attributes.buildAudienceType, expired: build.attributes.expired, internalState: beta?.internalBuildState || null });
    }
    return { runId, number: run.attributes.number, progress: run.attributes.executionProgress, completionStatus: run.attributes.completionStatus, commitSha: run.attributes.sourceCommit?.commitSha, builds: result };
  }
}
