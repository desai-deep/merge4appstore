import crypto from 'crypto';
import { execFile } from 'child_process';
import { constants as fsConstants, realpathSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { acquireProcessLock } from './process-lock.js';

const execFileAsync = promisify(execFile);
const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateMarkerName = '.merge4appstore-state';
const stateMarkerContents = 'merge4appstore-state-v1\n';
const maxCandidateChecks = 20;
const noLazyFetchPatchFloors = new Map([
  [39, 4],
  [40, 2],
  [41, 1],
  [42, 2],
  [43, 4],
  [44, 1],
  [45, 1],
]);
const mirrors = new Map();
let gitCapabilityCheck = null;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function requestMirrorLockTimeoutMs(environment = process.env) {
  const configured = environment.MERGE4APPSTORE_MIRROR_REQUEST_LOCK_TIMEOUT_MS
    ?? environment.MERGE4APPSTORE_MIRROR_LOCK_TIMEOUT_MS;
  // A request must reach provider fallback before its 45-second HTTP deadline.
  // Keep the legacy variable as a lower-only alias so an old 60-second value
  // cannot silently restore the starvation window.
  return Math.min(positiveInteger(configured, 5_000), 5_000);
}

export function gitSupportsNoLazyFetch(versionOutput) {
  const match = /^git version\s+(\d+)\.(\d+)\.(\d+)([^\s]*)/i.exec(
    String(versionOutput || '').trim(),
  );
  if (!match) return false;
  const [, majorText, minorText, patchText, suffix] = match;
  // Pre-release and custom development builds are not a safe capability
  // signal. The Windows release suffix is the one stable distribution suffix
  // emitted by Git itself; vendor labels such as Apple Git follow whitespace.
  if (suffix && !/^\.windows\.\d+$/i.test(suffix)) return false;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  if (major > 2) return true;
  if (major < 2 || minor < 39) return false;
  if (minor >= 46) return true;
  const patchFloor = noLazyFetchPatchFloors.get(minor);
  return patchFloor !== undefined && patch >= patchFloor;
}

async function ensureGitSupportsNoLazyFetch() {
  if (!gitCapabilityCheck) {
    gitCapabilityCheck = execFileAsync('git', ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    }).then(({ stdout }) => {
      if (gitSupportsNoLazyFetch(stdout)) return;
      const reported = String(stdout || '').trim().replace(/\s+/g, ' ') || 'an unrecognized version';
      const error = new Error(
        `Git with GIT_NO_LAZY_FETCH support is required (at least the 2.39.4 security release); found ${reported}`,
      );
      error.code = 'EGITVERSION';
      throw error;
    });
  }
  return gitCapabilityCheck;
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function canonicalPotentialPath(candidate) {
  let current = candidate;
  const missing = [];
  while (true) {
    try {
      return path.resolve(realpathSync(current), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertSafeStateDirectory(candidate) {
  // Resolve every existing parent component before checking containment. A
  // lexical check alone can be bypassed by `/outside/repo-alias -> checkout`,
  // including when the requested final directory does not exist yet.
  const canonical = canonicalPotentialPath(candidate);
  const canonicalCheckout = canonicalPotentialPath(checkoutRoot);
  const canonicalHome = canonicalPotentialPath(path.resolve(os.homedir()));
  const filesystemRoot = path.parse(canonical).root;
  const prohibited = [
    filesystemRoot,
    canonicalHome,
    canonicalCheckout,
    path.join(canonicalCheckout, '.git'),
  ];
  if (
    prohibited.includes(canonical)
    || isWithin(canonical, canonicalCheckout)
    || isWithin(canonical, path.join(canonicalCheckout, '.git'))
  ) {
    throw new Error(`Unsafe Git mirror state directory: ${candidate}`);
  }
}

export function resolveStateDirectory(value = (
  process.env.MERGE4APPSTORE_STATE_DIR
  || path.join(os.homedir(), '.local', 'state', 'merge4appstore')
)) {
  if (!path.isAbsolute(value)) {
    throw new Error('MERGE4APPSTORE_STATE_DIR must be an absolute path');
  }
  const resolved = path.resolve(value);
  assertSafeStateDirectory(resolved);
  return resolved;
}

export async function ensureStateDirectory(value) {
  const resolved = resolveStateDirectory(value);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(resolved);
  }
  // Recheck after creation so a parent alias changed during initialization
  // cannot make the subsequent chmod/marker writes target the checkout.
  assertSafeStateDirectory(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe Git mirror state directory: ${resolved}`);
  }
  const serviceUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (serviceUid !== null && stat.uid !== serviceUid) {
    throw new Error(`Git mirror state directory is not owned by the service user: ${resolved}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`Git mirror state directory is writable by another user: ${resolved}`);
  }
  const marker = path.join(resolved, stateMarkerName);
  await fs.chmod(resolved, 0o700);

  const validateMarker = async () => {
    let markerHandle;
    try {
      markerHandle = await fs.open(marker, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      const markerStat = await markerHandle.stat();
      if (!markerStat.isFile() || (serviceUid !== null && markerStat.uid !== serviceUid)) {
        throw new Error(`Unsafe Git mirror state marker: ${marker}`);
      }
      if ((markerStat.mode & 0o022) !== 0) {
        throw new Error(`Git mirror state marker is writable by another user: ${marker}`);
      }
      if (await markerHandle.readFile('utf8') !== stateMarkerContents) {
        throw new Error(`Invalid Git mirror state marker: ${marker}`);
      }
      await markerHandle.chmod(0o600);
      return true;
    } finally {
      await markerHandle.close();
    }
  };

  if (await validateMarker()) return resolved;

  // Initialization itself needs cross-process exclusion. The kernel-held lock
  // may create only the private .process-locks directory; no application state
  // is accepted before the durable marker is atomically published.
  const release = await acquireProcessLock(resolved, 'state-directory-initialize', {
    timeoutMs: 60_000,
  });
  try {
    if (await validateMarker()) return resolved;
    const processLocksDirectory = path.join(resolved, '.process-locks');
    try {
      await fs.mkdir(processLocksDirectory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const processLocksStat = await fs.lstat(processLocksDirectory);
    if (
      processLocksStat.isSymbolicLink()
      || !processLocksStat.isDirectory()
      || (serviceUid !== null && processLocksStat.uid !== serviceUid)
    ) {
      throw new Error(`Unsafe process-lock directory: ${processLocksDirectory}`);
    }
    await fs.chmod(processLocksDirectory, 0o700);
    const entries = await fs.readdir(resolved);
    const unexpected = entries.filter(name => name !== '.process-locks');
    if (unexpected.length > 0) {
      throw new Error(`Git mirror state directory is not an empty dedicated directory: ${resolved}`);
    }

    const temporary = path.join(
      processLocksDirectory,
      `${stateMarkerName}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let temporaryHandle;
    try {
      temporaryHandle = await fs.open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await temporaryHandle.writeFile(stateMarkerContents);
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = null;
      await fs.rename(temporary, marker);
      const directoryHandle = await fs.open(resolved, 'r');
      try {
        await directoryHandle.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await temporaryHandle?.close();
      await fs.rm(temporary, { force: true });
    }
    if (!await validateMarker()) {
      throw new Error(`Failed to initialize Git mirror state marker: ${marker}`);
    }
  } finally {
    await release();
  }
  return resolved;
}

function mirrorName(owner, repository, remoteUrl) {
  const identity = `${owner}/${repository}`.toLowerCase();
  const label = `${owner}-${repository}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80);
  const digest = crypto.createHash('sha256')
    .update(`${identity}\0${remoteUrl}`)
    .digest('hex')
    .slice(0, 12);
  return `${label}-${digest}.git`;
}

function validateCommit(commit) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit || '')) {
    const error = new Error(`Invalid Git commit: ${commit || '(missing)'}`);
    error.statusCode = 400;
    throw error;
  }
  return commit;
}

function isCommit(commit) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit || '');
}

function rangeCacheWeight(cacheKey, result) {
  let bytes = Buffer.byteLength(cacheKey, 'utf8') + 128;
  if (!result) return bytes;
  bytes += Buffer.byteLength(result.baseCommit || '', 'utf8');
  bytes += Buffer.byteLength(result.baseBuildNumber || '', 'utf8');
  bytes += Buffer.byteLength(result.baseMarketingVersion || '', 'utf8');
  for (const subject of result.subjects || []) {
    bytes += Buffer.byteLength(subject, 'utf8') + 16;
  }
  return bytes;
}

function validateRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl || /[\r\n]/.test(remoteUrl)) {
    throw new Error('Invalid Git mirror remote URL');
  }
  // Keep credentials out of the durable bare repository config for every URL
  // form understood by WHATWG URL (not only HTTP). SCP-style SSH remotes may
  // contain the conventional non-secret `git@` transport user, but they have
  // no syntax for an embedded password.
  if (/^[a-z][a-z\d+.-]*:/i.test(remoteUrl)) {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) {
      throw new Error('Git mirror remote URL must not contain credentials');
    }
  }
  return remoteUrl;
}

