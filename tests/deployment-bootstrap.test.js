import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import { deploymentEndpoint } from '../lib/deployment-endpoint.js';

test('deployment endpoints retain the legacy default and validate custom DNS routing', () => {
  assert.equal(deploymentEndpoint().hostname, 'api.runningorder.app');
  assert.deepEqual(deploymentEndpoint('https://hooks.example.com/merge4appstore'), {
    baseUrl: 'https://hooks.example.com/merge4appstore', hostname: 'hooks.example.com',
    healthUrl: 'https://hooks.example.com/merge4appstore/health',
    appWebhookUrl: 'https://hooks.example.com/merge4appstore/webhooks/github-app',
  });
  for (const value of ['https://hooks.example.com/merge4appstore/', 'http://example.com/merge4appstore', 'https://user:pass@example.com/merge4appstore', 'https://example.com/other', 'https://example.com/merge4appstore?token=x', 'https://example.com/merge4appstore#x', 'https://example.com:8443/merge4appstore', 'https://-bad.example/merge4appstore', 'https://127.0.0.1/merge4appstore', 'https://example.com\n; echo bad/merge4appstore']) {
    assert.throws(() => deploymentEndpoint(value));
  }
});

test('bootstrap renders a private review bundle without overwriting existing files', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-bootstrap-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'bundle');
  const args = ['scripts/bootstrap-deployment.js', '--domain', 'hooks.example.com', '--environment', 'production', '--output', output];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'deployment.json')));
  assert.equal(manifest.healthUrl, 'https://hooks.example.com/merge4appstore/health');
  const tls = fs.readFileSync(path.join(output, 'nginx-tls.conf'), 'utf8');
  assert.match(tls, /listen 443 ssl;/);
  assert.match(tls, /server_name hooks.example.com;/);
  assert.doesNotMatch(fs.readFileSync(path.join(output, 'nginx-http.conf'), 'utf8'), /ssl_certificate/);
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(output, 'deployment.json')).mode & 0o777, 0o600);
  assert.notEqual(spawnSync(process.execPath, args).status, 0);
  assert.equal(fs.readFileSync(path.join(output, 'nginx-tls.conf'), 'utf8'), tls);
  const invalidOutput = path.join(parent, 'bad');
  assert.notEqual(spawnSync(process.execPath, ['scripts/bootstrap-deployment.js', '--domain', 'bad;domain', '--environment', 'uat', '--output', invalidOutput]).status, 0);
  assert.equal(fs.existsSync(invalidOutput), false);
});

test('workflow transports a validated endpoint and derives every health check from it', () => {
  const workflow = YAML.parse(fs.readFileSync('.github/workflows/deploy.yml', 'utf8'));
  const deploy = workflow.jobs.deploy.steps.find(step => step.name === 'Deploy to VPS');
  assert.match(deploy.env.MERGE4APPSTORE_PUBLIC_BASE_URL, /vars.MERGE4APPSTORE_PUBLIC_BASE_URL/);
  assert.match(deploy.run, /endpoint_json="\$\(node scripts\/deployment-endpoint.js\)"/);
  assert.match(deploy.run, /DEPLOYMENT_ENDPOINT_B64='\$endpoint_b64'/);
  assert.match(deploy.run, /export MERGE4APPSTORE_PUBLIC_BASE_URL MERGE4APPSTORE_NGINX_SERVER_NAME/);
  const source = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
  const healthLines = source.split('\n').filter(line => line.includes('HEALTH_URL:'));
  assert.equal(healthLines.length, 2);
  for (const line of healthLines) assert.match(line, /vars.MERGE4APPSTORE_PUBLIC_BASE_URL/);
});
