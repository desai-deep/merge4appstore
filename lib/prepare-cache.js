import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureStateDirectory, resolveStateDirectory } from './git-mirror.js';
import { acquireProcessLock } from './process-lock.js';

const HOUR_MS = 60 * 60 * 1000;

function digest(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export class MemoryPrepareCache {
  constructor({ ttlMs = 60_000, maxEntries = 100, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.values = new Map();
    this.flights = new Map();
  }

  async get(key, load) {
    const existing = this.values.get(key);
    if (existing && existing.expiresAt > this.now()) return structuredClone(existing.value);
    this.values.delete(key);
    if (!this.flights.has(key)) {
      for (const [candidate, record] of this.values) {
        if (record.expiresAt <= this.now()) this.values.delete(candidate);
      }
      while (this.values.size + this.flights.size >= this.maxEntries) {
        const oldestResolved = this.values.keys().next().value;
        if (oldestResolved === undefined) {
          const error = new Error('Preparation cache is at capacity with in-flight loads');
          error.code = 'ECACHECAPACITY';
          error.statusCode = 503;
          error.retryAfter = 1;
          throw error;
        }
        this.values.delete(oldestResolved);
      }
      const flight = Promise.resolve().then(load).then(
        value => {
          this.flights.delete(key);
          this.values.set(key, {
            expiresAt: this.now() + this.ttlMs,
            value: structuredClone(value),
          });
          return value;
        },
        error => {
          this.flights.delete(key);
          throw error;
        },
      );
      this.flights.set(key, flight);
    }
    return this.flights.get(key);
  }
}

export class FilePrepareCache {
  constructor({
    stateDirectory = process.env.MERGE4APPSTORE_STATE_DIR,
    ttlMs = 60_000,
    retentionMs = 24 * HOUR_MS,
    maxEntries = 1_000,
    lockTimeoutMs = 60_000,
    now = () => Date.now(),
  } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.stateDirectory = resolveStateDirectory(stateDirectory);
    this.directory = path.join(this.stateDirectory, 'prepare-cache');
    this.ttlMs = ttlMs;
    this.retentionMs = retentionMs;
    this.maxEntries = maxEntries;
    this.lockTimeoutMs = lockTimeoutMs;
    this.now = now;
    this.ready = null;
    this.nextPruneAt = 0;
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureStateDirectory(this.stateDirectory);
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stats = await fs.lstat(this.directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error(`Unsafe preparation cache directory: ${this.directory}`);
        }
        await fs.chmod(this.directory, 0o700);
      })().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  fileFor(key) {
    return path.join(this.directory, `${digest(key)}.json`);
  }

  async read(key) {
    let source;
    try {
      source = await fs.readFile(this.fileFor(key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const record = JSON.parse(source);
      if (record.key !== key || !Number.isFinite(record.expiresAt)) throw new Error('invalid record');
      return record;
    } catch {
      // Preparation results are an optimization, never the source of truth.
      // Discard a torn/corrupt cache record and recompute it under the lock.
      await fs.rm(this.fileFor(key), { force: true });
      return null;
    }
  }

  async write(key, value) {
    const file = this.fileFor(key);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({
        key,
        expiresAt: this.now() + this.ttlMs,
        value,
      })}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
      await syncDirectory(this.directory);
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true });
    }
  }

  async maybePrune({ force = false } = {}) {
    if (!force && this.now() < this.nextPruneAt) return;
    this.nextPruneAt = this.now() + HOUR_MS;
    let release;
    try {
      release = await acquireProcessLock(this.directory, 'prepare-cache:prune', {
        timeoutMs: this.lockTimeoutMs,
      });
    } catch (error) {
      if (error.code === 'ELOCKTIMEOUT') {
        error.statusCode = 503;
        error.retryAfter = 5;
      }
      throw error;
    }
    try {
      const entries = await fs.readdir(this.directory, { withFileTypes: true });
      const records = (await Promise.all(entries
        .filter(entry => entry.isFile() && (
          entry.name.endsWith('.json') || entry.name.endsWith('.tmp')
        ))
        .map(async entry => {
          const file = path.join(this.directory, entry.name);
          try {
            return {
              file,
              isTemporary: entry.name.endsWith('.tmp'),
              modifiedAt: (await fs.stat(file)).mtimeMs,
            };
          } catch (error) {
            // Another worker may have pruned the same entry after our readdir.
            if (error.code === 'ENOENT') return null;
            throw error;
          }
        })))
        .filter(Boolean);
      const temporaryCutoff = this.now() - Math.max(HOUR_MS, this.lockTimeoutMs * 2);
      await Promise.all(records
        .filter(entry => entry.isTemporary && entry.modifiedAt < temporaryCutoff)
        .map(entry => fs.rm(entry.file, { force: true })));

      const files = records
        .filter(entry => !entry.isTemporary)
        .sort((left, right) => right.modifiedAt - left.modifiedAt);
      const cutoff = this.now() - this.retentionMs;
      await Promise.all(files
        .filter((entry, index) => index >= this.maxEntries || entry.modifiedAt < cutoff)
        .map(entry => fs.rm(entry.file, { force: true })));
    } finally {
      await release();
    }
  }

  async get(key, load, { signal = null } = {}) {
    await this.ensureReady();
    await this.maybePrune();
    const existing = await this.read(key);
    if (existing && existing.expiresAt > this.now()) return existing.value;

    let release;
    try {
      release = await acquireProcessLock(this.directory, `prepare:${digest(key)}`, {
        timeoutMs: this.lockTimeoutMs,
        signal,
      });
    } catch (error) {
      if (error.code === 'ELOCKTIMEOUT') {
        error.statusCode = 503;
        error.retryAfter = 5;
      }
      throw error;
    }
    try {
      const afterWait = await this.read(key);
      if (afterWait && afterWait.expiresAt > this.now()) return afterWait.value;
      const value = await load();
      await this.write(key, value);
      // Every successful admission enforces the bound under a cross-process
      // lock; the hourly pass remains only an optimization for retention.
      await this.maybePrune({ force: true });
      return value;
    } finally {
      await release();
    }
  }
}

export function createPrepareCache(options) {
  return new FilePrepareCache(options);
}
