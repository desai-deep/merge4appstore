export class AsyncTtlCache {
  constructor({
    ttlMs = 60_000,
    maxEntries = 100,
    staleIfError = false,
    retryTtlMs = 5_000,
    now = () => Date.now(),
  } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.staleIfError = staleIfError;
    this.retryTtlMs = retryTtlMs;
    this.now = now;
    this.entries = new Map();
  }

  get(key, load) {
    const existing = this.entries.get(key);
    const now = this.now();
    if (existing?.promise) return existing.promise;
    if (existing && existing.expiresAt > now) return Promise.resolve(existing.value);

    const staleValue = existing && !existing.promise ? existing.value : undefined;
    const hasStaleValue = existing && !existing.promise;
    // An expired entry for this key no longer consumes admission capacity, but
    // retain its value locally so stale-if-error can still use it.
    this.entries.delete(key);
    this.prune();
    while (this.entries.size >= this.maxEntries) {
      const oldestResolved = [...this.entries]
        .find(([, entry]) => !entry.promise)?.[0];
      if (oldestResolved === undefined) {
        const error = new Error('Cache is at capacity with in-flight loads');
        error.code = 'ECACHECAPACITY';
        error.statusCode = 503;
        error.retryAfter = 1;
        return Promise.reject(error);
      }
      this.entries.delete(oldestResolved);
    }
    const promise = Promise.resolve()
      .then(load)
      .then(value => {
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        this.prune();
        return value;
      })
      .catch(error => {
        this.entries.delete(key);
        if (this.staleIfError && hasStaleValue) {
          this.entries.set(key, { value: staleValue, expiresAt: this.now() + this.retryTtlMs });
          return staleValue;
        }
        throw error;
      });
    this.entries.set(key, { promise, expiresAt: Number.POSITIVE_INFINITY });
    return promise;
  }

  prune() {
    for (const [key, entry] of this.entries) {
      if (!entry.promise && entry.expiresAt <= this.now()) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries].find(([, entry]) => !entry.promise)?.[0];
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
