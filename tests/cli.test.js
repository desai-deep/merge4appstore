import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCliArgs } from '../lib/cli.js';

test('uses the default config and mode', () => {
  assert.deepEqual(parseCliArgs([], '/srv/merge4appstore', {}), {
    mode: 'all',
    configPath: '/srv/merge4appstore/.env',
  });
});

test('accepts a profile config before or after the mode', () => {
  assert.deepEqual(
    parseCliArgs(['deploy', '--config', 'profiles/jams.env'], '/srv/merge4appstore', {}),
    { mode: 'deploy', configPath: '/srv/merge4appstore/profiles/jams.env' },
  );
  assert.deepEqual(
    parseCliArgs(['--config=profiles/jams.env', 'sync'], '/srv/merge4appstore', {}),
    { mode: 'sync', configPath: '/srv/merge4appstore/profiles/jams.env' },
  );
});

test('supports an environment-selected config', () => {
  assert.equal(
    parseCliArgs([], '/srv/merge4appstore', { MERGE4APPSTORE_ENV: '/etc/jams.env' }).configPath,
    '/etc/jams.env',
  );
});

test('rejects unknown modes and options', () => {
  assert.throws(() => parseCliArgs(['publish'], '/srv', {}), /Unknown mode/);
  assert.throws(() => parseCliArgs(['--wat'], '/srv', {}), /Unknown option/);
});
