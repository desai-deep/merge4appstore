import path from 'path';

const MODES = new Set(['all', 'deploy', 'sync']);

export function parseCliArgs(args, rootDir, environment = process.env) {
  let mode = 'all';
  let configValue = environment.MERGE4APPSTORE_ENV || '.env';
  let modeWasSet = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--config') {
      configValue = args[index + 1];
      if (!configValue) throw new Error('--config requires a path');
      index += 1;
      continue;
    }

    if (argument.startsWith('--config=')) {
      configValue = argument.slice('--config='.length);
      if (!configValue) throw new Error('--config requires a path');
      continue;
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (modeWasSet) throw new Error(`Unexpected argument: ${argument}`);
    mode = argument;
    modeWasSet = true;
  }

  if (!MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}. Expected all, deploy, or sync.`);
  }

  const configPath = path.isAbsolute(configValue)
    ? configValue
    : path.resolve(rootDir, configValue);

  return { mode, configPath };
}
