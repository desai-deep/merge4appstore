import crypto from 'crypto';

// Constant-time comparison of two strings. Returns false on any length/encoding
// mismatch instead of throwing, so callers can treat it as a plain predicate.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Verify a GitHub `X-Hub-Signature-256` header against the raw request body.
// Kept available for a future GitHub trigger even though Xcode Cloud is the
// active source.
export function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(signatureHeader, expected);
}

// Xcode Cloud webhooks don't sign their payloads, so we authenticate the caller
// with a shared secret token. To accommodate that, the token can be supplied as
// a trailing path segment (the only field Xcode Cloud lets you control in the
// URL), an `X-Webhook-Secret` header, or a `?token=`/`?secret=` query param.
export function extractWebhookSecret(req, url, pathPrefix) {
  const headerSecret = req.headers['x-webhook-secret'];
  if (typeof headerSecret === 'string' && headerSecret.length > 0) {
    return headerSecret;
  }

  const queryToken = url.searchParams.get('token') || url.searchParams.get('secret');
  if (queryToken) return queryToken;

  if (pathPrefix && url.pathname.startsWith(pathPrefix + '/')) {
    const trailing = url.pathname.slice(pathPrefix.length + 1);
    if (trailing) return decodeURIComponent(trailing);
  }

  return null;
}

export function verifySharedSecret(provided, expected) {
  if (!expected) return false;
  return safeEqual(provided || '', expected);
}
