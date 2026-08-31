import { ensureStateDirectory } from '../../lib/git-mirror.js';

const [stateDirectory, startAtValue = '0'] = process.argv.slice(2);
const startAt = Number(startAtValue);
if (startAt > Date.now()) {
  await new Promise(resolve => setTimeout(resolve, startAt - Date.now()));
}

await ensureStateDirectory(stateDirectory);
process.stdout.write('ready\n');
