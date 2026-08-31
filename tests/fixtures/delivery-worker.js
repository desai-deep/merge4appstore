import { FileDeliveryStore } from '../../lib/delivery-store.js';

const [mode, stateDirectory, key, startAtValue = '0', holdMsValue = '0'] = process.argv.slice(2);
const startAt = Number(startAtValue);
const holdMs = Number(holdMsValue);
if (startAt > Date.now()) await new Promise(resolve => setTimeout(resolve, startAt - Date.now()));

const store = new FileDeliveryStore({ stateDirectory });
let claim;
if (mode === 'claim') {
  claim = await store.claim(key, {
    instance: 'example-ios',
    jobs: [{ mode: 'first' }, { mode: 'second' }],
  });
} else if (mode === 'recover') {
  [claim] = await store.claimPending();
} else {
  throw new Error(`Unknown delivery worker mode: ${mode}`);
}

process.stdout.write(`${JSON.stringify({
  claimed: Boolean(claim),
  attempts: claim?.attempts || null,
  cursor: claim?.cursor || 0,
})}\n`);
if (claim && holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
