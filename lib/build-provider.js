export class XcodeCloudBuildProvider {
  constructor(asc) {
    this.asc = asc;
    this.name = 'xcode_cloud';
  }

  async findRun(intent, { pullRequestId = null, branchReferenceId = null } = {}) {
    return this.asc.getWorkflowRunStatus(
      intent.workflowId,
      intent.commitSha,
      intent.branch,
      intent.pullRequest,
      pullRequestId,
      branchReferenceId,
      ...(intent.rebuildAfter ? [{ createdAfter: intent.rebuildAfter }] : []),
    );
  }

  async getRun(runId) {
    return this.asc.getBuildRun(runId);
  }

  async trigger(intent, options = {}) {
    let startAttempted = false;
    try {
      return await this.triggerWithTracking(intent, { ...options, onStart: () => { startAttempted = true; } });
    } catch (error) {
      error.beforeBuildStart = !startAttempted;
      throw error;
    }
  }

  async triggerWithTracking(intent, { dryRun = false, onStart } = {}) {
    const pullRequest = intent.pullRequest
      ? await this.asc.getWorkflowPullRequest(intent.workflowId, intent.pullRequest)
      : null;
    if (intent.pullRequest && !pullRequest) {
      const error = new Error(`Xcode Cloud pull request is not available yet: #${intent.pullRequest}`);
      error.code = 'SOURCE_PULL_REQUEST_NOT_FOUND';
      throw error;
    }
    const reference = await this.asc.getWorkflowBranchReference(intent.workflowId, intent.branch);

    const existing = await this.findRun(intent, {
      pullRequestId: pullRequest?.id || null,
      branchReferenceId: reference?.id || null,
    });
    if (existing.found) {
      return {
        action: 'existing',
        provider: this.name,
        runId: existing.runId,
        number: existing.number,
        executionProgress: existing.executionProgress,
        completionStatus: existing.completionStatus,
      };
    }

    const unknownActiveRun = existing.unknownActivePullRequestRun
      || existing.unknownActiveBranchRun;
    if (unknownActiveRun) {
      const active = unknownActiveRun;
      return {
        action: 'waiting',
        provider: this.name,
        runId: active.runId,
        number: active.number,
        executionProgress: active.executionProgress,
      };
    }

    if (existing.uncertainActivePullRequestRun || existing.uncertainActiveBranchRun) {
      const error = new Error('Xcode Cloud has an active build whose source identity is not available yet');
      error.code = 'SOURCE_ACTIVE_RUN_UNCERTAIN';
      error.statusCode = 503;
      error.retryAfter = 5;
      throw error;
    }

    if (!intent.pullRequest && !reference) {
      const error = new Error(`Xcode Cloud source branch is not available yet: ${intent.branch}`);
      error.code = 'SOURCE_REFERENCE_NOT_FOUND';
      throw error;
    }

    if (dryRun) {
      return {
        action: 'would_start',
        provider: this.name,
        workflowId: intent.workflowId,
        ...(pullRequest
          ? { pullRequestId: pullRequest.id }
          : { sourceReferenceId: reference.id }),
      };
    }

    if (intent.rebuildAfter) {
      // Wait out GitHub's timestamp second so a freshly created run cannot be
      // confused with a run from before the edit, even on immediate retries.
      // Allow two seconds for clock skew between the worker and Apple.
      const delay = Date.parse(intent.rebuildAfter) + 3000 - Date.now();
      if (delay > 7000) {
        const error = new Error('Retarget timestamp is ahead of the build clock');
        error.statusCode = 503;
        error.retryAfter = 5;
        throw error;
      }
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }

    let run;
    let source = pullRequest ? 'pull_request' : 'branch';
    try {
      onStart?.();
      run = await this.asc.startWorkflowBuild(intent.workflowId, pullRequest ? null : reference?.id || null, {
        pullRequestId: pullRequest?.id || null,
      });
    } catch (error) {
      // Apple requires a pull-request start-condition association even for a
      // manual build. A manual-only workflow can still build the exact source
      // branch, and the preparation endpoint recovers the open PR by commit.
      if (!pullRequest || error.statusCode !== 409 || !reference) throw error;
      run = await this.asc.startWorkflowBuild(intent.workflowId, reference.id);
      source = 'branch_fallback';
    }
    return {
      action: 'started',
      provider: this.name,
      source,
      ...run,
    };
  }
}
