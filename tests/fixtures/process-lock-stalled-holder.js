import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [pidFile, mode = 'stall-before-ready'] = process.argv.slice(2);

if (mode === 'kill-wrapper-after-ready') {
  fs.writeFileSync(pidFile, `${process.pid}\n${process.ppid}\n`, { mode: 0o600 });
  process.stdout.write('acquired\n');
  setTimeout(() => process.kill(process.ppid, 'SIGKILL'), 50);
  process.stdin.resume();
  setInterval(() => {}, 1_000);
} else {
  const descendant = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1_000);',
  ], {
    stdio: mode === 'exit-before-ready' ? 'inherit' : 'ignore',
  });

  if (mode === 'exit-before-ready') {
    fs.writeFileSync(pidFile, `${descendant.pid}\n`, { mode: 0o600 });
    process.exit(2);
  }

  fs.writeFileSync(pidFile, `${process.pid}\n${descendant.pid}\n`, { mode: 0o600 });
  process.stdin.resume();
  setInterval(() => {}, 1_000);
}
