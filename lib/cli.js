import path from 'path';

const MODES = new Set(['all', 'deploy', 'sync', 'expire']);

export function parseCliArgs(args, rootDir, environment = process.env) {
  let mode = 'all';
  let configValue = environment.MERGE4APPSTORE_ENV || '.env';
  let profileValue = environment.MERGE4APPSTORE_PROFILE || '';
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

    if (argument === '--profile') {
      profileValue = args[index + 1];
      if (!profileValue) throw new Error('--profile requires a path');
      index += 1;
      continue;
    }

    if (argument.startsWith('--profile=')) {
      profileValue = argument.slice('--profile='.length);
      if (!profileValue) throw new Error('--profile requires a path');
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
    throw new Error(`Unknown mode: ${mode}. Expected all, deploy, sync, or expire.`);
  }

  const configPath = path.isAbsolute(configValue)
    ? configValue
    : path.resolve(rootDir, configValue);

  const profilePath = profileValue
    ? (path.isAbsolute(profileValue) ? profileValue : path.resolve(rootDir, profileValue))
    : null;

  return { mode, configPath, profilePath };
}
