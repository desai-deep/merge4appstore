#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { loadRepositoryProfile } from './lib/profile.js';
import { resolveBuildPurpose } from './lib/profile.js';
import { AppStoreConnectAPI } from './lib/app-store-connect.js';
import { GitHubAPI } from './lib/github.js';
import { inferBuildPurpose, prepareBuild } from './lib/build-prepare.js';
import {
  jobsForGitHubEvent,
  jobsForXcodeCloudEvent,
  safeEqual,
  verifyGitHubSignature,
  webhookSettings,
} from './lib/webhooks.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.MERGE4APPSTORE_ENV || path.join(ROOT, '.env') });

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

export function runJob(entry, job, spawnProcess = spawn) {
  const args = [path.join(ROOT, 'index.js'), job.mode, '--profile', entry.profilePath];
  const environment = { ...process.env };
  if (job.purpose) environment.BUILD_PURPOSE = job.purpose;
  if (job.commitSha) environment.BUILD_COMMIT_SHA = job.commitSha;
  if (job.branch) environment.BUILD_BRANCH = job.branch;
  if (job.pullRequest) environment.BUILD_PULL_REQUEST = job.pullRequest;
  if (job.deliveryId) environment.BUILD_SOURCE_DELIVERY_ID = job.deliveryId;

  return new Promise(resolve => {
    const child = spawnProcess(process.execPath, args, { cwd: ROOT, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      console.log(`${new Date().toISOString()} webhook job ${entry.profile.instance}:${job.mode}${job.purpose ? `:${job.purpose}` : ''} exited ${code}`);
      resolve(code);
    };
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once('error', error => {
      console.error(`${new Date().toISOString()} webhook job ${entry.profile.instance}:${job.mode} failed to start: ${error.message}`);
      finish(1);
    });
    child.once('exit', code => finish(code));
  });
}

function send(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function singleHeader(value) {
  return typeof value === 'string' ? value : '';
}

export function normalizePreparePayload(payload) {
  return {
    ...payload,
    branch: payload.branch?.replace(/^refs\/heads\//, '') || payload.branch,
    target_branch: payload.target_branch?.replace(/^refs\/heads\//, '') || payload.target_branch,
  };
}

async function prepareRequest(entry, payload) {
  const github = new GitHubAPI(entry.profile.repository.owner, entry.profile.repository.name);
  let normalizedPayload = normalizePreparePayload(payload);
  if (!normalizedPayload.pull_request && normalizedPayload.commit && normalizedPayload.branch) {
    const betaBranch = entry.profile.repository.beta_branch || 'develop';
    const pullRequest = github.findOpenPullRequestForCommit(
      normalizedPayload.commit,
      betaBranch,
      normalizedPayload.branch,
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
  const purpose = inferBuildPurpose(entry.profile, normalizedPayload);
  const build = resolveBuildPurpose(entry.profile, purpose);
  const asc = new AppStoreConnectAPI(
    process.env.APP_STORE_CONNECT_API_KEY_ID,
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    process.env.APP_STORE_CONNECT_API_KEY_CONTENT,
  );
  return prepareBuild({ profile: entry.profile, build, payload: normalizedPayload, asc, github });
}

export function createWebhookServer({ profiles, dispatch = runJob, prepare = prepareRequest }) {
  const seen = new Map();
  const remember = key => {
    const now = Date.now();
    for (const [candidate, timestamp] of seen) {
      if (now - timestamp > 24 * 60 * 60 * 1000) seen.delete(candidate);
    }
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        return send(response, 200, { ok: true, profiles: Object.keys(profiles) });
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

      const settings = webhookSettings(entry.profile);
      let jobs;
      let deliveryKey;
      if (prepareMatch) {
        const bearer = singleHeader(request.headers.authorization).replace(/^Bearer\s+/i, '');
        if (!settings.buildToken || !safeEqual(bearer, settings.buildToken)) {
          return send(response, 401, { error: 'Invalid build token' });
        }
        const prepared = await prepare(entry, payload);
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
        deliveryKey = `github:${delivery}`;
        jobs = jobsForGitHubEvent(entry.profile, event, payload, delivery);
      } else if (xcodeMatch) {
        let suppliedToken;
        try { suppliedToken = decodeURIComponent(xcodeMatch[2]); }
        catch { return send(response, 401, { error: 'Invalid token' }); }
        if (!settings.xcodeToken || !safeEqual(suppliedToken, settings.xcodeToken)) {
          return send(response, 401, { error: 'Invalid token' });
        }
        const fingerprint = crypto.createHash('sha256').update(rawBody).digest('hex');
        deliveryKey = `xcode:${fingerprint}`;
        jobs = jobsForXcodeCloudEvent(entry.profile, payload);
      } else return send(response, 404, { error: 'Not found' });

      if (!remember(deliveryKey)) return send(response, 200, { accepted: true, duplicate: true });
      send(response, 202, { accepted: true, jobs: jobs.map(job => `${job.mode}${job.purpose ? `:${job.purpose}` : ''}`) });
      for (const job of jobs) await dispatch(entry, job);
    } catch (error) {
      if (!response.headersSent) send(response, error.statusCode || 500, { error: error.message });
      console.error(error);
    }
  });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (process.env.WEBHOOK_AUTOSTART === 'true' || invokedDirectly) {
  const directory = path.resolve(process.env.MERGE4APPSTORE_PROFILES_DIR || path.join(ROOT, 'profiles'));
  const profiles = loadProfiles(directory);
  const port = Number(process.env.WEBHOOK_PORT || 8787);
  const host = process.env.WEBHOOK_HOST || '127.0.0.1';
  createWebhookServer({ profiles }).listen(port, host, () => {
    console.log(`${new Date().toISOString()} webhook server listening on ${host}:${port} for ${Object.keys(profiles).join(', ')}`);
  });
}
