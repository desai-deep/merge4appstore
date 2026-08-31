import cluster from 'node:cluster';
import { tryAcquireProcessLock } from '../../lib/process-lock.js';

const [directory, key] = process.argv.slice(2);

if (cluster.isPrimary) {
  const workers = [cluster.fork(), cluster.fork()];
  const results = [];
  let finished = false;
  const fail = message => {
    if (finished) return;
    finished = true;
    process.stderr.write(`${message}\n`);
    for (const worker of workers) worker.kill('SIGKILL');
    process.exitCode = 1;
  };
  const timer = setTimeout(() => fail('Timed out waiting for clustered lock attempts'), 5_000);
  for (const worker of workers) {
    worker.on('message', message => {
      results.push({ worker, status: message.status });
      if (results.length !== 2) return;
      const statuses = results.map(result => result.status).sort();
      if (statuses.join(',') !== 'acquired,busy') return fail(`Unexpected clustered lock results: ${statuses}`);
      finished = true;
      clearTimeout(timer);
      for (const result of results) result.worker.send({ release: true });
    });
    worker.on('exit', code => {
      if (!finished && code !== 0) fail(`Cluster lock worker exited ${code}`);
    });
  }
  let exits = 0;
  cluster.on('exit', () => {
    exits += 1;
    if (finished && exits === workers.length) process.exit(0);
  });
} else {
  const release = await tryAcquireProcessLock(directory, key);
  process.send({ status: release ? 'acquired' : 'busy' });
  process.once('message', async () => {
    await release?.();
    process.exit(0);
  });
}
