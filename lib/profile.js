import fs from 'fs';
import YAML from 'yaml';

const APP_ROLES = new Set(['prod', 'uat', 'internal']);
const AUTOMATIONS = new Set(['deploy', 'sync', 'expire']);

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function normalizeAutomation(value, name) {
  if (value === undefined || value === false) return { enabled: false };
  if (value === true) return { enabled: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`automation.${name} must be a boolean or mapping`);
  }
  return { enabled: value.enabled !== false, ...value };
}

export function validateRepositoryProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Profile must contain a YAML mapping');
  }

  if (profile.version !== 1) throw new Error('Profile version must be 1');

  assertString(profile.instance, 'instance');
  assertString(profile.repository?.owner, 'repository.owner');
  assertString(profile.repository?.name, 'repository.name');

  if (!profile.apps || typeof profile.apps !== 'object' || Array.isArray(profile.apps)) {
    throw new Error('apps must be a mapping');
  }
  if (!profile.apps.prod) throw new Error('apps.prod is required');

  for (const [role, app] of Object.entries(profile.apps)) {
    if (!APP_ROLES.has(role)) {
      throw new Error(`Unknown app role: ${role}. Expected prod, uat, or internal.`);
    }
    assertString(app?.app_id, `apps.${role}.app_id`);
    assertString(app?.bundle_id, `apps.${role}.bundle_id`);
    assertString(app?.name, `apps.${role}.name`);
    if (app.workflows !== undefined && (!app.workflows || typeof app.workflows !== 'object' || Array.isArray(app.workflows))) {
      throw new Error(`apps.${role}.workflows must be a mapping`);
    }
  }

  if (profile.automation !== undefined && (!profile.automation || typeof profile.automation !== 'object' || Array.isArray(profile.automation))) {
    throw new Error('automation must be a mapping');
  }

  for (const name of Object.keys(profile.automation || {})) {
    if (!AUTOMATIONS.has(name)) {
      throw new Error(`Unknown automation: ${name}. Expected deploy, sync, or expire.`);
    }
    resolveAutomation(profile, name);
  }

  return profile;
}

export function loadRepositoryProfile(profilePath) {
  const source = fs.readFileSync(profilePath, 'utf8');
  return validateRepositoryProfile(YAML.parse(source));
}

export function resolveAutomation(profile, name) {
  if (!AUTOMATIONS.has(name)) throw new Error(`Unknown automation: ${name}`);

  const automation = normalizeAutomation(profile.automation?.[name], name);
  if (!automation.enabled) return { name, enabled: false };

  const appRole = automation.app || 'prod';
  if (!APP_ROLES.has(appRole)) {
    throw new Error(`automation.${name}.app must be prod, uat, or internal`);
  }

  const baseApp = profile.apps?.[appRole];
  if (!baseApp) throw new Error(`automation.${name} selects missing apps.${appRole}`);

  const workflowId = automation.workflow_id
    || (automation.workflow ? baseApp.workflows?.[automation.workflow] : '')
    || '';

  if (automation.workflow && !workflowId) {
    throw new Error(`automation.${name}.workflow references missing apps.${appRole}.workflows.${automation.workflow}`);
  }
  if (name === 'expire' && !workflowId) {
    throw new Error('automation.expire requires workflow or workflow_id to scope destructive cleanup');
  }

  return {
    name,
    enabled: true,
    appRole,
    appId: String(automation.app_id || baseApp.app_id),
    appIdentifier: automation.bundle_id || baseApp.bundle_id,
    appName: automation.app_name || baseApp.name,
    workflowId: String(workflowId),
    recoverMissedBuilds: automation.recover_missed_builds === true,
  };
}

export function applyRepositoryProfile(profile, environment = process.env) {
  environment.INSTANCE_NAME = profile.instance;
  environment.GITHUB_REPO_OWNER = profile.repository.owner;
  environment.GITHUB_REPO_NAME = profile.repository.name;
  environment.GITHUB_REPO = `${profile.repository.owner}/${profile.repository.name}`;
  environment.PRODUCTION_BRANCH = profile.repository.production_branch || 'main';
  environment.BETA_BRANCH = profile.repository.beta_branch || 'develop';

  if (Object.hasOwn(profile.repository, 'ios_repo_path')) {
    environment.IOS_REPO_PATH = profile.repository.ios_repo_path || '';
  }
}

export function applyAutomationProfile(profile, name, environment = process.env) {
  const automation = resolveAutomation(profile, name);
  if (!automation.enabled) return automation;

  environment.APP_ID = automation.appId;
  environment.APP_BUNDLE_ID = automation.appIdentifier;
  environment.APP_NAME = automation.appName;
  environment.XCODE_WORKFLOW_ID = automation.workflowId;
  environment.RECOVER_MISSED_XCODE_BUILDS = automation.recoverMissedBuilds ? 'true' : 'false';
  environment.EXPIRE_XCODE_WORKFLOW_ID = name === 'expire' ? automation.workflowId : '';
  return automation;
}
