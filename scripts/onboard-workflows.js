#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { loadRepositoryProfile } from '../lib/profile.js';
import { AppStoreConnectAPI } from '../lib/app-store-connect.js';
import { planWorkflowOnboarding, applyWorkflowOnboarding, saveOnboardedWorkflowIDs } from '../lib/workflow-onboarding.js';

export function parseOnboardingArgs(args) {
  const result = { apply: false, role: 'prod', profilePath: null, configPath: '.env' };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    if (argument === '--apply') { result.apply = true; continue; }
    const keys = { '--profile': 'profilePath', '--app': 'role', '--config': 'configPath' };
    if (!keys[argument] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${argument}`);
    result[keys[argument]] = args[++index];
  }
  if (!result.profilePath) throw new Error('--profile is required');
  if (!['prod', 'uat', 'internal'].includes(result.role)) throw new Error('--app must be prod, uat, or internal');
  return result;
}

export async function main(args = process.argv.slice(2), { asc: injectedASC, environment = process.env, write = console.log } = {}) {
  const options = parseOnboardingArgs(args);
  const profilePath = path.resolve(options.profilePath);
  const originalText = fs.readFileSync(profilePath, 'utf8');
  const profile = loadRepositoryProfile(profilePath);
  let asc = injectedASC;
  if (!asc) {
    const loaded = dotenv.config({ path: path.resolve(options.configPath), quiet: true, processEnv: environment });
    if (loaded.error && loaded.error.code !== 'ENOENT') throw loaded.error;
    const credentials = ['APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_API_KEY_CONTENT'];
    for (const key of credentials) if (!environment[key]) throw new Error(`${key} is required`);
    asc = new AppStoreConnectAPI(...credentials.map(key => environment[key]));
  }
  const apply = options.apply && environment.DRY_RUN !== 'true';
  const plan = await planWorkflowOnboarding(asc, profile, options.role);
  for (const entry of plan.entries) {
    write(`${apply ? 'PLAN' : 'PREVIEW'} ${entry.action}: ${entry.definition.key} (${entry.definition.data.attributes.name})${entry.id ? ` [${entry.id}]` : ''}`);
  }
  write(JSON.stringify(plan.entries.map(entry => ({ action: entry.action, id: entry.id, key: entry.definition.key, ...entry.definition.data })), null, 2));
  if (!apply) {
    write(environment.DRY_RUN === 'true'
      ? 'Preview only: DRY_RUN=true. No Apple or profile changes.'
      : 'Preview only. No Apple or profile changes. Add --apply to reconcile workflows and save IDs.');
    return plan;
  }
  const result = await applyWorkflowOnboarding(asc, profile, options.role, {
    onWorkflow: entry => write(`${entry.action}: ${entry.definition.key} -> ${entry.id}`),
  });
  saveOnboardedWorkflowIDs(profilePath, originalText, options.role, result.ids);
  write(`Saved workflow IDs in ${profilePath}. No builds started or App Store submissions made.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
