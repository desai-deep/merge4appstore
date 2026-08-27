import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutomationProfile,
  applyBuildPurposeProfile,
  applyRepositoryProfile,
  resolveAutomation,
  resolveBuildPurpose,
  validateRepositoryProfile,
} from '../lib/profile.js';

function profileFixture() {
  return {
    version: 1,
    instance: 'runningorder-ios',
    repository: {
      owner: 'desai-deep',
      name: 'runningorder-ios',
      production_branch: 'main',
      beta_branch: 'develop',
    },
    apps: {
      prod: {
        app_id: 'prod-id',
        bundle_id: 'com.example.app',
        name: 'Example',
        workflows: { production: 'prod-workflow', internal: 'internal-workflow' },
      },
      uat: {
        app_id: 'uat-id',
        bundle_id: 'com.example.app.uat',
        name: 'Example UAT',
        workflows: { pull_requests: 'uat-pr-workflow' },
      },
      internal: {
        app_id: 'internal-id',
        bundle_id: 'com.example.app.internal',
        name: 'Example Internal',
        workflows: { pull_requests: 'internal-pr-workflow' },
      },
    },
    automation: {
      deploy: { workflow: 'production' },
      sync: true,
      expire: { app: 'uat', workflow: 'pull_requests' },
    },
    build: {
      provider: 'xcode_cloud',
      trigger_mode: 'native',
      purposes: {
        pull_request: { app: 'uat', workflow: 'pull_requests' },
        beta: { workflow: 'internal' },
        production: { workflow: 'production' },
      },
    },
  };
}

test('defaults each automation to the prod app', () => {
  const profile = validateRepositoryProfile(profileFixture());
  assert.deepEqual(resolveAutomation(profile, 'deploy'), {
    name: 'deploy',
    enabled: true,
    appRole: 'prod',
    appId: 'prod-id',
    appIdentifier: 'com.example.app',
    appName: 'Example',
    workflowId: 'prod-workflow',
    recoverMissedBuilds: false,
  });
  assert.equal(resolveAutomation(profile, 'sync').appRole, 'prod');
});

test('routes cleanup to a separate UAT app and PR workflow', () => {
  const automation = resolveAutomation(validateRepositoryProfile(profileFixture()), 'expire');
  assert.equal(automation.appRole, 'uat');
  assert.equal(automation.appId, 'uat-id');
  assert.equal(automation.workflowId, 'uat-pr-workflow');
});

test('supports the standard internal app role', () => {
  const profile = profileFixture();
  profile.automation.expire.app = 'internal';
  const automation = resolveAutomation(validateRepositoryProfile(profile), 'expire');
  assert.equal(automation.appRole, 'internal');
  assert.equal(automation.appId, 'internal-id');
});

test('resolves provider-neutral build purposes to app workflows', () => {
  const profile = validateRepositoryProfile(profileFixture());
  assert.deepEqual(resolveBuildPurpose(profile, 'pull_request'), {
    purpose: 'pull_request',
    provider: 'xcode_cloud',
    triggerMode: 'native',
    appRole: 'uat',
    appId: 'uat-id',
    appIdentifier: 'com.example.app.uat',
    appName: 'Example UAT',
    workflowId: 'uat-pr-workflow',
    includeCommits: true,
  });
  assert.equal(resolveBuildPurpose(profile, 'beta').includeCommits, false);
  assert.equal(resolveBuildPurpose(profile, 'production').includeCommits, false);
});

test('allows commit-list defaults to be overridden per build purpose', () => {
  const profile = profileFixture();
  profile.build.purposes.pull_request.include_commits = false;
  profile.build.purposes.beta.include_commits = true;
  const validated = validateRepositoryProfile(profile);
  assert.equal(resolveBuildPurpose(validated, 'pull_request').includeCommits, false);
  assert.equal(resolveBuildPurpose(validated, 'beta').includeCommits, true);

  profile.build.purposes.beta.include_commits = 'yes';
  assert.throws(() => validateRepositoryProfile(profile), /include_commits must be a boolean/);
});

