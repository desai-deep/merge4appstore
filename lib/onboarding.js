import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { validateRepositoryProfile, loadRepositoryProfile } from './profile.js';
import { validateMarketingVersion, compareMarketingVersions } from './version-state.js';

const OPTIONS = new Set(['repo', 'bundle-id', 'instance', 'initial-version', 'production-branch',
  'beta-branch', 'production-workflow', 'beta-workflow', 'pr-workflow', 'output', 'service-url', 'env']);

/**
 * Parse onboarding flags, rejecting unknown options, duplicate values, and missing arguments.
 */
export function parseOnboardingArgs(args) {
  const result = {};
  if (args[0] === 'onboard') args = args.slice(1);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') { result.help = true; continue; }
    if (argument === '--dry-run') { result.dryRun = true; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || !OPTIONS.has(match[1])) throw new Error(`Unknown onboarding option: ${argument}`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${match[1]} requires a value`);
    if (Object.hasOwn(result, match[1])) throw new Error(`Duplicate option: --${match[1]}`);
    result[match[1]] = value;
  }
  return result;
}

/**
 * Validate app and repository identifiers and normalize the instance slug and service URL.
 */
export function normalizeOptions(options) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo || '')) {
    throw new Error('--repo must be OWNER/REPOSITORY');
  }
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(options['bundle-id'] || '')) {
    throw new Error('--bundle-id must identify an existing Apple app');
  }
  const instance = options.instance || options.repo.split('/')[1].toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(instance)) throw new Error('--instance must be a lowercase slug');
  if (options['initial-version']) validateMarketingVersion(options['initial-version']);
  let serviceUrl = '';
  if (options['service-url']) {
    const url = new URL(options['service-url']);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('--service-url must be an HTTPS base URL without credentials, query, or fragment');
    }
    serviceUrl = url.toString().replace(/\/$/, '');
  }
  return { ...options, instance, serviceUrl };
}

/**
 * Read a paginated Apple collection, rejecting foreign destinations and repeated or excessive pages.
 */
export async function appleCollection(apple, initialEndpoint) {
  const items = [];
  const seen = new Set();
  let endpoint = initialEndpoint;
  while (endpoint) {
    if (seen.has(endpoint) || seen.size >= 100) throw new Error('Invalid Apple pagination');
    seen.add(endpoint);
    const response = await apple.request(endpoint);
    if (!Array.isArray(response.data)) throw new Error('Apple returned an invalid collection');
    items.push(...response.data);
    const next = response.links?.next;
    if (!next) break;
    const url = new URL(next, 'https://api.appstoreconnect.apple.com/v1/');
    if (url.origin !== 'https://api.appstoreconnect.apple.com' || !url.pathname.startsWith('/v1/')) {
      throw new Error('Invalid Apple pagination URL');
    }
    endpoint = url.pathname.slice(3) + url.search;
  }
  return items;
}

/**
 * Normalize supported GitHub clone URLs for case-insensitive workflow ownership comparisons.
 */
function repositoryFromUrl(value) {
  return value?.replace(/^git@github.com:/, 'https://github.com/')
    .replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();
}

/**
 * Read the selected repository and exact existing Apple app, including its workflows and iOS versions.
 */
export async function discoverExistingApp(options, { apple, github }) {
  const repository = await github(`/repos/${options.repo}`);
  if (!repository.id || !repository.full_name || !repository.default_branch) {
    throw new Error('GitHub returned incomplete repository information');
  }
  const apps = await appleCollection(apple, `/apps?filter[bundleId]=${encodeURIComponent(options['bundle-id'])}&limit=200`);
  const matches = apps.filter(app => app.attributes?.bundleId === options['bundle-id']);
  if (matches.length !== 1) throw new Error('Bundle ID must resolve to exactly one accessible existing Apple app');
  const app = matches[0];
  const { data: product } = await apple.request(`/apps/${encodeURIComponent(app.id)}/ciProduct`);
  if (!product?.id) throw new Error('Existing app has no Xcode Cloud product; configure Xcode Cloud first');
  const workflows = await appleCollection(apple, `/ciProducts/${encodeURIComponent(product.id)}/workflows?limit=200`);
  const versions = await appleCollection(apple, `/apps/${encodeURIComponent(app.id)}/appStoreVersions?filter[platform]=IOS&limit=200`);
  return { repository, app, workflows, versions };
}

/**
 * Build a validated native-trigger profile with release automation disabled and an explicit version floor.
 */
export function createOnboardingProfile(options, discovery) {
  validateMarketingVersion(options['initial-version']);
  // A seed below an existing store version would let the first CI build use an obsolete version.
  for (const version of discovery.versions) {
    const observed = version.attributes?.versionString;
    if (observed && compareMarketingVersions(options['initial-version'], observed) < 0) {
      throw new Error(`--initial-version is below observed App Store version ${observed}; reconcile versions before onboarding`);
    }
  }
  const productionBranch = options['production-branch'] || discovery.repository.default_branch;
  const betaBranch = options['beta-branch'] || 'develop';
  if (productionBranch === betaBranch) throw new Error('Production and beta branches must differ');
  const workflows = {};
  const purposes = {};
  for (const [flag, purpose, name] of [
    ['production-workflow', 'production', 'production'],
    ['beta-workflow', 'beta', 'beta'],
    ['pr-workflow', 'pull_request', 'pull_requests'],
  ]) {
    const id = options[flag];
    if (!id) continue;
    const workflow = discovery.workflows.find(item => item.id === id);
    if (!workflow) throw new Error(`--${flag} must be an ID belonging to the selected app`);
    if (workflow.attributes?.isEnabled === false) throw new Error(`--${flag} selects a disabled workflow`);
    workflows[name] = id;
    purposes[purpose] = { workflow: name };
  }
  if (!workflows.production) throw new Error('--production-workflow is required');
  const [owner, name] = discovery.repository.full_name.split('/');
  return validateRepositoryProfile({
    version: 1,
    instance: options.instance,
    repository: { owner, name, github_id: discovery.repository.id,
      production_branch: productionBranch, beta_branch: betaBranch },
    versioning: { initial_version: options['initial-version'] },
    webhooks: { github: { secret_env: 'GH_WEBHOOK_SECRET' },
      xcode_cloud: { token_env: 'XCODE_CLOUD_WEBHOOK_TOKEN' } },
    ci: { version: { token_env: `MERGE4APPSTORE_BUILD_TOKEN_${options.instance.toUpperCase().replace(/-/g, '_')}` } },
    apps: { prod: { app_id: String(discovery.app.id), bundle_id: discovery.app.attributes.bundleId,
      name: discovery.app.attributes.name, workflows } },
    build: { provider: 'xcode_cloud', trigger_mode: 'native', purposes },
    automation: { deploy: false, sync: false, expire: false },
    release_pull_request: false,
    auto_rebase_pull_requests: false,
  });
}

/**
 * Verify configured branch access and ensure every selected workflow belongs to the profile repository.
 */
export async function verifyOnboardingRoutes(profile, { apple, github }) {
  const repo = `${profile.repository.owner}/${profile.repository.name}`;
  const branches = new Set([profile.repository.production_branch]);
  if (profile.build.purposes.beta || profile.build.purposes.pull_request) branches.add(profile.repository.beta_branch);
  for (const branch of branches) await github(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  for (const id of Object.values(profile.apps.prod.workflows)) {
    const { data } = await apple.request(`/ciWorkflows/${encodeURIComponent(id)}/repository`);
    const attributes = data?.attributes || {};
    const url = attributes.httpCloneUrl || attributes.repositoryUrl || attributes.sshCloneUrl;
    if (repositoryFromUrl(url) !== `https://github.com/${repo}`.toLowerCase()) {
      throw new Error(`Workflow ${id} repository does not match ${repo}`);
    }
  }
}

