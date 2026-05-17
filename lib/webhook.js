import crypto from 'crypto';

export function buildWebhookPath(pathname, secretToken = '') {
  if (!secretToken) {
    return pathname;
  }

  const suffix = secretToken.startsWith('/') ? secretToken : `/${secretToken}`;
  return `${pathname}${suffix}`;
}

export function extractWebhookEvent(payload) {
  return {
    deliveryId: payload?.webhook?.id || '',
    eventType: payload?.metadata?.attributes?.eventType || '',
    workflowId: payload?.ciWorkflow?.id || '',
    workflowName: payload?.ciWorkflow?.attributes?.name || '',
    buildRunId: payload?.ciBuildRun?.id || '',
    buildNumber: payload?.ciBuildRun?.attributes?.number?.toString() || '',
    executionProgress: payload?.ciBuildRun?.attributes?.executionProgress || '',
    completionStatus: payload?.ciBuildRun?.attributes?.completionStatus || '',
  };
}

export function shouldTriggerDeploy(payload, expectedWorkflowId = '') {
  const event = extractWebhookEvent(payload);

  if (event.eventType !== 'BUILD_COMPLETED') {
    return { accepted: false, reason: `Ignoring event type ${event.eventType || 'unknown'}`, event };
  }

  if (event.completionStatus && event.completionStatus !== 'SUCCEEDED') {
    return { accepted: false, reason: `Ignoring build with completion status ${event.completionStatus}`, event };
  }

  if (event.executionProgress && event.executionProgress !== 'COMPLETE') {
    return { accepted: false, reason: `Ignoring build with execution progress ${event.executionProgress}`, event };
  }

  if (expectedWorkflowId && event.workflowId !== expectedWorkflowId) {
    return { accepted: false, reason: `Ignoring workflow ${event.workflowId || 'unknown'}`, event };
  }

  return { accepted: true, reason: 'Accepted build completion event', event };
}

export class DeliveryDeduper {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.seen = new Map();
  }

  remember(event) {
    const key = this.#buildKey(event);
    if (!key) {
      return false;
    }

    this.#cleanup();
    if (this.seen.has(key)) {
      return true;
    }

    this.seen.set(key, Date.now());
    return false;
  }

  #buildKey(event) {
    if (event.buildRunId) {
      return `run:${event.buildRunId}`;
    }

    if (event.deliveryId) {
      return `delivery:${event.deliveryId}`;
    }

    if (event.workflowId && event.buildNumber) {
      return crypto
        .createHash('sha256')
        .update(`${event.workflowId}:${event.buildNumber}`)
        .digest('hex');
    }

    return '';
  }

  #cleanup() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, timestamp] of this.seen.entries()) {
      if (timestamp < cutoff) {
        this.seen.delete(key);
      }
    }
  }
}
