import http from 'node:http';
import { extractWebhookSecret, verifySharedSecret } from './webhook-verify.js';

const XCODE_PATH = '/webhook/xcode-cloud';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB - webhook payloads are small

function send(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Builds the webhook HTTP server. `onXcodeCloud(payload)` is invoked (fire and
// forget) for every authenticated build event; the deploy work happens
// asynchronously via the runner, so the webhook caller gets an immediate 202.
export function createWebhookServer({ secret, onXcodeCloud, log = console.log, maxBodyBytes = MAX_BODY_BYTES }) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad request' });
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, { status: 'ok' });
    }

    const isXcodePath =
      url.pathname === XCODE_PATH || url.pathname.startsWith(XCODE_PATH + '/');

    if (!isXcodePath) {
      return send(res, 404, { error: 'not found' });
    }

    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }

    const provided = extractWebhookSecret(req, url, XCODE_PATH);
    if (!verifySharedSecret(provided, secret)) {
      log('Rejected webhook with invalid or missing secret');
      return send(res, 401, { error: 'unauthorized' });
    }

    let payload = null;
    try {
      const raw = await readBody(req, maxBodyBytes);
      if (raw.length > 0) {
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          payload = null; // tolerate non-JSON / empty bodies
        }
      }
    } catch (e) {
      return send(res, e.statusCode || 400, { error: e.message });
    }

    log('Accepted Xcode Cloud webhook - triggering deploy check');
    // Acknowledge immediately; the deploy/retry loop runs in the background.
    send(res, 202, { status: 'accepted' });

    try {
      onXcodeCloud(payload);
    } catch (e) {
      log(`Error handling webhook trigger: ${e.message}`);
    }
  });
}