/**
 * Reject profiles that duplicate an installed repository, instance, or build-token environment name.
 */
export function assertNewProfile(profile, directory) {
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file))) {
    const existing = loadRepositoryProfile(path.join(directory, file));
    if (existing.instance === profile.instance
      || (existing.ci?.version?.token_env || `MERGE4APPSTORE_BUILD_TOKEN_${existing.instance.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`) === profile.ci.version.token_env
      || `${existing.repository.owner}/${existing.repository.name}`.toLowerCase()
        === `${profile.repository.owner}/${profile.repository.name}`.toLowerCase()) {
      throw new Error(`Repository or instance already configured in ${file}; update its existing profile instead`);
    }
  }
}

export const VERSION_FETCH_SCRIPT = `#!/bin/sh
set -eu
: "\${MERGE4APPSTORE_URL:?Set the service base URL}"
: "\${MERGE4APPSTORE_BUILD_TOKEN:?Set the secret build token}"
: "\${CI_WORKFLOW_ID:?Xcode Cloud workflow ID is required}"
case "$MERGE4APPSTORE_URL" in
  https://?*) ;;
  *) echo 'MERGE4APPSTORE_URL must use HTTPS' >&2; exit 1 ;;
esac
# Keep credentials out of curl's command-line arguments. Do not run this script with shell tracing.
version=$(printf 'header = "Authorization: Bearer %s"\\n' "$MERGE4APPSTORE_BUILD_TOKEN" |
  curl --disable --proto '=https' --proto-redir '=https' --config - --fail --silent --show-error --connect-timeout 10 --max-time 30 \\
    --retry 3 --retry-delay 2 --retry-max-time 120 --get \\
    --data-urlencode "workflow_id=$CI_WORKFLOW_ID" \\
    "\${MERGE4APPSTORE_URL%/}/v1/builds/version/INSTANCE")
case "$version" in
  ''|*[!0-9.]*) echo 'Service returned an invalid marketing version' >&2; exit 1 ;;
esac
if ! printf '%s\\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\\.[0-9]+(\\.[0-9]+)?$'; then
  echo 'Service returned an invalid marketing version' >&2
  exit 1
fi
printf '%s\\n' "$version"
`;

