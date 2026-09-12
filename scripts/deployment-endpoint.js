#!/usr/bin/env node
import { deploymentEndpoint } from '../lib/deployment-endpoint.js';
try {
  const result = deploymentEndpoint(process.env.MERGE4APPSTORE_PUBLIC_BASE_URL || undefined);
  if (process.env.MERGE4APPSTORE_NGINX_SERVER_NAME && process.env.MERGE4APPSTORE_NGINX_SERVER_NAME !== result.hostname) {
    throw new Error('Nginx server name must match the public base URL hostname');
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
