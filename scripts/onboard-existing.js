#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import dotenv from 'dotenv';
import { AppStoreConnectAPI } from '../lib/app-store-connect.js';
import { createGitHubAuthenticator } from '../lib/github-app-auth.js';
import { loadWebhookEnvironment } from '../lib/secret-environment.js';
import { parseOnboardingArgs, normalizeOptions, discoverExistingApp, createOnboardingProfile,
  verifyOnboardingRoutes, assertNewProfile, writeOnboardingBundle } from '../lib/onboarding.js';
import YAML from 'yaml';

export const HELP = `Usage: merge4appstore onboard --repo OWNER/REPO --bundle-id com.example.app [options]
       npm run onboard -- --repo OWNER/REPO --bundle-id com.example.app [options]

Onboard an existing iOS app with existing Xcode Cloud workflows. Reads providers
and creates a local setup bundle; never changes provider configuration or starts builds.

  --initial-version VERSION      Explicit version seed (prompted on a terminal)
  --production-workflow ID       Existing production workflow (prompted on a terminal)
  --beta-workflow ID             Optional beta workflow
  --pr-workflow ID               Optional pull-request workflow
  --production-branch BRANCH     Defaults to GitHub's default branch
  --beta-branch BRANCH           Defaults to develop; verified if beta/PR is mapped
  --instance SLUG                Defaults to the repository name
  --service-url HTTPS_URL        Service base URL for the setup checklist
  --output DIRECTORY            New directory; defaults to .merge4appstore-onboarding/SLUG
  --env FILE                    Shared Apple/GitHub environment; default .env in current directory
  --dry-run                     Verify and print profile; no files or secrets generated
  --help                        Show this help

Requires shared APP_STORE_CONNECT_API_KEY_ID, APP_STORE_CONNECT_ISSUER_ID,
APP_STORE_CONNECT_API_KEY_CONTENT (base64 PEM), and GitHub App access or gh auth.
An explicit MERGE4APPSTORE_WEBHOOK_ENV can load private GitHub App credentials.
`;

/**
 * Discover and validate an existing app, then preview its profile or write a private local setup bundle.
 */
export async function main(args = process.argv.slice(2)) {
  let options = parseOnboardingArgs(args);
  if (options.help) { console.log(HELP); return; }
  const terminal = process.stdin.isTTY && process.stdout.isTTY;
  const rl = terminal ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    for (const [key, label] of [['repo', 'GitHub repository (OWNER/REPO)'], ['bundle-id', 'Existing Apple bundle ID']]) {
      if (!options[key] && rl) options[key] = (await rl.question(`${label}: `)).trim();
    }
    options = normalizeOptions(options);
    dotenv.config({ path: options.env || path.resolve('.env'), quiet: true });
    if (process.env.MERGE4APPSTORE_WEBHOOK_ENV) loadWebhookEnvironment(process.env.MERGE4APPSTORE_WEBHOOK_ENV);
    for (const key of ['APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_API_KEY_CONTENT']) {
      if (!process.env[key]) throw new Error(`Missing ${key}; supply it through the environment or --env`);
    }
    const apple = new AppStoreConnectAPI(process.env.APP_STORE_CONNECT_API_KEY_ID,
      process.env.APP_STORE_CONNECT_ISSUER_ID, process.env.APP_STORE_CONNECT_API_KEY_CONTENT);
    const authenticator = createGitHubAuthenticator();
    let github;
    if (authenticator) {
      const [owner, repository] = options.repo.split('/');
      const credential = await authenticator.installationToken(owner, repository);
      github = async endpoint => (await authenticator.request(endpoint, { token: credential.token })).data;
    } else {
      const run = promisify(execFile);
      github = async endpoint => {
        try {
          const { stdout } = await run('gh', ['api', '--hostname', 'github.com', endpoint], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
          return JSON.parse(stdout);
        } catch { throw new Error(`GitHub read failed for ${endpoint}; check gh auth and repository/branch access`); }
      };
    }
    console.log('Reading existing app, repository, workflows, and iOS store versions…');
    const discovery = await discoverExistingApp(options, { apple, github });
    console.log(`App: ${discovery.app.attributes.name} (${discovery.app.id})`);
    for (const workflow of discovery.workflows) {
      console.log(`Workflow: ${workflow.id} — ${workflow.attributes.name}${workflow.attributes.isEnabled === false ? ' (disabled)' : ''}`);
    }
    for (const version of discovery.versions) console.log(`Store version: ${version.attributes.versionString} (${version.attributes.appStoreState})`);
    if (!options['production-workflow'] && rl) {
      options['production-workflow'] = (await rl.question('Production workflow ID: ')).trim();
      if (!options['beta-workflow']) options['beta-workflow'] = (await rl.question('Beta workflow ID (Enter to skip): ')).trim();
      if (!options['pr-workflow']) options['pr-workflow'] = (await rl.question('Pull-request workflow ID (Enter to skip): ')).trim();
    }
    if (!options['initial-version'] && rl) {
      options['initial-version'] = (await rl.question('Initial marketing version (check current project, TestFlight, and any in-flight review): ')).trim();
    }
    if (!options['initial-version']) throw new Error('--initial-version is required; existing-app versions are never guessed');
    const profile = createOnboardingProfile(options, discovery);
    const profilesDirectory = path.resolve(process.env.MERGE4APPSTORE_PROFILES_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles'));
    assertNewProfile(profile, profilesDirectory);
    await verifyOnboardingRoutes(profile, { apple, github });
    if (options.dryRun) { console.log(YAML.stringify(profile)); return; }
    const output = writeOnboardingBundle(options.output || path.join('.merge4appstore-onboarding', profile.instance),
      profile, { serviceUrl: options.serviceUrl, versions: discovery.versions });
    console.log(`Created ${output}\nReview profile.yml and README.md. The build token is in private secrets.env; it has not been printed.`);
  } finally { rl?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Onboarding failed: ${error.message}`); process.exitCode = 1; });
}
