#!/usr/bin/env node

import { createDeliveryStore } from '../lib/delivery-store.js';

const store = createDeliveryStore();
await store.initialize();
const before = await store.queueStatus();
const quarantined = process.argv.includes('--quarantine-corrupt')
  ? await store.quarantineCorrupt()
  : [];
const requeued = await store.requeueFailed();
const after = await store.queueStatus();
console.log(JSON.stringify({ requeued, quarantined, before, after }));
if (after.corrupt > 0) {
  console.error('Corrupt receipts remain. Inspect them, then rerun with --quarantine-corrupt and redeliver the original webhook.');
  process.exitCode = 2;
}
