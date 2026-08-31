import crypto from 'node:crypto';

import { FileDeliveryStore } from './file-delivery-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * DAY_MS;

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
      token: claim.token,
      state: 'complete',
      cursor: existing.cursor,
      intent: existing.intent,
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

  async requeueFailed() {
    let requeued = 0;
    for (const [key, receipt] of this.receipts) {
      if (receipt.state !== 'failed') continue;
      this.receipts.set(key, {
        ...receipt,
        state: 'pending',
        token: crypto.randomUUID(),
        ownerPid: null,
        attempts: 0,
        nextAttemptAt: this.now(),
        lastError: 'Manually requeued',
        updatedAt: this.now(),
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
