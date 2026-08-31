import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureStateDirectory, resolveStateDirectory } from './git-mirror.js';
import { acquireProcessLock } from './process-lock.js';

export function buildFailureMarker(workflowId, purpose = 'production') {
  return `<!-- merge4appstore:xcode-build-failure:${purpose}:${workflowId} -->`;
}

function eventOrder({ buildNumber, completedAt }) {
  const hasBuildNumber = buildNumber !== null
    && buildNumber !== undefined
    && String(buildNumber).trim() !== '';
  const number = Number(buildNumber);
  const build = hasBuildNumber && Number.isSafeInteger(number) && number >= 0 ? number : null;
  const timestamp = Date.parse(completedAt || '');
  const time = Number.isFinite(timestamp) ? timestamp : null;
  return build === null && time === null ? null : { build, time };
}

function ignoreReason(candidate, previous) {
  if (!previous) return null;
  if (!candidate) return 'unorderable-event';
  if (!previous.order) return null;
  if (candidate.build !== null && previous.order.build !== null) {
    if (candidate.build !== previous.order.build) {
      return candidate.build < previous.order.build ? 'older-build' : null;
    }
    if (candidate.time !== null && previous.order.time !== null && candidate.time < previous.order.time) {
      return 'older-build';
    }
    return null;
  }
  if (candidate.time !== null && previous.order.time !== null) {
    return candidate.time < previous.order.time ? 'older-build' : null;
  }
  return 'unorderable-event';
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

export class MemoryBuildStatusStore {
  constructor() {
    this.records = new Map();
    this.locks = new Map();
  }

  async read(key) {
    return this.records.get(key) || null;
  }

  async write(key, record) {
    this.records.set(key, structuredClone(record));
  }

  async withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.locks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

export class FileBuildStatusStore {
  constructor({ stateDirectory = process.env.MERGE4APPSTORE_STATE_DIR } = {}) {
    this.stateDirectory = resolveStateDirectory(stateDirectory);
    this.directory = path.join(this.stateDirectory, 'build-status');
    this.ready = null;
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureStateDirectory(this.stateDirectory);
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stats = await fs.lstat(this.directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error(`Unsafe build status directory: ${this.directory}`);
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
    const digest = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.directory, `${digest}.json`);
  }

  async read(key) {
    await this.ensureReady();
    let contents;
    try {
      contents = await fs.readFile(this.fileFor(key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const record = JSON.parse(contents);
    if (record.key !== key) throw new Error(`Build status key mismatch for ${key}`);
    return record;
  }

  async write(key, record) {
    await this.ensureReady();
    const file = this.fileFor(key);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ ...record, key })}\n`, 'utf8');
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

  async withLock(key, operation) {
    await this.ensureReady();
    const release = await acquireProcessLock(this.directory, `build-status:${key}`, {
      timeoutMs: 60_000,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

export async function reportXcodeBuildStatus(github, {
  status,
  workflowId,
  runId,
  purpose = 'production',
  buildNumber = null,
  commitSha = null,
  completedAt = null,
}, store = new FileBuildStatusStore()) {
  if (!workflowId || !runId || !status) throw new Error('Incomplete Xcode Cloud build status');
  const key = `${purpose}:${workflowId}`;
  const update = async () => {
    const previous = await store.read(key);
    const order = eventOrder({ buildNumber, completedAt });
    const ignored = ignoreReason(order, previous);
    if (ignored) return { ignored: true, reason: ignored };

    const marker = buildFailureMarker(workflowId, purpose);
    const label = buildNumber ? `#${buildNumber}` : runId;
    let result;
    if (status === 'SUCCEEDED') {
      result = await github.closeIssueByMarker(
        marker,
        `Xcode Cloud ${purpose} build ${label} succeeded; closing the previous failure alert.`,
      );
    } else {
      const commit = commitSha ? `\n- Commit: \`${commitSha}\`` : '';
      result = await github.upsertIssue(
        marker,
        `Xcode Cloud ${purpose} build failed (${label})`,
        `## ${purpose.replaceAll('_', ' ')} build failure\n\nThe ${purpose.replaceAll('_', ' ')} Xcode Cloud workflow completed with **${status}**.\n\n- Build: ${label}\n- Run ID: \`${runId}\`\n- Workflow ID: \`${workflowId}\`${commit}\n\n## Recovery\n\nInspect the Xcode Cloud build logs, fix the failure, and rerun the workflow. This issue closes automatically after a newer successful build.`,
      );
      if (!result) throw new Error('Could not publish the Xcode Cloud build failure issue');
    }

    await store.write(key, {
      order,
      status,
      runId,
      buildNumber,
      completedAt,
      updatedAt: Date.now(),
    });
    return result;
  };
  return typeof store.withLock === 'function' ? store.withLock(key, update) : update();
}
