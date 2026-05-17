#!/usr/bin/env node

process.env.DOTENV_CONFIG_QUIET = 'true';

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { CONFIG, log } from './lib/config.js';
import { runMode, validateEnv } from './lib/runner.js';
import {
  buildWebhookPath,
  DeliveryDeduper,
  extractWebhookEvent,
  shouldTriggerDeploy,
} from './lib/webhook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_BODY_BYTES = 1024 * 1024;
const deduper = new DeliveryDeduper();
const configuredPath = buildWebhookPath(CONFIG.webhookPath, CONFIG.webhookSecretToken);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function handleWebhook(payload) {
  const decision = shouldTriggerDeploy(payload, CONFIG.workflowId);
  const event = decision.event;
  const workflowLabel = event.workflowName || event.workflowId || 'unknown';
  const buildLabel = event.buildNumber || 'unknown';

  if (!decision.accepted) {
    log(`${decision.reason} (workflow: ${workflowLabel}, build: ${buildLabel})`);
    return;
  }

  if (deduper.remember(event)) {
    log(`Ignoring duplicate webhook delivery for build #${buildLabel} from ${workflowLabel}`);
    return;
  }

  log(`Webhook accepted for build #${buildLabel} from ${workflowLabel}`);

  try {
    await runMode('deploy', { dryRun: DRY_RUN });
  } catch (error) {
    log(`Webhook-triggered deploy failed: ${error.message}`);
    if (error.stack) {
      log(`Stack: ${error.stack.split('\n').slice(1, 4).join('\n')}`);
    }
  }
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method !== 'POST' || url.pathname !== configuredPath) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    let rawBody = '';
    let bodyTooLarge = false;

    request.setEncoding('utf8');
    request.on('data', chunk => {
      rawBody += chunk;
      if (rawBody.length > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        request.destroy();
      }
    });

    request.on('error', error => {
      log(`Webhook request error: ${error.message}`);
      if (!response.headersSent) {
        sendJson(response, 400, { error: 'Invalid request body' });
      }
    });

    request.on('close', () => {
      if (bodyTooLarge && !response.headersSent) {
        sendJson(response, 413, { error: 'Payload too large' });
      }
    });

    request.on('end', () => {
      if (bodyTooLarge) {
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody || '{}');
      } catch (error) {
        sendJson(response, 400, { error: 'Invalid JSON payload' });
        return;
      }

      const event = extractWebhookEvent(payload);
      sendJson(response, 202, {
        accepted: true,
        eventType: event.eventType,
        buildNumber: event.buildNumber,
      });

      setImmediate(() => {
        handleWebhook(payload);
      });
    });
  });
}

function main() {
  validateEnv('deploy');

  const server = createServer();
  server.listen(CONFIG.webhookPort, CONFIG.webhookHost, () => {
    log('=== merge4appstore webhook server ===');
    log(`Listening on http://${CONFIG.webhookHost}:${CONFIG.webhookPort}${configuredPath}`);
    if (DRY_RUN) {
      log('DRY RUN MODE - No actual changes will be made');
    }
  });
}

main();
