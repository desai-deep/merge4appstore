import { acquireProcessLock } from '../../lib/process-lock.js';

const [directory, key] = process.argv.slice(2);
const release = await acquireProcessLock(directory, key, {
  timeoutMs: 5_000,
  retryMs: 20,
});

process.stdout.write('acquired\n');
process.stdin.resume();
process.stdin.once('end', async () => {
  await release();
});