function normalizeBranch(branch) {
  return branch?.replace(/^refs\/heads\//, '') || null;
}

function commandExitCode(error) {
  const rawCode = error?.code;
  if (rawCode === null || rawCode === undefined || rawCode === '') return null;
  const code = Number(rawCode);
  return Number.isInteger(code) ? code : null;
}

function transientError(message, cause) {
  const error = new Error(message, { cause });
  error.name = 'GitMirrorError';
  error.statusCode = 503;
  error.retryAfter = 5;
  return error;
}

class InvalidMirrorError extends Error {
  constructor(message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InvalidMirrorError';
  }
}

class CorruptMirrorError extends InvalidMirrorError {
  constructor(message, cause = null) {
    super(message, cause);
    this.name = 'CorruptMirrorError';
  }
}

function errorText(error) {
  const parts = [];
  let current = error;
  while (current) {
    parts.push(current.message || '', current.stderr || '', current.stdout || '');
    current = current.cause;
  }
  return parts.join('\n');
}

const objectCorruptionPatterns = [
  /object\s+file\s+.*\s+(?:is\s+empty|is\s+corrupt)/i,
  /(?:packed|loose)\s+object\s+.*\s+is\s+corrupt/i,
  /inflate:\s+data\s+stream\s+error/i,
  /packfile\s+.*(?:cannot\s+be\s+accessed|does\s+not\s+match\s+index|is\s+corrupt)/i,
  /pack\s+.*(?:bad\s+object\s+at\s+offset|checksum\s+mismatch|unresolved\s+deltas|is\s+corrupt)/i,
  /index\s+file\s+.*(?:is\s+too\s+small|is\s+corrupt)/i,
  /bad\s+object\s+refs\//i,
  /(?:unable|could\s+not)\s+to\s+read\s+[0-9a-f]{40,64}/i,
  /(?:broken\s+link\s+from|invalid\s+sha(?:1|256)\s+pointer)/i,
  /missing\s+(?:blob|tree|commit)\s+[0-9a-f]{40,64}/i,
  /(?:sha(?:1|256)\s+mismatch|object\s+corrupt\s+or\s+missing)/i,
];

function isObjectCorruption(error) {
  if (error instanceof CorruptMirrorError) return true;
  const text = errorText(error);
  return objectCorruptionPatterns.some(pattern => pattern.test(text));
}

function isAbortLike(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

function cloneFilterIgnored(result) {
  return /filtering not recognized by server, ignoring|filter is ignored in local clones/i
    .test(result?.stderr || '');
}

async function runGit(args, { timeoutMs, environment = process.env, signal = null } = {}) {
  await ensureGitSupportsNoLazyFetch();
  const gitEnvironment = {
    ...environment,
    // Security/resource diagnostics below must not depend on the host locale.
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.useHttpPath',
    GIT_CONFIG_VALUE_2: 'true',
  };
  return execFileAsync('git', args, {
    encoding: 'utf8',
    env: gitEnvironment,
    timeout: timeoutMs,
    signal: signal || undefined,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export class GitMirror {
  constructor(owner, repository, {
    stateDirectory = process.env.MERGE4APPSTORE_STATE_DIR
      || path.join(os.homedir(), '.local', 'state', 'merge4appstore'),
    remoteUrl = `https://github.com/${owner}/${repository}.git`,
    refreshTtlMs = positiveInteger(process.env.MERGE4APPSTORE_MIRROR_TTL_MS, 60_000),
    commandTimeoutMs = positiveInteger(process.env.MERGE4APPSTORE_MIRROR_TIMEOUT_MS, 15_000),
    // Request-time initialization must leave room for the GitHub fallback
    // inside the overall preparation deadline. Deployment prewarming opts in
    // to longer clone and fetch timeouts before the HTTP workers start.
    cloneTimeoutMs = commandTimeoutMs,
    fetchTimeoutMs = commandTimeoutMs,
    lockTimeoutMs = requestMirrorLockTimeoutMs(),
    retryBackoffMs = positiveInteger(process.env.MERGE4APPSTORE_MIRROR_RETRY_BACKOFF_MS, 5_000),
    candidateLimit = Math.min(20, positiveInteger(process.env.MERGE4APPSTORE_MIRROR_CANDIDATE_LIMIT, 20)),
    rangeCacheMaxEntries = 100,
    rangeCacheMaxBytes = 2 * 1024 * 1024,
    run = runGit,
    now = () => Date.now(),
  } = {}) {
    this.owner = owner;
    this.repository = repository;
    this.identity = `${owner}/${repository}`.toLowerCase();
    this.remoteUrl = validateRemoteUrl(remoteUrl);
    this.lockIdentity = `${this.identity}\0${this.remoteUrl}`;
    this.stateDirectory = resolveStateDirectory(stateDirectory);
    this.mirrorsDirectory = path.join(this.stateDirectory, 'mirrors');
    this.locksDirectory = path.join(this.stateDirectory, 'locks');
    const storageName = mirrorName(owner, repository, this.remoteUrl);
    this.mirrorPath = path.join(this.mirrorsDirectory, storageName);
    this.refreshStampName = '.merge4appstore-refresh';
    this.lockPath = path.join(this.locksDirectory, `${storageName}.lock`);
    this.refreshTtlMs = refreshTtlMs;
    this.commandTimeoutMs = positiveInteger(commandTimeoutMs, 15_000);
    this.cloneTimeoutMs = positiveInteger(cloneTimeoutMs, this.commandTimeoutMs);
    this.fetchTimeoutMs = positiveInteger(fetchTimeoutMs, this.commandTimeoutMs);
    this.lockTimeoutMs = positiveInteger(lockTimeoutMs, 5_000);
    this.retryBackoffMs = positiveInteger(retryBackoffMs, 5_000);
    this.candidateLimit = Math.min(
      maxCandidateChecks,
      positiveInteger(candidateLimit, maxCandidateChecks),
    );
    this.rangeCacheMaxEntries = positiveInteger(rangeCacheMaxEntries, 100);
    this.rangeCacheMaxBytes = positiveInteger(rangeCacheMaxBytes, 2 * 1024 * 1024);
    this.run = run;
    this.now = now;
    this.lastRefreshAt = 0;
    this.retryAt = 0;
    this.lastFailure = null;
    this.refreshRetryAt = 0;
    this.lastRefreshFailure = null;
    this.validated = false;
    this.rangeCache = new Map();
    this.rangeCacheBytes = 0;
  }

  async git(args, { signal = null, timeoutMs = this.commandTimeoutMs } = {}) {
    return this.run(args, { timeoutMs, signal });
  }

  async ensureStateDirectories() {
    await ensureStateDirectory(this.stateDirectory);
    await fs.mkdir(this.mirrorsDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.locksDirectory, { recursive: true, mode: 0o700 });
    for (const directory of [this.mirrorsDirectory, this.locksDirectory]) {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe Git mirror directory: ${directory}`);
      }
      await fs.chmod(directory, 0o700);
    }
  }

  async withMutationLock(kind, load, { signal = null } = {}) {
    await this.ensureStateDirectories();
    let release;
    try {
      release = await acquireProcessLock(this.locksDirectory, `mirror:${this.lockIdentity}`, {
        timeoutMs: this.lockTimeoutMs,
        signal,
      });
      await this.cleanupAbandonedCloneDirectories();
      return await load(signal);
    } catch (error) {
      if (error.code === 'ELOCKTIMEOUT') {
        throw transientError(`Timed out waiting for Git mirror lock ${path.basename(this.lockPath)}`, error);
      }
      throw error;
    } finally {
      await release?.();
    }
  }

  async validateMirror(target = this.mirrorPath, { signal = null } = {}) {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new InvalidMirrorError('Mirror is missing', error);
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new InvalidMirrorError('Mirror is not a directory');
    let values;
    try {
      values = await Promise.all([
        this.git(['-C', target, 'rev-parse', '--is-bare-repository'], { signal }),
        this.git(['-C', target, 'remote', 'get-url', 'origin'], { signal }),
        this.git(['-C', target, 'config', '--get', 'merge4appstore.repository'], { signal }),
        this.git(['-C', target, 'config', '--get', 'remote.origin.promisor'], { signal }),
        this.git(['-C', target, 'config', '--get', 'remote.origin.partialclonefilter'], { signal }),
      ]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error) || commandExitCode(error) === null) throw error;
      throw new InvalidMirrorError('Mirror metadata is invalid', error);
    }
    const [
      { stdout: bare },
      { stdout: origin },
      { stdout: identity },
      { stdout: promisor },
      { stdout: filter },
    ] = values;
    if (bare.trim() !== 'true') throw new InvalidMirrorError('Mirror is not a bare Git repository');
    if (origin.trim() !== this.remoteUrl) throw new InvalidMirrorError('Mirror origin does not match the configured repository');
    if (identity.trim() !== this.identity) throw new InvalidMirrorError('Mirror repository identity does not match');
    if (promisor.trim() !== 'true' || filter.trim() !== 'blob:none') {
      throw new InvalidMirrorError('Mirror is not configured as a blobless partial clone');
    }
  }

  async configureMirror(target, { signal = null } = {}) {
    await this.git(['-C', target, 'config', 'merge4appstore.repository', this.identity], { signal });
  }

  async verifyObjectConnectivity(target = this.mirrorPath, { signal = null } = {}) {
    try {
      // `fsck` understands promisor packs, so intentionally omitted blobs in a
      // blobless clone are not reported as corruption. Missing commits, trees,
      // pack indexes, and broken refs still fail closed before a refresh stamp
      // can advertise the mirror as healthy.
      await this.git([
        '-C', target,
        'fsck', '--connectivity-only', '--no-dangling',
      ], { signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error)) throw error;
      if (commandExitCode(error) === null) {
        throw transientError(`Could not verify Git mirror connectivity for ${this.identity}`, error);
      }
      throw new CorruptMirrorError(
        `Git mirror object connectivity is invalid for ${this.identity}`,
        error,
      );
    }
  }

  async getLastRefreshAt() {
    try {
      const stat = await fs.stat(path.join(this.mirrorPath, this.refreshStampName));
      return Math.max(this.lastRefreshAt, stat.mtimeMs);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return this.lastRefreshAt;
    }
  }

  async markRefreshed(target = this.mirrorPath) {
    const stamp = path.join(target, this.refreshStampName);
    const refreshedAt = this.now();
    await fs.writeFile(stamp, `${new Date(refreshedAt).toISOString()}\n`, { mode: 0o600 });
    await fs.utimes(stamp, refreshedAt / 1000, refreshedAt / 1000);
    await fs.chmod(stamp, 0o600);
    this.lastRefreshAt = refreshedAt;
  }

  async quarantineInvalidMirror() {
    const quarantine = `${this.mirrorPath}.invalid-${Date.now()}-${crypto.randomUUID()}`;
    await fs.rename(this.mirrorPath, quarantine);
    this.validated = false;
    const prefix = `${path.basename(this.mirrorPath)}.invalid-`;
    const quarantines = (await fs.readdir(this.mirrorsDirectory, { withFileTypes: true }))
      .filter(entry => entry.name.startsWith(prefix))
      .map(entry => path.join(this.mirrorsDirectory, entry.name));
    const byNewest = await Promise.all(quarantines.map(async candidate => ({
      candidate,
      modifiedAt: (await fs.lstat(candidate)).mtimeMs,
    })));
    byNewest.sort((left, right) => right.modifiedAt - left.modifiedAt);
    await Promise.all(byNewest.slice(2).map(({ candidate }) => (
      fs.rm(candidate, { recursive: true, force: true })
    )));
    return quarantine;
  }

  async cleanupAbandonedCloneDirectories() {
    const prefix = `${path.basename(this.mirrorPath)}.tmp-`;
    const abandoned = (await fs.readdir(this.mirrorsDirectory, { withFileTypes: true }))
      .filter(entry => entry.name.startsWith(prefix))
      .map(entry => path.join(this.mirrorsDirectory, entry.name));
    await Promise.all(abandoned.map(candidate => fs.rm(candidate, { recursive: true, force: true })));
  }

  recordInitializationFailure(error) {
    const failure = this.withConfiguredRetryAfter(error.statusCode === 503
      ? error
      : transientError(`Could not initialize Git mirror for ${this.identity}`, error));
    this.retryAt = this.now() + this.retryBackoffMs;
    this.lastFailure = failure;
    return failure;
  }

  withConfiguredRetryAfter(failure) {
    failure.retryAfter = Math.max(
      Number(failure.retryAfter) || 0,
      Math.ceil(this.retryBackoffMs / 1_000),
    );
    return failure;
  }

  async rebuildCorruptMirrorLocked(signal = null) {
    this.rangeCache.clear();
    this.rangeCacheBytes = 0;
    this.validated = false;
    this.retryAt = 0;
    this.lastFailure = null;
    this.refreshRetryAt = 0;
    this.lastRefreshFailure = null;
    try {
      if (await pathExists(this.mirrorPath)) await this.quarantineInvalidMirror();
      await this.initializeMirrorLocked(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error)) throw error;
      // Once quarantine has started there may be no active mirror left. Record
      // the failed replacement as an initialization outage as well as a refresh
      // outage, otherwise the next refresh enters ensureInitialized() first and
      // immediately reclones despite the transport backoff.
      throw this.recordInitializationFailure(error);
    }
  }

  async withCorruptionRecovery(load, { signal = null } = {}) {
    try {
      return await load(signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error) || !isObjectCorruption(error)) throw error;
    }

    return this.withMutationLock('repair', async operationSignal => {
      try {
        // A different process may have repaired the mirror while this caller
        // waited. Repeat the exact read while holding the mutation lock before
        // quarantining a repository that is now healthy.
        return await load(operationSignal);
      } catch (error) {
        if (operationSignal?.aborted) throw operationSignal.reason;
        if (isAbortLike(error) || !isObjectCorruption(error)) throw error;
      }

      await this.rebuildCorruptMirrorLocked(operationSignal);
      try {
        return await load(operationSignal);
      } catch (error) {
        if (operationSignal?.aborted) throw operationSignal.reason;
        if (isAbortLike(error)) throw error;
        if (isObjectCorruption(error)) {
          throw transientError(`Git mirror for ${this.identity} remained corrupt after rebuilding`, error);
        }
        throw error;
      }
    }, { signal });
  }

  async initializeMirrorLocked(signal = null) {
    if (await pathExists(this.mirrorPath)) {
      try {
        await this.validateMirror(this.mirrorPath, { signal });
        await this.verifyObjectConnectivity(this.mirrorPath, { signal });
        this.validated = true;
        return false;
      } catch (error) {
        if (!(error instanceof InvalidMirrorError)) throw error;
        await this.quarantineInvalidMirror();
      }
    }

    const temporary = `${this.mirrorPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      const clone = await this.git([
        'clone', '--mirror', '--filter=blob:none', this.remoteUrl, temporary,
      ], { signal, timeoutMs: this.cloneTimeoutMs });
      if (cloneFilterIgnored(clone)) {
        throw new InvalidMirrorError(
          `Remote for ${this.identity} did not honor the blobless clone filter`,
        );
      }
      await this.configureMirror(temporary, { signal });
      await this.verifyObjectConnectivity(temporary, { signal });
      await this.markRefreshed(temporary);
      await this.validateMirror(temporary, { signal });
      await fs.chmod(temporary, 0o700);
      await fs.rename(temporary, this.mirrorPath);
      this.validated = true;
      this.lastRefreshAt = this.now();
      return true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error)) throw error;
      throw transientError(`Could not initialize Git mirror for ${this.identity}`, error);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  async ensureInitialized({ signal = null } = {}) {
    if (this.validated) return;
    if (this.retryAt > this.now() && this.lastFailure) throw this.lastFailure;
    try {
      await this.withMutationLock('initialize', async operationSignal => {
        if (this.validated) return;
        if (this.retryAt > this.now() && this.lastFailure) throw this.lastFailure;
        try {
          await this.initializeMirrorLocked(operationSignal);
        } catch (error) {
          if (operationSignal?.aborted) throw operationSignal.reason;
          if (isAbortLike(error)) throw error;
          const failure = this.recordInitializationFailure(error);
          // Record the failure before releasing the mutation lock so callers
          // that already passed the outer check do not clone sequentially.
          throw failure;
        }
      }, { signal });
      this.validated = true;
      this.retryAt = 0;
      this.lastFailure = null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error)) throw error;
      const failure = this.recordInitializationFailure(error);
      throw failure;
    }
  }

  async hasCommitUnchecked(commit, { signal = null } = {}) {
    try {
      await this.git(
        ['-C', this.mirrorPath, 'cat-file', '-e', `${commit}^{commit}`],
        { signal },
      );
      return true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error)) throw error;
      if (isObjectCorruption(error)) {
        throw new CorruptMirrorError(`Git mirror object storage is corrupt while inspecting ${commit}`, error);
      }
      if (commandExitCode(error) === 128 && /not a valid object|could not get object info|bad object/i.test(error.stderr || '')) {
        return false;
      }
      throw transientError(`Could not inspect commit ${commit} in the Git mirror`, error);
    }
  }

  async hasCommit(commit, { signal = null } = {}) {
    validateCommit(commit);
    return this.withCorruptionRecovery(
      operationSignal => this.hasCommitUnchecked(commit, { signal: operationSignal }),
      { signal },
    );
  }

  async refresh({ headCommit = null, force = false, signal = null } = {}) {
    if (headCommit) validateCommit(headCommit);
    // Forced deployment prewarming validates/initializes inside the refresh
    // mutation lock below. Taking a separate initialization lock first would
    // double the lock-wait budget and a new clone would be fetched again
    // immediately. Runtime reads retain their ordinary initialization path.
    if (!force || this.validated) {
      await this.ensureInitialized({ signal });
    } else if (this.retryAt > this.now() && this.lastFailure) {
      throw this.lastFailure;
    }

    // Most preparation requests ask for the subject and then the range for the
    // same head. Avoid taking a kernel lock and re-running metadata/fsck checks
    // twice while the durable stamp is fresh and the requested commit is
    // already readable. A missing/corrupt object falls through to the locked
    // verification and repair path below.
    if (!force && this.now() - await this.getLastRefreshAt() < this.refreshTtlMs) {
      try {
        if (!headCommit || await this.hasCommitUnchecked(headCommit, { signal })) return;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (isAbortLike(error)) throw error;
      }
    }

    if (!force && this.refreshRetryAt > this.now() && this.lastRefreshFailure) {
      throw this.lastRefreshFailure;
    }

    try {
      await this.withMutationLock('refresh', async operationSignal => {
        // A forced caller may have queued before another caller recorded an
        // initialization failure. Recheck after acquiring the lock so queued
        // callers share that backoff instead of cloning serially.
        if (!this.validated && this.retryAt > this.now() && this.lastFailure) {
          throw this.lastFailure;
        }
        if (!force && this.refreshRetryAt > this.now() && this.lastRefreshFailure) {
          throw this.lastRefreshFailure;
        }
        try {
          const becameFresh = this.now() - await this.getLastRefreshAt() < this.refreshTtlMs;
          if (!force && becameFresh) {
            try {
              if (
                !headCommit
                || await this.hasCommitUnchecked(headCommit, { signal: operationSignal })
              ) return;
            } catch (error) {
              if (operationSignal?.aborted) throw operationSignal.reason;
              if (isAbortLike(error)) throw error;
              // The verification below produces the authoritative corruption
              // or missing-repository classification before deciding whether
              // to rebuild. Fast-path read failures are not authoritative
              // because another process may just have replaced the mirror.
            }
          }
          try {
            await this.validateMirror(this.mirrorPath, { signal: operationSignal });
            await this.verifyObjectConnectivity(this.mirrorPath, { signal: operationSignal });
            this.validated = true;
          } catch (error) {
            // Corruption is an InvalidMirrorError subtype, so test it first and
            // let the outer recovery path record both refresh and replacement
            // initialization backoff if recloning fails.
            if (error instanceof CorruptMirrorError) throw error;
            if (!(error instanceof InvalidMirrorError)) {
              throw transientError(`Could not validate Git mirror for ${this.identity}`, error);
            }
            this.validated = false;
            let initializedNow;
            try {
              initializedNow = await this.initializeMirrorLocked(operationSignal);
            } catch (initializationError) {
              if (operationSignal?.aborted) throw operationSignal.reason;
              if (isAbortLike(initializationError)) throw initializationError;
              throw this.recordInitializationFailure(initializationError);
            }
            // A successful clone already fetched the remote, verified object
            // connectivity, and published a fresh stamp. Do not repeat the
            // same network operation while retaining the mutation lock.
            if (initializedNow) return;
          }

          let fetchResult;
          try {
            fetchResult = await this.git([
              '-C', this.mirrorPath,
              'fetch', '--prune', '--filter=blob:none', 'origin',
            ], { signal: operationSignal, timeoutMs: this.fetchTimeoutMs });
          } catch (error) {
            if (operationSignal?.aborted) throw operationSignal.reason;
            if (isAbortLike(error)) throw error;
            if (headCommit && await this.hasCommitUnchecked(headCommit, { signal: operationSignal })) {
              await this.markRefreshed();
              return;
            }
            throw transientError(`Could not refresh Git mirror for ${this.identity}`, error);
          }
          if (cloneFilterIgnored(fetchResult)) {
            throw transientError(
              `Remote for ${this.identity} did not honor the blobless fetch filter`,
            );
          }
          try {
            await this.git(['-C', this.mirrorPath, 'maintenance', 'run', '--auto'], { signal: operationSignal });
          } catch (error) {
            if (operationSignal?.aborted) throw operationSignal.reason;
            if (isAbortLike(error)) throw error;
            if (isObjectCorruption(error)) {
              throw new CorruptMirrorError(`Git mirror object storage is corrupt during maintenance for ${this.identity}`, error);
            }
            // Maintenance is opportunistic; a successful fetch is already usable.
          }
          await this.verifyObjectConnectivity(this.mirrorPath, { signal: operationSignal });
          await this.markRefreshed();
        } catch (error) {
          if (operationSignal?.aborted) throw operationSignal.reason;
          if (isAbortLike(error)) throw error;
          if (isObjectCorruption(error)) {
            try {
              await this.rebuildCorruptMirrorLocked(operationSignal);
              return;
            } catch (repairError) {
              if (operationSignal?.aborted) throw operationSignal.reason;
              if (isAbortLike(repairError)) throw repairError;
              error = repairError;
            }
          }
          const failure = this.withConfiguredRetryAfter(error.statusCode === 503
            ? error
            : transientError(`Could not refresh Git mirror for ${this.identity}`, error));
          // Set backoff before releasing the lock so already-queued requests
          // cannot repeat the same failed transport operation serially.
          this.refreshRetryAt = this.now() + this.retryBackoffMs;
          this.lastRefreshFailure = failure;
          throw failure;
        }
      }, { signal });
      this.retryAt = 0;
      this.lastFailure = null;
      this.refreshRetryAt = 0;
      this.lastRefreshFailure = null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error)) throw error;
      const failure = this.withConfiguredRetryAfter(error.statusCode === 503
        ? error
        : transientError(`Could not refresh Git mirror for ${this.identity}`, error));
      this.refreshRetryAt = this.now() + this.retryBackoffMs;
      this.lastRefreshFailure = failure;
      throw failure;
    }
    this.lastRefreshAt = await this.getLastRefreshAt();
  }

  selectCandidates(publishedCommits, headCommit, branch) {
    const normalizedBranch = normalizeBranch(branch);
    const candidates = (publishedCommits || [])
      .map(candidate => typeof candidate === 'string' ? { commitSha: candidate } : candidate)
      .filter(candidate => isCommit(candidate?.commitSha) && candidate.commitSha !== headCommit);
    // Without a source branch every build is branch-unknown. Retain the old
    // bounded-search contract instead of spawning hundreds of local Git
    // processes for legacy preparation clients that omit the branch.
    if (!normalizedBranch) return candidates.slice(0, this.candidateLimit);

    // App Store builds arrive newest-first. Preserve that ordering while
    // excluding known-other branches; grouping exact matches ahead of unknown
    // ones can incorrectly select an older published ancestor and repeat
    // commits that a newer branch-unknown build already shipped.
    let unknownBranches = 0;
    return candidates.filter(candidate => {
      const candidateBranch = normalizeBranch(candidate.sourceBranch);
      if (candidateBranch === normalizedBranch) return true;
      if (candidateBranch) return false;
      unknownBranches += 1;
      return unknownBranches <= this.candidateLimit;
    }).slice(0, maxCandidateChecks);
  }

  async readCommitSubjectUnchecked(commit, { signal = null } = {}) {
    if (!(await this.hasCommitUnchecked(commit, { signal }))) {
      throw transientError(`Commit ${commit} is not available in the Git mirror`);
    }
    try {
      const result = await this.git([
        '-C', this.mirrorPath,
        'show', '-s', '--format=%s', commit,
      ], { signal });
      return result.stdout.trim() || null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isAbortLike(error)) throw error;
      if (isObjectCorruption(error)) {
        throw new CorruptMirrorError(`Git mirror object storage is corrupt while reading ${commit}`, error);
      }
      throw transientError(`Could not read commit ${commit} from the Git mirror`, error);
    }
  }

  async getCommitSubject(commit, { forceRefresh = false, signal = null } = {}) {
    validateCommit(commit);
    await this.refresh({ headCommit: commit, force: forceRefresh, signal });
    return this.withCorruptionRecovery(
      operationSignal => this.readCommitSubjectUnchecked(commit, { signal: operationSignal }),
      { signal },
    );
  }

  async readCommitSubjectsSinceUnchecked(candidates, headCommit, {
    signal = null,
    onUnavailableCandidate = () => {},
  } = {}) {
    if (!(await this.hasCommitUnchecked(headCommit, { signal }))) {
      throw transientError(`Commit ${headCommit} is not available in the Git mirror`);
    }

    let result = null;
    for (const candidate of candidates) {
      if (!(await this.hasCommitUnchecked(candidate.commitSha, { signal }))) {
        // The candidates are ordered newest-first. A later ancestor is a safe
        // fallback for this response, but it must not become a process-lifetime
        // cache entry: a subsequent refresh may make this preferred commit
        // available and shorten the release-note range.
        onUnavailableCandidate(candidate);
        continue;
      }
      try {
        await this.git([
          '-C', this.mirrorPath,
          'merge-base', '--is-ancestor', candidate.commitSha, headCommit,
        ], { signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (isAbortLike(error)) throw error;
        if (commandExitCode(error) === 1) continue;
        if (isObjectCorruption(error)) {
          throw new CorruptMirrorError(`Git mirror object storage is corrupt while comparing ${this.identity}`, error);
        }
        throw transientError(`Could not compare Git history for ${this.identity}`, error);
      }
      try {
        const history = await this.git([
          '-C', this.mirrorPath,
          'log', '--reverse', '--topo-order', '--format=%s',
          `${candidate.commitSha}..${headCommit}`,
        ], { signal });
        result = {
          baseCommit: candidate.commitSha,
          baseBuildNumber: candidate.buildNumber || null,
          baseMarketingVersion: candidate.marketingVersion || null,
          subjects: history.stdout.split('\n').map(subject => subject.trim()).filter(Boolean),
        };
        break;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (isAbortLike(error)) throw error;
        if (isObjectCorruption(error)) {
          throw new CorruptMirrorError(`Git mirror object storage is corrupt while reading ${this.identity}`, error);
        }
        throw transientError(`Could not read Git history for ${this.identity}`, error);
      }
    }
    return result;
  }

  async getCommitSubjectsSince(publishedCommits, headCommit, { branch = null, signal = null } = {}) {
    validateCommit(headCommit);
    const candidates = this.selectCandidates(publishedCommits, headCommit, branch);
    const cacheKey = JSON.stringify([
      headCommit,
      normalizeBranch(branch),
      candidates.map(candidate => [
        candidate.commitSha,
        candidate.buildNumber || null,
        candidate.marketingVersion || null,
      ]),
    ]);
    if (this.rangeCache.has(cacheKey)) return this.rangeCache.get(cacheKey).value;

    await this.refresh({ headCommit, signal });
    let unavailableCandidate = false;
    const result = await this.withCorruptionRecovery(
      operationSignal => this.readCommitSubjectsSinceUnchecked(candidates, headCommit, {
        signal: operationSignal,
        onUnavailableCandidate: () => { unavailableCandidate = true; },
      }),
      { signal },
    );

    if (!unavailableCandidate) {
      const weight = rangeCacheWeight(cacheKey, result);
      if (weight <= this.rangeCacheMaxBytes) {
        const previous = this.rangeCache.get(cacheKey);
        if (previous) this.rangeCacheBytes -= previous.weight;
        this.rangeCache.delete(cacheKey);
        this.rangeCache.set(cacheKey, { value: result, weight });
        this.rangeCacheBytes += weight;
        while (
          this.rangeCache.size > this.rangeCacheMaxEntries
          || this.rangeCacheBytes > this.rangeCacheMaxBytes
        ) {
          const oldestKey = this.rangeCache.keys().next().value;
          const oldest = this.rangeCache.get(oldestKey);
          this.rangeCache.delete(oldestKey);
          this.rangeCacheBytes -= oldest.weight;
        }
      }
    }
    return result;
  }
}

export function getGitMirror(owner, repository, options = {}) {
  const stateDirectory = resolveStateDirectory(options.stateDirectory || (
    options.environment?.MERGE4APPSTORE_STATE_DIR
    || process.env.MERGE4APPSTORE_STATE_DIR
    || path.join(os.homedir(), '.local', 'state', 'merge4appstore')
  ));
  const key = `${stateDirectory}\0${owner.toLowerCase()}/${repository.toLowerCase()}\0${options.remoteUrl || ''}`;
  if (!mirrors.has(key)) mirrors.set(key, new GitMirror(owner, repository, { ...options, stateDirectory }));
  return mirrors.get(key);
}

export function clearGitMirrorRegistry() {
  mirrors.clear();
}
