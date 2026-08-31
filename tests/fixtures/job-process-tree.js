import { spawn } from 'node:child_process';
import fs from 'node:fs';

const marker = process.argv[2];
const ready = process.argv[3];
const leaderExitsOnTerm = process.argv[4] === 'leader-exits-on-term';
const grandchild = `
  const fs = require('node:fs');
  process.on('SIGTERM', () => {});
  setTimeout(() => fs.writeFileSync(process.argv[1], 'survived\\n'), 300);
  setInterval(() => {}, 1000);
`;

spawn(process.execPath, ['-e', grandchild, marker], {
  stdio: 'ignore',
});

process.on('SIGTERM', () => {
  if (leaderExitsOnTerm) process.exit(143);
});
fs.writeFileSync(ready, 'ready\n');
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
