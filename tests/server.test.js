import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebhookServer } from '../lib/server.js';

async function withServer(secret, fn) {
  let triggers = 0;
  const server = createWebhookServer({
    secret,
    onXcodeCloud: () => {
      triggers++;
    },
    log: () => {},
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    await fn(base, () => triggers);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('healthz responds 200', async () => {
  await withServer('shh', async base => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });
});

test('unknown path 404, wrong method 405', async () => {
  await withServer('shh', async base => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/webhook/xcode-cloud`)).status, 405);
  });
});

test('rejects missing or wrong secret with 401', async () => {
  await withServer('shh', async (base, triggers) => {
    assert.equal((await fetch(`${base}/webhook/xcode-cloud`, { method: 'POST' })).status, 401);
    assert.equal(
      (await fetch(`${base}/webhook/xcode-cloud/wrong`, { method: 'POST' })).status,
      401
    );
    assert.equal(triggers(), 0);
  });
});

test('accepts valid secret via path or header and triggers once each', async () => {
  await withServer('shh', async (base, triggers) => {
    const viaPath = await fetch(`${base}/webhook/xcode-cloud/shh`, { method: 'POST', body: '{}' });
    assert.equal(viaPath.status, 202);

    const viaHeader = await fetch(`${base}/webhook/xcode-cloud`, {
      method: 'POST',
      headers: { 'x-webhook-secret': 'shh' },
      body: '{}',
    });
    assert.equal(viaHeader.status, 202);

    assert.equal(triggers(), 2);
  });
});

test('tolerates non-JSON body', async () => {
  await withServer('shh', async (base, triggers) => {
    const res = await fetch(`${base}/webhook/xcode-cloud/shh`, {
      method: 'POST',
      body: 'not json',
    });
    assert.equal(res.status, 202);
    assert.equal(triggers(), 1);
  });
});
