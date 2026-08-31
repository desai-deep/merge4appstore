#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { getGitMirror } from '../lib/git-mirror.js';
import { loadRepositoryProfile } from '../lib/profile.js';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function prewarmGitMirrors(
  repositories,
  { mirrorFor = getGitMirror, logger = console } = {},
) {
  const failures = [];
  for (const [name, repository] of repositories) {
    try {
      const mirror = mirrorFor(repository.owner, repository.name);
      await mirror.refresh({ force: true });
      logger.log(`Git mirror ready: ${name}`);
    } catch (error) {
      failures.push({ name, error });
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Git mirror failed: ${name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Could not prepare ${failures.length} Git mirror(s): ${failures.map(({ name }) => name).join(', ')}`,
    );
  }
}

export async function prepareConfiguredGitMirrors() {
  dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(root, '.env') });
  const cloneTimeoutMs = positiveInteger(
    process.env.MERGE4APPSTORE_MIRROR_CLONE_TIMEOUT_MS,
    120_000,
  );

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
    mirrorFor: (owner, repository) => getGitMirror(owner, repository, { cloneTimeoutMs }),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await prepareConfiguredGitMirrors();
}
