#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { deploymentEndpoint } from '../lib/deployment-endpoint.js';

const options = {};
try {
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    if (!['--domain', '--output', '--environment'].includes(key) || options[key] !== undefined || !process.argv[index + 1]) {
      throw new Error('Usage: npm run bootstrap:deployment -- --domain HOST --environment production|uat --output NEW-DIRECTORY');
    }
    options[key] = process.argv[index + 1];
  }
  if (!options['--domain'] || !options['--output'] || !['production', 'uat'].includes(options['--environment'])) {
    throw new Error('domain, output, and environment (production or uat) are required');
  }
  const endpoint = deploymentEndpoint(`https://${options['--domain']}/merge4appstore`);
  const directory = path.resolve(options['--output']);
  const domain = endpoint.hostname;
  // A bundle contains configuration only. Never modify the host, DNS, secrets,
  // or an existing bundle; the operator chooses when to apply these files.
  fs.mkdirSync(directory, { mode: 0o700 });
  const write = (name, contents) => fs.writeFileSync(path.join(directory, name), contents, { flag: 'wx', mode: 0o600 });
  const http = `server {
    listen 80;
    server_name ${domain};
    access_log off;
    error_log /dev/null crit;
    location /.well-known/acme-challenge/ { root /var/www/merge4appstore-acme; }
    location / { return 404; }
}
`;
  const tls = `server {
    listen 443 ssl;
    server_name ${domain};
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    error_log /dev/null crit;
    # The transactional deployer adds its managed /merge4appstore/ include here.
    location / { return 404; }
}
`;
  write('nginx-http.conf', http);
  write('nginx-tls.conf', http + tls);
  write('actions-variables.json', JSON.stringify({ MERGE4APPSTORE_PUBLIC_BASE_URL: endpoint.baseUrl }, null, 2) + '\n');
  write('deployment.json', JSON.stringify({ environment: options['--environment'], ...endpoint, controlDirectory: '/srv/merge4appstore', stateDirectory: '/srv/merge4appstore.state', listener: '127.0.0.1:8788', isolatedHostRequiredForSecondInstance: true }, null, 2) + '\n');
  write('NEXT-STEPS.md', `# Deployment bootstrap: ${options['--environment']}

Public endpoint: ${endpoint.baseUrl}
Health: ${endpoint.healthUrl}
GitHub App webhook: ${endpoint.appWebhookUrl}

This bundle has not provisioned or deployed anything. Follow docs/deployment-bootstrap.md in the repository.

1. Choose an existing host for the same service or provision a separate Linux host. Do not run two deployments of this service on the same host.
2. Point DNS for ${domain} at the target. Install prerequisites and establish a trusted SSH host-key fingerprint.
3. Install nginx-http.conf as a new enabled site. Create /var/www/merge4appstore-acme; run nginx -t before reloading.
4. Obtain a certificate with certbot certonly --webroot -w /var/www/merge4appstore-acme -d ${domain}. Verify certificate renewal and its Nginx reload hook.
5. Replace that site's HTTP configuration with nginx-tls.conf, then nginx -t and reload. There must be exactly one enabled TLS server block for ${domain}.
6. Provision private runtime credentials on the host, outside the checkout history. See docs/secret-storage.md.
7. Configure Actions deployment secrets and the public URL in actions-variables.json. Remove a stale MERGE4APPSTORE_HEALTH_URL override.
8. Follow the migration checklist before dispatching deployment. The production workflow runs main and all tracked profiles; this environment label does not isolate UAT execution.
`);
  console.log(`Created deployment bootstrap bundle: ${directory}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
