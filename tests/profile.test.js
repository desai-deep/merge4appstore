import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutomationProfile,
  applyBuildPurposeProfile,
  applyRepositoryProfile,
  resolveAutoRebasePullRequests,
  resolveAutomation,
  resolveBuildPurpose,
  resolveReleasePullRequest,
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
    metadataPath: '',
  });
  assert.equal(resolveAutomation(profile, 'sync').appRole, 'prod');
});

test('resolves centralized release pull request policy', () => {
  const profile = profileFixture();
  assert.deepEqual(resolveReleasePullRequest(profile), { enabled: false });

  profile.release_pull_request = true;
  assert.deepEqual(resolveReleasePullRequest(validateRepositoryProfile(profile)), {
    enabled: true,
    baseBranch: 'main',
    headBranch: 'develop',
    title: 'Bug fixes and performance improvements',
    noteLimit: 100,
  });
});

test('defaults automatic pull request rebasing off and allows profiles to enable it', () => {
  const profile = profileFixture();
  assert.deepEqual(resolveAutoRebasePullRequests(profile), {
    enabled: false,
    baseBranch: 'develop',
  });

  profile.auto_rebase_pull_requests = true;
  assert.deepEqual(resolveAutoRebasePullRequests(validateRepositoryProfile(profile)), {
    enabled: true,
    baseBranch: 'develop',
  });
});

test('rejects a non-boolean automatic pull request rebase flag', () => {
  const profile = profileFixture();
  profile.auto_rebase_pull_requests = 'yes';
  assert.throws(
    () => validateRepositoryProfile(profile),
    /auto_rebase_pull_requests must be a boolean/,
  );
});

test('validates release pull request overrides', () => {
  const profile = profileFixture();
  profile.release_pull_request = { title: 'Monthly release', note_limit: 25 };
  const policy = resolveReleasePullRequest(validateRepositoryProfile(profile));
  assert.equal(policy.title, 'Monthly release');
  assert.equal(policy.noteLimit, 25);

  profile.release_pull_request.note_limit = 0;
  assert.throws(() => validateRepositoryProfile(profile), /note_limit must be a positive integer/);
  profile.release_pull_request = { unknown: true };
  assert.throws(() => validateRepositoryProfile(profile), /unknown is not supported/);
});

test('validates release pull request branch configuration', () => {
  const profile = profileFixture();
  profile.release_pull_request = true;
  profile.repository.beta_branch = 42;
  assert.throws(() => validateRepositoryProfile(profile), /repository\.beta_branch must be a non-empty string/);

  profile.repository.beta_branch = 'main';
  assert.throws(() => validateRepositoryProfile(profile), /requires different production and beta branches/);
});

test('adds optional repository metadata only to deployment', () => {
  const fixture = profileFixture();
  fixture.metadata = { path: 'AppStore' };
  const profile = validateRepositoryProfile(fixture);

  assert.equal(resolveAutomation(profile, 'deploy').metadataPath, 'AppStore');
  assert.equal(resolveAutomation(profile, 'sync').metadataPath, '');
  assert.equal(resolveAutomation(profile, 'expire').metadataPath, '');
});

test('requires metadata roots to use a normalized repository directory path', () => {
  for (const invalid of ['.', '/AppStore', '../AppStore', 'AppStore/../Metadata', 'AppStore\\Metadata']) {
    const profile = profileFixture();
    profile.metadata = { path: invalid };
    assert.throws(() => validateRepositoryProfile(profile), /metadata\.path/);
  }
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

test('requires a distinct Xcode Cloud workflow for every build purpose', () => {
  const profile = profileFixture();
  profile.build.purposes.beta.workflow_id = 'prod-workflow';
  assert.throws(
    () => validateRepositoryProfile(profile),
    /beta and production cannot share Xcode Cloud workflow prod-workflow/,
  );
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

test('requires deployment to name an exact workflow', () => {
  const profile = profileFixture();
  delete profile.automation.deploy.workflow;
  assert.throws(() => validateRepositoryProfile(profile), /automation\.deploy requires workflow/);
});

test('rejects non-standard app roles', () => {
  const profile = profileFixture();
  profile.apps.main = profile.apps.prod;
  assert.throws(() => validateRepositoryProfile(profile), /Unknown app role: main/);
});

test('requires every configured workflow id to be a non-empty string', () => {
  const empty = profileFixture();
  empty.apps.prod.workflows.production = '';
  assert.throws(() => validateRepositoryProfile(empty), /apps\.prod\.workflows\.production must be a non-empty string/);

  const mapping = profileFixture();
  mapping.apps.prod.workflows.production = { id: 'workflow' };
  assert.throws(() => validateRepositoryProfile(mapping), /apps\.prod\.workflows\.production must be a non-empty string/);
});

test('rejects unsupported profile versions', () => {
  const profile = profileFixture();
  profile.version = 2;
  assert.throws(() => validateRepositoryProfile(profile), /version must be 1/);
});

test('requires an immutable GitHub repository id to be a positive safe integer', () => {
  const profile = profileFixture();
  profile.repository.github_id = '789442740';
  assert.throws(() => validateRepositoryProfile(profile), /repository.github_id/);
  profile.repository.github_id = 789442740;
  assert.equal(validateRepositoryProfile(profile).repository.github_id, 789442740);
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
