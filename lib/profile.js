import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

const APP_ROLES = new Set(['prod', 'uat', 'internal']);
const AUTOMATIONS = new Set(['deploy', 'sync', 'expire']);
const BUILD_PROVIDERS = new Set(['xcode_cloud']);
const BUILD_TRIGGER_MODES = new Set(['native', 'shadow', 'managed']);
const BUILD_PURPOSES = new Set(['pull_request', 'beta', 'production']);

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

  if (profile.metadata !== undefined) {
    if (!profile.metadata || typeof profile.metadata !== 'object' || Array.isArray(profile.metadata)) {
      throw new Error('metadata must be a mapping');
    }
    for (const key of Object.keys(profile.metadata)) {
      if (key !== 'path') throw new Error(`metadata.${key} is not supported`);
    }
    assertString(profile.metadata.path, 'metadata.path');
    const metadataPath = profile.metadata.path;
    if (path.posix.isAbsolute(metadataPath)
      || metadataPath.includes('\\')
      || path.posix.normalize(metadataPath) !== metadataPath
      || metadataPath === '.'
      || metadataPath === '..'
      || metadataPath.startsWith('../')) {
      throw new Error('metadata.path must be a normalized repository directory path');
    }
  }

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
    for (const [workflow, workflowId] of Object.entries(app.workflows || {})) {
      assertString(workflowId, `apps.${role}.workflows.${workflow}`);
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

  if (profile.webhooks !== undefined) {
    if (!profile.webhooks || typeof profile.webhooks !== 'object' || Array.isArray(profile.webhooks)) {
      throw new Error('webhooks must be a mapping');
    }
    for (const provider of Object.keys(profile.webhooks)) {
      if (!['github', 'xcode_cloud'].includes(provider)) {
        throw new Error(`Unknown webhook provider: ${provider}. Expected github or xcode_cloud.`);
      }
      const settings = profile.webhooks[provider];
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error(`webhooks.${provider} must be a mapping`);
      }
      const allowedKeys = provider === 'github' ? new Set(['secret_env']) : new Set(['token_env']);
      for (const key of Object.keys(settings)) {
        if (!allowedKeys.has(key)) {
          throw new Error(`webhooks.${provider}.${key} is not supported`);
        }
        assertString(settings[key], `webhooks.${provider}.${key}`);
      }
    }
  }

  if (profile.ci !== undefined) {
    if (!profile.ci || typeof profile.ci !== 'object' || Array.isArray(profile.ci)) {
      throw new Error('ci must be a mapping');
    }
    if (profile.ci.prepare !== undefined) {
      if (!profile.ci.prepare || typeof profile.ci.prepare !== 'object' || Array.isArray(profile.ci.prepare)) {
        throw new Error('ci.prepare must be a mapping');
      }
      if (profile.ci.prepare.token_env !== undefined) assertString(profile.ci.prepare.token_env, 'ci.prepare.token_env');
    }
  }

  if (profile.build !== undefined) {
    if (!profile.build || typeof profile.build !== 'object' || Array.isArray(profile.build)) {
      throw new Error('build must be a mapping');
    }
    const provider = profile.build.provider || 'xcode_cloud';
    if (!BUILD_PROVIDERS.has(provider)) {
      throw new Error(`Unknown build provider: ${provider}`);
    }
    const triggerMode = profile.build.trigger_mode || 'native';
    if (!BUILD_TRIGGER_MODES.has(triggerMode)) {
      throw new Error('build.trigger_mode must be native, shadow, or managed');
    }
    if (!profile.build.purposes || typeof profile.build.purposes !== 'object' || Array.isArray(profile.build.purposes)) {
      throw new Error('build.purposes must be a mapping');
    }
    for (const purpose of Object.keys(profile.build.purposes)) {
      resolveBuildPurpose(profile, purpose);
    }
  }

  return profile;
}

export function resolveBuildPurpose(profile, purpose) {
  if (!BUILD_PURPOSES.has(purpose)) {
    throw new Error(`Unknown build purpose: ${purpose}. Expected pull_request, beta, or production.`);
  }
  if (!profile.build) throw new Error('Profile does not configure build providers');

  const route = profile.build.purposes?.[purpose];
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error(`build.purposes.${purpose} must be a mapping`);
  }

  const provider = profile.build.provider || 'xcode_cloud';
  if (!BUILD_PROVIDERS.has(provider)) throw new Error(`Unknown build provider: ${provider}`);

  const triggerMode = route.trigger_mode || profile.build.trigger_mode || 'native';
  if (!BUILD_TRIGGER_MODES.has(triggerMode)) {
    throw new Error(`build.purposes.${purpose}.trigger_mode must be native, shadow, or managed`);
  }

  const appRole = route.app || 'prod';
  if (!APP_ROLES.has(appRole)) {
    throw new Error(`build.purposes.${purpose}.app must be prod, uat, or internal`);
  }
  const app = profile.apps?.[appRole];
  if (!app) throw new Error(`build.purposes.${purpose} selects missing apps.${appRole}`);

  const workflowId = route.workflow_id
    || (route.workflow ? app.workflows?.[route.workflow] : '')
    || '';
  if (!workflowId) {
    throw new Error(`build.purposes.${purpose} requires workflow or workflow_id`);
  }
  if (route.include_commits !== undefined && typeof route.include_commits !== 'boolean') {
    throw new Error(`build.purposes.${purpose}.include_commits must be a boolean`);
  }

  return {
    purpose,
    provider,
    triggerMode,
    appRole,
    appId: String(route.app_id || app.app_id),
    appIdentifier: route.bundle_id || app.bundle_id,
    appName: route.app_name || app.name,
    workflowId: String(workflowId),
    includeCommits: route.include_commits ?? purpose === 'pull_request',
  };
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
  if ((name === 'deploy' || name === 'expire') && !workflowId) {
    throw new Error(`automation.${name} requires workflow or workflow_id to scope build selection`);
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
    metadataPath: name === 'deploy' ? (profile.metadata?.path || '') : '',
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

export function applyBuildPurposeProfile(profile, purpose, environment = process.env) {
  const build = resolveBuildPurpose(profile, purpose);
  environment.APP_ID = build.appId;
  environment.APP_BUNDLE_ID = build.appIdentifier;
  environment.APP_NAME = build.appName;
  environment.XCODE_WORKFLOW_ID = build.workflowId;
  return build;
}
