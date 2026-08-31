import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const dependabot = fs.readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
const deployScript = fs.readFileSync(new URL('../scripts/deploy-vps.sh', import.meta.url), 'utf8');
const ecosystemUrl = new URL('../ecosystem.config.cjs', import.meta.url);
const ecosystem = fs.readFileSync(ecosystemUrl, 'utf8');
const webhookServer = fs.readFileSync(new URL('../webhook-server.js', import.meta.url), 'utf8');
const repositoryRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const parsedWorkflow = YAML.parse(workflow);
const deployRun = parsedWorkflow.jobs.deploy.steps.find(step => step.name === 'Deploy to VPS').run;
const setupSshRun = parsedWorkflow.jobs.deploy.steps.find(step => step.name === 'Setup SSH').run;
const inspectRun = parsedWorkflow.jobs.deploy.steps.find(step => step.name === 'Inspect process and HTTPS support').run;
const deploymentAlertStep = parsedWorkflow.jobs['deployment-alert'].steps
  .find(step => step.name === 'Open or resolve the deployment alert');
const deploymentAlertScript = deploymentAlertStep.with.script;
const reconciliationScript = parsedWorkflow.jobs['public-health-monitor'].steps
  .find(step => step.name === 'Reconcile the latest main-branch deployment alert').with.script;
const publicHealthAlertScript = parsedWorkflow.jobs['public-health-monitor'].steps
  .find(step => step.name === 'Open service health alert').with.script;
const expectedDeploymentScript = parsedWorkflow.jobs['public-health-monitor'].steps
  .find(step => step.name === 'Resolve expected main deployment').with.script;
const publicHealthRun = parsedWorkflow.jobs['public-health-monitor'].steps
  .find(step => step.name === 'Check public health and durable delivery queue').run;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function extractStateBootstrap() {
  const match = deployRun.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\n/);
  assert.ok(match, 'persistent-state bootstrap must be a complete nested heredoc');
  return match[1];
}

function extractPublicHealthValidator() {
  const match = publicHealthRun.match(/node -e '\n([\s\S]*?)\n'\n?$/);
  assert.ok(match, 'public-health validator must be an extractable Node program');
  return match[1];
}

