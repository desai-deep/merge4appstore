import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { AppStoreConnectAPI } from '../lib/app-store-connect.js';
import { validateRepositoryProfile } from '../lib/profile.js';
import { workflowDefinitions } from '../lib/workflow-templates.js';
import { planWorkflowOnboarding, applyWorkflowOnboarding, saveOnboardedWorkflowIDs } from '../lib/workflow-onboarding.js';
import { main, parseOnboardingArgs } from '../scripts/onboard-workflows.js';

function profile() {
  return {
    version: 1, instance: 'new-app',
    repository: { owner: 'someone', name: 'new-app', production_branch: 'release', beta_branch: 'testing' },
    versioning: { initial_version: '1.0' },
    apps: { prod: { app_id: 'app', bundle_id: 'com.example.new', name: 'New App' } },
    workflow_onboarding: { prod: {
      product_id: 'product', repository_id: 'repo', xcode_version_id: 'xcode', mac_os_version_id: 'mac',
      scheme: 'New App', container_file_path: 'New App.xcworkspace', trigger_mode: 'managed',
      workflows: { pull_requests: { template: 'pull_request' }, beta: { template: 'beta' }, production: { template: 'production' } },
    } },
  };
}

function fakeApple() {
  const resources = [];
  const writes = [];
  let serial = 0;
  return {
    resources, writes,
    getCIProduct: async () => ({ id: 'product', relationships: { app: { data: { id: 'app' } } } }),
    getCIProductRepositories: async () => [{ id: 'repo', attributes: { httpCloneUrl: 'https://github.com/someone/new-app.git' } }],
    getXcodeCompatibleMacOSVersions: async () => [{ id: 'mac' }],
    getWorkflows: async () => structuredClone(resources),
    getXcodeWorkflow: async id => structuredClone(resources.find(item => item.id === id)),
    createXcodeWorkflow: async data => {
      writes.push({ method: 'POST', data: structuredClone(data) });
      const resource = { ...structuredClone(data), id: `workflow-${++serial}` };
      resources.push(resource);
      return resource;
    },
    updateXcodeWorkflow: async (id, data) => {
      writes.push({ method: 'PATCH', id, data: structuredClone(data) });
      const resource = resources.find(item => item.id === id);
      Object.assign(resource, structuredClone(data));
      return resource;
    },
  };
}

function seed(asc, p, index = 0) {
  const resource = { ...structuredClone(workflowDefinitions(p)[index].data), id: `existing-${index}` };
  asc.resources.push(resource);
  return resource;
}

test('managed templates use manual starts only and preserve role-specific audiences', () => {
  const p = profile(); validateRepositoryProfile(p);
  const definitions = workflowDefinitions(p);
  for (const { data } of definitions) {
    assert.equal(data.attributes.branchStartCondition, null);
    assert.equal(data.attributes.pullRequestStartCondition, null);
    assert.equal(data.attributes.containerFilePath, 'New App.xcworkspace');
    assert.equal(data.attributes.actions[0].scheme, 'New App');
    assert.equal(data.relationships.product.data.id, 'product');
  }
  const pr = definitions[0].data.attributes;
  assert.equal(pr.actions[0].buildDistributionAudience, 'INTERNAL_ONLY');
  assert.deepEqual(pr.manualPullRequestStartCondition.destination.patterns, [{ pattern: 'testing', isPrefix: false }]);
  assert.equal(definitions[1].data.attributes.actions[0].buildDistributionAudience, 'APP_STORE_ELIGIBLE');
  assert.deepEqual(definitions[2].data.attributes.manualBranchStartCondition.source.patterns, [{ pattern: 'release', isPrefix: false }]);
});

test('native templates use branch and PR starts with cancellation', () => {
  const p = profile(); p.workflow_onboarding.prod.trigger_mode = 'native';
  const definitions = workflowDefinitions(p);
  assert.equal(definitions[0].data.attributes.pullRequestStartCondition.autoCancel, true);
  assert.equal(definitions[0].data.attributes.manualPullRequestStartCondition, null);
  assert.equal(definitions[1].data.attributes.branchStartCondition.autoCancel, true);
  assert.equal(definitions[1].data.attributes.manualBranchStartCondition, null);
});

test('preview performs no mutations', async () => {
  const asc = fakeApple();
  const plan = await planWorkflowOnboarding(asc, profile());
  assert.deepEqual(plan.entries.map(entry => entry.action), ['create', 'create', 'create']);
  assert.deepEqual(asc.writes, []);
});

test('applying twice reuses workflows even before IDs have been written to the profile', async () => {
  const asc = fakeApple(); const p = profile();
  const first = await applyWorkflowOnboarding(asc, p);
  const second = await applyWorkflowOnboarding(asc, p);
  assert.deepEqual(first.ids, second.ids);
  assert.equal(asc.writes.length, 3);
  assert.deepEqual(second.entries.map(entry => entry.action), ['reuse', 'reuse', 'reuse']);
});

