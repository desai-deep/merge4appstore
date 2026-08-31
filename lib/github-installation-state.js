import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureStateDirectory, resolveStateDirectory } from './git-mirror.js';
import { acquireProcessLock } from './process-lock.js';

const STATE_VERSION = 1;

function installationKey(value) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw new Error('GitHub installation id must be a positive integer');
  }
  return String(value);
}

function eventTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('GitHub installation event time is invalid');
  }
  return parsed;
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

function validateState(state, file, expectedInstallationId) {
  if (
    !state
    || typeof state !== 'object'
    || Array.isArray(state)
    || state.version !== STATE_VERSION
    || state.installation_id !== expectedInstallationId
    || !['active', 'suspended'].includes(state.status)
    || !Number.isFinite(state.updated_at)
    || state.updated_at < 0
    || (
      state.event_at !== null
      && (!Number.isFinite(state.event_at) || state.event_at < 0)
    )
    || (typeof state.delivery_id !== 'string' && state.delivery_id !== null)
  ) {
    const error = new Error(`Corrupt GitHub installation state: ${file}`);
    error.code = 'ECORRUPTINSTALLATIONSTATE';
    throw error;
  }
  return state;
}

export class MemoryGitHubInstallationState {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.states = new Map();
  }

  async initialize() {}

  async state(installationId) {
    const key = installationKey(installationId);
    return this.states.get(key) || {
      version: STATE_VERSION,
      installation_id: key,
      status: 'active',
      updated_at: 0,
      event_at: null,
      delivery_id: null,
    };
  }

  async isSuspended(installationId) {
    return (await this.state(installationId)).status === 'suspended';
  }

  async setSuspended(installationId, suspended, {
    eventAt = null,
    deliveryId = null,
  } = {}) {
    const key = installationKey(installationId);
    const normalizedEventAt = eventTime(eventAt);
    const existing = await this.state(key);
    if (
      existing.event_at !== null
      && normalizedEventAt !== null
      && normalizedEventAt < existing.event_at
    ) return existing;
    const updated = {
      version: STATE_VERSION,
      installation_id: key,
      status: suspended ? 'suspended' : 'active',
      updated_at: this.now(),
      event_at: normalizedEventAt,
      delivery_id: deliveryId === null ? null : String(deliveryId),
    };
    this.states.set(key, updated);
    return updated;
  }
}

export class FileGitHubInstallationState {
  constructor({
    stateDirectory = process.env.MERGE4APPSTORE_STATE_DIR,
    lockTimeoutMs = 15_000,
    now = () => Date.now(),
  } = {}) {
    this.stateDirectory = resolveStateDirectory(stateDirectory);
    this.directory = path.join(this.stateDirectory, 'github-installations');
    this.lockTimeoutMs = lockTimeoutMs;
    this.now = now;
    this.ready = null;
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureStateDirectory(this.stateDirectory);
        try {
          await fs.mkdir(this.directory, { mode: 0o700 });
          await syncDirectory(this.stateDirectory);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const stats = await fs.lstat(this.directory);
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (
          stats.isSymbolicLink()
          || !stats.isDirectory()
          || (uid !== null && stats.uid !== uid)
        ) {
          throw new Error(`Unsafe GitHub installation state directory: ${this.directory}`);
        }
        await fs.chmod(this.directory, 0o700);
      })().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async initialize() {
    await this.ensureReady();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.process-locks' && entry.isDirectory()) continue;
      const match = entry.isFile() && entry.name.match(/^([1-9]\d*)\.json$/);
      if (!match) {
        throw new Error(`Unsafe GitHub installation state entry: ${path.join(this.directory, entry.name)}`);
      }
      await this.readState(match[1]);
    }
  }

  stateFile(installationId) {
    return path.join(this.directory, `${installationKey(installationId)}.json`);
  }

  async readState(installationId) {
    await this.ensureReady();
    const key = installationKey(installationId);
    const file = this.stateFile(key);
    let stats;
    try {
      stats = await fs.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || (stats.mode & 0o077) !== 0
      || (uid !== null && stats.uid !== uid)
    ) {
      throw new Error(`Unsafe GitHub installation state file: ${file}`);
    }
    let state;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (cause) {
      if (cause.code) throw cause;
      const error = new Error(`Corrupt GitHub installation state: ${file}`, { cause });
      error.code = 'ECORRUPTINSTALLATIONSTATE';
      throw error;
    }
    return validateState(state, file, key);
  }

  async state(installationId) {
    const key = installationKey(installationId);
    return await this.readState(key) || {
      version: STATE_VERSION,
      installation_id: key,
      status: 'active',
      updated_at: 0,
      event_at: null,
      delivery_id: null,
    };
  }

  async isSuspended(installationId) {
    return (await this.state(installationId)).status === 'suspended';
  }

  async writeState(file, state) {
    const temporary = path.join(
      this.directory,
      `.${path.basename(file)}-${crypto.randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
      await fs.chmod(file, 0o600);
      await syncDirectory(this.directory);
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async setSuspended(installationId, suspended, {
    eventAt = null,
    deliveryId = null,
  } = {}) {
    await this.ensureReady();
    const key = installationKey(installationId);
    const normalizedEventAt = eventTime(eventAt);
    let release;
    try {
      release = await acquireProcessLock(
        this.directory,
        `github-installation:${key}`,
        { timeoutMs: this.lockTimeoutMs },
      );
      const existing = await this.state(key);
      if (
        existing.event_at !== null
        && normalizedEventAt !== null
        && normalizedEventAt < existing.event_at
      ) return existing;
      const updated = {
        version: STATE_VERSION,
        installation_id: key,
        status: suspended ? 'suspended' : 'active',
        updated_at: this.now(),
        event_at: normalizedEventAt,
        delivery_id: deliveryId === null ? null : String(deliveryId),
      };
      await this.writeState(this.stateFile(key), updated);
      return updated;
    } catch (error) {
      if (error.code === 'ELOCKTIMEOUT') {
        error.statusCode = 503;
        error.retryAfter = 5;
      }
      throw error;
    } finally {
      await release?.();
    }
  }
}

export function createGitHubInstallationState(options = {}) {
  return new FileGitHubInstallationState(options);
}
