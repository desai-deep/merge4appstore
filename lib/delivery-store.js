import crypto from 'node:crypto';

import { summarizeDeliveryJob } from './delivery-recovery.js';
import { FileDeliveryStore } from './file-delivery-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * DAY_MS;

function receiptHash(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export class MemoryDeliveryStore {
  constructor({ retentionMs = DEFAULT_RETENTION_MS, now = () => Date.now() } = {}) {
    this.retentionMs = retentionMs;
    this.now = now;
    this.receipts = new Map();
  }

  async initialize() {}

  async claim(key, intent = null) {
    const now = this.now();
    const existing = this.receipts.get(key);
    if (existing && (
      existing.state === 'pending'
      || existing.state === 'failed'
      || (existing.state === 'complete' && now - existing.updatedAt < this.retentionMs)
    )) {
      return null;
    }
    const claim = { key, token: crypto.randomUUID() };
    this.receipts.set(key, {
      token: claim.token,
      state: 'pending',
      ownerPid: process.pid,
      attempts: 1,
      cursor: existing?.state === 'complete' ? 0 : Number(existing?.cursor || 0),
      intent,
      updatedAt: now,
    });
    return {
      ...claim,
      intent,
      attempts: 1,
      cursor: existing?.state === 'complete' ? 0 : Number(existing?.cursor || 0),
    };
  }

  async complete(claim) {
    const existing = this.receipts.get(claim.key);
    if (existing?.token !== claim.token) return false;
    this.receipts.set(claim.key, {
      ...existing,
      state: 'complete',
      ownerPid: null,
      updatedAt: this.now(),
    });
    return true;
  }

  async release(claim) {
    if (this.receipts.get(claim.key)?.token !== claim.token) return false;
    this.receipts.delete(claim.key);
    return true;
  }

  async retry(claim, error, { delayMs = 5_000 } = {}) {
    const existing = this.receipts.get(claim.key);
    if (existing?.token !== claim.token) return false;
    this.receipts.set(claim.key, {
      ...existing,
      ownerPid: null,
      nextAttemptAt: this.now() + delayMs,
      lastError: String(error?.message || error).slice(0, 2_000),
      updatedAt: this.now(),
    });
    return true;
  }

  async claimPending() {
    const claims = [];
    const now = this.now();
    for (const [key, receipt] of this.receipts) {
      if (
        receipt.state !== 'pending'
        || receipt.ownerPid
        || Number(receipt.nextAttemptAt || 0) > now
      ) continue;
      const token = crypto.randomUUID();
      const updated = {
        ...receipt,
        token,
        ownerPid: process.pid,
        attempts: Number(receipt.attempts || 0) + 1,
        updatedAt: now,
      };
      this.receipts.set(key, updated);
      claims.push({
        key,
        token,
        intent: updated.intent,
        attempts: updated.attempts,
        cursor: Number(updated.cursor || 0),
      });
    }
    return claims;
  }

  async advance(claim, cursor) {
    const existing = this.receipts.get(claim.key);
    if (existing?.token !== claim.token || existing.state !== 'pending') return false;
    existing.cursor = cursor;
    existing.updatedAt = this.now();
    claim.cursor = cursor;
    return true;
  }

  async fail(claim, error) {
    const existing = this.receipts.get(claim.key);
    if (existing?.token !== claim.token || existing.state !== 'pending') return false;
    this.receipts.set(claim.key, {
      ...existing,
      state: 'failed',
      ownerPid: null,
      lastError: String(error?.message || error).slice(0, 2_000),
      updatedAt: this.now(),
    });
    return true;
  }

  async queueStatus({ includeAge = false } = {}) {
    const status = { pending: 0, failed: 0, corrupt: 0 };
    let oldestPendingUpdatedAt = null;
    for (const receipt of this.receipts.values()) {
      if (receipt.state === 'pending') {
        status.pending += 1;
        oldestPendingUpdatedAt = oldestPendingUpdatedAt === null
          ? receipt.updatedAt
          : Math.min(oldestPendingUpdatedAt, receipt.updatedAt);
      }
      if (receipt.state === 'failed') status.failed += 1;
    }
    if (includeAge) {
      status.oldest_pending_age_ms = oldestPendingUpdatedAt === null
        ? null
        : Math.max(0, this.now() - oldestPendingUpdatedAt);
    }
    return status;
  }

  async inspectFailedReceipts() {
    const failed = [];
    for (const [key, receipt] of this.receipts) {
      if (receipt.state !== 'failed') continue;
      const updatedAt = new Date(receipt.updatedAt);
      failed.push({
        hash: receiptHash(key),
        instance: typeof receipt.intent?.instance === 'string'
          ? receipt.intent.instance
          : null,
        cursor: receipt.cursor,
        next_job: summarizeDeliveryJob(receipt.intent?.jobs?.[receipt.cursor]),
        attempts: receipt.attempts,
        last_error: typeof receipt.lastError === 'string' ? receipt.lastError : null,
        updated_at: Number.isNaN(updatedAt.getTime())
          ? receipt.updatedAt
          : updatedAt.toISOString(),
      });
    }
    failed.sort((left, right) => left.hash.localeCompare(right.hash));
    return { failed, corrupt: [] };
  }

  async requeueFailed({ receiptHashes = null, expectedCount = null } = {}) {
    if (receiptHashes !== null && !Array.isArray(receiptHashes)) {
      throw new TypeError('receiptHashes must be an array or null');
    }
    const requested = receiptHashes === null
      ? null
      : receiptHashes.map(hash => String(hash).toLowerCase());
    if (requested?.some(hash => !/^[0-9a-f]{64}$/.test(hash))) {
      throw new Error('Every failed receipt selector must be a 64-character hexadecimal hash');
    }
    if (requested && new Set(requested).size !== requested.length) {
      throw new Error('Failed receipt selectors must be unique');
    }
    if (
      expectedCount !== null
      && (!Number.isSafeInteger(expectedCount) || expectedCount < 0)
    ) {
      throw new Error('Expected failed receipt count must be a non-negative integer');
    }

    await this.inspectFailedReceipts();
    // Inspection is asynchronous even though this in-memory implementation is
    // not. Rebuild the eligible set after that await so a concurrent task that
    // completed or released a receipt cannot be replayed from a stale result.
    const failedByHash = new Map();
    for (const [key, receipt] of this.receipts) {
      if (receipt.state === 'failed') {
        failedByHash.set(receiptHash(key), { key, receipt });
      }
    }
    if (expectedCount !== null && failedByHash.size !== expectedCount) {
      const error = new Error(
        `Failed receipt count changed: expected ${expectedCount}, found ${failedByHash.size}`,
      );
      error.code = 'ECOUNTMISMATCH';
      throw error;
    }
    const selected = requested === null
      ? [...failedByHash.keys()].sort()
      : [...requested].sort();
    const unavailable = selected.filter(hash => !failedByHash.has(hash));
    if (unavailable.length > 0) {
      const error = new Error(
        `Receipt is no longer a readable failed delivery: ${unavailable.join(', ')}`,
      );
      error.code = 'ENOTFAILED';
      throw error;
    }

    let requeued = 0;
    for (const hash of selected) {
      const { key, receipt } = failedByHash.get(hash);
      const now = this.now();
      const history = Array.isArray(receipt.recoveryHistory)
        ? receipt.recoveryHistory.slice(-9)
        : [];
      this.receipts.set(key, {
        ...receipt,
        state: 'pending',
        token: crypto.randomUUID(),
        ownerPid: null,
        attempts: 0,
        nextAttemptAt: now,
        lastError: 'Manually requeued',
        recoveryHistory: [...history, {
          failedAt: receipt.updatedAt,
          attempts: receipt.attempts,
          lastError: typeof receipt.lastError === 'string' ? receipt.lastError : null,
          requeuedAt: now,
        }],
        updatedAt: now,
      });
      requeued += 1;
    }
    return requeued;
  }
}

export { FileDeliveryStore };

export function createDeliveryStore(environment = process.env) {
  return new FileDeliveryStore({ stateDirectory: environment.MERGE4APPSTORE_STATE_DIR });
}
