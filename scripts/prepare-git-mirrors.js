#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { getGitMirror } from '../lib/git-mirror.js';
import { loadRepositoryProfile } from '../lib/profile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(root, '.env') });

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

for (const [name, repository] of repositories) {
  const mirror = getGitMirror(repository.owner, repository.name);
  await mirror.refresh({ force: true });
  console.log(`Git mirror ready: ${name}`);
}