test('configured ID preserves workflow identity across renames and reconciles settings', async () => {
  const asc = fakeApple(); const p = profile(); const existing = seed(asc, p);
  p.apps.prod.workflows = { pull_requests: existing.id };
  p.workflow_onboarding.prod.workflows.pull_requests.name = 'PR archive';
  const result = await applyWorkflowOnboarding(asc, p);
  assert.equal(result.ids.pull_requests, existing.id);
  assert.equal(asc.writes[0].method, 'PATCH');
  assert.equal(existing.attributes.name, 'PR archive');
});

test('refuses ambiguous names before any writes', async () => {
  const asc = fakeApple(); const p = profile(); const existing = seed(asc, p, 2);
  asc.resources.push({ ...structuredClone(existing), id: 'duplicate' });
  await assert.rejects(applyWorkflowOnboarding(asc, p), /Multiple workflows/);
  assert.equal(asc.writes.length, 0);
});

test('refuses stale configured IDs instead of silently creating replacements', async () => {
  const asc = fakeApple(); const p = profile(); p.apps.prod.workflows = { production: 'stale' };
  await assert.rejects(applyWorkflowOnboarding(asc, p), /missing from the selected product/);
  assert.equal(asc.writes.length, 0);
});

test('checks app, repository and toolchain ownership before writes', async () => {
  for (const [override, error] of [
    [{ getCIProduct: async () => ({ relationships: { app: { data: { id: 'another-app' } } } }) }, /selected app/],
    [{ getCIProductRepositories: async () => [] }, /primary repository/],
    [{ getCIProductRepositories: async () => [{ id: 'repo', attributes: { httpCloneUrl: 'https://github.com/other/repo' } }] }, /GitHub repository/],
    [{ getXcodeCompatibleMacOSVersions: async () => [{ id: 'other-mac' }] }, /not compatible/],
  ]) {
    const asc = Object.assign(fakeApple(), override);
    await assert.rejects(applyWorkflowOnboarding(asc, profile()), error);
    assert.equal(asc.writes.length, 0);
  }
});

test('checks existing workflow repository and edit lock', async () => {
  for (const change of [resource => { resource.relationships.repository.data.id = 'other'; }, resource => { resource.attributes.isLockedForEditing = true; }]) {
    const asc = fakeApple(); const p = profile(); const existing = seed(asc, p); change(existing);
    await assert.rejects(applyWorkflowOnboarding(asc, p), /selected repository|locked for editing/);
    assert.equal(asc.writes.length, 0);
  }
});

test('recovers an uncertain POST by reading the exact created workflow, without a second POST', async () => {
  const asc = fakeApple(); const create = asc.createXcodeWorkflow;
  asc.createXcodeWorkflow = async data => { await create(data); throw new Error('Response lost'); };
  const result = await applyWorkflowOnboarding(asc, profile());
  assert.equal(Object.keys(result.ids).length, 3);
  assert.equal(asc.writes.length, 3);
});

test('rejects a conflicting workflow after an uncertain creation response', async () => {
  const asc = fakeApple(); const create = asc.createXcodeWorkflow;
  asc.createXcodeWorkflow = async data => {
    const resource = await create(data); resource.attributes.actions[0].scheme = 'Other app';
    throw new Error('Response lost');
  };
  await assert.rejects(applyWorkflowOnboarding(asc, profile()), /Response lost/);
  assert.equal(asc.writes.length, 1);
});

test('resumes after partial creation failure without duplicating completed workflows', async () => {
  const asc = fakeApple(); const create = asc.createXcodeWorkflow; let fail = true;
  asc.createXcodeWorkflow = async data => {
    if (fail && data.attributes.name === 'Make Beta') { fail = false; throw new Error('Unavailable'); }
    return create(data);
  };
  await assert.rejects(applyWorkflowOnboarding(asc, profile()), /Unavailable/);
  const result = await applyWorkflowOnboarding(asc, profile());
  assert.equal(Object.keys(result.ids).length, 3);
  assert.equal(asc.writes.length, 3);
});

test('supports a separate internal app role without touching production templates', async () => {
  const p = profile(); p.apps.internal = { app_id: 'app', bundle_id: 'com.example.internal', name: 'Internal' };
  p.workflow_onboarding.internal = { ...p.workflow_onboarding.prod, workflows: { pr: { template: 'pull_request' } } };
  const asc = fakeApple(); const result = await applyWorkflowOnboarding(asc, p, 'internal');
  assert.deepEqual(Object.keys(result.ids), ['pr']);
  assert.equal(asc.writes.length, 1);
});

test('rejects invalid onboarding configuration through normal profile validation', () => {
  for (const change of [
    p => { p.workflow_onboarding.prod.scheme = ''; },
    p => { p.workflow_onboarding.prod.container_file_path = '../App.xcodeproj'; },
    p => { p.workflow_onboarding.prod.trigger_mode = 'shadow'; },
    p => { p.workflow_onboarding.prod.workflows.production.template = 'unknown'; },
    p => { p.workflow_onboarding.prod.workflows.production.name = 'Make Beta'; },
    p => { p.workflow_onboarding.prod.unexpected = true; },
    p => { p.workflow_onboarding.uat = p.workflow_onboarding.prod; },
  ]) {
    const p = profile(); change(p); assert.throws(() => validateRepositoryProfile(p));
  }
});

