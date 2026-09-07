#!/usr/bin/env node

import { createDeliveryStore } from '../lib/delivery-store.js';

const HASH = /^[0-9a-f]{64}$/;

function usage() {
  return `Usage:
  npm run retry:deliveries
  npm run retry:deliveries -- --receipt <sha256> [--receipt <sha256> ...]
  npm run retry:deliveries -- --all --confirm-count <count>
  npm run retry:deliveries -- --quarantine-corrupt

Without a mutation flag, the command only lists failed and corrupt receipts.
`;
}

function optionValue(args, index, name) {
  const argument = args[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, consumed: 0 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return { value, consumed: 1 };
}

function parseArguments(args) {
  const options = {
    help: false,
    all: false,
    quarantineCorrupt: false,
    receiptHashes: [],
    expectedCount: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--all') {
      if (options.all) throw new Error('--all may only be specified once');
      options.all = true;
    } else if (argument === '--quarantine-corrupt') {
      if (options.quarantineCorrupt) {
        throw new Error('--quarantine-corrupt may only be specified once');
      }
      options.quarantineCorrupt = true;
    } else if (argument === '--receipt' || argument.startsWith('--receipt=')) {
      const { value, consumed } = optionValue(args, index, '--receipt');
      index += consumed;
      const hash = value.toLowerCase();
      if (!HASH.test(hash)) {
        throw new Error('--receipt must be a 64-character hexadecimal hash');
      }
      options.receiptHashes.push(hash);
    } else if (argument === '--confirm-count' || argument.startsWith('--confirm-count=')) {
      if (options.expectedCount !== null) {
        throw new Error('--confirm-count may only be specified once');
      }
      const { value, consumed } = optionValue(args, index, '--confirm-count');
      index += consumed;
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--confirm-count must be a non-negative integer');
      }
      options.expectedCount = Number(value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.help && args.length > 1) {
    throw new Error('--help cannot be combined with other options');
  }
  if (new Set(options.receiptHashes).size !== options.receiptHashes.length) {
    throw new Error('--receipt values must be unique');
  }
  if (options.all && options.receiptHashes.length > 0) {
    throw new Error('--all cannot be combined with --receipt');
  }
  if (options.quarantineCorrupt && (
    options.all
    || options.receiptHashes.length > 0
    || options.expectedCount !== null
  )) {
    throw new Error('--quarantine-corrupt must be run separately from requeue options');
  }
  if (options.all && options.expectedCount === null) {
    throw new Error('--all requires --confirm-count with the inspected failed count');
  }
  if (!options.all && options.expectedCount !== null) {
    throw new Error('--confirm-count is only valid with --all');
  }

  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const store = createDeliveryStore();
  await store.initialize();
  const before = await store.queueStatus();

  if (options.quarantineCorrupt) {
    const quarantined = await store.quarantineCorrupt();
    const after = await store.queueStatus();
    console.log(JSON.stringify({ action: 'quarantine-corrupt', quarantined, before, after }));
    if (after.corrupt > 0) {
      console.error('Corrupt receipts remain after quarantine. Inspect the state directory before retrying.');
      process.exitCode = 2;
    }
    return;
  }

  const inspection = await store.inspectFailedReceipts();
  const selectingReceipts = options.receiptHashes.length > 0;
  if (!options.all && !selectingReceipts) {
    console.log(JSON.stringify({ action: 'inspect', queue: before, ...inspection }));
    if (inspection.corrupt.length > 0) {
      console.error('Corrupt receipts block recovery. Preserve and inspect them, then quarantine explicitly.');
      process.exitCode = 2;
    }
    return;
  }

  const selected = options.all
    ? inspection.failed.map(receipt => receipt.hash)
    : options.receiptHashes;
  const requeued = await store.requeueFailed({
    receiptHashes: selected,
    expectedCount: options.expectedCount,
  });
  const after = await store.queueStatus();
  console.log(JSON.stringify({ action: 'requeue', selected, requeued, before, after }));
}

main().catch(error => {
  console.error(`Recovery refused: ${error.message}`);
  process.exitCode = 1;
});
