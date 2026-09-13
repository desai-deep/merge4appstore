export const DEFAULT_PUBLIC_BASE_URL = 'https://api.runningorder.app/merge4appstore';

// Keep the current reverse-proxy prefix during domain/host migration. Changing
// the hostname and changing every CI callback path are separate operations.
export function deploymentEndpoint(value = DEFAULT_PUBLIC_BASE_URL) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+\/merge4appstore$/.test(value)) {
    throw new Error('Public base URL must be https://DNS-HOST/merge4appstore');
  }
  const url = new URL(value);
  if (url.hostname.length > 253 || !url.hostname.includes('.') || url.hostname.split('.').some(label => (
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) || /^[0-9.]+$/.test(url.hostname)) throw new Error('Public base URL must use a DNS hostname');
  const baseUrl = `https://${url.hostname}/merge4appstore`;
  return { baseUrl, hostname: url.hostname, healthUrl: `${baseUrl}/health`, appWebhookUrl: `${baseUrl}/webhooks/github-app` };
}
