import { isRetryable } from './deploy-result.js';

// Statuses that are not terminal but mean "try again shortly": either a build is
// still processing in TestFlight (isRetryable) or a transient condition (another
// run holds the lock, or the API errored).
function shouldRetry(status) {
  return isRetryable(status) || status === 'busy' || status === 'error';
}

// DeployRunner turns a single webhook trigger into a bounded series of deploy
// checks. Xcode Cloud fires its webhook when CI finishes building, but Apple
// still needs several minutes to process the build before it becomes a valid
// TestFlight build the deploy check can submit. So on a retryable outcome we
// re-run after a delay until the build appears or we exhaust the window.
//
// Triggers are coalesced: overlapping webhooks reset the attempt counter and
// extend the window rather than spawning concurrent runs.
export class DeployRunner {
  constructor({
    runOnce,
    intervalMs = 3 * 60 * 1000,
    maxAttempts = 20,
    log = console.log,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    this.runOnce = runOnce;
    this.intervalMs = intervalMs;
    this.maxAttempts = maxAttempts;
    this.log = log;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;

    this.running = false;
    this.attempts = 0;
    this.timer = null;
    this.retriggered = false;
  }

  trigger(source = 'unknown') {
    this.log(`Trigger received from ${source} - starting deploy attempts`);
    this.attempts = 0;
    this.#clearTimer();

    if (this.running) {
      // A run is in flight; remember to start a fresh window once it finishes.
      this.retriggered = true;
      return;
    }

    this.#scheduleRun(0);
  }

  stop() {
    this.#clearTimer();
  }

  #clearTimer() {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  #scheduleRun(delayMs) {
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.#run();
    }, delayMs);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  async #run() {
    if (this.running) return;
    this.running = true;

    let result;
    try {
      result = await this.runOnce();
    } catch (e) {
      this.log(`Deploy run errored: ${e.message}`);
      result = { status: 'error' };
    } finally {
      this.running = false;
    }

    // A webhook arrived mid-run: start a clean window immediately.
    if (this.retriggered) {
      this.retriggered = false;
      this.attempts = 0;
      this.#scheduleRun(0);
      return;
    }

    const status = result?.status;

    if (!shouldRetry(status)) {
      this.log(`Deploy run finished with status: ${status}`);
      this.attempts = 0;
      return;
    }

    this.attempts += 1;
    if (this.attempts >= this.maxAttempts) {
      this.log(
        `Gave up after ${this.attempts} attempts (last status: ${status}) - no eligible build became ready in time`
      );
      this.attempts = 0;
      return;
    }

    this.log(
      `Build not ready yet (status: ${status}); retry ${this.attempts}/${this.maxAttempts} in ${Math.round(this.intervalMs / 1000)}s`
    );
    this.#scheduleRun(this.intervalMs);
  }
}
