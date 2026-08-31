import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureStateDirectory, resolveStateDirectory } from './git-mirror.js';
import { acquireProcessLock } from './process-lock.js';

const SCHEMA_VERSION = 1;
const MARKETING_VERSION = /^\d+(?:\.\d+){1,2}$/;

function invalidVersion(value) {
  const error = new Error(`Invalid marketing version: ${value || '(missing)'}`);
  error.statusCode = 400;
  return error;
}

export function validateMarketingVersion(value) {
  if (typeof value !== 'string' || !MARKETING_VERSION.test(value)) {
    throw invalidVersion(value);
  }
  return value;
}

function versionParts(value) {
  return validateMarketingVersion(value).split('.').map(Number);
}

export function compareMarketingVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function nextMinorMarketingVersion(value) {
  const parts = versionParts(value);
  const next = [parts[0], (parts[1] || 0) + 1];
  if (parts.length === 3) next.push(0);
  return next.join('.');
}

function maximumVersion(...values) {
  return values.reduce((highest, value) => (
    !highest || compareMarketingVersions(value, highest) > 0 ? value : highest
  ), null);
}

function validateRecord(instance, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Version state for ${instance} is not an object`);
  }
  if (record.schemaVersion !== SCHEMA_VERSION || record.instance !== instance) {
    throw new Error(`Version state for ${instance} has an invalid identity or schema`);
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw new Error(`Version state for ${instance} has an invalid generation`);
  }
  validateMarketingVersion(record.productionVersion);
  validateMarketingVersion(record.developmentVersion);
  if (compareMarketingVersions(record.developmentVersion, record.productionVersion) < 0) {
    throw new Error(`Version state for ${instance} places development behind production`);
  }
  return record;
}

function initialRecord(instance, initialVersion, now) {
  validateMarketingVersion(initialVersion);
  return {
    schemaVersion: SCHEMA_VERSION,
    instance,
    generation: 1,
    productionVersion: initialVersion,
    developmentVersion: initialVersion,
    reason: 'profile_initial_version',
    sourceId: null,
    updatedAt: new Date(now).toISOString(),
  };
}

function transition(record, {
  productionVersion,
  developmentVersion,
  reason,
  sourceId = null,
  now,
}) {
  const production = maximumVersion(record.productionVersion, productionVersion);
  const development = maximumVersion(
    record.developmentVersion,
    developmentVersion,
    production,
  );
  if (
    production === record.productionVersion
    && development === record.developmentVersion
  ) return record;
  return {
    ...record,
    generation: record.generation + 1,
    productionVersion: production,
    developmentVersion: development,
    reason,
    sourceId: sourceId ? String(sourceId) : null,
    updatedAt: new Date(now).toISOString(),
  };
}

function initializeOrRaiseFloor(instance, record, initialVersion, now) {
  if (!record) return initialRecord(instance, initialVersion, now);
  validateRecord(instance, record);
  return transition(record, {
    productionVersion: initialVersion,
    developmentVersion: initialVersion,
    reason: 'profile_initial_version_raised',
    now,
  });
}

function submittedTransition(instance, record, initialVersion, version, sourceId, now) {
  const initialized = initializeOrRaiseFloor(instance, record, initialVersion, now);
  validateMarketingVersion(version);
  return transition(initialized, {
    productionVersion: version,
    developmentVersion: nextMinorMarketingVersion(version),
    reason: 'app_review_submitted',
    sourceId,
    now,
  });
}

function releasedTransition(instance, record, initialVersion, version, sourceId, now) {
  const initialized = initializeOrRaiseFloor(instance, record, initialVersion, now);
  const nextVersion = nextMinorMarketingVersion(version);
  return transition(initialized, {
    productionVersion: nextVersion,
    developmentVersion: nextVersion,
    reason: 'app_store_released',
    sourceId,
    now,
  });
}

export function versionForPurpose(record, purpose) {
  if (purpose === 'production') return record.productionVersion;
  if (purpose === 'pull_request' || purpose === 'beta') return record.developmentVersion;
  const error = new Error(`Unsupported build purpose: ${purpose || '(missing)'}`);
  error.statusCode = 400;
  throw error;
}

export class MemoryVersionStateStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.records = new Map();
    this.locks = new Map();
  }

  async withLock(instance, operation) {
    const previous = this.locks.get(instance) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.locks.set(instance, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(instance) === queued) this.locks.delete(instance);
    }
  }

  async update(instance, change) {
    return this.withLock(instance, async () => {
      const previous = this.records.get(instance) || null;
      const next = change(previous, this.now());
      if (next !== previous) this.records.set(instance, structuredClone(next));
      return structuredClone(next);
    });
  }

  async getOrInitialize(instance, initialVersion) {
    return this.update(instance, (record, now) => (
      initializeOrRaiseFloor(instance, record, initialVersion, now)
    ));
  }

  async recordSubmitted(instance, initialVersion, version, { sourceId = null } = {}) {
    return this.update(instance, (record, now) => (
      submittedTransition(instance, record, initialVersion, version, sourceId, now)
    ));
  }

  async recordReleased(instance, initialVersion, version, { sourceId = null } = {}) {
    return this.update(instance, (record, now) => (
      releasedTransition(instance, record, initialVersion, version, sourceId, now)
    ));
  }
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

export class FileVersionStateStore {
  constructor({
    stateDirectory = process.env.MERGE4APPSTORE_STATE_DIR,
    lockTimeoutMs = 5_000,
    now = () => Date.now(),
  } = {}) {
    this.stateDirectory = resolveStateDirectory(stateDirectory);
    this.directory = path.join(this.stateDirectory, 'version-state');
    this.lockTimeoutMs = lockTimeoutMs;
    this.now = now;
    this.ready = null;
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureStateDirectory(this.stateDirectory);
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stats = await fs.lstat(this.directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error(`Unsafe version state directory: ${this.directory}`);
        }
        await fs.chmod(this.directory, 0o700);
      })().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  fileFor(instance) {
    const digest = crypto.createHash('sha256').update(instance).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  async read(instance) {
    await this.ensureReady();
    let source;
    try {
      source = await fs.readFile(this.fileFor(instance), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return validateRecord(instance, JSON.parse(source));
    } catch (cause) {
      const error = new Error(`Version state for ${instance} is corrupt`, { cause });
      error.statusCode = 503;
      error.retryAfter = 5;
      throw error;
    }
  }

  async write(instance, record) {
    validateRecord(instance, record);
    const file = this.fileFor(instance);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
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

  async update(instance, change) {
    await this.ensureReady();
    let release;
    try {
      release = await acquireProcessLock(this.directory, `version-state:${instance}`, {
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
      const previous = await this.read(instance);
      const next = change(previous, this.now());
      if (next !== previous) await this.write(instance, next);
      return structuredClone(next);
    } finally {
      await release();
    }
  }

  async getOrInitialize(instance, initialVersion) {
    return this.update(instance, (record, now) => (
      initializeOrRaiseFloor(instance, record, initialVersion, now)
    ));
  }

  async recordSubmitted(instance, initialVersion, version, { sourceId = null } = {}) {
    return this.update(instance, (record, now) => (
      submittedTransition(instance, record, initialVersion, version, sourceId, now)
    ));
  }

  async recordReleased(instance, initialVersion, version, { sourceId = null } = {}) {
    return this.update(instance, (record, now) => (
      releasedTransition(instance, record, initialVersion, version, sourceId, now)
    ));
  }
}

export function createVersionStateStore(options) {
  return new FileVersionStateStore(options);
}
