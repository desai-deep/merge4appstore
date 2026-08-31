const path = require('node:path');

const appName = process.env.MERGE4APPSTORE_PM2_NAME || 'merge4appstore-webhooks-v2';
const configuredDrainTimeout = Number(process.env.MERGE4APPSTORE_DRAIN_TIMEOUT_MS);
const drainTimeout = Number.isFinite(configuredDrainTimeout) && configuredDrainTimeout >= 0
  ? configuredDrainTimeout
  : 10 * 60 * 1000;
const requiredEnvironment = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to start the production webhook service`);
  return value;
};
const stateDirectory = requiredEnvironment('MERGE4APPSTORE_STATE_DIR');

module.exports = {
  apps: [{
    name: appName,
    script: 'webhook-server.js',
    cwd: __dirname,
    exec_mode: 'cluster',
    instances: 2,
    merge_logs: true,
    out_file: path.join(stateDirectory, 'logs', 'webhook-out.log'),
    error_file: path.join(stateDirectory, 'logs', 'webhook-error.log'),
    autorestart: true,
    wait_ready: true,
    listen_timeout: 60000,
    // Give webhook-server.js time to drain every acknowledged background job.
    // PM2 sends SIGKILL when this deadline expires, so keep a small margin above
    // the application's own drain deadline.
    kill_timeout: drainTimeout + 10000,
    env: {
      BUILD_BRANCH: '',
      BUILD_COMMIT_SHA: '',
      BUILD_COMPLETED_AT: '',
      BUILD_NUMBER: '',
      BUILD_PULL_REQUEST: '',
      BUILD_PURPOSE: '',
      BUILD_RUN_ID: '',
      BUILD_SOURCE_DELIVERY_ID: '',
      BUILD_STATUS: '',
      BUILD_WAIT_FOR_COMPLETION: '',
      BUILD_WORKFLOW_ID: '',
      DRY_RUN: 'false',
      MERGE4APPSTORE_DELIVERY_PAUSE_FILE: requiredEnvironment('MERGE4APPSTORE_DELIVERY_PAUSE_FILE'),
      MERGE4APPSTORE_DEPLOY_SHA: requiredEnvironment('MERGE4APPSTORE_DEPLOY_SHA'),
      MERGE4APPSTORE_DRAIN_TIMEOUT_MS: requiredEnvironment('MERGE4APPSTORE_DRAIN_TIMEOUT_MS'),
      MERGE4APPSTORE_ENV: requiredEnvironment('MERGE4APPSTORE_ENV'),
      MERGE4APPSTORE_PM2_NAME: appName,
      MERGE4APPSTORE_STATE_DIR: requiredEnvironment('MERGE4APPSTORE_STATE_DIR'),
      MERGE4APPSTORE_WEBHOOK_ENV: requiredEnvironment('MERGE4APPSTORE_WEBHOOK_ENV'),
      NODE_ENV: 'production',
      RECONCILE_METADATA: 'false',
      WEBHOOK_AUTOSTART: 'true',
      WEBHOOK_HOST: requiredEnvironment('WEBHOOK_HOST'),
      WEBHOOK_PORT: requiredEnvironment('WEBHOOK_PORT'),
    },
    filter_env: [
      'APP_STORE_CONNECT_API_',
      'BUILD_',
      'DRY_RUN',
      'GH_TOKEN',
      'GH_WEBHOOK_SECRET',
      'RECONCILE_METADATA',
      'XCODE_CLOUD_WEBHOOK_TOKEN',
      'MERGE4APPSTORE_BUILD_TOKEN_',
    ],
  }],
};
