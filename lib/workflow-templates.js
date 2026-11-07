import path from 'node:path';

const TEMPLATES = new Set(['pull_request', 'beta', 'production']);
const ROLES = new Set(['prod', 'uat', 'internal']);
const TARGET_KEYS = new Set(['product_id', 'repository_id', 'xcode_version_id', 'mac_os_version_id', 'scheme', 'container_file_path', 'trigger_mode', 'workflows']);
const NAMES = { pull_request: 'Internal PR', beta: 'Make Beta', production: 'Publish to App Store' };

function required(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`${label} must be a non-empty trimmed string`);
}
function mapping(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
}

export function validateWorkflowOnboarding(profile) {
  if (profile.workflow_onboarding === undefined) return;
  mapping(profile.workflow_onboarding, 'workflow_onboarding');
  if (!Object.keys(profile.workflow_onboarding).length) throw new Error('workflow_onboarding must configure at least one app');
  for (const [role, config] of Object.entries(profile.workflow_onboarding)) {
    if (!ROLES.has(role) || !profile.apps?.[role]) throw new Error(`workflow_onboarding.${role} requires a configured app role`);
    const prefix = `workflow_onboarding.${role}`;
    mapping(config, prefix);
    for (const key of Object.keys(config)) if (!TARGET_KEYS.has(key)) throw new Error(`${prefix}.${key} is not supported`);
    for (const key of ['product_id', 'repository_id', 'xcode_version_id', 'mac_os_version_id', 'scheme', 'container_file_path']) required(config[key], `${prefix}.${key}`);
    const container = config.container_file_path;
    if (path.posix.isAbsolute(container) || container.includes('\\') || container.split('/').includes('..') || path.posix.normalize(container) !== container || !/\.(xcodeproj|xcworkspace)$/.test(container)) {
      throw new Error(`${prefix}.container_file_path must be a repository-relative Xcode project or workspace`);
    }
    if (!['managed', 'native'].includes(config.trigger_mode)) throw new Error(`${prefix}.trigger_mode must be managed or native`);
    mapping(config.workflows, `${prefix}.workflows`);
    if (!Object.keys(config.workflows).length) throw new Error(`${prefix}.workflows must contain at least one template`);
    const names = new Set();
    for (const [key, workflow] of Object.entries(config.workflows)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Invalid workflow key: ${key}`);
      mapping(workflow, `${prefix}.workflows.${key}`);
      for (const field of Object.keys(workflow)) if (!['template', 'name'].includes(field)) throw new Error(`${prefix}.workflows.${key}.${field} is not supported`);
      if (!TEMPLATES.has(workflow.template)) throw new Error(`${prefix}.workflows.${key}.template must be pull_request, beta, or production`);
      if (workflow.name !== undefined) required(workflow.name, `${prefix}.workflows.${key}.name`);
      const name = workflow.name || NAMES[workflow.template];
      if (names.has(name)) throw new Error(`Duplicate onboarding workflow name: ${name}`);
      names.add(name);
    }
  }
}

const branch = name => ({ isAllMatch: false, patterns: [{ pattern: name, isPrefix: false }] });
const allBranches = () => ({ isAllMatch: true, patterns: [] });
const relationship = (type, id) => ({ data: { type, id } });

export function workflowDefinitions(profile, role = 'prod') {
  validateWorkflowOnboarding(profile);
  const config = profile.workflow_onboarding?.[role];
  if (!config) throw new Error(`No workflow_onboarding configuration for ${role}`);
  return Object.entries(config.workflows).map(([key, definition]) => {
    const template = definition.template;
    const source = branch(template === 'production' ? profile.repository.production_branch || 'main' : profile.repository.beta_branch || 'develop');
    const attributes = {
      name: definition.name || NAMES[template],
      description: template === 'production'
        ? 'Archive an App Store eligible build. merge4appstore handles review submission separately.'
        : template === 'beta' ? 'Archive an App Store eligible build for beta testing.' : 'Archive a pull request build for internal testing only.',
      isEnabled: true,
      clean: true,
      containerFilePath: config.container_file_path,
      actions: [{
        name: 'Archive - iOS', actionType: 'ARCHIVE', destination: null,
        buildDistributionAudience: template === 'pull_request' ? 'INTERNAL_ONLY' : 'APP_STORE_ELIGIBLE',
        testConfiguration: null, scheme: config.scheme, platform: 'IOS', isRequiredToPass: true,
      }],
      branchStartCondition: null, pullRequestStartCondition: null,
      tagStartCondition: null, scheduledStartCondition: null,
      manualBranchStartCondition: null, manualTagStartCondition: null,
      manualPullRequestStartCondition: null,
    };
    if (template === 'pull_request') {
      const condition = { source: allBranches(), destination: source };
      if (config.trigger_mode === 'managed') attributes.manualPullRequestStartCondition = condition;
      else attributes.pullRequestStartCondition = { ...condition, filesAndFoldersRule: null, autoCancel: true };
    } else if (config.trigger_mode === 'managed') {
      attributes.manualBranchStartCondition = { source };
    } else {
      attributes.branchStartCondition = { source, filesAndFoldersRule: null, autoCancel: true };
    }
    return {
      key, role, configuredId: profile.apps[role].workflows?.[key] || null,
      data: {
        type: 'ciWorkflows', attributes,
        relationships: {
          product: relationship('ciProducts', config.product_id),
          repository: relationship('scmRepositories', config.repository_id),
          xcodeVersion: relationship('ciXcodeVersions', config.xcode_version_id),
          macOsVersion: relationship('ciMacOsVersions', config.mac_os_version_id),
        },
      },
    };
  });
}
