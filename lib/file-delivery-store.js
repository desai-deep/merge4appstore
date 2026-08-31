import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ensureStateDirectory, resolveStateDirectory } from './git-mirror.js';
import { acquireProcessLock } from './process-lock.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * DAY_MS;
const RECEIPT_NAME = /^([0-9a-f]{64})\.json$/;
const execFileAsync = promisify(execFile);

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function receiptHash(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function readReceipt(file) {
  let contents;
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch (cause) {
    const error = new Error(`Corrupt webhook delivery receipt: ${file}`, { cause });
    error.code = 'ECORRUPTRECEIPT';
    error.statusCode = 503;
    error.retryAfter = 30;
    throw error;
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

async function processStartIdentity(pid) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '(Get-Process -Id $args[0]).StartTime.ToUniversalTime().Ticks',
        String(pid),
      ], { encoding: 'utf8', timeout: 2_000, windowsHide: true });
      return stdout.trim() ? `windows:${stdout.trim()}` : null;
    }
    if (process.platform !== 'linux') {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 2_000,
      });
      return stdout.trim() ? `${process.platform}:${stdout.trim()}` : null;
    }
    const [stat, bootId] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startedAtTick = fields[19];
    return startedAtTick ? `linux:${bootId.trim()}:${startedAtTick}` : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 1].includes(error.code)) return null;
    return null;
  }
}

export class FileDeliveryStore {
  constructor({
    stateDirectory = process.env.MERGE4APPSTORE_STATE_DIR,
    retentionMs = DEFAULT_RETENTION_MS,
    lockTimeoutMs = 15_000,
    pruneBatchSize = 100,
    now = () => Date.now(),
    isProcessAlive = processIsAlive,
    processIdentity = processStartIdentity,
    ownerLeaseMs = 2 * 60 * 60 * 1000,
  } = {}) {
    this.stateDirectory = resolveStateDirectory(stateDirectory);
    this.receiptsDirectory = path.join(this.stateDirectory, 'deliveries');
    this.pendingDirectory = path.join(this.receiptsDirectory, 'pending');
    this.failedDirectory = path.join(this.receiptsDirectory, 'failed');
    this.completeDirectory = path.join(this.receiptsDirectory, 'complete');
    this.expiryDirectory = path.join(this.receiptsDirectory, 'expiry');
    this.corruptDirectory = path.join(this.receiptsDirectory, 'corrupt');
    this.retentionMs = retentionMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.pruneBatchSize = Math.max(1, Number(pruneBatchSize) || 100);
    this.expiryBucketSizeMs = Math.min(DAY_MS, Math.max(1, retentionMs));
    this.now = now;
    this.isProcessAlive = isProcessAlive;
    this.processIdentity = processIdentity;
    this.ownerLeaseMs = ownerLeaseMs;
    this.readReceipt = readReceipt;
    this.ready = null;
    this.lastPruneAt = Number.NEGATIVE_INFINITY;
    this.ownerIdentity = null;
  }

