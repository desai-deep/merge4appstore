#!/usr/bin/env node

import { createDeliveryStore } from '../lib/delivery-store.js';
import {
  MAX_RETIREMENT_ACTOR_LENGTH,
  MAX_RETIREMENT_REASON_CODE_LENGTH,
  MAX_RETIREMENT_REFERENCE_LENGTH,
  normalizeRetirementActor,
  normalizeRetirementReasonCode,
  normalizeRetirementReference,
} from '../lib/delivery-retirement.js';

const HASH = /^[0-9a-f]{64}$/;

function usage() {
  return `Usage:
  npm run retry:deliveries
  npm run retry:deliveries -- --receipt <sha256> [--receipt <sha256> ...]
  npm run retry:deliveries -- --all --confirm-count <count>
  npm run retry:deliveries -- --retire <sha256> --revision <sha256> \\
    --reason-code <code> --reference <text>
  npm run retry:deliveries -- --quarantine-corrupt

Without a mutation flag, the command only lists failed and corrupt receipts.
Retirement reason codes and references are limited to
${MAX_RETIREMENT_REASON_CODE_LENGTH} and ${MAX_RETIREMENT_REFERENCE_LENGTH} characters respectively.
The derived operator identity is limited to ${MAX_RETIREMENT_ACTOR_LENGTH} characters.
`;
}

function retirementActor(environment = process.env) {
  if (environment.SUDO_USER !== undefined && environment.SUDO_USER !== '') {
    return normalizeRetirementActor(environment.SUDO_USER);
  }
  if (environment.USER !== undefined && environment.USER !== '') {
    return normalizeRetirementActor(environment.USER);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unavailable';
  return normalizeRetirementActor(`uid:${uid}`);
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
    retireHash: null,
    revision: null,
    reasonCode: null,
    reference: null,
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
    } else if (argument === '--retire' || argument.startsWith('--retire=')) {
      if (options.retireHash !== null) throw new Error('--retire may only be specified once');
      const { value, consumed } = optionValue(args, index, '--retire');
      index += consumed;
      const hash = value.toLowerCase();
      if (!HASH.test(hash)) {
        throw new Error('--retire must be a 64-character hexadecimal hash');
      }
      options.retireHash = hash;
    } else if (argument === '--revision' || argument.startsWith('--revision=')) {
      if (options.revision !== null) throw new Error('--revision may only be specified once');
      const { value, consumed } = optionValue(args, index, '--revision');
      index += consumed;
      options.revision = value.toLowerCase();
      if (!HASH.test(options.revision)) {
        throw new Error('--revision must be a 64-character hexadecimal hash');
      }
    } else if (argument === '--reason-code' || argument.startsWith('--reason-code=')) {
      if (options.reasonCode !== null) throw new Error('--reason-code may only be specified once');
      const { value, consumed } = optionValue(args, index, '--reason-code');
      index += consumed;
      options.reasonCode = normalizeRetirementReasonCode(value);
    } else if (argument === '--reference' || argument.startsWith('--reference=')) {
      if (options.reference !== null) throw new Error('--reference may only be specified once');
      const { value, consumed } = optionValue(args, index, '--reference');
      index += consumed;
      options.reference = normalizeRetirementReference(value);
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
  const hasRetirementMetadata = options.revision !== null
    || options.reasonCode !== null
    || options.reference !== null;
  if (options.retireHash !== null && (
    options.all
    || options.receiptHashes.length > 0
    || options.quarantineCorrupt
    || options.expectedCount !== null
  )) {
    throw new Error('--retire must be run separately from requeue and quarantine options');
  }
  if (options.retireHash !== null && options.revision === null) {
    throw new Error('--retire requires --revision from the immediately preceding inspection');
  }
  if (options.retireHash !== null && options.reasonCode === null) {
    throw new Error('--retire requires --reason-code');
  }
  if (options.retireHash !== null && options.reference === null) {
    throw new Error('--retire requires --reference');
  }
  if (options.retireHash === null && hasRetirementMetadata) {
    throw new Error('--revision, --reason-code, and --reference are only valid with --retire');
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
  const retiringReceipts = options.retireHash !== null;
  if (!options.all && !selectingReceipts && !retiringReceipts) {
    console.log(JSON.stringify({ action: 'inspect', queue: before, ...inspection }));
    if (inspection.corrupt.length > 0) {
      console.error('Corrupt receipts block recovery. Preserve and inspect them, then quarantine explicitly.');
      process.exitCode = 2;
    }
    return;
  }

  if (retiringReceipts) {
    const retired = await store.retireFailed({
      receiptHash: options.retireHash,
      revision: options.revision,
      reasonCode: options.reasonCode,
      reference: options.reference,
      actor: retirementActor(),
    });
    const after = await store.queueStatus();
    console.log(JSON.stringify({
      action: 'retire', selected: options.retireHash, retired, before, after,
    }));
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
