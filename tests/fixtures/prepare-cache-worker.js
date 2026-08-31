import fs from 'node:fs/promises';
import { FilePrepareCache } from '../../lib/prepare-cache.js';

const [stateDirectory, counter] = process.argv.slice(2);
const cache = new FilePrepareCache({ stateDirectory });
const value = await cache.get('shared-key', async () => {
  let count = 0;
  try { count = Number(await fs.readFile(counter, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(counter, String(count + 1));
  await new Promise(resolve => setTimeout(resolve, 150));
  return { marketing_version: '1.5' };
});
process.stdout.write(JSON.stringify(value));