test('saving IDs preserves comments, unrelated roles and detects concurrent edits', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'app.yml');
  const original = `# Keep this comment\n${YAML.stringify(profile())}`;
  fs.writeFileSync(file, original);
  saveOnboardedWorkflowIDs(file, original, 'prod', { beta: 'created-id' });
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /Keep this comment/);
  const value = YAML.parse(written);
  assert.equal(value.apps.prod.workflows.beta, 'created-id');
  assert.deepEqual(value.workflow_onboarding, profile().workflow_onboarding);
  assert.throws(() => saveOnboardedWorkflowIDs(file, original, 'prod', {}), /Profile changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), written);
  assert.deepEqual(fs.readdirSync(directory), ['app.yml']);
});

test('CLI defaults to preview and requires explicit apply', () => {
  assert.equal(parseOnboardingArgs(['--profile', 'new.yml']).apply, false);
  assert.equal(parseOnboardingArgs(['--profile', 'new.yml', '--apply']).apply, true);
  assert.throws(() => parseOnboardingArgs([]), /profile is required/);
  assert.throws(() => parseOnboardingArgs(['--profile', '--apply']), /incomplete/);
  assert.throws(() => parseOnboardingArgs(['--profile', 'a.yml', '--apply', '--apply']), /Duplicate/);
  assert.throws(() => parseOnboardingArgs(['--profile', 'a.yml', '--app', 'another']), /app must be/);
});

test('Apple create disables POST retries and PATCH omits immutable relationships', async () => {
  const asc = new AppStoreConnectAPI('key', 'issuer', Buffer.from('key').toString('base64'));
  const calls = [];
  asc.request = async (...args) => { calls.push(args); return { data: { id: 'workflow' } }; };
  const data = workflowDefinitions(profile())[0].data;
  await asc.createXcodeWorkflow(data);
  await asc.updateXcodeWorkflow('workflow', data);
  assert.equal(calls[0][0], '/ciWorkflows');
  assert.equal(calls[0][2].maxRetries, 0);
  assert.deepEqual(JSON.parse(calls[0][1].body), { data });
  const patch = JSON.parse(calls[1][1].body).data;
  assert.equal(patch.id, 'workflow');
  assert.deepEqual(Object.keys(patch.relationships).sort(), ['macOsVersion', 'xcodeVersion']);
});

test('onboarding list pagination follows Apple pages and rejects foreign URLs', async () => {
  const asc = new AppStoreConnectAPI('key', 'issuer', Buffer.from('key').toString('base64'));
  const endpoints = [];
  asc.request = async endpoint => {
    endpoints.push(endpoint);
    return endpoint.includes('cursor=2') ? { data: [{ id: 'two' }] }
      : { data: [{ id: 'one' }], links: { next: 'https://api.appstoreconnect.apple.com/v1/ciProducts/p/primaryRepositories?cursor=2' } };
  };
  assert.deepEqual(await asc.getCIProductRepositories('p'), [{ id: 'one' }, { id: 'two' }]);
  assert.equal(endpoints[1], '/ciProducts/p/primaryRepositories?cursor=2');
  asc.request = async () => ({ data: [], links: { next: 'https://other.example/v1/items' } });
  await assert.rejects(asc.getCIProductRepositories('p'), /Invalid Apple/);
});


test('CLI preview and global dry run leave both Apple and the profile unchanged', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'app.yml');
  const original = YAML.stringify(profile());
  fs.writeFileSync(filename, original);
  for (const args of [[], ['--apply']]) {
    const asc = fakeApple(); const output = [];
    await main(['--profile', filename, ...args], { asc, environment: { DRY_RUN: 'true' }, write: line => output.push(line) });
    assert.deepEqual(asc.writes, []);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    assert.match(output.join('\n'), /PREVIEW create/);
  }
});

test('CLI apply saves usable IDs and a second run makes no Apple writes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'app.yml');
  fs.writeFileSync(filename, YAML.stringify(profile()));
  const asc = fakeApple();
  const first = await main(['--profile', filename, '--apply'], { asc, environment: {}, write: () => {} });
  const saved = YAML.parse(fs.readFileSync(filename, 'utf8'));
  validateRepositoryProfile(saved);
  assert.deepEqual(saved.apps.prod.workflows, first.ids);
  await main(['--profile', filename, '--apply'], { asc, environment: {}, write: () => {} });
  assert.equal(asc.writes.length, 3);
});

test('CLI does not save partial IDs when Apple creation fails', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'app.yml');
  const original = YAML.stringify(profile());
  fs.writeFileSync(filename, original);
  const asc = fakeApple(); const create = asc.createXcodeWorkflow;
  asc.createXcodeWorkflow = async data => {
    if (asc.resources.length) throw new Error('Apple unavailable');
    return create(data);
  };
  await assert.rejects(main(['--profile', filename, '--apply'], { asc, environment: {}, write: () => {} }), /Apple unavailable/);
  assert.equal(asc.resources.length, 1);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
});