  async ensurePrivateDirectory(directory) {
    let created = false;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe webhook delivery directory: ${directory}`);
    }
    await fs.chmod(directory, 0o700);
    if (created) await syncDirectory(path.dirname(directory));
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureStateDirectory(this.stateDirectory);
        this.ownerIdentity = await this.processIdentity(process.pid);
        for (const directory of [
          this.receiptsDirectory,
          this.pendingDirectory,
          this.failedDirectory,
          this.completeDirectory,
          this.expiryDirectory,
          this.corruptDirectory,
        ]) {
          await this.ensurePrivateDirectory(directory);
        }
      })().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async ownerIsActive(owner) {
    const ownerPid = Number(owner?.ownerPid ?? owner?.pid);
    if (!this.isProcessAlive(ownerPid)) return false;
    const expectedIdentity = owner?.ownerIdentity;
    if (expectedIdentity) {
      const actualIdentity = await this.processIdentity(ownerPid);
      if (actualIdentity !== null) return actualIdentity === expectedIdentity;
    }
    // A portable start time can be unavailable in a restricted environment.
    // Never let a recycled live PID strand a receipt forever; after a generous
    // lease, another worker can reclaim it and the per-repository job lock still
    // serializes any unusually long operation that remains alive.
    return this.now() - Number(owner?.updatedAt || 0) < this.ownerLeaseMs;
  }

  async initialize() {
    await this.ensureReady();
    await this.maybePrune();
  }

  stateDirectoryFor(state) {
    if (state === 'pending') return this.pendingDirectory;
    if (state === 'failed') return this.failedDirectory;
    if (state === 'complete') return this.completeDirectory;
    throw new Error(`Invalid webhook delivery state ${state}`);
  }

  receiptFileForHash(hash, state) {
    return path.join(this.stateDirectoryFor(state), `${hash}.json`);
  }

  receiptFile(key, state = 'complete') {
    return this.receiptFileForHash(receiptHash(key), state);
  }

  claimHash(claim) {
    const hash = claim?.receiptHash
      || path.basename(claim?.receiptFile || '', '.json')
      || path.basename(claim?.receiptDirectory || '');
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Webhook delivery claim is missing its receipt hash');
    }
    return hash;
  }

  async writeReceipt(receiptFile, receipt, { exclusive = false } = {}) {
    const temporary = path.join(
      path.dirname(receiptFile),
      `.${path.basename(receiptFile)}-${crypto.randomUUID()}.tmp`,
    );
    let handle;
    try {
      if (exclusive && await this.readReceipt(receiptFile)) {
        const error = new Error(`Webhook delivery receipt already exists: ${receiptFile}`);
        error.code = 'EEXIST';
        throw error;
      }
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(receipt)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, receiptFile);
      await fs.chmod(receiptFile, 0o600);
      await syncDirectory(path.dirname(receiptFile));
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async withProcessLock(key, operation) {
    let release;
    try {
      release = await acquireProcessLock(
        this.receiptsDirectory,
        key,
        { timeoutMs: this.lockTimeoutMs },
      );
      return await operation();
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

  async withReceiptLock(hash, operation) {
    return this.withProcessLock(`delivery:${hash}`, operation);
  }

  async withExpiryBucketLock(bucket, operation) {
    return this.withProcessLock(`delivery-expiry:${bucket}`, operation);
  }

  corruptReceiptError(file, message, cause = undefined) {
    const error = new Error(
      `Corrupt webhook delivery receipt: ${file} (${message})`,
      cause ? { cause } : {},
    );
    error.code = 'ECORRUPTRECEIPT';
    error.statusCode = 503;
    error.retryAfter = 30;
    return error;
  }

  validateReceipt(receipt, file, hash) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw this.corruptReceiptError(file, 'receipt must be an object');
    }
    if (!['pending', 'failed', 'complete'].includes(receipt.state)) {
      throw this.corruptReceiptError(file, `invalid state ${receipt.state}`);
    }
    if (receipt.receiptHash && receipt.receiptHash !== hash) {
      throw this.corruptReceiptError(file, 'receipt hash does not match its filename');
    }
    if (typeof receipt.token !== 'string' || !receipt.token) {
      throw this.corruptReceiptError(file, 'missing ownership token');
    }
    if (
      !receipt.intent
      || typeof receipt.intent !== 'object'
      || Array.isArray(receipt.intent)
      || typeof receipt.intent.instance !== 'string'
      || !receipt.intent.instance
      || !Array.isArray(receipt.intent.jobs)
      || receipt.intent.jobs.some(job => (
        !job
        || typeof job !== 'object'
        || Array.isArray(job)
        || typeof job.mode !== 'string'
        || !job.mode
      ))
    ) {
      throw this.corruptReceiptError(file, 'invalid delivery intent');
    }
    if (
      !Number.isSafeInteger(receipt.cursor)
      || receipt.cursor < 0
      || receipt.cursor > receipt.intent.jobs.length
    ) {
      throw this.corruptReceiptError(file, 'invalid job cursor');
    }
    const minimumAttempts = receipt.state === 'pending' && receipt.ownerPid == null ? 0 : 1;
    if (!Number.isSafeInteger(receipt.attempts) || receipt.attempts < minimumAttempts) {
      throw this.corruptReceiptError(file, 'invalid attempt count');
    }
    if (!Number.isFinite(receipt.updatedAt) || receipt.updatedAt < 0) {
      throw this.corruptReceiptError(file, 'invalid update timestamp');
    }
    for (const timestampName of ['nextAttemptAt', 'expiresAt']) {
      if (
        receipt[timestampName] !== undefined
        && (!Number.isFinite(receipt[timestampName]) || receipt[timestampName] < 0)
      ) {
        throw this.corruptReceiptError(file, `invalid ${timestampName} timestamp`);
      }
    }
    if (
      receipt.ownerPid !== null
      && receipt.ownerPid !== undefined
      && (!Number.isSafeInteger(receipt.ownerPid) || receipt.ownerPid <= 0)
    ) {
      throw this.corruptReceiptError(file, 'invalid owner process');
    }
    if (
      receipt.ownerIdentity !== null
      && receipt.ownerIdentity !== undefined
      && (typeof receipt.ownerIdentity !== 'string' || !receipt.ownerIdentity)
    ) {
      throw this.corruptReceiptError(file, 'invalid owner identity');
    }
    return receipt;
  }

  receiptExpiresAt(receipt) {
    const explicit = Number(receipt?.expiresAt);
    if (Number.isFinite(explicit)) return explicit;
    return Number(receipt?.updatedAt || 0) + this.retentionMs;
  }

  expiryBucket(expiresAt) {
    return String(Math.floor(expiresAt / this.expiryBucketSizeMs) * this.expiryBucketSizeMs);
  }

  expiryMarkerFile(hash, expiresAt) {
    return path.join(this.expiryDirectory, this.expiryBucket(expiresAt), `${hash}.json`);
  }

  async ensureExpiryMarkerLocked(hash, receipt) {
    const expiresAt = this.receiptExpiresAt(receipt);
    const markerFile = this.expiryMarkerFile(hash, expiresAt);
    const bucket = path.basename(path.dirname(markerFile));
    await this.withExpiryBucketLock(bucket, async () => {
      await this.ensurePrivateDirectory(path.dirname(markerFile));
      let marker;
      try {
        marker = await this.readReceipt(markerFile);
      } catch (error) {
        if (error.code !== 'ECORRUPTRECEIPT') throw error;
      }
      if (marker?.token === receipt.token && Number(marker.expiresAt) === expiresAt) return;
      await this.writeReceipt(markerFile, {
        version: 1,
        receiptHash: hash,
        token: receipt.token,
        expiresAt,
      });
    });
  }

  async removeMarkerFile(markerFile) {
    const bucket = path.basename(path.dirname(markerFile));
    await this.withExpiryBucketLock(bucket, async () => {
      try {
        await fs.unlink(markerFile);
        await syncDirectory(path.dirname(markerFile));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    });
  }

  async removeExpiryMarkerLocked(hash, receipt) {
    if (!receipt) return;
    const markerFile = this.expiryMarkerFile(hash, this.receiptExpiresAt(receipt));
    await this.removeMarkerFile(markerFile);
  }

  async moveReceiptLocked(hash, sourceState, targetState, receipt) {
    const sourceFile = this.receiptFileForHash(hash, sourceState);
    const targetFile = this.receiptFileForHash(hash, targetState);
    if (sourceFile === targetFile) return targetFile;
    try {
      await fs.rename(sourceFile, targetFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const target = await this.readReceipt(targetFile);
      if (target?.token === receipt.token && target.state === targetState) return targetFile;
      if (target) {
        throw this.corruptReceiptError(targetFile, 'state move would overwrite another receipt');
      }
      await this.writeReceipt(targetFile, receipt, { exclusive: true });
    }
    await syncDirectory(path.dirname(sourceFile));
    await syncDirectory(path.dirname(targetFile));
    return targetFile;
  }

  async deleteReceiptLocked(hash, state, receipt) {
    const receiptFile = this.receiptFileForHash(hash, state);
    try {
      await fs.unlink(receiptFile);
      await syncDirectory(path.dirname(receiptFile));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (state === 'complete') await this.removeExpiryMarkerLocked(hash, receipt);
  }

  async resolveMultipleReceiptsLocked(hash, located) {
    const active = located.filter(item => item.location !== 'complete');
    const complete = located.find(item => item.location === 'complete');
    if (
      located.length === 2
      && active.length === 1
      && complete
      && complete.receipt.state === 'complete'
      && (
        this.receiptExpiresAt(complete.receipt) <= this.now()
        || Number(active[0].receipt.updatedAt || 0) >= this.receiptExpiresAt(complete.receipt)
      )
    ) {
      await this.deleteReceiptLocked(hash, 'complete', complete.receipt);
      return active[0];
    }
    const files = located.map(item => item.file).join(', ');
    throw this.corruptReceiptError(files, 'multiple state files exist for one delivery');
  }

  async locateReceiptLocked(hash) {
    const located = [];
    for (const location of ['pending', 'failed', 'complete']) {
      const file = this.receiptFileForHash(hash, location);
      const receipt = await this.readReceipt(file);
      if (receipt) {
        located.push({ location, file, receipt: this.validateReceipt(receipt, file, hash) });
      }
    }
    if (located.length > 1) {
      const resolved = await this.resolveMultipleReceiptsLocked(hash, located);
      located.splice(0, located.length, resolved);
    }
    if (located.length === 0) return null;

    const current = located[0];
    if (current.receipt.state !== current.location) {
      if (current.receipt.state === 'complete') {
        await this.ensureExpiryMarkerLocked(hash, current.receipt);
      }
      current.file = await this.moveReceiptLocked(
        hash,
        current.location,
        current.receipt.state,
        current.receipt,
      );
      current.location = current.receipt.state;
    }
    if (current.location === 'complete') {
      await this.ensureExpiryMarkerLocked(hash, current.receipt);
    }
    return current;
  }

  async persistStateLocked(hash, located, receipt, targetState) {
    const updated = { ...receipt, version: 2, receiptHash: hash, state: targetState };
    const sourceState = located?.location || 'pending';
    const sourceFile = this.receiptFileForHash(hash, sourceState);
    await this.writeReceipt(sourceFile, updated, { exclusive: !located });
    if (targetState === 'complete') await this.ensureExpiryMarkerLocked(hash, updated);
    const receiptFile = await this.moveReceiptLocked(hash, sourceState, targetState, updated);
    return { location: targetState, file: receiptFile, receipt: updated };
  }

  claimFor(hash, located) {
    return {
      receiptHash: hash,
      receiptDirectory: path.dirname(located.file),
      receiptFile: located.file,
      token: located.receipt.token,
      intent: located.receipt.intent,
      attempts: Number(located.receipt.attempts || 0),
      cursor: Number(located.receipt.cursor || 0),
    };
  }

  receiptFromClaim(claim) {
    const hash = this.claimHash(claim);
    if (typeof claim.token !== 'string' || !claim.token) {
      throw new Error('Webhook delivery claim is missing its ownership token');
    }
    return {
      version: 2,
      receiptHash: hash,
      state: 'pending',
      token: claim.token,
      ownerPid: process.pid,
      ownerIdentity: this.ownerIdentity,
      attempts: Math.max(1, Number(claim.attempts || 1)),
      cursor: Math.max(0, Number(claim.cursor || 0)),
      intent: claim.intent,
      updatedAt: this.now(),
    };
  }

  async replaceExpiredCompleteLocked(hash, complete, pending) {
    // Publish the active record first. If this process crashes before deleting
    // the expired completion, recovery sees pending work and removes the stale copy.
    const pendingFile = this.receiptFileForHash(hash, 'pending');
    await this.writeReceipt(pendingFile, pending, { exclusive: true });
    await this.deleteReceiptLocked(hash, 'complete', complete.receipt);
    return { location: 'pending', file: pendingFile, receipt: pending };
  }

  async takeOwnershipLocked(hash, {
    intent = undefined,
    respectRetryDelay = true,
  } = {}) {
    const current = await this.locateReceiptLocked(hash);
    const now = this.now();
    if (!current && intent === undefined) return null;
    if (
      current?.location === 'complete'
      && this.receiptExpiresAt(current.receipt) > now
    ) return null;
    // Dead letters require an explicit operator requeue. An ordinary provider
    // redelivery must not reset their bounded attempt count and silently make
    // them automatic again.
    if (current?.location === 'failed') return null;
    if (current?.location === 'pending' && await this.ownerIsActive(current.receipt)) return null;
    if (
      respectRetryDelay
      && current?.location === 'pending'
      && Number(current.receipt.nextAttemptAt || 0) > now
    ) return null;

    const token = crypto.randomUUID();
    const attempts = current?.location === 'pending'
      ? Number(current.receipt.attempts || 0) + 1
      : 1;
    const updated = {
      version: 2,
      receiptHash: hash,
      state: 'pending',
      token,
      ownerPid: process.pid,
      ownerIdentity: this.ownerIdentity,
      attempts,
      // An expired completion begins a new delivery lifecycle. Reusing its
      // terminal cursor would acknowledge the redelivery without executing
      // any jobs before extending retention again.
      cursor: current?.location === 'complete' ? 0 : Number(current?.receipt.cursor || 0),
      intent: intent === undefined ? current?.receipt.intent : intent,
      updatedAt: now,
    };
    const located = current?.location === 'complete'
      ? await this.replaceExpiredCompleteLocked(hash, current, updated)
      : await this.persistStateLocked(hash, current, updated, 'pending');
    return this.claimFor(hash, located);
  }

  async takeOwnership(hash, options = {}) {
    return this.withReceiptLock(hash, () => this.takeOwnershipLocked(hash, options));
  }

  async surfaceCorruptCompletedReceiptLocked(hash) {
    const completeFile = this.receiptFileForHash(hash, 'complete');
    try {
      const receipt = await this.readReceipt(completeFile);
      if (!receipt) return true;
      this.validateReceipt(receipt, completeFile, hash);
      return false;
    } catch (error) {
      if (error.code !== 'ECORRUPTRECEIPT') throw error;
    }

    // Retention has elapsed, but preserve the unreadable completion as a
    // visible dead letter until an operator explicitly quarantines it. Do not
    // overwrite an existing failed record; that record already makes this key
    // visible and quarantineCorrupt() will inspect every state file together.
    const failedFile = this.receiptFileForHash(hash, 'failed');
    try {
      await fs.lstat(failedFile);
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(completeFile, failedFile);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
    await syncDirectory(this.completeDirectory);
    await syncDirectory(this.failedDirectory);
    return true;
  }

  async pruneExpiryMarker(hash, markerFile, now) {
    await this.withReceiptLock(hash, async () => {
      let current;
      try {
        current = await this.locateReceiptLocked(hash);
      } catch (error) {
        if (error.code === 'ECORRUPTRECEIPT') {
          if (await this.surfaceCorruptCompletedReceiptLocked(hash)) {
            await this.removeMarkerFile(markerFile);
          }
          return;
        }
        throw error;
      }
      if (current?.location === 'complete' && this.receiptExpiresAt(current.receipt) <= now) {
        await this.deleteReceiptLocked(hash, 'complete', current.receipt);
        return;
      }
      await this.removeMarkerFile(markerFile);
    });
  }

  async maybePrune() {
    const now = this.now();
    if (now >= this.lastPruneAt && now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;
    const buckets = await fs.readdir(this.expiryDirectory, { withFileTypes: true });
    let remaining = this.pruneBatchSize;
    for (const bucket of buckets) {
      if (remaining <= 0) break;
      if (!bucket.isDirectory() || !/^\d+$/.test(bucket.name)) continue;
      const bucketStart = Number(bucket.name);
      if (bucketStart + this.expiryBucketSizeMs > now) continue;
      const bucketDirectory = path.join(this.expiryDirectory, bucket.name);
      let directory;
      try {
        directory = await fs.opendir(bucketDirectory);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      let exhausted = false;
      try {
        while (remaining > 0) {
          const entry = await directory.read();
          if (!entry) {
            exhausted = true;
            break;
          }
          remaining -= 1;
          const match = entry.isFile() && entry.name.match(RECEIPT_NAME);
          if (!match) continue;
          await this.pruneExpiryMarker(match[1], path.join(bucketDirectory, entry.name), now);
        }
      } finally {
        await directory.close();
      }
      if (exhausted) {
        await this.withExpiryBucketLock(bucket.name, async () => {
          try {
            if ((await fs.readdir(bucketDirectory)).length > 0) return;
            await fs.rmdir(bucketDirectory);
            await syncDirectory(this.expiryDirectory);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
          }
        });
      }
    }
  }

  async claim(key, intent = null) {
    await this.ensureReady();
    await this.maybePrune();
    return this.takeOwnership(receiptHash(key), { intent, respectRetryDelay: false });
  }

  async receiptForMutationLocked(hash, claim) {
    const current = await this.locateReceiptLocked(hash);
    if (!current) return { current: null, receipt: this.receiptFromClaim(claim) };
    if (current.receipt.token !== claim.token || current.location !== 'pending') {
      return { current, receipt: null };
    }
    return { current, receipt: current.receipt };
  }

  updateClaimLocation(claim, located) {
    claim.receiptHash = located.receipt.receiptHash;
    claim.receiptDirectory = path.dirname(located.file);
    claim.receiptFile = located.file;
  }

  async advance(claim, cursor) {
    const hash = this.claimHash(claim);
    return this.withReceiptLock(hash, async () => {
      const { current, receipt } = await this.receiptForMutationLocked(hash, claim);
      if (!receipt) return false;
      const located = await this.persistStateLocked(hash, current, {
        ...receipt,
        cursor,
        updatedAt: this.now(),
      }, 'pending');
      claim.cursor = cursor;
      this.updateClaimLocation(claim, located);
      return true;
    });
  }

  async retry(claim, error, { delayMs = 5_000 } = {}) {
    const hash = this.claimHash(claim);
    return this.withReceiptLock(hash, async () => {
      const { current, receipt } = await this.receiptForMutationLocked(hash, claim);
      if (!receipt) return false;
      const located = await this.persistStateLocked(hash, current, {
        ...receipt,
        ownerPid: null,
        ownerIdentity: null,
        nextAttemptAt: this.now() + delayMs,
        lastError: String(error?.message || error).slice(0, 2_000),
        updatedAt: this.now(),
      }, 'pending');
      this.updateClaimLocation(claim, located);
      return true;
    });
  }

  async fail(claim, error) {
    const hash = this.claimHash(claim);
    return this.withReceiptLock(hash, async () => {
      const current = await this.locateReceiptLocked(hash);
      if (current?.receipt.token === claim.token && current.location === 'failed') return true;
      const receipt = !current ? this.receiptFromClaim(claim) : (
        current.receipt.token === claim.token && current.location === 'pending'
          ? current.receipt
          : null
      );
      if (!receipt) return false;
      const located = await this.persistStateLocked(hash, current, {
        ...receipt,
        ownerPid: null,
        ownerIdentity: null,
        lastError: String(error?.message || error).slice(0, 2_000),
        updatedAt: this.now(),
      }, 'failed');
      this.updateClaimLocation(claim, located);
      return true;
    });
  }

  async complete(claim) {
    const hash = this.claimHash(claim);
    return this.withReceiptLock(hash, async () => {
      const current = await this.locateReceiptLocked(hash);
      if (current?.receipt.token === claim.token && current.location === 'complete') return true;
      const receipt = !current ? this.receiptFromClaim(claim) : (
        current.receipt.token === claim.token && current.location === 'pending'
          ? current.receipt
          : null
      );
      if (!receipt) return false;
      const updatedAt = this.now();
      const located = await this.persistStateLocked(hash, current, {
        ...receipt,
        ownerPid: null,
        ownerIdentity: null,
        updatedAt,
        expiresAt: updatedAt + this.retentionMs,
      }, 'complete');
      this.updateClaimLocation(claim, located);
      return true;
    });
  }

  async release(claim) {
    const hash = this.claimHash(claim);
    return this.withReceiptLock(hash, async () => {
      const current = await this.locateReceiptLocked(hash);
      if (current?.receipt.token !== claim.token) return false;
      await this.deleteReceiptLocked(hash, current.location, current.receipt);
      return true;
    });
  }

  async hashesIn(directories) {
    const hashes = new Set();
    for (const directory of directories) {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const match = entry.isFile() && entry.name.match(RECEIPT_NAME);
        if (match) hashes.add(match[1]);
      }
    }
    return hashes;
  }

  async activeHashes() {
    return this.hashesIn([this.pendingDirectory, this.failedDirectory]);
  }

  async pendingHashes() {
    return this.hashesIn([this.pendingDirectory]);
  }

  async failedHashes() {
    return this.hashesIn([this.failedDirectory]);
  }

  async claimPending() {
    await this.ensureReady();
    await this.maybePrune();
    const claims = [];
    const hashes = await this.pendingHashes();
    for (const hash of hashes) {
      let claim;
      try {
        claim = await this.takeOwnership(hash);
      } catch (error) {
        if (error.code === 'ECORRUPTRECEIPT') continue;
        throw error;
      }
      if (claim) claims.push(claim);
    }
    return claims;
  }

  async queueStatus({ includeAge = false } = {}) {
    await this.ensureReady();
    await this.maybePrune();
    const status = { pending: 0, failed: 0, corrupt: 0 };
    let oldestPendingUpdatedAt = null;
    const hashes = await this.activeHashes();
    for (const hash of hashes) {
      const active = [];
      let corrupt = false;
      for (const location of ['pending', 'failed']) {
        const file = this.receiptFileForHash(hash, location);
        try {
          const receipt = await this.readReceipt(file);
          if (receipt) active.push(this.validateReceipt(receipt, file, hash));
        } catch (error) {
          if (error.code !== 'ECORRUPTRECEIPT') throw error;
          corrupt = true;
          break;
        }
      }
      if (corrupt || active.length > 1) {
        status.failed += 1;
        status.corrupt += 1;
      } else if (active[0]?.state === 'pending') {
        status.pending += 1;
        oldestPendingUpdatedAt = oldestPendingUpdatedAt === null
          ? active[0].updatedAt
          : Math.min(oldestPendingUpdatedAt, active[0].updatedAt);
      }
      else if (active[0]?.state === 'failed') status.failed += 1;
    }
    if (includeAge) {
      status.oldest_pending_age_ms = oldestPendingUpdatedAt === null
        ? null
        : Math.max(0, this.now() - oldestPendingUpdatedAt);
    }
    return status;
  }

  async requeueFailed() {
    await this.ensureReady();
    let requeued = 0;
    // Include pending filenames whose durable record already says "failed";
    // locateReceiptLocked repairs that crash window before requeueing it.
    const hashes = await this.activeHashes();
    for (const hash of hashes) {
      try {
        const didRequeue = await this.withReceiptLock(hash, async () => {
          const current = await this.locateReceiptLocked(hash);
          if (current?.location !== 'failed') return false;
          const now = this.now();
          const updated = {
            ...current.receipt,
            token: crypto.randomUUID(),
            ownerPid: null,
            ownerIdentity: null,
            attempts: 0,
            nextAttemptAt: now,
            lastError: 'Manually requeued',
            updatedAt: now,
          };
          // Move the still-failed record into the directory scanned by
          // automatic recovery before changing its durable state. A crash
          // before this rename leaves an ordinary dead letter. A crash after
          // it leaves a failed record in pending/, which claimPending repairs
          // back to failed instead of stranding a pending record in failed/.
          const pendingFile = await this.moveReceiptLocked(
            hash,
            current.location,
            'pending',
            current.receipt,
          );
          await this.persistStateLocked(hash, {
            location: 'pending',
            file: pendingFile,
            receipt: current.receipt,
          }, updated, 'pending');
          return true;
        });
        if (didRequeue) requeued += 1;
      } catch (error) {
        if (error.code === 'ECORRUPTRECEIPT') continue;
        throw error;
      }
    }
    return requeued;
  }

  async quarantineCorrupt() {
    await this.ensureReady();
    const quarantined = [];
    const hashes = new Set();
    for (const location of ['pending', 'failed', 'complete']) {
      const directory = this.stateDirectoryFor(location);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const match = entry.isFile() && entry.name.match(RECEIPT_NAME);
        if (match) hashes.add(match[1]);
      }
    }

    for (const hash of hashes) {
      await this.withReceiptLock(hash, async () => {
        const valid = [];
        const invalid = [];
        for (const location of ['pending', 'failed', 'complete']) {
          const receiptFile = this.receiptFileForHash(hash, location);
          try {
            const receipt = await this.readReceipt(receiptFile);
            if (receipt) {
              valid.push({
                location,
                file: receiptFile,
                receipt: this.validateReceipt(receipt, receiptFile, hash),
              });
            }
          } catch (error) {
            if (error.code !== 'ECORRUPTRECEIPT') throw error;
            invalid.push({ location, file: receiptFile });
          }
        }

        const toQuarantine = [...invalid];
        if (valid.length > 1) {
          try {
            await this.resolveMultipleReceiptsLocked(hash, valid);
          } catch (error) {
            if (error.code !== 'ECORRUPTRECEIPT') throw error;
            toQuarantine.push(...valid.map(({ location, file }) => ({ location, file })));
          }
        }
        if (toQuarantine.length === 0) return;

        const syncedDirectories = new Set();
        for (const { location, file: receiptFile } of toQuarantine) {
          const target = path.join(
            this.corruptDirectory,
            `${location}-${hash}-${Date.now()}-${crypto.randomUUID()}.json`,
          );
          try {
            await fs.rename(receiptFile, target);
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          syncedDirectories.add(path.dirname(receiptFile));
          quarantined.push(target);
        }
        for (const directory of syncedDirectories) {
          await syncDirectory(directory);
        }
        if (syncedDirectories.size > 0) await syncDirectory(this.corruptDirectory);
      });
    }
    return quarantined;
  }
}
