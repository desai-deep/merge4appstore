#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { GitMirror, getGitMirror } from '../lib/git-mirror.js';
import { loadRepositoryProfile } from '../lib/profile.js';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const defaultPrewarmAttempts = 2;
const defaultRepositoryTimeoutMs = 6 * 60_000;
const defaultPrewarmCommandTimeoutMs = 60_000;
const defaultPrewarmNetworkTimeoutMs = 120_000;
const defaultPrewarmLockTimeoutMs = 60_000;
const defaultPrewarmRetryDelayMs = 5_000;

function abortReason(signal) {
  return signal?.reason || new Error('Git mirror preparation aborted');
}

function delay(milliseconds, signal = null) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function retryDelayMs(error, maximumMs) {
  const retryAfterSeconds = Number(error?.retryAfter);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return Math.min(maximumMs, defaultPrewarmRetryDelayMs);
  }
  return Math.min(maximumMs, Math.ceil(retryAfterSeconds * 1_000));
}

export async function prewarmGitMirrors(
  repositories,
  {
    mirrorFor = getGitMirror,
    logger = console,
    attempts = defaultPrewarmAttempts,
    repositoryTimeoutMs = defaultRepositoryTimeoutMs,
    sleep = delay,
  } = {},
) {
  const failures = [];
  const maximumAttempts = positiveInteger(attempts, defaultPrewarmAttempts);
  const timeoutMs = positiveInteger(repositoryTimeoutMs, defaultRepositoryTimeoutMs);
  for (const [name, repository] of repositories) {
    const controller = new AbortController();
    const repositoryDeadline = Date.now() + timeoutMs;
    const timeoutError = new Error(`Timed out preparing Git mirror ${name}`);
    timeoutError.code = 'EMIRRORPREWARMTIMEOUT';
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    const assertRepositoryBudget = () => {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (Date.now() >= repositoryDeadline) {
        controller.abort(timeoutError);
        throw abortReason(controller.signal);
      }
    };
    try {
      const mirror = mirrorFor(repository.owner, repository.name);
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        assertRepositoryBudget();
        try {
          await mirror.refresh({ force: true, signal: controller.signal });
          assertRepositoryBudget();
          break;
        } catch (error) {
          if (controller.signal.aborted) throw abortReason(controller.signal);
          if (error?.statusCode !== 503 || attempt === maximumAttempts) throw error;
          const remainingMs = repositoryDeadline - Date.now();
          const waitMs = retryDelayMs(error, Number.MAX_SAFE_INTEGER);
          // A retry that cannot finish its required backoff before the
          // repository deadline has no usable execution budget. Fail with the
          // deadline classification now instead of racing two same-deadline
          // timers and occasionally starting an already-expired attempt.
          if (remainingMs <= 0 || waitMs >= remainingMs) {
            controller.abort(timeoutError);
            throw abortReason(controller.signal);
          }
          const message = error instanceof Error ? error.message : String(error);
          const warning = `Git mirror transient failure: ${name}: ${message}; retrying in ${waitMs}ms (attempt ${attempt + 1}/${maximumAttempts})`;
          if (typeof logger.warn === 'function') logger.warn(warning);
          else logger.log(warning);
          await sleep(waitMs, controller.signal);
          assertRepositoryBudget();
        }
      }
      logger.log(`Git mirror ready: ${name}`);
    } catch (error) {
      failures.push({ name, error });
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Git mirror failed: ${name}: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Could not prepare ${failures.length} Git mirror(s): ${failures.map(({ name }) => name).join(', ')}`,
    );
  }
}

export function prewarmGitMirrorOptions(environment = process.env) {
  return {
    commandTimeoutMs: positiveInteger(
      environment.MERGE4APPSTORE_MIRROR_PREWARM_TIMEOUT_MS,
      defaultPrewarmCommandTimeoutMs,
    ),
    cloneTimeoutMs: positiveInteger(
      environment.MERGE4APPSTORE_MIRROR_CLONE_TIMEOUT_MS,
      defaultPrewarmNetworkTimeoutMs,
    ),
    fetchTimeoutMs: positiveInteger(
      environment.MERGE4APPSTORE_MIRROR_PREWARM_FETCH_TIMEOUT_MS,
      defaultPrewarmNetworkTimeoutMs,
    ),
    lockTimeoutMs: positiveInteger(
      environment.MERGE4APPSTORE_MIRROR_PREWARM_LOCK_TIMEOUT_MS,
      defaultPrewarmLockTimeoutMs,
    ),
  };
}

export async function prepareConfiguredGitMirrors() {
  dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(root, '.env') });
  const mirrorOptions = prewarmGitMirrorOptions();

  const profilesDirectory = path.resolve(
    process.env.MERGE4APPSTORE_PROFILES_DIR || path.join(root, 'profiles'),
  );
  const profileFiles = fs.readdirSync(profilesDirectory)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const repositories = new Map();
  for (const name of profileFiles) {
    const profile = loadRepositoryProfile(path.join(profilesDirectory, name));
    const key = `${profile.repository.owner}/${profile.repository.name}`;
    if (!repositories.has(key)) repositories.set(key, profile.repository);
  }

  await prewarmGitMirrors(repositories, {
    // This command is a standalone process. Construct dedicated instances so
    // deployment-only budgets cannot be shadowed by an earlier registry entry.
    mirrorFor: (owner, repository) => new GitMirror(owner, repository, mirrorOptions),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await prepareConfiguredGitMirrors();
}
