#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadRepositoryProfile, resolveAutomation, resolveBuildPurpose } from '../lib/profile.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profilesDir = path.join(rootDir, 'profiles');
const profileFiles = fs.readdirSync(profilesDir)
  .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
  .sort();

if (profileFiles.length === 0) {
  throw new Error('No repository profiles found');
}

for (const file of profileFiles) {
  const profile = loadRepositoryProfile(path.join(profilesDir, file));
  const routes = ['deploy', 'sync', 'expire']
    .map(name => {
      const automation = resolveAutomation(profile, name);
      if (!automation.enabled) return `${name}=disabled`;
      return `${name}=${automation.appRole}:${automation.appId}${automation.workflowId ? `:${automation.workflowId}` : ''}`;
    })
    .join(', ');
  const builds = profile.build
    ? Object.keys(profile.build.purposes)
      .map(purpose => {
        const build = resolveBuildPurpose(profile, purpose);
        return `${purpose}=${build.provider}:${build.appRole}:${build.workflowId}`;
      })
      .join(', ')
    : 'disabled';
  console.log(`${file}: ${routes}; builds: ${builds}`);
}
