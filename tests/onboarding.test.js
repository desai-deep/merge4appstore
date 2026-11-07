import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import crypto from 'node:crypto';
import { loadRepositoryProfile, resolveBuildPurpose } from '../lib/profile.js';
import { parseEnvironment } from '../lib/secret-environment.js';
import { parseOnboardingArgs, normalizeOptions, appleCollection, discoverExistingApp,
  createOnboardingProfile, verifyOnboardingRoutes, assertNewProfile, writeOnboardingBundle } from '../lib/onboarding.js';

const options = normalizeOptions({ repo: 'example/existing-ios', 'bundle-id': 'com.example.existing',
  'initial-version': '2.10', 'production-workflow': 'production-id', 'beta-workflow': 'beta-id',
  'pr-workflow': 'pr-id', 'service-url': 'https://example.com/merge4appstore/' });
const discovery = {
  repository: { id: 42, full_name: 'example/existing-ios', default_branch: 'release' },
  app: { id: '123', attributes: { name: 'Existing App', bundleId: 'com.example.existing' } },
  workflows: ['production-id', 'beta-id', 'pr-id'].map(id => ({ id, attributes: { name: id, isEnabled: true } })),
  versions: [{ id: 'version-id', attributes: { versionString: '2.9', appStoreState: 'READY_FOR_SALE' } }],
};
/** Create an isolated directory that is removed when the test finishes. */
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('parses terminal and noninteractive options and rejects typos and unsafe identities', () => {
  assert.deepEqual(parseOnboardingArgs(['onboard', '--repo=example/app', '--dry-run']), { repo: 'example/app', dryRun: true });
  assert.throws(() => parseOnboardingArgs(['--repo']), /requires a value/);
  assert.throws(() => parseOnboardingArgs(['--managed']), /Unknown/);
  assert.throws(() => parseOnboardingArgs(['--repo=a/b', '--repo=c/d']), /Duplicate/);
  assert.throws(() => normalizeOptions({ ...options, instance: '../app' }), /slug/);
  assert.throws(() => normalizeOptions({ ...options, repo: 'example/app?token=x' }), /OWNER/);
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=x']) {
    assert.throws(() => normalizeOptions({ ...options, 'service-url': url }), /HTTPS/);
  }
  assert.equal(options.serviceUrl, 'https://example.com/merge4appstore');
});

test('discovers exact existing app and paginated workflows/versions using only reads', async () => {
  const requests = [];
  const apple = { request: async endpoint => {
    requests.push(endpoint);
    if (endpoint.startsWith('/apps?')) return { data: [discovery.app] };
    if (endpoint === '/apps/123/ciProduct') return { data: { id: 'product-id' } };
    if (endpoint.startsWith('/ciProducts/')) return { data: discovery.workflows.slice(0, 1), links: { next: 'https://api.appstoreconnect.apple.com/v1/workflow-page-2' } };
    if (endpoint === '/workflow-page-2') return { data: discovery.workflows.slice(1) };
    if (endpoint.startsWith('/apps/123/appStoreVersions')) return { data: discovery.versions };
    throw new Error(`Unexpected request ${endpoint}`);
  } };
  const result = await discoverExistingApp(options, { apple, github: async endpoint => {
    assert.equal(endpoint, '/repos/example/existing-ios'); return discovery.repository;
  } });
  assert.deepEqual(result, discovery);
  assert.equal(requests.length, 5);
});

test('pagination refuses foreign origins and loops before making unsafe requests', async () => {
  let calls = 0;
  const apple = { request: async () => { calls++; return { data: [], links: { next: 'https://evil.example/v1/apps' } }; } };
  await assert.rejects(appleCollection(apple, '/apps'), /pagination URL/);
  assert.equal(calls, 1);
  await assert.rejects(appleCollection({ request: async () => ({ data: [], links: { next: 'https://api.appstoreconnect.apple.com/v1/apps' } }) }, '/apps'), /pagination/);
});

test('fails closed for inaccessible or ambiguous Apple apps', async () => {
  for (const data of [[], [discovery.app, discovery.app]]) {
    await assert.rejects(discoverExistingApp(options, {
      github: async () => discovery.repository, apple: { request: async () => ({ data }) },
    }), /exactly one/);
  }
});

test('generated profile uses immutable repository ID and preserves native triggers with automation off', () => {
  const profile = createOnboardingProfile(options, discovery);
  assert.equal(profile.repository.github_id, 42);
  assert.equal(profile.repository.production_branch, 'release');
  assert.equal(profile.ci.version.token_env, 'MERGE4APPSTORE_BUILD_TOKEN_EXISTING_IOS');
  assert.deepEqual(profile.automation, { deploy: false, sync: false, expire: false });
  assert.equal(profile.release_pull_request, false);
  assert.equal(profile.auto_rebase_pull_requests, false);
  assert.equal(profile.metadata, undefined);
  assert.equal(resolveBuildPurpose(profile, 'production').triggerMode, 'native');
});

