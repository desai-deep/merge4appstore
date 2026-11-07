import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { validateRepositoryProfile } from './profile.js';
import { workflowDefinitions } from './workflow-templates.js';

const sameID = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const relatedID = (resource, key) => resource.relationships?.[key]?.data?.id;

// Compare only fields that the template owns. Apple may add other response fields.
function project(actual, desired) {
  if (desired === null) return actual ?? null;
  if (Array.isArray(desired)) return Array.isArray(actual) ? actual.map((item, i) => project(item, desired[i] ?? item)) : actual;
  if (desired && typeof desired === 'object') return Object.fromEntries(Object.entries(desired).map(([key, value]) => [key, project(actual?.[key], value)]));
  return actual;
}
export function workflowMatches(resource, definition) {
  return JSON.stringify(project(resource.attributes, definition.data.attributes)) === JSON.stringify(definition.data.attributes)
    && ['xcodeVersion', 'macOsVersion'].every(key => sameID(relatedID(resource, key), relatedID(definition.data, key)));
}
function assertOwnership(resource, definition) {
  for (const key of ['product', 'repository']) {
    if (!sameID(relatedID(resource, key), relatedID(definition.data, key))) throw new Error(`Workflow ${resource.id} does not belong to the selected ${key}`);
  }
  if (resource.attributes?.isLockedForEditing) throw new Error(`Workflow ${resource.id} is locked for editing`);
}

export async function planWorkflowOnboarding(asc, profile, role = 'prod') {
  validateRepositoryProfile(profile);
  const definitions = workflowDefinitions(profile, role);
  const config = profile.workflow_onboarding[role];
  const product = await asc.getCIProduct(config.product_id);
  if (!sameID(relatedID(product, 'app'), profile.apps[role].app_id)) throw new Error('Xcode Cloud product does not belong to the selected app');
  const [repositories, compatibleOS, workflows] = await Promise.all([
    asc.getCIProductRepositories(config.product_id),
    asc.getXcodeCompatibleMacOSVersions(config.xcode_version_id),
    asc.getWorkflows(config.product_id),
  ]);
  const repository = repositories.find(item => sameID(item.id, config.repository_id));
  if (!repository) throw new Error('Selected repository is not a primary repository of this Xcode Cloud product');
  const expectedURL = `https://github.com/${profile.repository.owner}/${profile.repository.name}`.toLowerCase();
  const cloneURL = String(repository.attributes?.httpCloneUrl || '').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();
  if (cloneURL !== expectedURL) throw new Error('Xcode Cloud repository does not match the profile GitHub repository');
  if (!compatibleOS.some(item => sameID(item.id, config.mac_os_version_id))) throw new Error('Selected macOS version is not compatible with the selected Xcode version');

  const entries = [];
  for (const definition of definitions) {
    const named = workflows.filter(item => item.attributes?.name === definition.data.attributes.name);
    if (named.length > 1) throw new Error(`Multiple workflows named ${definition.data.attributes.name}; configure a unique name before onboarding`);
    const selected = definition.configuredId
      ? workflows.find(item => sameID(item.id, definition.configuredId)) : named[0];
    if (definition.configuredId && !selected) throw new Error(`Configured workflow ${definition.configuredId} is missing from the selected product`);
    if (selected && named[0] && !sameID(named[0].id, selected.id)) throw new Error(`Workflow name ${definition.data.attributes.name} conflicts with another workflow`);
    if (!selected) { entries.push({ action: 'create', id: null, definition }); continue; }
    const current = await asc.getXcodeWorkflow(selected.id);
    assertOwnership(current, definition);
    entries.push({ action: workflowMatches(current, definition) ? 'reuse' : 'update', id: current.id, definition });
  }
  // One Apple workflow must never serve two differently configured template keys.
  const ids = entries.map(entry => entry.id?.toLowerCase()).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('Multiple onboarding templates select the same workflow');
  return { role, productId: config.product_id, entries };
}

export async function applyWorkflowOnboarding(asc, profile, role = 'prod', { onWorkflow = () => {} } = {}) {
  // Re-plan immediately before mutation rather than executing a stale preview.
  const plan = await planWorkflowOnboarding(asc, profile, role);
  const ids = {};
  for (const entry of plan.entries) {
    let resource;
    if (entry.action === 'create') {
      try {
        resource = await asc.createXcodeWorkflow(entry.definition.data);
      } catch (error) {
        // A timeout can occur AFTER Apple created the workflow. Read before any
        // subsequent attempt; never automatically retry this non-idempotent POST.
        const found = (await asc.getWorkflows(plan.productId)).filter(item => item.attributes?.name === entry.definition.data.attributes.name);
        if (found.length !== 1) throw error;
        resource = await asc.getXcodeWorkflow(found[0].id);
        assertOwnership(resource, entry.definition);
        if (!workflowMatches(resource, entry.definition)) throw error;
      }
    } else if (entry.action === 'update') {
      resource = await asc.updateXcodeWorkflow(entry.id, entry.definition.data);
    } else {
      resource = await asc.getXcodeWorkflow(entry.id);
    }
    if (!resource?.id) throw new Error(`Apple returned no workflow ID for ${entry.definition.key}`);
    const verified = await asc.getXcodeWorkflow(resource.id);
    assertOwnership(verified, entry.definition);
    if (!workflowMatches(verified, entry.definition)) throw new Error(`Apple did not preserve the expected settings for ${entry.definition.key}`);
    ids[entry.definition.key] = verified.id;
    await onWorkflow({ ...entry, id: verified.id });
  }
  return { ...plan, ids };
}

export function saveOnboardedWorkflowIDs(profilePath, originalText, role, ids) {
  if (fs.readFileSync(profilePath, 'utf8') !== originalText) throw new Error('Profile changed during onboarding. Rerun to reuse the created workflows and save their IDs.');
  const document = YAML.parseDocument(originalText);
  if (document.errors.length) throw document.errors[0];
  for (const [key, id] of Object.entries(ids)) document.setIn(['apps', role, 'workflows', key], id);
  const temporary = path.join(path.dirname(profilePath), `.${path.basename(profilePath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, document.toString(), { flag: 'wx', mode: fs.statSync(profilePath).mode & 0o777 });
    fs.renameSync(temporary, profilePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
