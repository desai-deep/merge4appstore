import crypto from 'node:crypto';

export const MAX_RETIREMENT_REASON_CODE_LENGTH = 64;
export const MAX_RETIREMENT_REFERENCE_LENGTH = 500;
export const MAX_RETIREMENT_ACTOR_LENGTH = 128;

const HASH = /^[0-9a-f]{64}$/;
const REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function normalizeBoundedText(value, name, maximumLength, { singleLine = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > maximumLength) {
    throw new Error(`${name} must not exceed ${maximumLength} characters`);
  }
  if (singleLine && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    throw new Error(`${name} must not contain control characters or newlines`);
  }
  return normalized;
}

export function normalizeRetirementReasonCode(reasonCode) {
  const normalized = normalizeBoundedText(
    reasonCode,
    'Retirement reason code',
    MAX_RETIREMENT_REASON_CODE_LENGTH,
  );
  if (!REASON_CODE.test(normalized)) {
    throw new Error(
      'Retirement reason code may contain only letters, digits, dot, underscore, colon, and hyphen',
    );
  }
  return normalized;
}

export function normalizeRetirementReference(reference) {
  return normalizeBoundedText(
    reference,
    'Retirement reference',
    MAX_RETIREMENT_REFERENCE_LENGTH,
    { singleLine: true },
  );
}

export function normalizeRetirementActor(actor) {
  return normalizeBoundedText(
    actor,
    'Retirement actor',
    MAX_RETIREMENT_ACTOR_LENGTH,
    { singleLine: true },
  );
}

export function deliveryReceiptRevision(hash, receipt) {
  return crypto.createHash('sha256').update(JSON.stringify({
    hash,
    token: receipt.token,
    state: receipt.state,
    updatedAt: receipt.updatedAt,
    cursor: receipt.cursor,
    attempts: receipt.attempts,
    lastError: receipt.lastError ?? null,
    intent: receipt.intent,
    recoveryHistory: receipt.recoveryHistory ?? null,
  })).digest('hex');
}

export function retirementAuditIsValid(retirement) {
  if (!retirement || typeof retirement !== 'object' || Array.isArray(retirement)) return false;
  try {
    if (
      normalizeRetirementReasonCode(retirement.reasonCode) !== retirement.reasonCode
      || normalizeRetirementReference(retirement.reference) !== retirement.reference
      || normalizeRetirementActor(retirement.actor) !== retirement.actor
    ) return false;
  } catch {
    return false;
  }
  return HASH.test(retirement.reviewedRevision)
    && Number.isFinite(retirement.retiredAt)
    && retirement.retiredAt >= 0
    && Number.isFinite(retirement.failedAt)
    && retirement.failedAt >= 0
    && Number.isSafeInteger(retirement.attempts)
    && retirement.attempts >= 1
    && Number.isSafeInteger(retirement.cursor)
    && retirement.cursor >= 0
    && (retirement.lastError === null || typeof retirement.lastError === 'string');
}