test('refuses obsolete version seeds and wrong, disabled, or duplicate workflow mappings', () => {
  assert.throws(() => createOnboardingProfile({ ...options, 'initial-version': '2.8' }, discovery), /below observed/);
  assert.throws(() => createOnboardingProfile({ ...options, 'initial-version': undefined }, discovery), /marketing version/);
  assert.throws(() => createOnboardingProfile({ ...options, 'production-workflow': 'foreign' }, discovery), /belonging/);
  assert.throws(() => createOnboardingProfile({ ...options, 'beta-workflow': 'production-id' }, discovery), /cannot share/);
  const disabled = { ...discovery, workflows: discovery.workflows.map(w => ({ ...w, attributes: { isEnabled: false } })) };
  assert.throws(() => createOnboardingProfile(options, disabled), /disabled/);
  assert.throws(() => createOnboardingProfile({ ...options, 'beta-branch': 'release' }, discovery), /must differ/);
});

test('verifies branch existence and workflow repository ownership including SSH clone URLs', async () => {
  const profile = createOnboardingProfile({ ...options, 'beta-branch': 'beta/release' }, discovery);
  const reads = [];
  await verifyOnboardingRoutes(profile, { github: async endpoint => { reads.push(endpoint); return {}; },
    apple: { request: async () => ({ data: { attributes: { sshCloneUrl: 'git@github.com:example/existing-ios.git' } } }) } });
  assert.deepEqual(reads, ['/repos/example/existing-ios/branches/release', '/repos/example/existing-ios/branches/beta%2Frelease']);
  await assert.rejects(verifyOnboardingRoutes(profile, { github: async () => ({}),
    apple: { request: async () => ({ data: { attributes: { httpCloneUrl: 'https://github.com/example/other.git' } } }) } }), /does not match/);
  await assert.rejects(verifyOnboardingRoutes(profile, { github: async () => { throw new Error('Branch missing'); }, apple: {} }), /Branch missing/);
});

