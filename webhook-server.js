#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { AsyncTtlCache } from './lib/async-cache.js';
import { createDeliveryStore } from './lib/delivery-store.js';
import { createPrepareCache } from './lib/prepare-cache.js';
import { loadRepositoryProfile } from './lib/profile.js';
import { resolveBuildPurpose } from './lib/profile.js';
import { AppStoreConnectAPI } from './lib/app-store-connect.js';
import { GitHubAPI } from './lib/github.js';
import { inferBuildPurpose, prepareBuild } from './lib/build-prepare.js';
import { loadEnvironmentFile, WEBHOOK_SECRET_NAMES } from './lib/secret-environment.js';
import {
  jobsForGitHubEvent,
  jobsForXcodeCloudEvent,
  safeEqual,
  verifyGitHubSignature,
  webhookSettings,
} from './lib/webhooks.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(ROOT, '.env') });
if (process.env.MERGE4APPSTORE_WEBHOOK_ENV) {
  try {
    loadEnvironmentFile(process.env.MERGE4APPSTORE_WEBHOOK_ENV, {
      override: true,
      allowedNames: WEBHOOK_SECRET_NAMES,
      requireAll: true,
    });
  } catch (error) {
    throw new Error(
      `Could not load MERGE4APPSTORE_WEBHOOK_ENV ${process.env.MERGE4APPSTORE_WEBHOOK_ENV}: ${error.message}`,
    );
  }
}

export function loadProfiles(directory) {
  const profiles = Object.create(null);
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))) {
    const profilePath = path.join(directory, name);
    const profile = loadRepositoryProfile(profilePath);
    if (profiles[profile.instance]) {
      throw new Error(`Duplicate profile instance ${profile.instance}: ${profiles[profile.instance].profilePath} and ${profilePath}`);
    }
    profiles[profile.instance] = { profile, profilePath };
  }
  return profiles;
}

function readBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function runJob(entry, job, spawnProcess = spawn, {
  onSpawn = () => {},
  onSettled = () => {},
  onTimeout = () => {},
  timeoutMs = 0,
} = {}) {
  const args = [path.join(ROOT, 'index.js'), job.mode, '--profile', entry.profilePath];
  const environment = { ...process.env };
  if (job.purpose) environment.BUILD_PURPOSE = job.purpose;
  if (job.commitSha) environment.BUILD_COMMIT_SHA = job.commitSha;
  if (job.branch) environment.BUILD_BRANCH = job.branch;
  if (job.pullRequest) environment.BUILD_PULL_REQUEST = job.pullRequest;
  if (job.deliveryId) environment.BUILD_SOURCE_DELIVERY_ID = job.deliveryId;
  if (job.reconcileMetadata) environment.RECONCILE_METADATA = 'true';
  if (job.dryRun) environment.DRY_RUN = 'true';
  if (job.buildStatus) environment.BUILD_STATUS = job.buildStatus;
  if (job.workflowId) environment.BUILD_WORKFLOW_ID = job.workflowId;
  if (job.runId) environment.BUILD_RUN_ID = job.runId;
  if (job.buildNumber) environment.BUILD_NUMBER = String(job.buildNumber);
  if (job.completedAt) environment.BUILD_COMPLETED_AT = job.completedAt;

  return new Promise(resolve => {
    const child = spawnProcess(process.execPath, args, {
      cwd: ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A separate process group lets forced shutdown terminate index.js and
      // any gh/git helpers it is synchronously waiting for before the webhook
      // owner process exits.
      detached: process.platform !== 'win32',
    });
    onSpawn(child);
    let settled = false;
    let timedOut = false;
    let timeout = null;
    const finish = (code, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      onSettled(child);
      const exitCode = Number.isInteger(code) ? code : 1;
      const outcome = signal ? `was terminated by ${signal}` : `exited ${exitCode}`;
      console.log(`${new Date().toISOString()} webhook job ${entry.profile.instance}:${job.mode}${job.purpose ? `:${job.purpose}` : ''} ${outcome}`);
      resolve(timedOut ? 1 : exitCode);
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        console.error(`${new Date().toISOString()} webhook job ${entry.profile.instance}:${job.mode} exceeded its ${timeoutMs}ms execution deadline`);
        try {
          Promise.resolve(onTimeout(child)).catch(error => {
            console.error(`${new Date().toISOString()} webhook job timeout cleanup failed: ${error.stack || error.message}`);
          });
        } catch (error) {
          console.error(`${new Date().toISOString()} webhook job timeout cleanup failed: ${error.stack || error.message}`);
        }
      }, timeoutMs);
      timeout.unref?.();
    }
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once('error', error => {
      console.error(`${new Date().toISOString()} webhook job ${entry.profile.instance}:${job.mode} failed to start: ${error.message}`);
      finish(1);
    });
    child.once('exit', (code, signal) => finish(code, signal));
  });
}

function childExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

function waitForChild(child) {
  if (childExited(child)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      child.removeListener('exit', done);
      child.removeListener('error', done);
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
  });
}

function signalJobTree(child, signal) {
  try {
    if (process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
      process.kill(-child.pid, signal);
    } else if (!childExited(child)) {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function processGroupIsAlive(pid) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroups(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processGroupIsAlive) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function waitAtMost(promise, timeoutMs) {
  let timer;
  await Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export function createJobRunner({
  spawnProcess = spawn,
  termTimeoutMs = 3_000,
  killTimeoutMs = 2_000,
  jobTimeoutMs = 20 * 60_000,
} = {}) {
  const children = new Set();
  const processGroups = new Set();
  const forgetProcessGroupWhenEmpty = pid => {
    if (!processGroups.has(pid)) return;
    if (!processGroupIsAlive(pid)) {
      processGroups.delete(pid);
      return;
    }
    const timer = setTimeout(() => forgetProcessGroupWhenEmpty(pid), 50);
    timer.unref?.();
  };
  const terminateChildTree = async child => {
    if (process.platform !== 'win32') {
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      if (processGroupIsAlive(pid)) signalJobTree(child, 'SIGTERM');
      await waitForProcessGroups([pid], termTimeoutMs);
      if (processGroupIsAlive(pid)) signalJobTree(child, 'SIGKILL');
      await waitForProcessGroups([pid], killTimeoutMs);
      if (processGroupIsAlive(pid)) {
        throw new Error(`Webhook job process group ${pid} survived its execution deadline`);
      }
      processGroups.delete(pid);
      return;
    }
    if (childExited(child)) return;
    let exit = waitForChild(child);
    signalJobTree(child, 'SIGTERM');
    await waitAtMost(exit, termTimeoutMs);
    if (!childExited(child)) {
      exit = waitForChild(child);
      signalJobTree(child, 'SIGKILL');
      await waitAtMost(exit, killTimeoutMs);
    }
    if (!childExited(child)) throw new Error('Webhook job survived its execution deadline');
  };
  const runner = (entry, job) => runJob(entry, job, spawnProcess, {
    onSpawn: child => {
      children.add(child);
      if (process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
        processGroups.add(child.pid);
      }
    },
    onSettled: child => {
      children.delete(child);
      if (process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
        forgetProcessGroupWhenEmpty(child.pid);
      }
    },
    onTimeout: terminateChildTree,
    timeoutMs: jobTimeoutMs,
  });
  runner.terminateChildren = async () => {
    if (process.platform !== 'win32') {
      const groups = [...processGroups];
      for (const pid of groups.filter(processGroupIsAlive)) {
        signalJobTree({ pid, exitCode: null, signalCode: null }, 'SIGTERM');
      }
      await waitForProcessGroups(groups, termTimeoutMs);
      for (const pid of groups.filter(processGroupIsAlive)) {
        signalJobTree({ pid, exitCode: null, signalCode: null }, 'SIGKILL');
      }
      await waitForProcessGroups(groups, killTimeoutMs);
      for (const pid of groups) {
        if (!processGroupIsAlive(pid)) processGroups.delete(pid);
      }
    } else {
      let active = [...children].filter(child => !childExited(child));
      let exits = active.map(child => waitForChild(child));
      for (const child of active) signalJobTree(child, 'SIGTERM');
      await waitAtMost(Promise.allSettled(exits), termTimeoutMs);
      active = [...children].filter(child => !childExited(child));
      exits = active.map(child => waitForChild(child));
      for (const child of active) signalJobTree(child, 'SIGKILL');
      await waitAtMost(Promise.allSettled(exits), killTimeoutMs);
    }

    if (
      [...children].some(child => !childExited(child))
      || [...processGroups].some(processGroupIsAlive)
    ) {
      throw new Error('Webhook job process tree did not exit before the forced shutdown deadline');
    }
  };
  Object.defineProperty(runner, 'activeChildren', {
    get: () => children.size,
  });
  return runner;
}

export function createSerialDispatcher(dispatch = runJob) {
  const queues = new Map();

  return (entry, job) => {
    const key = entry.profile.instance;
    const previous = queues.get(key) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => dispatch(entry, job));
    const tracked = current.finally(() => {
      if (queues.get(key) === tracked) queues.delete(key);
    });
    queues.set(key, tracked);
    return tracked;
  };
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function singleHeader(value) {
  return typeof value === 'string' ? value : '';
}

export function webhookDeliveryKey(provider, instance, delivery) {
  return `${provider}:${instance}:${delivery}`;
}

export function normalizePreparePayload(payload) {
  return {
    ...payload,
    branch: payload.branch?.replace(/^refs\/heads\//, '') || payload.branch,
    target_branch: payload.target_branch?.replace(/^refs\/heads\//, '') || payload.target_branch,
  };
}

export function createPrepareRequest({
  historyCache = new AsyncTtlCache({
    ttlMs: 60_000,
    maxEntries: 100,
  }),
  githubFactory = profile => new GitHubAPI(
    profile.repository.owner,
    profile.repository.name,
    profile.repository.production_branch || 'main',
  ),
  ascFactory = () => new AppStoreConnectAPI(
    process.env.APP_STORE_CONNECT_API_KEY_ID,
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    process.env.APP_STORE_CONNECT_API_KEY_CONTENT,
  ),
} = {}) {
  return async (entry, payload, { signal = null } = {}) => {
    let normalizedPayload = normalizePreparePayload(payload);
    let purpose = normalizedPayload.purpose !== undefined && normalizedPayload.purpose !== null
      ? inferBuildPurpose(entry.profile, normalizedPayload)
      : null;
    const github = githubFactory(entry.profile, { signal });
    github.signal = signal;
    const betaBranch = entry.profile.repository.beta_branch || 'develop';
    const productionBranch = entry.profile.repository.production_branch || 'main';
    if (
      !purpose
      && !normalizedPayload.pull_request
      && normalizedPayload.commit
      && normalizedPayload.branch
      && ![betaBranch, productionBranch].includes(normalizedPayload.branch)
    ) {
      const pullRequest = await (
        github.findOpenPullRequestForCommitAsync?.(
          normalizedPayload.commit,
          betaBranch,
          normalizedPayload.branch,
        )
        ?? github.findOpenPullRequestForCommit?.(
          normalizedPayload.commit,
          betaBranch,
          normalizedPayload.branch,
        )
      );
      if (pullRequest) {
        normalizedPayload = {
          ...normalizedPayload,
          purpose: 'pull_request',
          pull_request: pullRequest.number,
          target_branch: pullRequest.baseBranch,
        };
      }
    }
    purpose ||= inferBuildPurpose(entry.profile, normalizedPayload);
    const build = resolveBuildPurpose(entry.profile, purpose);
    const asc = ascFactory(entry.profile, { signal });
    asc.signal = signal;
    const loadPublishedCommits = asc.getPublishedWorkflowCommits.bind(asc);
    asc.getPublishedWorkflowCommits = (workflowId, limit = 200) => historyCache.get(
      `${entry.profile.instance}\0${build.appId}\0${workflowId}\0${limit}`,
      () => loadPublishedCommits(workflowId, limit),
    );
    return prepareBuild({
      profile: entry.profile,
      build,
      payload: normalizedPayload,
      asc,
      github,
      signal,
    });
  };
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function inspectDeploymentTransactions(stateDirectory, {
  staleAfterMs = 15 * 60_000,
  now = () => Date.now(),
} = {}) {
  if (!stateDirectory) return { active: 0, incomplete: 0 };
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error('MERGE4APPSTORE_STATE_DIR must be absolute');
  }
  const transactionsDirectory = path.join(path.resolve(stateDirectory), 'transactions');
  let entries;
  try {
    entries = await fs.promises.readdir(transactionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { active: 0, incomplete: 0 };
    throw error;
  }
  let active = 0;
  let incomplete = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Unsafe deployment transaction entry: ${path.join(transactionsDirectory, entry.name)}`);
    }
    const directory = path.join(transactionsDirectory, entry.name);
    const [marker, phase, phaseStats] = await Promise.all([
      fs.promises.readFile(path.join(directory, '.merge4appstore-transaction'), 'utf8'),
      fs.promises.readFile(path.join(directory, 'phase'), 'utf8'),
      fs.promises.stat(path.join(directory, 'phase')),
    ]);
    if (marker !== 'merge4appstore-deployment-transaction-v1\n') {
      throw new Error(`Invalid deployment transaction marker: ${directory}`);
    }
    if (!['complete', 'recovered-rolled-back'].includes(phase.trim())) {
      active += 1;
      if (now() - phaseStats.mtimeMs >= staleAfterMs) incomplete += 1;
    }
  }
  return { active, incomplete };
}

function withDeadline(promise, timeoutMs, onTimeout = () => {}) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Build preparation timed out; retry the request');
      error.name = 'AbortError';
      error.statusCode = 503;
      error.retryAfter = 5;
      onTimeout(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createWebhookServer({
  profiles,
  dispatch = null,
  prepare = createPrepareRequest(),
  prepareCache = createPrepareCache(),
  deliveryStore = createDeliveryStore(),
  deploymentSha = process.env.MERGE4APPSTORE_DEPLOY_SHA || null,
  prepareTimeoutMs = positiveNumber(process.env.MERGE4APPSTORE_PREPARE_TIMEOUT_MS, 45_000),
  maxPrepareFlights = 100,
  recoveryIntervalMs = positiveNumber(process.env.MERGE4APPSTORE_RECOVERY_INTERVAL_MS, 5_000),
  retryDelayMs = positiveNumber(process.env.MERGE4APPSTORE_JOB_RETRY_MS, 5_000),
  maxDeliveryAttempts = positiveNumber(process.env.MERGE4APPSTORE_JOB_MAX_ATTEMPTS, 8),
  pendingStaleAfterMs = 15 * 60_000,
  deliveryPausedUntil = Number(process.env.MERGE4APPSTORE_DELIVERY_PAUSED_UNTIL || 0),
  deliveryPauseFile = process.env.MERGE4APPSTORE_DELIVERY_PAUSE_FILE || null,
  deploymentProbe = () => inspectDeploymentTransactions(process.env.MERGE4APPSTORE_STATE_DIR),
  onFatalDeliveryError = () => {},
}) {
  if (!Number.isSafeInteger(maxPrepareFlights) || maxPrepareFlights <= 0) {
    throw new RangeError('maxPrepareFlights must be a positive integer');
  }
  const jobRunner = dispatch || createJobRunner();
  const enqueue = createSerialDispatcher(jobRunner);
  const prepareFlights = new Map();
  const activePrepareTasks = new Set();
  const activeWork = new Set();
  let deliveryInitializationError = null;
  let deliveryRuntimeError = null;
  let fatalDeliveryReported = false;
  const markDeliveryStoreFatal = error => {
    deliveryRuntimeError ||= error;
    if (fatalDeliveryReported) return;
    fatalDeliveryReported = true;
    try {
      Promise.resolve(onFatalDeliveryError(error)).catch(callbackError => {
        console.error(`${new Date().toISOString()} fatal delivery callback failed: ${callbackError.stack || callbackError.message}`);
      });
    } catch (callbackError) {
      console.error(`${new Date().toISOString()} fatal delivery callback failed: ${callbackError.stack || callbackError.message}`);
    }
  };
  const persistDelivery = async (description, operation) => {
    try {
      return await operation();
    } catch (cause) {
      markDeliveryStoreFatal(cause);
      const error = new Error(`${description}; the delivery worker must restart`, { cause });
      error.deliveryStorageFatal = true;
      throw error;
    }
  };
  const deliveryReady = Promise.resolve()
    .then(() => deliveryStore.initialize?.())
    .catch(error => {
      deliveryInitializationError = error;
      throw error;
    });
  deliveryReady.catch(() => {});
  const track = promise => {
    const tracked = Promise.resolve(promise);
    activeWork.add(tracked);
    const remove = () => activeWork.delete(tracked);
    tracked.then(remove, remove);
    return tracked;
  };
  let recoveryStopped = false;
  let recovering = false;
  const isDeliveryPaused = () => {
    if (deliveryPauseFile) {
      try {
        if (!path.isAbsolute(deliveryPauseFile)) {
          throw new Error('MERGE4APPSTORE_DELIVERY_PAUSE_FILE must be absolute');
        }
        const stats = fs.lstatSync(deliveryPauseFile);
        if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o022) !== 0) {
          throw new Error(`Unsafe webhook delivery pause file: ${deliveryPauseFile}`);
        }
        if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
          throw new Error(`Webhook delivery pause file is not owned by the service user: ${deliveryPauseFile}`);
        }
        return true;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          markDeliveryStoreFatal(error);
          return true;
        }
      }
    }
    return Number.isFinite(deliveryPausedUntil) && Date.now() < deliveryPausedUntil;
  };
  const runDelivery = (deliveryClaim, intent) => {
    const background = (async () => {
      try {
        const entry = profiles[intent?.instance];
        if (!entry || !Array.isArray(intent?.jobs)) {
          throw new Error(`Cannot recover webhook delivery for unknown instance ${intent?.instance || '(missing)'}`);
        }
        const cursor = Math.max(0, Number(deliveryClaim.cursor || 0));
        for (let index = cursor; index < intent.jobs.length; index += 1) {
          const job = intent.jobs[index];
          const exitCode = await enqueue(entry, job);
          if (typeof exitCode === 'number' && exitCode !== 0) {
            throw new Error(`Webhook job ${entry.profile.instance}:${job.mode} exited ${exitCode}`);
          }
          if (!await persistDelivery(
            'Could not persist webhook delivery progress',
            () => deliveryStore.advance(deliveryClaim, index + 1),
          )) {
            throw new Error('Webhook delivery ownership changed while recording progress');
          }
        }
        if (!await persistDelivery(
          'Could not persist webhook delivery completion',
          () => deliveryStore.complete(deliveryClaim),
        )) {
          throw new Error('Webhook delivery ownership changed before completion');
        }
      } catch (error) {
        if (error.deliveryStorageFatal) throw error;
        const attempts = Math.max(1, Number(deliveryClaim.attempts || 1));
        if (attempts >= maxDeliveryAttempts) {
          const failed = await persistDelivery(
            'Could not persist failed webhook delivery',
            () => deliveryStore.fail(deliveryClaim, error),
          );
          if (!failed) {
            const dispositionError = new Error('Webhook delivery ownership changed before its failure could be persisted', { cause: error });
            dispositionError.dispositionUnknown = true;
            throw dispositionError;
          }
          error.deadLettered = true;
        } else {
          const delayMs = Math.min(retryDelayMs * (2 ** Math.min(attempts - 1, 6)), 5 * 60_000);
          const retrying = await persistDelivery(
            'Could not persist webhook retry',
            () => deliveryStore.retry(deliveryClaim, error, { delayMs }),
          );
          if (!retrying) {
            const dispositionError = new Error('Webhook delivery ownership changed before its retry could be persisted', { cause: error });
            dispositionError.dispositionUnknown = true;
            throw dispositionError;
          }
        }
        throw error;
      }
    })();
    track(background).catch(error => {
      const disposition = error.deadLettered
        ? `failed ${maxDeliveryAttempts} times and requires manual recovery`
        : error.deliveryStorageFatal
          ? 'delivery storage failed and the worker must restart'
        : error.dispositionUnknown
          ? 'ownership changed; another worker must recover it'
          : 'will be retried';
      console.error(`${new Date().toISOString()} webhook delivery attempt failed; ${disposition}: ${error.stack || error.message}`);
    });
  };
  const recoverPending = async () => {
    if (recoveryStopped || recovering || isDeliveryPaused() || typeof deliveryStore.claimPending !== 'function') return;
    recovering = true;
    try {
      await deliveryReady;
      const claims = await deliveryStore.claimPending();
      for (const claim of claims) runDelivery(claim, claim.intent);
    } catch (error) {
      markDeliveryStoreFatal(error);
      console.error(`${new Date().toISOString()} could not recover pending webhook deliveries: ${error.stack || error.message}`);
    } finally {
      recovering = false;
    }
  };
  const triggerRecovery = () => {
    track(recoverPending()).catch(error => {
      console.error(`${new Date().toISOString()} recovery scan failed: ${error.stack || error.message}`);
    });
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        const deliveryPaused = isDeliveryPaused();
        let deliveryQueue = null;
        let deploymentState = null;
        let probeError = deliveryInitializationError || deliveryRuntimeError;
        try {
          await deliveryReady;
          [deliveryQueue, deploymentState] = await Promise.all([
            deliveryStore.queueStatus?.({ includeAge: true })
              || { pending: 0, failed: 0, corrupt: 0, oldest_pending_age_ms: null },
            deploymentProbe(),
          ]);
        } catch (error) {
          probeError = error;
        }
        const ok = !probeError;
        const degraded = deliveryPaused
          || Number(deliveryQueue?.failed || 0) > 0
          || Number(deliveryQueue?.corrupt || 0) > 0
          || (
            Number.isFinite(deliveryQueue?.oldest_pending_age_ms)
            && deliveryQueue.oldest_pending_age_ms >= pendingStaleAfterMs
          )
          || Number(deploymentState?.incomplete || 0) > 0;
        return send(response, ok ? 200 : 503, {
          ok,
          degraded,
          profiles: Object.keys(profiles),
          deployment_sha: deploymentSha,
          delivery_queue: deliveryQueue,
          deployment_state: deploymentState,
          delivery_paused_until: Number.isFinite(deliveryPausedUntil) && Date.now() < deliveryPausedUntil
            ? new Date(deliveryPausedUntil).toISOString()
            : null,
          delivery_paused: deliveryPaused,
          ...(probeError ? { error: 'Webhook runtime state is unavailable' } : {}),
        }, ok ? {} : { 'retry-after': '30' });
      }
      if (request.method !== 'POST') return send(response, 404, { error: 'Not found' });

      const prepareMatch = url.pathname.match(/^\/v1\/builds\/prepare\/([^/]+)$/);
      const githubMatch = url.pathname.match(/^\/webhooks\/github\/([^/]+)$/);
      const xcodeMatch = url.pathname.match(/^\/webhooks\/xcode-cloud\/([^/]+)\/([^/]+)$/);
      let instance;
      try { instance = decodeURIComponent(prepareMatch?.[1] || githubMatch?.[1] || xcodeMatch?.[1] || ''); }
      catch { return send(response, 400, { error: 'Invalid instance' }); }
      const entry = profiles[instance];
      if (!entry) return send(response, 404, { error: 'Unknown instance' });

      const rawBody = await readBody(request);
      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); }
      catch { return send(response, 400, { error: 'Invalid JSON' }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return send(response, 400, { error: 'JSON payload must be an object' });
      }

      const settings = webhookSettings(entry.profile);
      let jobs;
      let deliveryKey;
      if (prepareMatch) {
        const bearer = singleHeader(request.headers.authorization).replace(/^Bearer\s+/i, '');
        if (!settings.buildToken || !safeEqual(bearer, settings.buildToken)) {
          return send(response, 401, { error: 'Invalid build token' });
        }
        const fingerprint = crypto.createHash('sha256').update(rawBody).digest('hex');
        // A result computed by an older immutable release must not satisfy the
        // candidate release's authenticated smoke test or survive a profile
        // change across rollout. Cluster workers for one release still share
        // the same deployment-scoped key.
        const prepareKey = `${deploymentSha || 'unversioned'}:${instance}:${fingerprint}`;
        let flight = prepareFlights.get(prepareKey);
        if (!flight) {
          if (activePrepareTasks.size >= maxPrepareFlights) {
            const error = new Error('Build preparation is at capacity; retry the request');
            error.statusCode = 503;
            error.retryAfter = 1;
            throw error;
          }
          const controller = new AbortController();
          flight = {
            controller,
            task: track(prepareCache.get(
              prepareKey,
              () => prepare(entry, payload, { signal: controller.signal }),
              { signal: controller.signal },
            )),
          };
          activePrepareTasks.add(flight.task);
          prepareFlights.set(prepareKey, flight);
          const removeFlight = () => {
            activePrepareTasks.delete(flight.task);
            if (prepareFlights.get(prepareKey) === flight) prepareFlights.delete(prepareKey);
          };
          flight.task.then(removeFlight, removeFlight);
        }
        const prepared = await withDeadline(flight.task, prepareTimeoutMs, error => {
          if (prepareFlights.get(prepareKey) === flight) prepareFlights.delete(prepareKey);
          flight.controller.abort(error);
        });
        return send(response, 200, prepared);
      } else if (githubMatch) {
        if (!settings.githubSecret) return send(response, 503, { error: 'GitHub webhook secret is not configured' });
        const signature = singleHeader(request.headers['x-hub-signature-256']);
        if (!verifyGitHubSignature(rawBody, signature, settings.githubSecret)) {
          return send(response, 401, { error: 'Invalid signature' });
        }
        const event = singleHeader(request.headers['x-github-event']);
        const delivery = singleHeader(request.headers['x-github-delivery']);
        if (!delivery) return send(response, 400, { error: 'Missing delivery id' });
        deliveryKey = webhookDeliveryKey('github', instance, delivery);
        jobs = jobsForGitHubEvent(entry.profile, event, payload, delivery);
      } else if (xcodeMatch) {
        let suppliedToken;
        try { suppliedToken = decodeURIComponent(xcodeMatch[2]); }
        catch { return send(response, 401, { error: 'Invalid token' }); }
        if (!settings.xcodeToken || !safeEqual(suppliedToken, settings.xcodeToken)) {
          return send(response, 401, { error: 'Invalid token' });
        }
        const runId = payload.ciBuildRun?.id || payload.webhook?.id;
        const eventType = payload.metadata?.attributes?.eventType || 'unknown';
        const status = payload.ciBuildRun?.attributes?.completionStatus || 'unknown';
        const delivery = runId
          ? `${payload.ciWorkflow?.id || 'unknown'}:${runId}:${eventType}:${status}`
          : crypto.createHash('sha256').update(rawBody).digest('hex');
        deliveryKey = webhookDeliveryKey('xcode', instance, delivery);
        jobs = jobsForXcodeCloudEvent(entry.profile, payload);
      } else return send(response, 404, { error: 'Not found' });

      const intent = { instance, jobs };
      let deliveryClaim;
      try {
        deliveryClaim = await deliveryStore.claim(deliveryKey, intent);
      } catch (error) {
        if (error.code !== 'ECORRUPTRECEIPT') markDeliveryStoreFatal(error);
        error.statusCode ||= 503;
        error.retryAfter ||= 30;
        throw error;
      }
      if (!deliveryClaim) return send(response, 200, { accepted: true, duplicate: true });
      if (isDeliveryPaused()) {
        const delayMs = Math.max(0, deliveryPausedUntil - Date.now());
        const deferred = await persistDelivery(
          'Could not defer webhook delivery during migration',
          () => deliveryStore.retry(deliveryClaim, new Error('Deployment migration drain'), { delayMs }),
        );
        if (!deferred) throw new Error('Webhook delivery ownership changed before migration deferral');
        deliveryClaim = null;
      }
      send(response, 202, { accepted: true, jobs: jobs.map(job => `${job.mode}${job.purpose ? `:${job.purpose}` : ''}`) });
      if (deliveryClaim) runDelivery(deliveryClaim, intent);
    } catch (error) {
      if (!response.headersSent) send(
        response,
        error.statusCode || 500,
        { error: error.message },
        error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {},
      );
      console.error(error);
    }
  });
  server.waitForBackground = async () => {
    while (activeWork.size > 0) {
      await Promise.allSettled([...activeWork]);
    }
  };
  server.waitUntilReady = () => deliveryReady;
  server.terminateJobChildren = jobRunner.terminateChildren || (async () => {});
  Object.defineProperty(server, 'backgroundWorkCount', {
    get: () => activeWork.size,
  });
  const recoveryTimer = setInterval(triggerRecovery, recoveryIntervalMs);
  recoveryTimer.unref?.();
  server.stopBackgroundRecovery = () => {
    recoveryStopped = true;
    clearInterval(recoveryTimer);
  };
  queueMicrotask(triggerRecovery);
  return server;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (process.env.WEBHOOK_AUTOSTART === 'true' || invokedDirectly) {
  const directory = path.resolve(process.env.MERGE4APPSTORE_PROFILES_DIR || path.join(ROOT, 'profiles'));
  const profiles = loadProfiles(directory);
  const port = Number(process.env.WEBHOOK_PORT || 8787);
  const host = process.env.WEBHOOK_HOST || '127.0.0.1';
  const server = createWebhookServer({
    profiles,
    onFatalDeliveryError: error => {
      console.error(`${new Date().toISOString()} webhook delivery storage became unsafe: ${error.stack || error.message}`);
      setImmediate(() => process.kill(process.pid, 'SIGTERM'));
    },
  });
  server.waitUntilReady()
    .then(() => server.listen(port, host, () => {
      console.log(`${new Date().toISOString()} webhook server listening on ${host}:${port} for ${Object.keys(profiles).join(', ')}`);
      if (typeof process.send === 'function') process.send('ready');
    }))
    .catch(error => {
      console.error(`${new Date().toISOString()} webhook server could not initialize: ${error.stack || error.message}`);
      process.exit(1);
    });
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    console.log(`${new Date().toISOString()} received ${signal}; draining webhook requests`);
    server.stopBackgroundRecovery();
    const closed = new Promise(resolve => {
      server.close(error => resolve(error || null));
    });
    server.closeIdleConnections?.();
    let drainDeadlineExceeded = false;
    let forcedTermination = null;
    const timer = setTimeout(() => {
      drainDeadlineExceeded = true;
      console.error(`${new Date().toISOString()} webhook drain deadline exceeded`);
      forcedTermination = server.terminateJobChildren();
      forcedTermination
        .catch(error => console.error(`${new Date().toISOString()} forced child shutdown failed: ${error.stack || error.message}`))
        .finally(() => process.exit(1));
    }, positiveNumber(process.env.MERGE4APPSTORE_DRAIN_TIMEOUT_MS, 10 * 60 * 1000));
    const closeError = await closed;
    await server.waitForBackground();
    clearTimeout(timer);
    if (drainDeadlineExceeded) {
      await forcedTermination?.catch(() => {});
      process.exit(1);
    }
    if (closeError) console.error(closeError);
    process.exit(closeError ? 1 : 0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