test('allows each build purpose to override the default trigger mode', () => {
  const profile = profileFixture();
  profile.build.trigger_mode = 'managed';
  profile.build.purposes.pull_request.trigger_mode = 'shadow';
  const validated = validateRepositoryProfile(profile);

  assert.equal(resolveBuildPurpose(validated, 'pull_request').triggerMode, 'shadow');
  assert.equal(resolveBuildPurpose(validated, 'production').triggerMode, 'managed');
});

test('rejects unknown build providers and purposes', () => {
  const providerProfile = profileFixture();
  providerProfile.build.provider = 'unknown';
  assert.throws(() => validateRepositoryProfile(providerProfile), /Unknown build provider/);

  const purposeProfile = profileFixture();
  purposeProfile.build.purposes.nightly = { workflow: 'internal' };
  assert.throws(() => validateRepositoryProfile(purposeProfile), /Unknown build purpose/);
});

test('applies a build purpose to an environment', () => {
  const environment = {};
  const build = applyBuildPurposeProfile(
    validateRepositoryProfile(profileFixture()),
    'pull_request',
    environment,
  );
  assert.equal(build.appRole, 'uat');
  assert.deepEqual(environment, {
    APP_ID: 'uat-id',
    APP_BUNDLE_ID: 'com.example.app.uat',
    APP_NAME: 'Example UAT',
    XCODE_WORKFLOW_ID: 'uat-pr-workflow',
  });
});

test('allows an automation-specific app id override', () => {
  const profile = profileFixture();
  profile.automation.deploy.app_id = 'override-id';
  assert.equal(resolveAutomation(validateRepositoryProfile(profile), 'deploy').appId, 'override-id');
});

test('requires destructive cleanup to name an exact workflow', () => {
  const profile = profileFixture();
  delete profile.automation.expire.workflow;
  assert.throws(() => validateRepositoryProfile(profile), /requires workflow/);
});

test('rejects non-standard app roles', () => {
  const profile = profileFixture();
  profile.apps.main = profile.apps.prod;
  assert.throws(() => validateRepositoryProfile(profile), /Unknown app role: main/);
});

test('rejects unsupported profile versions', () => {
  const profile = profileFixture();
  profile.version = 2;
  assert.throws(() => validateRepositoryProfile(profile), /version must be 1/);
});

test('rejects webhook keys unsupported by their provider', () => {
  const profile = profileFixture();
  profile.webhooks = { github: { token_env: 'WRONG' } };
  assert.throws(() => validateRepositoryProfile(profile), /webhooks.github.token_env is not supported/);

  profile.webhooks = { xcode_cloud: { secret_env: 'WRONG' } };
  assert.throws(() => validateRepositoryProfile(profile), /webhooks.xcode_cloud.secret_env is not supported/);
});

test('applies repository and selected automation values to an environment', () => {
  const profile = validateRepositoryProfile(profileFixture());
  const environment = {};
  applyRepositoryProfile(profile, environment);
  applyAutomationProfile(profile, 'expire', environment);
  assert.deepEqual(environment, {
    INSTANCE_NAME: 'runningorder-ios',
    GITHUB_REPO_OWNER: 'desai-deep',
    GITHUB_REPO_NAME: 'runningorder-ios',
    GITHUB_REPO: 'desai-deep/runningorder-ios',
    PRODUCTION_BRANCH: 'main',
    BETA_BRANCH: 'develop',
    APP_ID: 'uat-id',
    APP_BUNDLE_ID: 'com.example.app.uat',
    APP_NAME: 'Example UAT',
    XCODE_WORKFLOW_ID: 'uat-pr-workflow',
    RECOVER_MISSED_XCODE_BUILDS: 'false',
    EXPIRE_XCODE_WORKFLOW_ID: 'uat-pr-workflow',
  });
});