function shellSection(start, end) {
  const startIndex = deployScript.indexOf(start);
  const endIndex = deployScript.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing shell section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing shell section end: ${end}`);
  return deployScript.slice(startIndex, endIndex);
}

function runBash(source, environment = {}) {
  return spawnSync('bash', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

const portableStatShim = String.raw`stat() {
  if [ "$1" != "-c" ]; then command stat "$@"; return; fi
  TEST_STAT_FORMAT="$2" TEST_STAT_PATH="$3" "$TEST_NODE_BINARY" -e '
    const fs = require("fs");
    const stats = fs.statSync(process.env.TEST_STAT_PATH);
    const mode = (stats.mode & 0o7777).toString(8);
    const values = {
      "%u": String(stats.uid),
      "%g": String(stats.gid),
      "%a": mode,
      "%u:%g:%a": [stats.uid, stats.gid, mode].join(":"),
    };
    if (!(process.env.TEST_STAT_FORMAT in values)) process.exit(2);
    process.stdout.write(values[process.env.TEST_STAT_FORMAT]);
  '
}`;

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function createHostKey(directory, name, type = 'ed25519') {
  const privateKey = path.join(directory, name);
  const generated = spawnSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-f', privateKey], {
    encoding: 'utf8',
  });
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs.readFileSync(`${privateKey}.pub`, 'utf8').trim().split(/\s+/);
  const fingerprint = spawnSync('ssh-keygen', ['-E', 'sha256', '-lf', `${privateKey}.pub`], {
    encoding: 'utf8',
  });
  assert.equal(fingerprint.status, 0, fingerprint.stderr);
  return {
    line: `fixture.example ${publicKey[0]} ${publicKey[1]}\n`,
    fingerprint: fingerprint.stdout.trim().split(/\s+/)[1],
  };
}

function runSetupSsh(t, scans, fingerprint) {
  const directory = temporaryDirectory(t, 'merge4appstore-host-key-');
  const home = path.join(directory, 'home');
  const bin = path.join(directory, 'bin');
  const fixtures = path.join(directory, 'scans');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(fixtures);
  scans.forEach((scan, index) => fs.writeFileSync(path.join(fixtures, String(index + 1)), scan));
  writeExecutable(path.join(bin, 'timeout'), '#!/bin/bash\nshift\nexec "$@"\n');
  writeExecutable(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n');
  writeExecutable(path.join(bin, 'ssh-keyscan'), `#!/bin/bash
set -eu
counter="$FAKE_SCAN_DIRECTORY/counter"
attempt=0
if [ -f "$counter" ]; then attempt="$(cat "$counter")"; fi
attempt="$((attempt + 1))"
printf '%s\n' "$attempt" > "$counter"
fixture="$FAKE_SCAN_DIRECTORY/$attempt"
[ -f "$fixture" ] || exit 1
cat "$fixture"
`);
  const result = runBash(setupSshRun, {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_SCAN_DIRECTORY: fixtures,
    VPS_HOST: 'fixture.example',
    VPS_SSH_KEY: 'fixture-private-key',
    VPS_SSH_HOST_ED25519_SHA256: fingerprint,
  });
  return { result, home, fixtures };
}

async function runGithubScript(script, {
  github,
  context,
  core,
  environment = {},
  fetchImpl = globalThis.fetch,
}) {
  const previous = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await new AsyncFunction('github', 'context', 'core', 'fetch', script)(
      github,
      context,
      core,
      fetchImpl,
    );
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('deployment shell programs are syntactically valid', () => {
  const shellPrograms = [['release deployer', deployScript]];
  for (const [jobName, job] of Object.entries(parsedWorkflow.jobs)) {
    for (const step of job.steps || []) {
      if (step.run) shellPrograms.push([`${jobName}/${step.name}`, step.run]);
      if (step.uses?.startsWith('actions/github-script@')) {
        assert.doesNotThrow(
          () => new AsyncFunction('github', 'context', 'core', step.with.script),
          `${jobName}/${step.name}`,
        );
      }
    }
  }
  for (const [name, source] of shellPrograms) {
    const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
  const nodeCheck = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: extractStateBootstrap(),
    encoding: 'utf8',
  });
  assert.equal(nodeCheck.status, 0, `deploy/persistent-state bootstrap: ${nodeCheck.stderr}`);
});

test('pins privileged GitHub Actions and schedules pin updates', () => {
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(match => match[1]);
  assert.ok(actionReferences.length > 0);
  for (const reference of actionReferences) {
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/);
  }
  const configuration = YAML.parse(dependabot);
  assert.ok(configuration.updates.some(update => (
    update['package-ecosystem'] === 'github-actions'
    && update.directory === '/'
  )));
});

test('pins every scanned VPS ed25519 key and retries only an empty scan', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-host-fixture-');
  const host = createHostKey(directory, 'host');
  const { result, home, fixtures } = runSetupSsh(t, ['', host.line], host.fingerprint);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(home, '.ssh', 'known_hosts'), 'utf8'), host.line);
  assert.equal(fs.statSync(path.join(home, '.ssh', 'known_hosts')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(fixtures, 'counter'), 'utf8').trim(), '2');
});

test('fails closed for a wrong, mixed, malformed, or missing VPS host key pin', async t => {
  const directory = temporaryDirectory(t, 'merge4appstore-host-fixtures-');
  const first = createHostKey(directory, 'first');
  const second = createHostKey(directory, 'second');
  const rsa = createHostKey(directory, 'rsa', 'rsa');
  for (const [name, scans, fingerprint] of [
    ['wrong fingerprint', [first.line], second.fingerprint],
    ['mixed keys', [`${first.line}${second.line}`], first.fingerprint],
    ['rsa only', [rsa.line], first.fingerprint],
    ['malformed scan', ['not a known-hosts record\n'], first.fingerprint],
    ['empty scans', ['', '', ''], first.fingerprint],
    ['missing pin', [first.line], ''],
    ['malformed pin', [first.line], 'SHA256:not-valid'],
  ]) {
    await t.test(name, child => {
      const { result } = runSetupSsh(child, scans, fingerprint);
      assert.notEqual(result.status, 0, 'unsafe host-key input was accepted');
    });
  }
});

test('forces both VPS SSH calls to use only the pinned host key', () => {
  const required = [
    'StrictHostKeyChecking=yes',
    'UserKnownHostsFile="$HOME/.ssh/known_hosts"',
    'GlobalKnownHostsFile=/dev/null',
    'HostKeyAlgorithms=ssh-ed25519',
    'UpdateHostKeys=no',
    'IdentitiesOnly=yes',
  ];
  for (const option of required) {
    assert.equal(workflow.split(option).length - 1, 2, `${option} must protect both SSH calls`);
  }
  assert.match(workflow, /VPS_SSH_HOST_ED25519_SHA256: \$\{\{ secrets\.VPS_SSH_HOST_ED25519_SHA256 \}\}/);
});

test('inspection verifies the PM2 reboot and Node runtime contract', () => {
  assert.match(inspectRun, /systemctl is-enabled "\$pm2_unit"/);
  assert.match(inspectRun, /systemctl is-active "\$pm2_unit"/);
  assert.match(inspectRun, /--property=User --value/);
  assert.match(inspectRun, /--property=MainPID --value/);
  assert.match(inspectRun, /"\$pm2_home\/pm2\.pid"/);
  assert.match(inspectRun, /readlink -f -- "\/proc\/\$main_pid\/exe"/);
  assert.match(inspectRun, /startsWith\("PM2_HOME="\)/);
  assert.match(inspectRun, /\*pm2\*resurrect\*/);
  assert.match(inspectRun, /pm2_env\?\.status !== "online"/);
  assert.match(inspectRun, /node_version/);
  assert.match(inspectRun, /Number\(nodeVersion\.split\("\."\)\[0\]\) < 20/);
  assert.doesNotMatch(inspectRun, /pm2 jlist[^\n]*\|[^\n]*\|\| true/);
});

test('deployment and inspection require Git versions with GIT_NO_LAZY_FETCH support', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-git-version-');
  const fakeGit = path.join(directory, 'git');
  writeExecutable(fakeGit, '#!/bin/bash\nprintf "git version %s\\n" "$TEST_GIT_VERSION"\n');
  const validation = shellSection('validate_git_version() {', 'validate_git_version || fail');
  const runVersion = version => runBash([
    'set -u',
    'NODE_BINARY="$TEST_NODE_BINARY"',
    'GIT_BINARY="$TEST_GIT_BINARY"',
    validation,
    'validate_git_version',
  ].join('\n'), {
    TEST_GIT_BINARY: fakeGit,
    TEST_GIT_VERSION: version,
    TEST_NODE_BINARY: process.execPath,
  });
  for (const version of ['2.39.4', '2.40.2', '2.41.1', '2.42.2', '2.43.4', '2.44.1', '2.45.1', '2.46.0', '3.0.0']) {
    assert.equal(runVersion(version).status, 0, `${version} should be supported`);
  }
  for (const version of ['2.38.99', '2.39.3', '2.40.1', '2.41.0', '2.42.1', '2.43.3', '2.44.0', '2.45.0', 'malformed']) {
    assert.notEqual(runVersion(version).status, 0, `${version} should be rejected`);
  }
  assert.match(inspectRun, /maintenanceFloors = new Map\(\[\[39, 4\].*\[45, 1\]\]\)/);
  assert.match(inspectRun, /minor >= 46/);
});

test('serializes deployments and keeps webhook credentials on the server', () => {
  assert.match(workflow, /concurrency:\s*\n\s+group: merge4appstore-vps\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /DEPLOY_RUN_ID: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /for private_file in "\$DEPLOY_DIR\/\.env" "\$DEPLOY_DIR\/\.webhook\.env"/);
  assert.match(inspectRun, /numeric_permissions & 8#133/);
  assert.match(inspectRun, /deployment will tighten it to mode 0600/);
  assert.match(workflow, /Control \.webhook\.env points outside the private secrets directory/);
  assert.match(deployScript, /CONTROL_WEBHOOK_ENV="\$DEPLOY_DIR\/\.webhook\.env"/);
  assert.match(deployScript, /secure_migratable_private_file "\$CONTROL_ENV"/);
  assert.doesNotMatch(workflow, /write-webhook-env|STAGED_WEBHOOK_ENV|scp[\s\S]*webhook/i);
  assert.doesNotMatch(deployScript, /STAGED_WEBHOOK_ENV/);
  assert.match(workflow, /flock --exclusive --wait 900/);
});

test('tightens safe legacy control files and rejects writable or linked ones', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-control-permissions-');
  const safe = path.join(directory, 'safe.env');
  const writable = path.join(directory, 'writable.env');
  const linked = path.join(directory, 'linked.env');
  fs.writeFileSync(safe, 'SAFE=value\n', { mode: 0o644 });
  fs.writeFileSync(writable, 'UNSAFE=value\n', { mode: 0o666 });
  fs.symlinkSync(safe, linked);
  fs.chmodSync(safe, 0o644);
  fs.chmodSync(writable, 0o666);

  const privateFileFunctions = shellSection(
    'validate_private_file() {',
    'ensure_private_log_file() {',
  );
  const run = file => runBash([
    'set -u',
    portableStatShim,
    'sync() { :; }',
    privateFileFunctions,
    'secure_migratable_private_file "$TEST_CONTROL_FILE"',
  ].join('\n'), {
    TEST_CONTROL_FILE: file,
    TEST_NODE_BINARY: process.execPath,
  });

  const safeResult = run(safe);
  assert.equal(safeResult.status, 0, safeResult.stderr || safeResult.stdout);
  assert.equal(fs.statSync(safe).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(safe, 'utf8'), 'SAFE=value\n');

  const writableResult = run(writable);
  assert.notEqual(writableResult.status, 0, 'group/world-writable control file was accepted');
  assert.equal(fs.statSync(writable).mode & 0o777, 0o666);

  const linkedResult = run(linked);
  assert.notEqual(linkedResult.status, 0, 'linked control file was accepted');
});

test('validates state without following a pre-existing symlink before opening the deploy lock', () => {
  const lstat = workflow.indexOf('stateStat = fs.lstatSync(state)');
  const mkdir = workflow.indexOf('fs.mkdirSync(state, { mode: 0o700 })');
  const lockOpen = workflow.indexOf('exec 9<>"$MERGE4APPSTORE_STATE_DIR/deploy.lock"');
  assert.ok(lstat > 0 && mkdir > lstat && lockOpen > mkdir);
  assert.match(workflow, /stateStat\.isSymbolicLink\(\)/);
  assert.match(workflow, /stateStat\.uid !== process\.getuid\(\)/);
  assert.match(workflow, /merge4appstore-state-v1\\n/);
  assert.match(workflow, /O_NOFOLLOW/);
  assert.match(workflow, /fs\.fsyncSync\(createdFd\)/);
  assert.match(workflow, /fs\.linkSync\(temporary, marker\)/);
  assert.match(workflow, /syncDirectory\(state\)/);
  assert.doesNotMatch(workflow, /mkdir -p \"\$MERGE4APPSTORE_STATE_DIR\"/);
});

test('executes the atomic persistent-state bootstrap and publishes complete private files', t => {
  const root = temporaryDirectory(t, 'merge4appstore-state-bootstrap-');
  const control = path.join(root, 'control');
  const state = path.join(root, 'state');
  fs.mkdirSync(control, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: extractStateBootstrap(),
    encoding: 'utf8',
    env: {
      ...process.env,
      STATE_DIRECTORY: state,
      CONTROL_DIRECTORY: control,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.readFileSync(path.join(state, '.merge4appstore-state'), 'utf8'),
    'merge4appstore-state-v1\n',
  );
  assert.equal(fs.statSync(path.join(state, '.merge4appstore-state')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(state, 'deploy.lock')).mode & 0o777, 0o600);
});

test('builds immutable marked releases without mutating the control checkout', () => {
  const noReplacements = deployRun.indexOf('export GIT_NO_REPLACE_OBJECTS=1');
  const firstIdentityCheck = deployRun.indexOf('git -C "$DEPLOY_DIR" rev-parse --is-inside-work-tree');
  const archive = deployRun.indexOf('git -C "$DEPLOY_DIR" archive --format=tar "$DEPLOY_SHA"');
  assert.ok(noReplacements >= 0 && noReplacements < firstIdentityCheck && firstIdentityCheck < archive);
  assert.match(workflow, /git -C \"\$DEPLOY_DIR\" archive --format=tar \"\$DEPLOY_SHA\"/);
  assert.match(workflow, /releases_dir\/\$DEPLOY_SHA-\$DEPLOY_RUN_ID/);
  assert.match(workflow, /merge4appstore-release-v1/);
  assert.match(workflow, /bash \"\$candidate_release\/scripts\/deploy-vps\.sh\"/);
  assert.doesNotMatch(workflow, /git reset --hard|git checkout --force/);
  assert.equal(parsedWorkflow.jobs.deploy.needs, 'test');
  const ciCommands = parsedWorkflow.jobs.test.steps.map(step => step.run).filter(Boolean);
  assert.ok(ciCommands.includes('npm test'));
  assert.ok(ciCommands.includes('npm run validate:profiles'));
  assert.match(deployScript, /timeout --kill-after=30s 10m npm ci --omit=dev/);
  assert.match(deployScript, /timeout --kill-after=10s 1m npm run validate:profiles/);
  assert.doesNotMatch(deployScript, /npm test/);
  assert.match(deployScript, /if ! \(cd \"\$CANDIDATE_RELEASE\" && timeout 2m npm run prepare:mirrors\); then/);
});

test('journals every mutating boundary and commits before legacy teardown', () => {
  const main = deployScript.slice(deployScript.indexOf('# A new release is already staged'));
  const topology = main.indexOf('write_transaction_phase topology-snapshotted');
  const gate = main.indexOf('activate_delivery_pause "$transaction_dir"');
  const cronPausing = main.indexOf('write_transaction_phase legacy-cron-pausing');
  const cronMutation = main.indexOf('pause_managed_cron "$transaction_dir/crontab.before"');
  const candidateStarting = main.indexOf('write_transaction_phase candidate-starting');
  const candidateStart = main.indexOf('start_release "$CANDIDATE_RELEASE"');
  const nginxSwitching = main.indexOf('write_transaction_phase nginx-switching');
  const nginxMutation = main.indexOf('mv -T -- "$nginx_snippet_new" "$NGINX_SNIPPET"');
  const pointerSwitching = main.indexOf('write_transaction_phase pointers-switching');
  const pointerMutation = main.indexOf('replace_link "$CANDIDATE_RELEASE" "$STATE_DIR/current"');
  const serviceCommitted = main.indexOf('write_transaction_phase service-committed');
  assert.ok(topology >= 0 && topology < gate && gate < cronPausing);
  assert.ok(cronPausing < cronMutation && cronMutation < candidateStarting);
  assert.doesNotMatch(main.slice(gate, cronPausing), /if \[ "\$had_v2" -eq 0 \]/);
  assert.ok(candidateStarting < candidateStart);
  assert.ok(nginxSwitching < nginxMutation);
  assert.ok(pointerSwitching < pointerMutation && pointerMutation < serviceCommitted);

  const finalizer = shellSection('finish_committed_transaction() {', 'recover_interrupted_transactions() {');
  const legacyStop = finalizer.indexOf('pm2 delete "$LEGACY_SERVICE_NAME"');
  const cronInstall = finalizer.indexOf('install_managed_cron');
  const gateClear = finalizer.indexOf('clear_delivery_pause');
  const hookConfigure = finalizer.indexOf('configure_repository_hooks');
  assert.ok(legacyStop >= 0 && legacyStop < cronInstall);
  assert.ok(cronInstall < gateClear && gateClear < hookConfigure);
});

test('deletes the legacy server only after observable job quiescence', t => {
  const drainFunctions = shellSection('legacy_descendant_count() {', 'validate_transaction_envelope() {');
  const directory = temporaryDirectory(t, 'merge4appstore-legacy-drain-');
  const result = runBash([
    'set -u',
    'DRAIN_TIMEOUT_MS=10000',
    'LEGACY_DRAIN_QUIET_SECONDS=5',
    'activity_sequence="1 0 0 0 0"',
    'printf "0\\n" > "$TEST_DIRECTORY/activity-index"',
    'sleep() { :; }',
    drainFunctions,
    'legacy_activity_count() {',
    '  local activity_index values',
    '  activity_index=$(( $(cat "$TEST_DIRECTORY/activity-index") + 1 ))',
    '  printf "%s\\n" "$activity_index" > "$TEST_DIRECTORY/activity-index"',
    '  values=( $activity_sequence )',
    '  printf "%s" "${values[$((activity_index - 1))]:-0}"',
    '}',
    'wait_for_legacy_drain || exit 10',
    '[ "$(cat "$TEST_DIRECTORY/activity-index")" -ge 4 ] || exit 11',
    'DRAIN_TIMEOUT_MS=6000',
    'activity_sequence="1 1 1 1 1"',
    'printf "0\\n" > "$TEST_DIRECTORY/activity-index"',
    'if wait_for_legacy_drain; then exit 12; fi',
  ].join('\n'), { TEST_DIRECTORY: directory });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const finalizer = shellSection('finish_committed_transaction() {', 'recover_interrupted_transactions() {');
  const wait = finalizer.indexOf('wait_for_legacy_drain');
  const finalObservation = finalizer.indexOf('[ "$(legacy_activity_count)" = "0" ]');
  const legacyDelete = finalizer.indexOf('pm2 delete "$LEGACY_SERVICE_NAME"');
  assert.ok(wait >= 0 && wait < finalObservation && finalObservation < legacyDelete);
  assert.match(deployScript, /ps -eo pid=,ppid=/);
  assert.match(deployScript, /\.merge4appstore-\*\.lock/);
});

test('uses a durable, owner-checked delivery pause gate', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-pause-');
  const pauseFunctions = shellSection('activate_delivery_pause() {', 'restore_crontab_exact() {')
    .replaceAll('mv -Tf -- ', 'mv ');
  const result = runBash([
    'set -u',
    'STATE_DIR="$TEST_DIRECTORY"',
    'DELIVERY_PAUSE_FILE="$STATE_DIR/delivery.pause"',
    'DEPLOY_RUN_ID=run-1',
    'sync() { :; }',
    pauseFunctions,
    'validate_private_file() { [ ! -L "$1" ] && [ -f "$1" ]; }',
    'activate_delivery_pause transaction-one || exit 10',
    '[ "$(cat "$DELIVERY_PAUSE_FILE")" = transaction-one ] || exit 11',
    'if clear_delivery_pause transaction-two; then exit 12; fi',
    '[ -f "$DELIVERY_PAUSE_FILE" ] || exit 13',
    'clear_delivery_pause transaction-one || exit 14',
    '[ ! -e "$DELIVERY_PAUSE_FILE" ] && [ ! -L "$DELIVERY_PAUSE_FILE" ] || exit 15',
  ].join('\n'), { TEST_DIRECTORY: directory });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(deployScript, /MERGE4APPSTORE_DELIVERY_PAUSE_FILE="\$DELIVERY_PAUSE_FILE"/);
  assert.doesNotMatch(deployScript, /DELIVERY_PAUSED_UNTIL|paused\.until/);
});

test('routes interrupted phases to rollback, forward recovery, or idempotent cleanup', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-recovery-');
  const recoveryFunction = shellSection('recover_interrupted_transactions() {', 'rollback() {');
  const result = runBash([
    'set -u',
    'TRANSACTIONS_DIR="$TEST_DIRECTORY"',
    'LOG="$TEST_DIRECTORY/events"',
    'for item in a-snapshot b-precommit c-postcommit d-cleanup e-terminal; do mkdir "$TRANSACTIONS_DIR/$item"; done',
    'printf "snapshot-complete\n" > "$TRANSACTIONS_DIR/a-snapshot/phase"',
    'printf "candidate-starting\n" > "$TRANSACTIONS_DIR/b-precommit/phase"',
    'printf "service-committed\n" > "$TRANSACTIONS_DIR/c-postcommit/phase"',
    'printf "rollback-verified\n" > "$TRANSACTIONS_DIR/d-cleanup/phase"',
    'printf "complete\n" > "$TRANSACTIONS_DIR/e-terminal/phase"',
    'read_transaction_value() { cat "$1/$2" 2>/dev/null || true; }',
    'validate_transaction_envelope() { :; }',
    'validate_interrupted_transaction() { :; }',
    'write_transaction_phase_for() { printf "%s\n" "$2" > "$1/phase"; printf "phase:%s:%s\n" "$(basename "$1")" "$2" >> "$LOG"; }',
    'cleanup_candidate_artifacts() { printf "cleanup\n" >> "$LOG"; }',
    'rollback_interrupted_transaction() { printf "rollback:%s\n" "$(basename "$1")" >> "$LOG"; write_transaction_phase_for "$1" recovered-rolled-back; }',
    'finish_committed_transaction() { printf "finish:%s\n" "$(basename "$1")" >> "$LOG"; write_transaction_phase_for "$1" complete; }',
    'fail() { printf "FAIL:%s\n" "$*" >&2; exit 90; }',
    recoveryFunction,
    'recover_interrupted_transactions "$TRANSACTIONS_DIR/skip" || exit 20',
    '[ "$(find "$TRANSACTIONS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d " ")" = 0 ] || exit 21',
    'cat "$LOG"',
  ].join('\n'), { TEST_DIRECTORY: directory });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /cleanup/);
  assert.match(result.stdout, /rollback:b-precommit/);
  assert.match(result.stdout, /finish:c-postcommit/);
  assert.match(result.stdout, /phase:d-cleanup:recovered-rolled-back/);
  assert.doesNotMatch(result.stdout, /rollback:e-terminal|finish:e-terminal/);
  assert.match(deployScript, /nginx-switching\|nginx-switched\|pointers-switching/);
  assert.match(deployScript, /service-committed\|committed\|legacy-draining\|legacy-stopped\|cron-configured\|hooks-configured\|reconciled/);
});

test('same-run recovery keeps the last distinct rollback release', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-same-run-recovery-');
  const releases = path.join(directory, 'releases');
  const current = path.join(releases, `${'a'.repeat(40)}-123-1`);
  const previous = path.join(releases, `${'b'.repeat(40)}-122-1`);
  const candidate = path.join(releases, `${'a'.repeat(40)}-123-2`);
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(previous);
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(current, '.merge4appstore-release'), 'merge4appstore-release-v1\n');
  fs.writeFileSync(path.join(current, '.merge4appstore-deployment-sha'), `${'a'.repeat(40)}\n`);
  const rerunFunction = shellSection('finish_recovered_rerun() {', 'recover_interrupted_transactions() {');
  const result = runBash([
    'set -u',
    `DEPLOY_SHA=${'a'.repeat(40)}`,
    'DEPLOY_RUN_ID=123-2',
    'STATE_DIR="$TEST_DIRECTORY/state"',
    'RELEASES_DIR="$TEST_RELEASES"',
    'SERVICE_HOST=127.0.0.1',
    'SERVICE_PORT=8788',
    'PUBLIC_BASE_URL=https://example.invalid/service',
    'CANDIDATE_RELEASE="$TEST_CANDIDATE"',
    'candidate_secret="$TEST_DIRECTORY/candidate.env"',
    'validate_state_link() { printf "%s" "$TEST_CURRENT"; }',
    'verify_health_url() { printf "health:%s\n" "$2" >> "$TEST_DIRECTORY/events"; }',
    'write_transaction_phase() { printf "phase:%s\n" "$1" >> "$TEST_DIRECTORY/events"; }',
    'cleanup_candidate_artifacts() { printf "cleanup:%s\n" "$1" >> "$TEST_DIRECTORY/events"; rm -rf -- "$1"; }',
    rerunFunction,
    'finish_recovered_rerun || exit 10',
    '[ -d "$TEST_CURRENT" ] || exit 11',
    '[ -d "$TEST_PREVIOUS" ] || exit 12',
    '[ ! -e "$TEST_CANDIDATE" ] || exit 13',
    'cat "$TEST_DIRECTORY/events"',
  ].join('\n'), {
    TEST_DIRECTORY: directory,
    TEST_RELEASES: releases,
    TEST_CURRENT: current,
    TEST_PREVIOUS: previous,
    TEST_CANDIDATE: candidate,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /phase:untouched-cleanup/);
  assert.match(result.stdout, /cleanup:.*-123-2/);
  const recovery = deployScript.indexOf('recover_interrupted_transactions "$transaction_dir"');
  const pauseInvariant = deployScript.indexOf('An unowned delivery pause gate remains after transaction recovery');
  const shortcut = deployScript.indexOf('if finish_recovered_rerun; then');
  assert.ok(recovery >= 0 && recovery < pauseInvariant && pauseInvariant < shortcut);
});

test('same-run recovery treats cleanup failure as fatal after journaling', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-same-run-cleanup-failure-');
  const current = path.join(directory, `${'a'.repeat(40)}-123-1`);
  fs.mkdirSync(current);
  fs.writeFileSync(path.join(current, '.merge4appstore-release'), 'merge4appstore-release-v1\n');
  fs.writeFileSync(path.join(current, '.merge4appstore-deployment-sha'), `${'a'.repeat(40)}\n`);
  const rerunFunction = shellSection('finish_recovered_rerun() {', 'recover_interrupted_transactions() {');
  const result = runBash([
    'set -u',
    `DEPLOY_SHA=${'a'.repeat(40)}`,
    'DEPLOY_RUN_ID=123-2',
    'STATE_DIR="$TEST_DIRECTORY/state"',
    'RELEASES_DIR="$TEST_DIRECTORY"',
    'SERVICE_HOST=127.0.0.1',
    'SERVICE_PORT=8788',
    'PUBLIC_BASE_URL=https://example.invalid/service',
    'CANDIDATE_RELEASE="$TEST_DIRECTORY/candidate"',
    'candidate_secret="$TEST_DIRECTORY/candidate.env"',
    'validate_state_link() { printf "%s" "$TEST_CURRENT"; }',
    'verify_health_url() { :; }',
    'write_transaction_phase() { printf "%s\n" "$1" > "$TEST_DIRECTORY/phase"; }',
    'cleanup_candidate_artifacts() { return 1; }',
    rerunFunction,
    'if finish_recovered_rerun; then exit 10; else status=$?; fi',
    '[ "$status" -eq 1 ] || exit 11',
    '[ "$(cat "$TEST_DIRECTORY/phase")" = untouched-cleanup ] || exit 12',
  ].join('\n'), { TEST_DIRECTORY: directory, TEST_CURRENT: current });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(deployScript, /recovered_rerun_status[\s\S]*redundant candidate cleanup failed/);
});

test('same-SHA manual deployments preserve the distinct previous rollback pair', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-same-sha-rollback-');
  const current = path.join(directory, 'current');
  const previous = path.join(directory, 'previous');
  fs.mkdirSync(current);
  fs.mkdirSync(previous);
  fs.writeFileSync(path.join(current, '.merge4appstore-deployment-sha'), `${'a'.repeat(40)}\n`);
  fs.writeFileSync(path.join(previous, '.merge4appstore-deployment-sha'), `${'b'.repeat(40)}\n`);
  const selector = shellSection('select_commit_previous() {', 'normalize_committed_pointers() {');
  const result = runBash([
    'set -u',
    selector,
    `select_commit_previous ${'a'.repeat(40)} "$TEST_CURRENT" current.env "$TEST_PREVIOUS" previous.env || exit 10`,
    '[ "$commit_previous_release" = "$TEST_PREVIOUS" ] || exit 11',
    '[ "$commit_previous_secret" = previous.env ] || exit 12',
    `select_commit_previous ${'c'.repeat(40)} "$TEST_CURRENT" current.env "$TEST_PREVIOUS" previous.env || exit 13`,
    '[ "$commit_previous_release" = "$TEST_CURRENT" ] || exit 14',
    '[ "$commit_previous_secret" = current.env ] || exit 15',
  ].join('\n'), { TEST_CURRENT: current, TEST_PREVIOUS: previous });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('preserves a post-commit journal instead of attempting an unsafe rollback', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-postcommit-');
  const transaction = path.join(directory, 'transaction');
  fs.mkdirSync(transaction);
  fs.writeFileSync(path.join(transaction, 'phase'), 'service-committed\n');
  const exitFunction = shellSection('on_exit() {', "trap 'on_exit $?' EXIT");
  const result = runBash([
    'set -u',
    'TRANSACTIONS_DIR="$TEST_DIRECTORY"',
    'transaction_dir="$TEST_TRANSACTION"',
    'candidate_secret_new="$TEST_DIRECTORY/candidate.new"',
    'rollback_preserve=0',
    'ROLLBACK_LOG="$TEST_DIRECTORY/rollback-called"',
    'read_transaction_value() { cat "$1/$2"; }',
    'rollback() { printf "called\n" > "$ROLLBACK_LOG"; }',
    exitFunction,
    'on_exit 17',
  ].join('\n'), { TEST_DIRECTORY: directory, TEST_TRANSACTION: transaction });
  assert.equal(result.status, 17, result.stderr || result.stdout);
  assert.equal(fs.existsSync(transaction), true);
  assert.equal(fs.existsSync(path.join(directory, 'rollback-called')), false);
  assert.match(result.stderr, /preserving transaction for idempotent recovery/);
});

test('keeps the pause gate and candidate evidence when legacy route restoration fails', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-rollback-');
  const rollbackFunction = shellSection('rollback_interrupted_transaction() {', 'finish_committed_transaction() {');
  const result = runBash([
    'set -u',
    'LOG="$TEST_DIRECTORY/events"',
    'V2_STATE="$TEST_DIRECTORY/v2-state"',
    'SOURCE="$TEST_DIRECTORY/transaction"',
    'mkdir "$SOURCE"',
    'printf "1\n" > "$V2_STATE"',
    'SERVICE_HOST=127.0.0.1',
    'SERVICE_PORT=8788',
    'PUBLIC_BASE_URL=https://example.invalid/service',
    'LEGACY_SERVICE_NAME=legacy',
    'SERVICE_NAME=v2',
    'read_transaction_value() {',
    '  case "$2" in',
    '    candidate-release) printf "/candidate-release" ;;',
    '    candidate-secret) printf "/candidate-secret" ;;',
    '    had-v2) printf "0" ;;',
    '    had-legacy) printf "1" ;;',
    '    legacy-sha) printf "%040d" 1 ;;',
    '    phase) printf "nginx-switching" ;;',
    '    old-current|old-current-secret) printf "" ;;',
    '  esac',
    '}',
    'pm2_app_count() { if [ "$1" = "$LEGACY_SERVICE_NAME" ]; then printf "1"; else cat "$V2_STATE"; fi; }',
    'verify_health_url() { printf "health:%s\n" "$1" >> "$LOG"; }',
    'restore_nginx_snapshot() { printf "nginx\n" >> "$LOG"; [ "${FAIL_NGINX:-0}" -eq 0 ]; }',
    'pm2() {',
    '  if [ "$1" = delete ]; then printf "0\n" > "$V2_STATE"; printf "pm2-delete\n" >> "$LOG";',
    '  else printf "pm2-save\n" >> "$LOG"; fi',
    '}',
    'restore_pointer_snapshot() { printf "pointers\n" >> "$LOG"; }',
    'restore_crontab_exact() { printf "cron\n" >> "$LOG"; }',
    'clear_delivery_pause() { printf "clear\n" >> "$LOG"; }',
    'secure_pm2_home() { printf "secure\n" >> "$LOG"; }',
    'cleanup_candidate_artifacts() { printf "cleanup\n" >> "$LOG"; }',
    'write_transaction_phase_for() { printf "phase:%s\n" "$2" >> "$LOG"; }',
    'start_release() { :; }',
    'validate_pm2_release() { :; }',
    rollbackFunction,
    'FAIL_NGINX=1',
    'if rollback_interrupted_transaction "$SOURCE"; then exit 20; fi',
    'if grep -Eq "cron|clear|pm2-delete|cleanup|rollback-verified" "$LOG"; then cat "$LOG"; exit 21; fi',
    ': > "$LOG"',
    'printf "1\n" > "$V2_STATE"',
    'FAIL_NGINX=0',
    'rollback_interrupted_transaction "$SOURCE" || exit 22',
    'cat "$LOG"',
  ].join('\n'), { TEST_DIRECTORY: directory });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = result.stdout.trim().split('\n');
  for (const event of ['nginx', 'pm2-delete', 'pointers', 'cron', 'clear', 'phase:rollback-verified', 'cleanup', 'phase:recovered-rolled-back']) {
    assert.ok(events.includes(event), 'missing ' + event + ': ' + result.stdout);
  }
  assert.ok(events.indexOf('clear') < events.indexOf('phase:rollback-verified'));
  assert.ok(events.indexOf('phase:rollback-verified') < events.indexOf('cleanup'));
  assert.match(deployScript, /Rollback was incomplete\. Preserving candidate release, secret, and transaction evidence/);
});

test('refuses candidate cleanup while a pointer or PM2 still references it', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-cleanup-');
  const releases = path.join(directory, 'releases');
  const secrets = path.join(directory, 'secrets');
  const state = path.join(directory, 'state');
  const release = path.join(releases, 'candidate');
  const secret = path.join(secrets, 'candidate.env');
  fs.mkdirSync(release, { recursive: true });
  fs.mkdirSync(secrets);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(release, '.merge4appstore-release'), 'merge4appstore-release-v1\n');
  fs.writeFileSync(secret, 'secret\n', { mode: 0o600 });
  fs.symlinkSync(release, path.join(state, 'current'));
  const cleanupFunction = shellSection('cleanup_candidate_artifacts() {', 'shell_quote() {');
  const result = runBash([
    'set -u',
    'RELEASES_DIR="$TEST_RELEASES"',
    'SECRETS_DIR="$TEST_SECRETS"',
    'STATE_DIR="$TEST_STATE"',
    'CONTROL_WEBHOOK_ENV="$TEST_DIRECTORY/control.env"',
    'pm2() {',
    '  if [ "${PM2_REF:-0}" -eq 1 ]; then printf "[{\\"pm2_env\\":{\\"pm_cwd\\":\\"%s\\"}}]" "$TEST_RELEASE";',
    '  else printf "[]"; fi',
    '}',
    'validate_private_file() { [ ! -L "$1" ] && [ -f "$1" ]; }',
    cleanupFunction,
    'if cleanup_candidate_artifacts "$TEST_RELEASE" "$TEST_SECRET"; then exit 10; fi',
    '[ -d "$TEST_RELEASE" ] && [ -f "$TEST_SECRET" ] || exit 11',
    'rm "$TEST_STATE/current"',
    'PM2_REF=1',
    'if cleanup_candidate_artifacts "$TEST_RELEASE" "$TEST_SECRET"; then exit 12; fi',
    '[ -d "$TEST_RELEASE" ] && [ -f "$TEST_SECRET" ] || exit 13',
    'PM2_REF=0',
    'cleanup_candidate_artifacts "$TEST_RELEASE" "$TEST_SECRET" || exit 14',
    '[ ! -e "$TEST_RELEASE" ] && [ ! -e "$TEST_SECRET" ] || exit 15',
  ].join('\n'), {
    TEST_DIRECTORY: directory,
    TEST_RELEASES: releases,
    TEST_SECRETS: secrets,
    TEST_STATE: state,
    TEST_RELEASE: release,
    TEST_SECRET: secret,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('restores the exact server-side webhook control file or symlink topology', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-control-secret-');
  const secrets = path.join(directory, 'secrets');
  const transaction = path.join(directory, 'transaction');
  const control = path.join(directory, '.webhook.env');
  const oldSecret = path.join(secrets, 'old.env');
  const candidateSecret = path.join(secrets, 'candidate.env');
  fs.mkdirSync(secrets);
  fs.mkdirSync(transaction);
  fs.writeFileSync(oldSecret, 'secret=old\n', { mode: 0o600 });
  fs.writeFileSync(candidateSecret, 'secret=candidate\n', { mode: 0o600 });
  fs.writeFileSync(path.join(transaction, 'control-webhook.env'), 'secret=legacy\n', { mode: 0o600 });
  fs.writeFileSync(path.join(transaction, 'control-secret-kind'), 'file\n', { mode: 0o600 });
  fs.writeFileSync(path.join(transaction, 'control-secret-target'), '', { mode: 0o600 });
  fs.symlinkSync(candidateSecret, control);

  const restoreFunction = shellSection('restore_control_secret_snapshot() {', 'restore_pointer_snapshot() {')
    .replaceAll('mv -Tf -- ', 'mv -f ');
  const result = runBash([
    'set -u',
    'SECRETS_DIR="$(readlink -f -- "$TEST_SECRETS")"',
    'CONTROL_WEBHOOK_ENV="$TEST_CONTROL"',
    'read_transaction_value() { cat "$1/$2"; }',
    'validate_private_file() { [ ! -L "$1" ] && [ -f "$1" ]; }',
    'install() { cp "$4" "$5" && chmod "$2" "$5"; }',
    'sync() { :; }',
    restoreFunction,
    'restore_control_secret_snapshot "$TEST_TRANSACTION" || exit 10',
    '[ ! -L "$CONTROL_WEBHOOK_ENV" ] && cmp -s "$CONTROL_WEBHOOK_ENV" "$TEST_TRANSACTION/control-webhook.env" || exit 11',
    'printf "link\n" > "$TEST_TRANSACTION/control-secret-kind"',
    'printf "%s\n" "$TEST_OLD_SECRET" > "$TEST_TRANSACTION/control-secret-target"',
    'ln -s "$TEST_CANDIDATE_SECRET" "$CONTROL_WEBHOOK_ENV.new"',
    'mv -f "$CONTROL_WEBHOOK_ENV.new" "$CONTROL_WEBHOOK_ENV"',
    'restore_control_secret_snapshot "$TEST_TRANSACTION" || exit 12',
    '[ -L "$CONTROL_WEBHOOK_ENV" ] || exit 13',
    '[ "$(readlink -- "$CONTROL_WEBHOOK_ENV")" = "$TEST_OLD_SECRET" ] || exit 14',
    '[ "$(readlink -f -- "$CONTROL_WEBHOOK_ENV")" = "$(readlink -f -- "$TEST_OLD_SECRET")" ] || exit 15',
  ].join('\n'), {
    TEST_SECRETS: secrets,
    TEST_CONTROL: control,
    TEST_TRANSACTION: transaction,
    TEST_OLD_SECRET: oldSecret,
    TEST_CANDIDATE_SECRET: candidateSecret,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('nginx snapshot restoration atomically publishes both live files', () => {
  const restoreFunction = shellSection('restore_nginx_snapshot() {', 'validate_logging_contract() {');
  assert.match(
    restoreFunction,
    /install_atomic_copy "\$source\/nginx-site\.conf" "\$config" "\$config_mode"/,
  );
  assert.match(
    restoreFunction,
    /install_atomic_copy "\$source\/nginx-snippet\.conf" "\$NGINX_SNIPPET" "\$snippet_mode"/,
  );
  assert.doesNotMatch(restoreFunction, /\bcp\s+(?:-[^\s]+\s+)*--\s+"\$source\/nginx-/);
});

test('atomic snapshot publication leaves the live file intact when rename fails', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-nginx-restore-');
  const source = path.join(directory, 'nginx-site.snapshot');
  const destination = path.join(directory, 'nginx-site.conf');
  fs.writeFileSync(source, 'server { # previous\n}\n', { mode: 0o640 });
  fs.writeFileSync(destination, 'server { # candidate\n}\n', { mode: 0o600 });
  const atomicCopy = shellSection('install_atomic_copy() {', 'restore_optional_managed_file() {');
  const result = runBash([
    'set -u',
    'validate_owned_regular_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }',
    'sync() { printf "%s\n" "$2" >> "$TEST_SYNC_LOG"; }',
    'mv() {',
    '  if [ "${FAIL_PUBLISH:-0}" = 1 ]; then return 7; fi',
    '  command mv "$3" "$4"',
    '}',
    portableStatShim,
    atomicCopy,
    'source_mode="$(stat -c "%a" "$TEST_SOURCE")"',
    'FAIL_PUBLISH=1',
    'if install_atomic_copy "$TEST_SOURCE" "$TEST_DESTINATION" "$source_mode"; then exit 10; fi',
    'grep -Fq "candidate" "$TEST_DESTINATION" || exit 11',
    'if compgen -G "$TEST_DIRECTORY/.merge4appstore-managed.*" >/dev/null; then exit 12; fi',
    'FAIL_PUBLISH=0',
    'install_atomic_copy "$TEST_SOURCE" "$TEST_DESTINATION" "$source_mode" || exit 13',
    'cmp -s "$TEST_SOURCE" "$TEST_DESTINATION" || exit 14',
    '[ "$(stat -c "%u:%g:%a" "$TEST_DESTINATION")" = "$(stat -c "%u:%g:%a" "$TEST_SOURCE")" ] || exit 15',
    'if compgen -G "$TEST_DIRECTORY/.merge4appstore-managed.*" >/dev/null; then exit 16; fi',
    'grep -Fxq "$TEST_DIRECTORY" "$TEST_SYNC_LOG" || exit 17',
  ].join('\n'), {
    TEST_DESTINATION: destination,
    TEST_DIRECTORY: directory,
    TEST_NODE_BINARY: process.execPath,
    TEST_SOURCE: source,
    TEST_SYNC_LOG: path.join(directory, 'sync.log'),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('targets the configured TLS nginx host instead of a hard-coded domain', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-nginx-target-');
  const config = path.join(directory, 'site.conf');
  fs.writeFileSync(config, [
    'server {',
    '  listen 80;',
    '  server_name hooks.example.test;',
    '}',
    'server {',
    '  listen [::]:443 ssl http2;',
    '  server_name hooks.example.test another.example.test;',
    '}',
    '',
  ].join('\n'), { mode: 0o640 });
  const installFunction = shellSection('install_nginx_include() {', 'activate_delivery_pause() {');
  const result = runBash([
    'set -u',
    'NGINX_SERVER_NAME=hooks.example.test',
    'NGINX_SNIPPET=/etc/nginx/snippets/merge4appstore-webhooks.conf',
    installFunction,
    'install_nginx_include "$TEST_CONFIG" || exit 10',
    'NGINX_SERVER_NAME=api.runningorder.app',
    'if install_nginx_include "$TEST_CONFIG"; then exit 11; fi',
  ].join('\n'), { TEST_CONFIG: config });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const updated = fs.readFileSync(config, 'utf8');
  assert.equal(updated.split('include /etc/nginx/snippets/merge4appstore-webhooks.conf;').length - 1, 1);
  assert.match(updated, /listen \[::\]:443 ssl http2;\n  server_name hooks\.example\.test another\.example\.test;\n  include/);
  assert.equal(fs.statSync(config).mode & 0o777, 0o640);
  assert.doesNotMatch(deployScript, /server_name api\\\.runningorder\\\.app/);
});

test('atomically restores or removes transaction-managed configuration', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-managed-config-');
  const source = path.join(directory, 'snapshot');
  const destination = path.join(directory, 'managed.conf');
  fs.writeFileSync(source, 'before\n', { mode: 0o600 });
  fs.writeFileSync(destination, 'after\n', { mode: 0o644 });
  const managedFunctions = shellSection('install_atomic_copy() {', 'write_nginx_observability_configuration() {');
  const result = runBash([
    'set -u',
    'validate_owned_regular_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }',
    'sync() { :; }',
    'mv() { command mv "$3" "$4"; }',
    portableStatShim,
    managedFunctions,
    'restore_optional_managed_file "$TEST_SOURCE" "$TEST_DESTINATION" 1 644 || exit 10',
    'cmp -s "$TEST_SOURCE" "$TEST_DESTINATION" || exit 11',
    '[ "$(stat -c "%a" "$TEST_DESTINATION" 2>/dev/null || stat -f "%Lp" "$TEST_DESTINATION")" = 644 ] || exit 12',
    'restore_optional_managed_file "$TEST_DIRECTORY/missing" "$TEST_DESTINATION" 0 644 || exit 13',
    '[ ! -e "$TEST_DESTINATION" ] && [ ! -L "$TEST_DESTINATION" ] || exit 14',
  ].join('\n'), {
    TEST_DIRECTORY: directory,
    TEST_SOURCE: source,
    TEST_DESTINATION: destination,
    TEST_NODE_BINARY: process.execPath,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('enforces disk headroom only after transaction recovery and again before cutover', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-disk-headroom-');
  const fakeNode = path.join(directory, 'node');
  writeExecutable(fakeNode, [
    '#!/bin/bash',
    '[ "$DISK_MIN_FREE_BYTES" = 1 ]',
    '',
  ].join('\n'));
  const diskFunction = shellSection('ensure_disk_headroom() {', 'install_atomic_copy() {');
  const result = runBash([
    'set -u',
    'NODE_BINARY="$TEST_NODE_BINARY"',
    'MIN_FREE_BYTES=1',
    'MIN_FREE_PERCENT=1',
    diskFunction,
    'ensure_disk_headroom "$TEST_DIRECTORY" || exit 10',
    'MIN_FREE_BYTES=999999999999999999',
    'if ensure_disk_headroom "$TEST_DIRECTORY"; then exit 11; fi',
  ].join('\n'), { TEST_DIRECTORY: directory, TEST_NODE_BINARY: fakeNode });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(diskFunction, /fs\.statfsSync/);
  assert.match(diskFunction, /BigInt\(stats\.bavail\) \* BigInt\(stats\.bsize\)/);
  assert.match(deployScript, /MIN_FREE_BYTES" -lt 1073741824/);
  assert.match(deployScript, /MIN_FREE_PERCENT" -lt 10/);

  const main = deployScript.slice(deployScript.indexOf('# A new release is already staged'));
  const recovery = main.indexOf('recover_interrupted_transactions "$transaction_dir"');
  const firstGate = main.indexOf('ensure_disk_headroom "$STATE_DIR"');
  const install = main.indexOf('npm ci --omit=dev');
  const secondGate = main.indexOf('ensure_disk_headroom "$STATE_DIR"', firstGate + 1);
  const nginxSwitch = main.indexOf('write_transaction_phase nginx-switching');
  assert.ok(recovery >= 0 && recovery < firstGate && firstGate < install);
  assert.ok(install < secondGate && secondGate < nginxSwitch);
});

test('rejects an HTTP failure even when its body looks healthy', () => {
  const verifyFunction = shellSection('verify_health_url() {', 'install_nginx_include() {');
  const expectedSha = 'a'.repeat(40);
  const result = runBash([
    'set -u',
    'sleep() { :; }',
    `HEALTH_BODY='{"ok":true,"deployment_sha":"${expectedSha}"}'`,
    'curl() { printf "%s" "$HEALTH_BODY"; return "${CURL_STATUS:-0}"; }',
    verifyFunction,
    'CURL_STATUS=22',
    `if verify_health_url https://example.invalid/health ${expectedSha} failed-http; then exit 10; fi`,
    'CURL_STATUS=0',
    `verify_health_url https://example.invalid/health ${expectedSha} healthy || exit 11`,
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('verifies an ambiguous hook POST before retrying creation', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-hook-');
  const hookFunctions = shellSection('read_hook_id() {', 'configure_repository_hooks() {');
  const result = runBash([
    'set -u',
    'CREATE_COUNT="$TEST_DIRECTORY/create-count"',
    'VERIFY_COUNT="$TEST_DIRECTORY/verify-count"',
    'printf "0\n" > "$CREATE_COUNT"',
    'printf "0\n" > "$VERIFY_COUNT"',
    'sleep() { :; }',
    'retry_capture() {',
    '  result_name="$1"; description="$2"',
    '  if printf "%s" "$description" | grep -q "hook creation for"; then',
    '    count="$(cat "$CREATE_COUNT")"; printf "%s\n" "$((count + 1))" > "$CREATE_COUNT"; return 1',
    '  fi',
    '  count="$(cat "$VERIFY_COUNT")"; printf "%s\n" "$((count + 1))" > "$VERIFY_COUNT"',
    '  printf -v "$result_name" "%s" "[[{\\"id\\":7,\\"config\\":{\\"url\\":\\"https://example.invalid/hook\\"}}]]"',
    '}',
    hookFunctions,
    'create_repository_hook_safely token owner/repo https://example.invalid/hook payload.json "$TEST_DIRECTORY" instance || exit 10',
    '[ "$(cat "$CREATE_COUNT")" -eq 1 ] || exit 11',
    '[ "$(cat "$VERIFY_COUNT")" -eq 1 ] || exit 12',
  ].join('\n'), { TEST_DIRECTORY: directory });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('fails closed when GitHub returns duplicate exact webhook URLs', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-duplicate-hook-');
  const unique = path.join(directory, 'unique.json');
  const duplicate = path.join(directory, 'duplicate.json');
  fs.writeFileSync(unique, JSON.stringify([[
    { id: 7, config: { url: 'https://example.invalid/hook' } },
    { id: 9, config: { url: 'https://example.invalid/other' } },
  ]]));
  fs.writeFileSync(duplicate, JSON.stringify([[
    { id: 7, config: { url: 'https://example.invalid/hook' } },
    { id: 8, config: { url: 'https://example.invalid/hook' } },
  ]]));
  const readHook = shellSection('read_hook_id() {', 'create_repository_hook_safely() {');
  const result = runBash([
    'set -u',
    readHook,
    'hook_id="$(read_hook_id "$TEST_UNIQUE" https://example.invalid/hook)" || exit 10',
    '[ "$hook_id" = 7 ] || exit 11',
    'if read_hook_id "$TEST_DUPLICATE" https://example.invalid/hook > "$TEST_DIRECTORY/output" 2> "$TEST_DIRECTORY/error"; then exit 12; fi',
    'grep -Fq "Duplicate GitHub hooks for https://example.invalid/hook: 7, 8" "$TEST_DIRECTORY/error" || exit 13',
    '[ ! -s "$TEST_DIRECTORY/output" ] || exit 14',
  ].join('\n'), {
    TEST_DIRECTORY: directory,
    TEST_UNIQUE: unique,
    TEST_DUPLICATE: duplicate,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('loads secrets from private files without persisting their values in PM2', () => {
  assert.match(deployScript, /MERGE4APPSTORE_ENV=\"\$CONTROL_ENV\"/);
  assert.match(deployScript, /MERGE4APPSTORE_WEBHOOK_ENV=\"\$secret_file\"/);
  assert.match(deployScript, /persisted forbidden secret/);
  assert.match(deployScript, /APP_STORE_CONNECT_API_\*\|GH_TOKEN\|GH_WEBHOOK_SECRET/);
  assert.match(deployScript, /pm2_env[\s\S]*MERGE4APPSTORE_WEBHOOK_ENV/);
  assert.match(ecosystem, /filter_env:[\s\S]*'GH_TOKEN'[\s\S]*'MERGE4APPSTORE_BUILD_TOKEN_'/);
  assert.match(ecosystem, /env:[\s\S]*DRY_RUN: 'false'[\s\S]*RECONCILE_METADATA: 'false'/);
  assert.match(ecosystem, /filter_env:[\s\S]*'BUILD_'[\s\S]*'DRY_RUN'/);
  assert.match(webhookServer, /MERGE4APPSTORE_ENV/);
  assert.match(webhookServer, /MERGE4APPSTORE_WEBHOOK_ENV/);
  assert.match(webhookServer, /override: true/);
  assert.match(deployScript, /v1\/builds\/prepare\/\$instance/);
  assert.match(deployScript, /install -m 600 -- "\$CONTROL_WEBHOOK_ENV" "\$candidate_secret_new"/);
  assert.match(deployScript, /cmp -s -- "\$CONTROL_WEBHOOK_ENV" "\$candidate_secret"/);
  assert.match(workflow, /"\$state_dir\/secrets\/"\*/);
  assert.doesNotMatch(workflow, /write-webhook-env|STAGED_WEBHOOK_ENV/);
  assert.match(deployScript, /readEnvironmentFile/);
  assert.match(deployScript, /access_log .*NGINX_ACCESS_LOG.*merge4appstore_upstream_v1/);
  assert.doesNotMatch(deployScript, /access_log off/);
  assert.match(deployScript, /error_log \/dev\/null crit/);
});

test('records URI-free JSON upstream diagnostics and journals their configuration', () => {
  const format = deployScript.match(/cat > "\$output" <<'NGINX'\n([\s\S]*?)\nNGINX/);
  assert.ok(format, 'sanitized nginx format must be extractable');
  const variables = [...format[1].matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(match => match[1]).sort();
  assert.deepEqual(variables, [
    'bytes_sent',
    'request_id',
    'request_method',
    'request_time',
    'status',
    'time_iso8601',
    'upstream_addr',
    'upstream_connect_time',
    'upstream_header_time',
    'upstream_response_time',
    'upstream_status',
  ]);
  assert.doesNotMatch(format[1], /\$(?:request_uri|uri|args|request_body|remote_addr|http_[A-Za-z0-9_]*)\b/);
  assert.match(deployScript, /add_header X-Merge4AppStore-Request-ID \$request_id always/);
  assert.match(deployScript, /proxy_set_header X-Merge4AppStore-Request-ID \$request_id/);
  assert.match(deployScript, /managed-config-snapshot-version/);
  assert.match(deployScript, /nginx-observability-existed/);
  assert.match(deployScript, /restore_optional_managed_file[\s\S]*NGINX_OBSERVABILITY_CONFIG/);
  assert.match(deployScript, /managed_snapshot_version[\s\S]*''\) return 0/);
});

test('bounds private state and PM2 logs with rootless managed rotation', () => {
  assert.match(deployScript, /LOGROTATE_CONFIG="\$STATE_DIR\/logrotate\.conf"/);
  assert.match(deployScript, /maxsize 10M[\s\S]*rotate 7[\s\S]*maxage 14/);
  assert.match(deployScript, /compress[\s\S]*delaycompress[\s\S]*copytruncate/);
  assert.match(deployScript, /ensure_private_log_file "\$managed_log"[\s\S]*cron\.log/);
  assert.match(deployScript, /"%s\/pm2\.log" "%s\/agent\.log"/);
  assert.match(deployScript, /LOGROTATE_STATE="\$STATE_DIR\/logrotate\.state"/);
  assert.match(deployScript, /LOGROTATE_LOCK="\$STATE_DIR\/logrotate\.lock"/);
  assert.match(deployScript, /run_logrotate_configuration[\s\S]*FLOCK_BINARY[\s\S]*LOGROTATE_BINARY/);
  assert.match(deployScript, /validate_active_logrotate_configuration[\s\S]*--debug --state "\$LOGROTATE_STATE"/);
  assert.match(deployScript, /# merge4appstore-logrotate/);
  assert.doesNotMatch(deployScript, /\/etc\/logrotate\.d/);
  assert.match(ecosystem, /merge_logs: true/);
  assert.match(ecosystem, /out_file: path\.join\(stateDirectory, 'logs', 'webhook-out\.log'\)/);
  assert.match(ecosystem, /error_file: path\.join\(stateDirectory, 'logs', 'webhook-error\.log'\)/);
  assert.match(deployScript, /EXPECTED_PM2_OUT_LOG/);
  assert.match(deployScript, /EXPECTED_PM2_ERROR_LOG/);
  assert.match(deployScript, /pm_out_log_path/);
  assert.match(deployScript, /pm_err_log_path/);
});

test('precreates an empty private logrotate state before its first real pass', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-logrotate-state-');
  const state = path.join(directory, 'logrotate.state');
  const ensurePrivateFile = shellSection('ensure_private_log_file() {', 'ensure_disk_headroom() {');
  const result = runBash([
    'set -u',
    'validate_private_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }',
    ensurePrivateFile,
    'ensure_private_log_file "$TEST_STATE"',
    '[ ! -s "$TEST_STATE" ]',
  ].join('\n'), { TEST_STATE: state });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  const initialization = deployScript.indexOf('ensure_private_log_file "$LOGROTATE_STATE"');
  const candidateDebug = deployScript.indexOf('validate_logrotate_configuration "$transaction_dir/logrotate.candidate"');
  const realPass = deployScript.indexOf('run_logrotate_configuration "$LOGROTATE_CONFIG"');
  assert.ok(initialization >= 0 && initialization < candidateDebug && candidateDebug < realPass);
});

test('overwrites stale PM2 release and job context on every reload', () => {
  const contract = {
    MERGE4APPSTORE_DELIVERY_PAUSE_FILE: '/state/delivery.pause',
    MERGE4APPSTORE_DEPLOY_SHA: 'b'.repeat(40),
    MERGE4APPSTORE_DRAIN_TIMEOUT_MS: '600000',
    MERGE4APPSTORE_ENV: '/control/.env',
    MERGE4APPSTORE_PM2_NAME: 'merge4appstore-webhooks-v2',
    MERGE4APPSTORE_PREPARE_TIMEOUT_MS: '45000',
    MERGE4APPSTORE_STATE_DIR: '/state',
    MERGE4APPSTORE_WEBHOOK_ENV: '/state/secrets/new.env',
    WEBHOOK_HOST: '127.0.0.1',
    WEBHOOK_PORT: '8788',
  };
  const loaded = spawnSync(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1])))',
    fileURLToPath(ecosystemUrl),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...contract,
      BUILD_COMMIT_SHA: 'stale-build',
      BUILD_PURPOSE: 'production',
      DRY_RUN: 'true',
      RECONCILE_METADATA: 'true',
    },
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  const application = JSON.parse(loaded.stdout).apps[0];
  const appEnvironment = application.env;
  for (const [name, value] of Object.entries(contract)) {
    assert.equal(appEnvironment[name], value, name);
  }
  assert.equal(appEnvironment.DRY_RUN, 'false');
  assert.equal(appEnvironment.RECONCILE_METADATA, 'false');
  assert.equal(application.merge_logs, true);
  assert.equal(application.out_file, '/state/logs/webhook-out.log');
  assert.equal(application.error_file, '/state/logs/webhook-error.log');
  for (const [name, value] of Object.entries(appEnvironment)) {
    if (name.startsWith('BUILD_')) assert.equal(value, '', name);
  }

  const simulatedReload = {
    MERGE4APPSTORE_DEPLOY_SHA: 'a'.repeat(40),
    MERGE4APPSTORE_WEBHOOK_ENV: '/state/secrets/old.env',
    BUILD_COMMIT_SHA: 'stale-build',
    BUILD_PURPOSE: 'production',
    ...appEnvironment,
  };
  assert.equal(simulatedReload.MERGE4APPSTORE_DEPLOY_SHA, contract.MERGE4APPSTORE_DEPLOY_SHA);
  assert.equal(simulatedReload.MERGE4APPSTORE_WEBHOOK_ENV, contract.MERGE4APPSTORE_WEBHOOK_ENV);
  assert.equal(simulatedReload.BUILD_COMMIT_SHA, '');
  assert.equal(simulatedReload.BUILD_PURPOSE, '');
});

test('rejects dry-run and transient job flags in the production control environment', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-production-env-');
  const clean = path.join(directory, 'clean.env');
  const dryRun = path.join(directory, 'dry-run.env');
  const transient = path.join(directory, 'transient.env');
  fs.writeFileSync(clean, 'DRY_RUN=false\nSTATIC_SETTING=yes\n');
  fs.writeFileSync(dryRun, 'DRY_RUN=true\n');
  fs.writeFileSync(transient, 'BUILD_COMMIT_SHA=abc123\n');
  const validator = shellSection('validate_production_environment() {', 'verify_health_url() {');
  const result = runBash([
    'set -u',
    'NODE_BINARY="$TEST_NODE_BINARY"',
    validator,
    'validate_production_environment "$TEST_RELEASE" "$TEST_CLEAN" || exit 10',
    'if validate_production_environment "$TEST_RELEASE" "$TEST_DRY_RUN"; then exit 11; fi',
    'if validate_production_environment "$TEST_RELEASE" "$TEST_TRANSIENT"; then exit 12; fi',
  ].join('\n'), {
    TEST_NODE_BINARY: process.execPath,
    TEST_RELEASE: repositoryRoot,
    TEST_CLEAN: clean,
    TEST_DRY_RUN: dryRun,
    TEST_TRANSIENT: transient,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('replaces PM2 legacy-secret backups and rejects forbidden dump keys', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-pm2-dump-');
  const pm2Home = path.join(directory, 'pm2');
  const currentTopology = path.join(directory, 'current.json');
  fs.mkdirSync(pm2Home);
  fs.writeFileSync(path.join(pm2Home, 'dump.pm2'), JSON.stringify([
    { name: 'legacy', pm2_env: { env: { GH_TOKEN: 'legacy-secret' } } },
  ]));
  fs.writeFileSync(currentTopology, JSON.stringify([
    { name: 'v2', pm2_env: { env: { SAFE_SETTING: 'yes' } } },
  ]));
  const dumpFunctions = shellSection('validate_pm2_dumps_no_secrets() {', 'configure_process_environment() {');
  const result = runBash([
    'set -u',
    'COUNT_FILE="$TEST_DIRECTORY/save-count"',
    'printf "0\n" > "$COUNT_FILE"',
    'NODE_BINARY="$TEST_NODE_BINARY"',
    'PM2_HOME="$TEST_PM2_HOME"',
    'SERVICE_NAME=v2',
    'LEGACY_SERVICE_NAME=legacy',
    'pm2_app_count() { printf "0"; }',
    'secure_pm2_home() { :; }',
    'pm2() {',
    '  [ "$1" = save ] || return 1',
    '  if [ -e "$PM2_HOME/dump.pm2" ]; then cp "$PM2_HOME/dump.pm2" "$PM2_HOME/dump.pm2.bak"; fi',
    '  cp "$TEST_CURRENT_TOPOLOGY" "$PM2_HOME/dump.pm2"',
    '  count="$(cat "$COUNT_FILE")"; printf "%s\n" "$((count + 1))" > "$COUNT_FILE"',
    '}',
    dumpFunctions,
    'persist_pm2_without_legacy_secrets || exit 10',
    '[ "$(cat "$COUNT_FILE")" -eq 2 ] || exit 11',
    'if grep -q GH_TOKEN "$PM2_HOME/dump.pm2" "$PM2_HOME/dump.pm2.bak"; then exit 12; fi',
    `printf '%s\n' '${JSON.stringify([{ name: 'unrelated', pm2_env: { env: { GH_TOKEN: 'allowed-other-app-secret' } } }])}' > "$PM2_HOME/dump.pm2.bak"`,
    'validate_pm2_dumps_no_secrets || exit 13',
    `printf '%s\n' '${JSON.stringify([{ name: 'v2', pm2_env: { env: { APP_STORE_CONNECT_API_KEY_CONTENT: 'secret' } } }])}' > "$PM2_HOME/dump.pm2.bak"`,
    'if validate_pm2_dumps_no_secrets; then exit 14; fi',
    `printf '%s\n' '${JSON.stringify([{ name: 'legacy', pm2_env: { env: { SAFE_SETTING: 'yes' } } }])}' > "$PM2_HOME/dump.pm2.bak"`,
    'if validate_pm2_dumps_no_secrets; then exit 15; fi',
  ].join('\n'), {
    TEST_DIRECTORY: directory,
    TEST_NODE_BINARY: process.execPath,
    TEST_PM2_HOME: pm2Home,
    TEST_CURRENT_TOPOLOGY: currentTopology,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('keeps application, proxy, and PM2 drain deadlines aligned', () => {
  assert.match(deployScript, /PREPARE_TIMEOUT_MS=.*45000/);
  assert.match(deployScript, /DRAIN_TIMEOUT_MS=.*600000/);
  assert.match(deployScript, /proxy_connect_timeout 5s/);
  assert.match(deployScript, /proxy_send_timeout 50s/);
  assert.match(deployScript, /proxy_read_timeout 50s/);
  assert.match(ecosystem, /10 \* 60 \* 1000/);
  assert.match(ecosystem, /kill_timeout: drainTimeout \+ 10000/);
});

test('pauses, restores, and installs managed cron idempotently before unpausing delivery', t => {
  const directory = temporaryDirectory(t, 'merge4appstore-cron-');
  const release = path.join(directory, 'release with spaces');
  const state = path.join(directory, 'state with spaces');
  const logs = path.join(directory, 'logs with spaces');
  const nodeDirectory = path.join(directory, 'node runtime');
  const nodeBinary = path.join(nodeDirectory, 'node');
  const toolDirectory = path.join(directory, 'job tools');
  const nodeCalled = path.join(directory, 'node-called');
  fs.mkdirSync(path.join(release, 'profiles'), { recursive: true });
  fs.mkdirSync(state);
  fs.mkdirSync(logs);
  fs.mkdirSync(nodeDirectory);
  fs.mkdirSync(toolDirectory);
  fs.symlinkSync(release, path.join(state, 'current'));
  fs.writeFileSync(path.join(release, 'profiles', 'one.yml'), '');
  fs.writeFileSync(path.join(release, 'profiles', 'two.yaml'), '');
  fs.writeFileSync(path.join(directory, 'crontab'), 'MAILTO=ops@example.invalid\n');
  const logrotateConfig = path.join(state, 'logrotate.conf');
  fs.writeFileSync(logrotateConfig, 'fixture\n', { mode: 0o600 });
  const logrotateBinary = path.join(toolDirectory, 'logrotate');
  writeExecutable(logrotateBinary, '#!/bin/bash\nexit 0\n');
  for (const tool of ['gh', 'git', 'flock']) {
    writeExecutable(path.join(toolDirectory, tool), '#!/bin/bash\nexit 0\n');
  }
  writeExecutable(nodeBinary, [
    '#!/bin/bash',
    `for tool in gh git flock; do command -v "$tool" || exit 1; done > "${nodeCalled}"`,
    `printf '%s\\n' "$*" >> "${nodeCalled}"`,
    '',
  ].join('\n'));
  const cronFunctions = shellSection('shell_quote() {', 'configure_repository_hooks() {');
  const result = runBash([
    'set -u',
    'shopt -s nullglob',
    'STATE_DIR="$TEST_STATE"',
    'CONTROL_ENV="$TEST_DIRECTORY/control env"',
    'LOGS_DIR="$TEST_LOGS"',
    'NODE_BINARY="$TEST_NODE_BINARY"',
    'CRON_COMMAND_PATH="$TEST_CRON_PATH"',
    'LOGROTATE_BINARY="$TEST_LOGROTATE_BINARY"',
    'LOGROTATE_CONFIG="$TEST_LOGROTATE_CONFIG"',
    'LOGROTATE_STATE="$TEST_STATE/logrotate.state"',
    'LOGROTATE_LOCK="$TEST_STATE/logrotate.lock"',
    'FLOCK_BINARY="$TEST_TOOL_DIRECTORY/flock"',
    'DEPLOY_RUN_ID=123-1',
    'CRONTAB_STATE="$TEST_DIRECTORY/crontab"',
    'crontab() {',
    '  if [ "$1" = -l ]; then cat "$CRONTAB_STATE";',
    '  elif [ "$1" = - ]; then cat > "$CRONTAB_STATE";',
    '  else return 1; fi',
    '}',
    'validate_private_file() { [ -f "$1" ] && [ ! -L "$1" ]; }',
    'validate_logrotate_configuration() { return 0; }',
    'validate_active_logrotate_configuration() { return 0; }',
    cronFunctions,
    'install_managed_cron "$TEST_RELEASE" false || exit 10',
    '[ "$(grep -Fc "# merge4appstore:" "$CRONTAB_STATE" || true)" -eq 2 ] || exit 11',
    '[ "$(grep -Fc "# merge4appstore-logrotate" "$CRONTAB_STATE" || true)" -eq 1 ] || exit 32',
    'grep -Fq "\x27$TEST_TOOL_DIRECTORY/flock\x27 -n \x27$TEST_STATE/logrotate.lock\x27" "$CRONTAB_STATE" || exit 35',
    'grep -Fq "MERGE4APPSTORE_STATE_DIR=" "$CRONTAB_STATE" || exit 12',
    'grep -Fq "MERGE4APPSTORE_ENV=" "$CRONTAB_STATE" || exit 13',
    'grep -Fq "DRY_RUN=false RECONCILE_METADATA=false" "$CRONTAB_STATE" || exit 22',
    'grep "# merge4appstore:" "$CRONTAB_STATE" | grep -Fq "umask 077;" || exit 36',
    'grep -Fq "PATH=\x27$TEST_CRON_PATH\x27" "$CRONTAB_STATE" || exit 23',
    'grep -Fq "\x27$TEST_NODE_BINARY\x27 index.js" "$CRONTAB_STATE" || exit 19',
    'cron_command="$(grep "# merge4appstore:one" "$CRONTAB_STATE" | cut -d " " -f 6-)"',
    'PATH=/usr/bin:/bin /bin/bash -c "$cron_command" || exit 20',
    'grep -Fq "index.js --profile profiles/one.yml" "$TEST_NODE_CALLED" || exit 21',
    'grep -Fq "$TEST_TOOL_DIRECTORY/gh" "$TEST_NODE_CALLED" || exit 24',
    'grep -Fq "$TEST_TOOL_DIRECTORY/git" "$TEST_NODE_CALLED" || exit 25',
    'grep -Fq "$TEST_TOOL_DIRECTORY/flock" "$TEST_NODE_CALLED" || exit 26',
    'install_managed_cron "$TEST_RELEASE" false || exit 14',
    '[ "$(grep -Fc "# merge4appstore:" "$CRONTAB_STATE" || true)" -eq 2 ] || exit 15',
    'cp "$CRONTAB_STATE" "$TEST_DIRECTORY/crontab.before"',
    'chmod 600 "$TEST_DIRECTORY/crontab.before"',
    'printf "17 2 * * * /usr/local/bin/unrelated\n" >> "$CRONTAB_STATE"',
    'pause_managed_cron "$TEST_DIRECTORY/crontab.before" || exit 27',
    '[ "$(grep -Fc "# merge4appstore:" "$CRONTAB_STATE" || true)" -eq 0 ] || exit 28',
    '[ "$(grep -Fc "# merge4appstore-logrotate" "$CRONTAB_STATE" || true)" -eq 1 ] || exit 33',
    'grep -Fq "MAILTO=ops@example.invalid" "$CRONTAB_STATE" || exit 29',
    'grep -Fq "/usr/local/bin/unrelated" "$CRONTAB_STATE" || exit 31',
    'cp "$TEST_DIRECTORY/crontab.before" "$CRONTAB_STATE"',
    'cmp -s "$TEST_DIRECTORY/crontab.before" "$CRONTAB_STATE" || exit 30',
    'install_managed_cron "$TEST_RELEASE" true || exit 16',
    '[ "$(grep -Fc "# merge4appstore:" "$CRONTAB_STATE" || true)" -eq 0 ] || exit 17',
    '[ "$(grep -Fc "# merge4appstore-logrotate" "$CRONTAB_STATE" || true)" -eq 1 ] || exit 34',
    'grep -Fq "MAILTO=ops@example.invalid" "$CRONTAB_STATE" || exit 18',
  ].join('\n'), {
    TEST_DIRECTORY: directory,
    TEST_RELEASE: release,
    TEST_STATE: state,
    TEST_LOGS: logs,
    TEST_NODE_BINARY: nodeBinary,
    TEST_NODE_CALLED: nodeCalled,
    TEST_TOOL_DIRECTORY: toolDirectory,
    TEST_CRON_PATH: `${nodeDirectory}:${toolDirectory}:/usr/bin:/bin`,
    TEST_LOGROTATE_BINARY: logrotateBinary,
    TEST_LOGROTATE_CONFIG: logrotateConfig,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const finalizer = shellSection('finish_committed_transaction() {', 'recover_interrupted_transactions() {');
  assert.ok(finalizer.indexOf('install_managed_cron') < finalizer.indexOf('clear_delivery_pause'));
});

test('retries transient deployment probes with bounded diagnostics', () => {
  assert.match(deployScript, /retry_capture\(\)/);
  assert.match(deployScript, /GitHub branch-head lookup[\s\S]* 4/);
  assert.match(deployScript, /authenticated preparation smoke[\s\S]* 4/);
  assert.match(deployScript, /public deployment health check[\s\S]* 4/);
  assert.match(deployScript, /GitHub hook listing[\s\S]* 4[\s\S]*timeout 30s[\s\S]*gh api --paginate --slurp/);
  assert.match(deployScript, /GitHub hook update[\s\S]* 4[\s\S]*timeout 30s/);
  assert.match(deployScript, /GitHub hook creation[\s\S]* 4[\s\S]*timeout 30s/);
  assert.match(deployScript, /timeout --kill-after=30s 10m npm ci/);
  assert.match(deployScript, /WARNING: Git mirror prewarming failed/);
  assert.match(deployScript, /attempt \$attempt\/\$max_attempts/);
});

test('publishes deploy failures and monitors public health out of band', () => {
  assert.deepEqual(parsedWorkflow.on.schedule, [{ cron: '*/5 * * * *' }]);
  assert.deepEqual(parsedWorkflow.permissions, {});
  assert.deepEqual(parsedWorkflow.jobs.test.permissions, { contents: 'read' });
  assert.deepEqual(parsedWorkflow.jobs.deploy.permissions, { contents: 'read' });
  assert.deepEqual(parsedWorkflow.jobs['deployment-alert'].permissions, {
    contents: 'read',
    issues: 'write',
  });
  assert.deepEqual(parsedWorkflow.jobs['public-health-monitor'].permissions, {
    actions: 'read',
    contents: 'read',
    issues: 'write',
  });
  for (const job of [parsedWorkflow.jobs.test, parsedWorkflow.jobs.deploy]) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with['persist-credentials'], false);
  }
  assert.ok(parsedWorkflow.jobs['deployment-alert']);
  assert.ok(parsedWorkflow.jobs['public-health-monitor']);
  assert.match(deploymentAlertStep.env.HEALTH_URL, /MERGE4APPSTORE_HEALTH_URL/);
  assert.match(workflow, /merge4appstore:deployment-failure/);
  assert.match(workflow, /merge4appstore:public-health-failure/);
  assert.match(workflow, /deployed !== expected/);
  assert.match(expectedDeploymentScript, /activeStatuses/);
  assert.match(expectedDeploymentScript, /run\.head_sha === branch\.commit\.sha/);
  assert.match(expectedDeploymentScript, /run\.event/);
  assert.match(expectedDeploymentScript, /Inspect VPS webhook readiness/);
  assert.match(publicHealthRun, /rolloutPending/);
  assert.match(workflow, /Number\.isSafeInteger\(value\)/);
  assert.match(workflow, /Resolve expected main deployment/);
  assert.match(workflow, /rerun failed jobs from the Actions run/);
  assert.match(deploymentAlertScript, /transaction journal resumes finalization safely/);
  assert.match(deploymentAlertScript, /revert that commit on main/);
  assert.match(deploymentAlertScript, /AbortSignal\.timeout\(15_000\)/);
  assert.match(deploymentAlertScript, /Post-failure public health/);
  assert.ok(deploymentAlertScript.indexOf('healthSummary = await') < deploymentAlertScript.indexOf('issues.listForRepo'));
  assert.match(reconciliationScript, /transaction journal resumes finalization safely/);
  assert.match(reconciliationScript, /revert that commit on main/);
  assert.match(reconciliationScript, /AbortSignal\.timeout\(15_000\)/);
  assert.match(reconciliationScript, /Post-failure public health/);
  assert.ok(reconciliationScript.indexOf('healthSummary = await') < reconciliationScript.indexOf('issues.listForRepo'));
  for (const script of [deploymentAlertScript, publicHealthAlertScript, reconciliationScript]) {
    assert.match(script, /issues\.addAssignees/);
    assert.match(script, /Could not assign .* to repository owner/);
  }
  assert.doesNotMatch(deploymentAlertScript, /available for rollback/);
  assert.match(workflow, /--proto '=https' --proto-redir '=https'/);
  assert.match(workflow, /origin_main="\$\(git -C "\$DEPLOY_DIR" rev-parse origin\/main\)"/);
  assert.match(workflow, /MERGE4APPSTORE_DEPLOYMENT_SUPERSEDED/);
  assert.match(workflow, /branch\.commit\.sha !== context\.sha/);
  assert.match(workflow, /dispatchWindow\.length === 100/);
  assert.match(workflow, /Number\(deployment\.run_number\) < oldestVisibleDispatch/);
  assert.match(workflow, /Persistent state parent must be writable for the first deployment/);
  assert.match(deployScript, /Deployment rollback completed; the previous service topology was verified/);
  assert.match(deployScript, /Deployment cleanup completed before service cutover/);
});

test('requires public health to report the exact current main deployment and schema', async t => {
  const root = temporaryDirectory(t, 'merge4appstore-public-health-');
  const bodyFile = path.join(root, 'health.json');
  const expectedSha = 'a'.repeat(40);
  const validator = extractPublicHealthValidator();
  const run = (body, deploymentActive = false) => {
    fs.writeFileSync(bodyFile, JSON.stringify(body));
    return spawnSync(process.execPath, ['-e', validator], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BODY_FILE: bodyFile,
        HTTP_STATUS: '200',
        EXPECTED_SHA: expectedSha,
        EXPECTED_DEPLOYMENT_ACTIVE: String(deploymentActive),
      },
    });
  };
  const healthy = {
    ok: true,
    degraded: false,
    deployment_sha: expectedSha,
    delivery_queue: { pending: 0, failed: 0, corrupt: 0, oldest_pending_age_ms: null },
    deployment_state: { active: 0, incomplete: 0 },
    delivery_paused: false,
  };

  const valid = run(healthy);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  assert.match(valid.stdout, new RegExp(expectedSha));
  const stale = run({ ...healthy, deployment_sha: 'b'.repeat(40) });
  assert.notEqual(stale.status, 0, 'a stale healthy release was accepted');
  assert.match(stale.stderr, /expected current main/);
  const rollingOut = run({ ...healthy, deployment_sha: 'b'.repeat(40) }, true);
  assert.equal(rollingOut.status, 0, rollingOut.stderr || rollingOut.stdout);
  assert.match(rollingOut.stdout, /rollout to .* is active/);
  const unhealthyDuringRollout = run({
    ...healthy,
    ok: false,
    deployment_sha: 'b'.repeat(40),
  }, true);
  assert.notEqual(unhealthyDuringRollout.status, 0, 'an unhealthy service was hidden by an active rollout');
  assert.match(unhealthyDuringRollout.stderr, /Health is unhealthy/);
  const malformed = run({
    ...healthy,
    delivery_queue: { pending: '0', failed: 0, corrupt: 0 },
  });
  assert.notEqual(malformed.status, 0, 'a malformed queue was accepted');
  assert.match(malformed.stderr, /non-negative integer/);
  const missingAge = run({
    ...healthy,
    delivery_queue: { pending: 0, failed: 0, corrupt: 0 },
  });
  assert.notEqual(missingAge.status, 0, 'a queue with no oldest-pending age was accepted');
  assert.match(missingAge.stderr, /oldest_pending_age_ms must be a non-negative integer/);
  const malformedAge = run({
    ...healthy,
    delivery_queue: { ...healthy.delivery_queue, oldest_pending_age_ms: '0' },
  });
  assert.notEqual(malformedAge.status, 0, 'a malformed oldest-pending age was accepted');
  assert.match(malformedAge.stderr, /oldest_pending_age_ms must be a non-negative integer/);
  const pending = run({
    ...healthy,
    delivery_queue: { pending: 1, failed: 0, corrupt: 0, oldest_pending_age_ms: 1234 },
  });
  assert.equal(pending.status, 0, pending.stderr || pending.stdout);
  const stalePending = run({
    ...healthy,
    degraded: true,
    delivery_paused: true,
    delivery_queue: { pending: 1, failed: 0, corrupt: 0, oldest_pending_age_ms: 15 * 60_000 },
    deployment_state: { active: 1, incomplete: 0 },
  });
  assert.notEqual(stalePending.status, 0, 'a stale pending receipt was hidden as a planned migration');
  assert.match(stalePending.stderr, /Health is unhealthy/);

  const outputs = new Map();
  await runGithubScript(expectedDeploymentScript, {
    github: {
      rest: {
        repos: { getBranch: async () => ({ data: { commit: { sha: expectedSha } } }) },
        actions: {
          listWorkflowRuns: async request => {
            assert.equal(request.workflow_id, 'deploy.yml');
            assert.equal(request.branch, 'main');
            assert.equal(request.per_page, 100);
            return { data: { workflow_runs: [{
              head_sha: expectedSha,
              event: 'push',
              status: 'in_progress',
              display_title: 'Deploy current main',
            }] } };
          },
        },
      },
    },
    context: { repo: { owner: 'example', repo: 'service' } },
    core: { setOutput: (name, value) => { outputs.set(name, value); } },
  });
  assert.equal(outputs.get('sha'), expectedSha);
  assert.equal(outputs.get('deployment_active'), 'true');
});

test('does not let a stale direct run mutate the deployment alert', async () => {
  const calls = [];
  await runGithubScript(deploymentAlertScript, {
    github: {
      rest: {
        repos: {
          getBranch: async () => ({ data: { commit: { sha: 'new-main' } } }),
        },
        issues: {
          listForRepo: async () => { calls.push('issue-list'); throw new Error('must not list issues'); },
        },
      },
    },
    context: {
      eventName: 'push',
      sha: 'old-main',
      repo: { owner: 'owner', repo: 'repo' },
      serverUrl: 'https://github.example',
      runId: 1,
    },
    core: { info: message => calls.push(message) },
    environment: {
      DEPLOY_OUTCOME: '',
      TEST_RESULT: 'failure',
      DEPLOY_RESULT: 'skipped',
    },
  });
  assert.equal(calls.includes('issue-list'), false);
  assert.ok(calls.some(value => /not for the current main commit/.test(value)));
});

test('does not let main advance during failure-health collection before alert mutation', async () => {
  let branchLookups = 0;
  const calls = [];
  await runGithubScript(deploymentAlertScript, {
    github: {
      rest: {
        repos: {
          getBranch: async () => {
            branchLookups += 1;
            return { data: { commit: { sha: branchLookups === 1 ? 'current-main' : 'new-main' } } };
          },
        },
        issues: {
          listForRepo: async () => { calls.push('issue-list'); throw new Error('must not list issues'); },
        },
      },
    },
    context: {
      eventName: 'push',
      sha: 'current-main',
      repo: { owner: 'owner', repo: 'repo' },
      serverUrl: 'https://github.example',
      runId: 2,
    },
    core: {
      info: message => calls.push(message),
      warning: message => calls.push(message),
    },
    environment: {
      DEPLOY_OUTCOME: '',
      TEST_RESULT: 'success',
      DEPLOY_RESULT: 'failure',
      HEALTH_URL: 'https://health.example.test/status',
    },
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ ok: true, degraded: false, deployment_sha: 'a'.repeat(40) }),
    }),
  });

  assert.equal(branchLookups, 2);
  assert.equal(calls.includes('issue-list'), false);
  assert.ok(calls.some(value => /Main advanced while collecting failure health/.test(value)));
});

test('deployment failure alert records rollback health and assigns the owner without coupling publication', async () => {
  const created = [];
  const assignments = [];
  const warnings = [];
  const deploymentSha = 'a'.repeat(40);
  await runGithubScript(deploymentAlertScript, {
    github: {
      rest: {
        repos: {
          getBranch: async () => ({ data: { commit: { sha: 'current-main' } } }),
        },
        issues: {
          listForRepo: async () => ({ data: [] }),
          create: async request => {
            created.push(request);
            return { data: { number: 46 } };
          },
          addAssignees: async request => {
            assignments.push(request);
            throw new Error('fixture assignment failure');
          },
        },
        search: {
          issuesAndPullRequests: async () => ({ data: { items: [] } }),
        },
      },
    },
    context: {
      eventName: 'push',
      sha: 'current-main',
      repo: { owner: 'owner', repo: 'repo' },
      serverUrl: 'https://github.example',
      runId: 123,
    },
    core: {
      info() {},
      warning: message => warnings.push(message),
    },
    environment: {
      DEPLOY_OUTCOME: '',
      TEST_RESULT: 'success',
      DEPLOY_RESULT: 'failure',
      HEALTH_URL: 'https://health.example.test/status',
    },
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://health.example.test/status');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return {
        status: 200,
        json: async () => ({ ok: true, degraded: false, deployment_sha: deploymentSha }),
      };
    },
  });

  assert.equal(created.length, 1);
  assert.match(
    created[0].body,
    new RegExp(`Post-failure public health: HTTP 200; ok=true; degraded=false; deployment SHA=${deploymentSha}`),
  );
  assert.deepEqual(assignments, [{
    owner: 'owner',
    repo: 'repo',
    issue_number: 46,
    assignees: ['owner'],
  }]);
  assert.ok(warnings.some(message => /Could not assign deployment alert/.test(message)));
});

test('reconciles manual recovery, excludes inspections, and fails closed on saturated history', async t => {
  const marker = '<!-- merge4appstore:deployment-failure -->';
  const deploymentSha = 'b'.repeat(40);
  const runCase = async ({ pushes, dispatches }) => {
    const actions = [];
    const github = {
      rest: {
        repos: {
          getBranch: async () => ({ data: { commit: { sha: 'current-main' } } }),
        },
        actions: {
          listWorkflowRuns: async ({ event, per_page: perPage }) => {
            assert.equal(perPage, 100);
            return { data: { workflow_runs: event === 'push' ? pushes : dispatches } };
          },
        },
        issues: {
          listForRepo: async () => ({ data: [{
            number: 9,
            state: 'open',
            body: marker,
          }] }),
          createComment: async request => { actions.push(['comment', request]); },
          update: async request => { actions.push(['update', request]); },
          create: async request => { actions.push(['create', request]); },
          addAssignees: async request => { actions.push(['assign', request]); },
        },
        search: {
          issuesAndPullRequests: async () => ({ data: { items: [] } }),
        },
      },
    };
    const warnings = [];
    await runGithubScript(reconciliationScript, {
      github,
      context: { repo: { owner: 'owner', repo: 'repo' } },
      core: { warning: message => warnings.push(message) },
      environment: { HEALTH_URL: 'https://health.example.test/status' },
      fetchImpl: async url => {
        assert.equal(String(url), 'https://health.example.test/status');
        return {
          status: 200,
          json: async () => ({ ok: true, degraded: false, deployment_sha: deploymentSha }),
        };
      },
    });
    return { actions, warnings };
  };

  await t.test('later successful dispatch closes a failed push alert', async () => {
    const { actions } = await runCase({
      pushes: [{ run_number: 10, head_sha: 'current-main', conclusion: 'failure', html_url: 'push' }],
      dispatches: [{
        run_number: 11,
        head_sha: 'current-main',
        conclusion: 'success',
        html_url: 'recovery',
        display_title: 'Deploy merge4appstore to VPS',
      }],
    });
    assert.ok(actions.some(([action, request]) => action === 'update' && request.state === 'closed'));
  });

  await t.test('inspection success cannot hide a failed deployment', async () => {
    const { actions } = await runCase({
      pushes: [{ run_number: 10, head_sha: 'current-main', conclusion: 'failure', html_url: 'push' }],
      dispatches: [{
        run_number: 11,
        head_sha: 'current-main',
        conclusion: 'success',
        html_url: 'inspection',
        display_title: 'Inspect VPS webhook readiness',
      }],
    });
    assert.ok(actions.some(([action, request]) => action === 'update' && request.state === 'open'));
    assert.ok(actions.some(([action, request]) => action === 'assign' && request.issue_number === 9));
    assert.ok(actions.some(([action, request]) => (
      action === 'update'
      && request.body.includes(`Post-failure public health: HTTP 200; ok=true; degraded=false; deployment SHA=${deploymentSha}`)
    )));
  });

  await t.test('a later rerun wins even though it keeps its original run number', async () => {
    const { actions } = await runCase({
      pushes: [{
        run_number: 10,
        run_attempt: 2,
        run_started_at: '2026-08-30T19:11:00Z',
        head_sha: 'current-main',
        conclusion: 'success',
        html_url: 'recovered-rerun',
      }],
      dispatches: [{
        run_number: 11,
        run_attempt: 1,
        run_started_at: '2026-08-30T19:08:00Z',
        head_sha: 'current-main',
        conclusion: 'failure',
        html_url: 'earlier-dispatch',
        display_title: 'Deploy merge4appstore to VPS',
      }],
    });
    assert.ok(actions.some(([action, request]) => action === 'update' && request.state === 'closed'));
    assert.equal(actions.some(([action, request]) => action === 'update' && request.state === 'open'), false);
  });

  await t.test('one hundred newer inspections make older history ambiguous', async () => {
    const inspections = Array.from({ length: 100 }, (_, index) => ({
      run_number: 200 - index,
      head_sha: 'current-main',
      conclusion: 'success',
      display_title: 'Inspect VPS webhook readiness',
    }));
    const { actions, warnings } = await runCase({
      pushes: [{ run_number: 10, head_sha: 'current-main', conclusion: 'failure', html_url: 'push' }],
      dispatches: inspections,
    });
    assert.deepEqual(actions, []);
    assert.ok(warnings.some(value => /saturated/.test(value)));
  });
});
