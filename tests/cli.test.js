import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCliArgs } from '../lib/cli.js';

test('uses the default config and mode', () => {
  assert.deepEqual(parseCliArgs([], '/srv/merge4appstore', {}), {
    mode: 'all',
    configPath: '/srv/merge4appstore/.env',
    profilePath: null,
  });
});

test('accepts a profile config before or after the mode', () => {
  assert.deepEqual(
    parseCliArgs(['deploy', '--config', 'profiles/jams.env'], '/srv/merge4appstore', {}),
    { mode: 'deploy', configPath: '/srv/merge4appstore/profiles/jams.env', profilePath: null },
  );
  assert.deepEqual(
    parseCliArgs(['--config=profiles/jams.env', 'sync'], '/srv/merge4appstore', {}),
    { mode: 'sync', configPath: '/srv/merge4appstore/profiles/jams.env', profilePath: null },
  );
});

test('accepts a repository YAML profile', () => {
  assert.deepEqual(
    parseCliArgs(['--profile', 'profiles/runningorder.yml'], '/srv/merge4appstore', {}),
    {
      mode: 'all',
      configPath: '/srv/merge4appstore/.env',
      profilePath: '/srv/merge4appstore/profiles/runningorder.yml',
    },
  );
});

test('accepts the merged-build expiry mode', () => {
  assert.equal(parseCliArgs(['expire'], '/srv/merge4appstore', {}).mode, 'expire');
});

test('accepts the managed build trigger mode', () => {
  assert.equal(parseCliArgs(['trigger'], '/srv/merge4appstore', {}).mode, 'trigger');
});

test('accepts the TestFlight notes refresh mode', () => {
  assert.equal(parseCliArgs(['notes'], '/srv/merge4appstore', {}).mode, 'notes');
});

test('accepts the release pull request reconciliation mode', () => {
  assert.equal(parseCliArgs(['release-pr'], '/srv/merge4appstore', {}).mode, 'release-pr');
});

test('supports an environment-selected config', () => {
  assert.equal(
    parseCliArgs([], '/srv/merge4appstore', { MERGE4APPSTORE_ENV: '/etc/jams.env' }).configPath,
    '/etc/jams.env',
  );
});

test('supports an environment-selected repository profile', () => {
  assert.equal(
    parseCliArgs([], '/srv/merge4appstore', { MERGE4APPSTORE_PROFILE: 'profiles/jams.yml' }).profilePath,
    '/srv/merge4appstore/profiles/jams.yml',
  );
});

test('rejects unknown modes and options', () => {
  assert.throws(() => parseCliArgs(['publish'], '/srv', {}), /Unknown mode/);
  assert.throws(() => parseCliArgs(['--wat'], '/srv', {}), /Unknown option/);
});