/**
 * Exclusively create a private setup bundle; remove incomplete output if publication fails.
 */
export function writeOnboardingBundle(output, profile, { serviceUrl = '', versions = [] } = {}) {
  const target = path.resolve(output);
  // Exclusive directory creation protects credentials and makes reruns refuse to rotate tokens.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target, { mode: 0o700 });
  try {
    const tokenName = profile.ci.version.token_env;
    const secrets = `${tokenName}=${crypto.randomBytes(32).toString('hex')}\n`;
    fs.writeFileSync(path.join(target, 'profile.yml'), YAML.stringify(profile), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'secrets.env'), secrets, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, '.gitignore'), '*\n!profile.yml\n!README.md\n!fetch-version.sh\n!.gitignore\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'fetch-version.sh'), VERSION_FETCH_SCRIPT.replace('/INSTANCE', `/${profile.instance}`), { flag: 'wx', mode: 0o700 });
    const storeVersions = versions.map(v => `${v.attributes.versionString} (${v.attributes.appStoreState})`).join(', ') || 'none';
    const notes = `# Existing app onboarding: ${profile.instance}

Repository: ${profile.repository.owner}/${profile.repository.name}
Apple app: ${profile.apps.prod.name} (${profile.apps.prod.app_id})
Observed iOS store versions: ${storeVersions}
Initial version selected: ${profile.versioning.initial_version}

This bundle is a setup draft. Provider reads are verified; no hooks, workflows, server state, builds, or submissions were changed.

1. Review profile.yml, including branch/workflow mapping and the initial version. Compare with existing TestFlight builds and your project's current marketing version. The profile format has one initial version for both production and development; it cannot import separate in-flight versions. Reconcile any in-flight review before switching CI to this service.
2. Copy profile.yml into the service's profiles/${profile.instance}.yml. If using GitHub App webhook routing, install the existing GitHub App on this repository; the immutable GitHub repository ID is included in the profile.
3. Merge the single value in secrets.env into the server's private webhook environment using the encoded environment writer. Preserve all existing credentials. This file is a partial secret addition, not a replacement webhook environment. The shared GH_WEBHOOK_SECRET and XCODE_CLOUD_WEBHOOK_TOKEN must already be configured on the service. The CLI never rotates them.
4. Deploy/reload the service through its normal configuration process and verify this instance appears in /health. Authenticate the version endpoint with the build token and each mapped workflow ID; confirm the returned versions before editing CI.
5. In Xcode Cloud, set MERGE4APPSTORE_URL to ${serviceUrl || '<HTTPS service base URL>'} and the secret MERGE4APPSTORE_BUILD_TOKEN to the generated value. Copy fetch-version.sh into the app repository's ci_scripts directory. Call it from the existing ci_post_clone.sh and apply its output using your project's existing version-setting method (Xcode project, xcconfig, or Tuist). Merge with the existing adapter; do not overwrite ci_post_clone.sh. Do not enable shell tracing around secrets.
6. Connect Xcode Cloud lifecycle webhooks to <service base URL>/webhooks/xcode-cloud/${profile.instance}/<shared XCODE_CLOUD_WEBHOOK_TOKEN>. For classic GitHub hooks use <service base URL>/webhooks/github/${profile.instance} with the existing shared signing secret and push/pull_request events. For managed GitHub App routing use the existing App webhook instead; do not create duplicate classic hooks.
7. Run one normal build through the current native trigger and verify the fetched version and TestFlight notes. Run DRY_RUN=true node index.js deploy --profile profiles/${profile.instance}.yml after configuring automation.deploy with workflow: production. Enable deploy/sync/expiry individually after reviewing their effects. Expiry must select the exact pull-request workflow. Keep metadata management, release PRs, and automatic rebasing opt-in.

Build trigger mode remains native. Changing it to managed requires explicitly changing Xcode Cloud start conditions first to avoid duplicate builds. Extra UAT/internal apps can be added using the existing profile format after this production-app setup.

secrets.env is private (0600) and ignored by Git. Keep it in private storage; never commit it or paste tokens into logs or command-line arguments.
`;
    fs.writeFileSync(path.join(target, 'README.md'), notes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return target;
}