test('writes a private, loadable bundle, ignores secrets, and refuses token rotation on rerun', t => {
  const root = temporary(t);
  const output = path.join(root, 'bundle');
  const profile = createOnboardingProfile(options, discovery);
  writeOnboardingBundle(output, profile, { serviceUrl: options.serviceUrl, versions: discovery.versions });
  assert.deepEqual(loadRepositoryProfile(path.join(output, 'profile.yml')), profile);
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  const file = path.join(output, 'secrets.env');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const contents = fs.readFileSync(file, 'utf8');
  const secrets = parseEnvironment(contents);
  assert.match(secrets[profile.ci.version.token_env], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(fs.readFileSync(path.join(output, 'profile.yml'), 'utf8'), new RegExp(secrets[profile.ci.version.token_env]));
  assert.doesNotMatch(fs.readFileSync(path.join(output, 'README.md'), 'utf8'), new RegExp(secrets[profile.ci.version.token_env]));
  assert.match(fs.readFileSync(path.join(output, '.gitignore'), 'utf8'), /^\*\n/);
  assert.throws(() => writeOnboardingBundle(output, profile), /EEXIST/);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  assertNewProfile(profile, path.join(root, 'missing'));
  assert.throws(() => assertNewProfile(profile, output), /already configured/);
});

test('refuses symlink output without touching its target', t => {
  const root = temporary(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'existing');
  const output = path.join(root, 'link');
  fs.symlinkSync(target, output);
  assert.throws(() => writeOnboardingBundle(output, createOnboardingProfile(options, discovery)), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'existing');
});

test('version adapter encodes workflow IDs, keeps token out of argv, and rejects malformed responses', t => {
  const root = temporary(t);
  const output = path.join(root, 'bundle');
  writeOnboardingBundle(output, createOnboardingProfile(options, discovery));
  const curl = path.join(root, 'curl');
  fs.writeFileSync(curl, '#!/bin/sh\ncat > "$CAPTURE_CONFIG"\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\nprintf "%s" "$MOCK_VERSION"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, MERGE4APPSTORE_URL: 'https://example.com/base/',
    MERGE4APPSTORE_BUILD_TOKEN: 'test-secret', CI_WORKFLOW_ID: 'workflow/id',
    CAPTURE_CONFIG: path.join(root, 'config'), CAPTURE_ARGS: path.join(root, 'args'), MOCK_VERSION: '2.10' };
  assert.equal(execFileSync('sh', [path.join(output, 'fetch-version.sh')], { env, encoding: 'utf8' }), '2.10\n');
  assert.match(fs.readFileSync(env.CAPTURE_CONFIG, 'utf8'), /Bearer test-secret/);
  const args = fs.readFileSync(env.CAPTURE_ARGS, 'utf8');
  assert.doesNotMatch(args, /test-secret/);
  assert.match(args, /--disable\n--proto\n=https\n--proto-redir\n=https\n/);
  assert.match(args, /--data-urlencode\nworkflow_id=workflow\/id/);
  assert.match(args, /https:\/\/example.com\/base\/v1\/builds\/version\/existing-ios/);
  for (const value of ['invalid', '2.10\njunk', '2.10\n2.11', '2..10', '2.10;id']) {
    assert.throws(() => execFileSync('sh', [path.join(output, 'fetch-version.sh')], { env: { ...env, MOCK_VERSION: value }, stdio: 'pipe' }));
  }
  assert.throws(() => execFileSync('sh', [path.join(output, 'fetch-version.sh')], { env: { ...env, MERGE4APPSTORE_BUILD_TOKEN: '' }, stdio: 'pipe' }));
});

test('version adapter rejects insecure runtime URLs before invoking curl', t => {
  const root = temporary(t);
  const output = path.join(root, 'bundle');
  writeOnboardingBundle(output, createOnboardingProfile(options, discovery));
  const marker = path.join(root, 'curl-called');
  fs.writeFileSync(path.join(root, 'curl'), '#!/bin/sh\nprintf called > "$CURL_MARKER"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, CURL_MARKER: marker,
    MERGE4APPSTORE_BUILD_TOKEN: 'private-token', CI_WORKFLOW_ID: 'production-id' };
  for (const url of ['http://example.com', 'ftp://example.com', 'file:///tmp/version', 'https://', 'example.com']) {
    assert.throws(() => execFileSync('sh', [path.join(output, 'fetch-version.sh')], {
      env: { ...env, MERGE4APPSTORE_URL: url }, stdio: 'pipe',
    }), error => {
      assert.match(error.stderr.toString(), /must use HTTPS/);
      assert.doesNotMatch(error.stderr.toString(), /private-token/);
      return true;
    });
    assert.equal(fs.existsSync(marker), false);
  }
});

test('CLI help works without credentials and invalid input exits unsuccessfully', () => {
  const command = new URL('../scripts/onboard-existing.js', import.meta.url);
  assert.match(execFileSync(process.execPath, [command.pathname, '--help'], { encoding: 'utf8' }), /existing iOS app/);
  assert.throws(() => execFileSync(process.execPath, [command.pathname, '--repo', 'invalid'], { stdio: 'pipe' }));
});

test('complete noninteractive CLI discovers, previews, and creates a bundle without provider mutations', t => {
  const root = temporary(t);
  const output = path.join(root, 'setup');
  const responses = {
    '/v1/apps?filter[bundleId]=com.example.existing&limit=200': { data: [discovery.app] },
    '/v1/apps/123/ciProduct': { data: { id: 'product-id' } },
    '/v1/ciProducts/product-id/workflows?limit=200': { data: discovery.workflows },
    '/v1/apps/123/appStoreVersions?filter[platform]=IOS&limit=200': { data: discovery.versions },
    '/v1/ciWorkflows/production-id/repository': { data: { attributes: { httpCloneUrl: 'https://github.com/example/existing-ios.git' } } },
  };
  const mock = path.join(root, 'mock-fetch.mjs');
  fs.writeFileSync(mock, `import assert from 'node:assert/strict';
    const responses = ${JSON.stringify(responses)};
    globalThis.fetch = async (url, init) => {
      assert.equal(init.method || 'GET', 'GET');
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.appstoreconnect.apple.com');
      const result = responses[parsed.pathname + parsed.search];
      assert.ok(result, 'Unexpected Apple endpoint: ' + url);
      return new Response(JSON.stringify(result), { status: 200 });
    };`);
  const gh = path.join(root, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh
case "$4" in
  /repos/example/existing-ios) printf '%s' '${JSON.stringify(discovery.repository)}' ;;
  /repos/example/existing-ios/branches/release) printf '{}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const env = { PATH: `${root}:${process.env.PATH}`, HOME: root,
    APP_STORE_CONNECT_API_KEY_ID: 'test-key', APP_STORE_CONNECT_ISSUER_ID: 'test-issuer',
    APP_STORE_CONNECT_API_KEY_CONTENT: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
  const args = ['--import', mock, new URL('../scripts/onboard-existing.js', import.meta.url).pathname,
    'onboard', '--repo', options.repo, '--bundle-id', options['bundle-id'], '--initial-version', '2.10',
    '--production-workflow', 'production-id', '--output', output];
  const preview = execFileSync(process.execPath, [...args, '--dry-run'], { cwd: root, env, encoding: 'utf8' });
  assert.match(preview, /trigger_mode: native/);
  assert.equal(fs.existsSync(output), false);
  const result = execFileSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
  const profile = loadRepositoryProfile(path.join(output, 'profile.yml'));
  const token = parseEnvironment(fs.readFileSync(path.join(output, 'secrets.env')))[profile.ci.version.token_env];
  assert.doesNotMatch(result, new RegExp(token));
  assert.doesNotMatch(preview, /^[A-Fa-f0-9]{64}$/m);
  assert.equal(profile.apps.prod.app_id, '123');
  assert.throws(() => execFileSync(process.execPath, args, { cwd: root, env, stdio: 'pipe' }), /Command failed/);
});
