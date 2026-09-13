import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseClient, AppStoreConnectAPI } from '../lib/sdk.js';
function client({ repository = 'https://github.com/example/ios', workflow = 'workflow', ref = 'abc' } = {}) {
  const asc = {
    request: async endpoint => {
      if (endpoint.startsWith('/ciProducts')) return { data: [{ id: 'product', attributes: { name: 'Example' }, relationships: { app: { data: { id: 'app' } } } }] };
      if (endpoint.startsWith('/ciBuildRuns/') && endpoint.includes('?')) return { data: { attributes: {}, relationships: { workflow: { data: { id: workflow } } } } };
      return { data: [] };
    },
    getWorkflows: async () => [{ id: 'workflow', attributes: { name: 'Internal', actions: [{ actionType: 'ARCHIVE', buildDistributionAudience: 'INTERNAL_ONLY' }] } }],
    getWorkflowRepository: async () => ({ data: { attributes: { repositoryUrl: repository } } }),
  };
  const authenticator = { installationToken: async () => ({ token: 'private-token' }), request: async () => ({ data: { sha: ref } }) };
  return new ReleaseClient({}, { asc, authenticator });
}
const selection = { repository: 'example/ios', appId: 'app', workflowId: 'workflow', branch: 'main' };
test('SDK verifies app, workflow and repository before returning source identity', async () => {
  assert.equal((await client().validate(selection)).commitSha, 'abc');
  await assert.rejects(client({ repository: 'https://github.com/other/ios' }).validate(selection), /does not match/);
  await assert.rejects(client().validate({ ...selection, appId: 'other' }), /belonging/);
});
test('SDK rejects status reads from another configured workflow', async () => {
  await assert.rejects(client({ workflow: 'other' }).status('run', selection), /does not belong/);
});
test('SDK rejects closed or fork pull request sources', async () => {
  const c = client();
  c.github.request = async () => ({ data: { state: 'open', head: { repo: { full_name: 'fork/ios' }, sha: 'abc' } } });
  await assert.rejects(c.source({ ...selection, pullRequest: '1' }), /this repository/);
});

test('SDK refuses to start a different commit after the source changes', async () => {
  const c = client();
  c.provider.trigger = async () => { assert.fail('must not start'); };
  await assert.rejects(c.trigger({ ...selection, commitSha: 'old' }), { code: 'SOURCE_CHANGED' });
});

test('Apple workflow discovery follows all pages', async () => {
  const api = new AppStoreConnectAPI('', '', '');
  const paths = [];
  api.request = async endpoint => {
    paths.push(endpoint);
    return endpoint.includes('cursor=next') ? { data: [{id:'second'}] } : { data: [{id:'first'}], links: {next:'https://api.appstoreconnect.apple.com/v1/ciProducts/product/workflows?cursor=next'} };
  };
  assert.deepEqual((await api.getWorkflows('product')).map(w=>w.id), ['first','second']);
  assert.equal(paths.length, 2);
});
