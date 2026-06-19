import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  safeEqual,
  verifyGithubSignature,
  extractWebhookSecret,
  verifySharedSecret,
} from '../lib/webhook-verify.js';

test('safeEqual matches identical strings and rejects others', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', undefined), false);
});

test('verifyGithubSignature validates an HMAC-SHA256 signature', () => {
  const secret = 'topsecret';
  const body = Buffer.from('{"hello":"world"}');
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyGithubSignature(body, sig, secret), true);
  assert.equal(verifyGithubSignature(body, sig, 'wrong'), false);
  assert.equal(verifyGithubSignature(body, 'sha256=deadbeef', secret), false);
  assert.equal(verifyGithubSignature(body, undefined, secret), false);
});

test('verifySharedSecret is constant-time string equality', () => {
  assert.equal(verifySharedSecret('s3cret', 's3cret'), true);
  assert.equal(verifySharedSecret('nope', 's3cret'), false);
  assert.equal(verifySharedSecret('s3cret', ''), false);
  assert.equal(verifySharedSecret(null, 's3cret'), false);
});

test('extractWebhookSecret reads header, query, then trailing path', () => {
  const prefix = '/webhook/xcode-cloud';

  // Header wins
  assert.equal(
    extractWebhookSecret(
      { headers: { 'x-webhook-secret': 'fromheader' } },
      new URL('http://x/webhook/xcode-cloud/frompath?token=fromquery'),
      prefix
    ),
    'fromheader'
  );

  // Query next
  assert.equal(
    extractWebhookSecret(
      { headers: {} },
      new URL('http://x/webhook/xcode-cloud/frompath?token=fromquery'),
      prefix
    ),
    'fromquery'
  );

  // Trailing path segment last (and URL-decoded)
  assert.equal(
    extractWebhookSecret(
      { headers: {} },
      new URL('http://x/webhook/xcode-cloud/from%2Fpath'),
      prefix
    ),
    'from/path'
  );

  // Nothing provided
  assert.equal(
    extractWebhookSecret({ headers: {} }, new URL('http://x/webhook/xcode-cloud'), prefix),
    null
  );
});
