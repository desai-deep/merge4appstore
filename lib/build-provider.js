export class XcodeCloudBuildProvider {
  constructor(asc) {
    this.asc = asc;
    this.name = 'xcode_cloud';
  }

  async findRun(intent) {
    return this.asc.getWorkflowRunStatus(
      intent.workflowId,
      intent.commitSha,
      intent.branch,
    );
  }

  async getRun(runId) {
    return this.asc.getBuildRun(runId);
  }

  async trigger(intent, { dryRun = false } = {}) {
    const existing = await this.findRun(intent);
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

    if (existing.unknownActiveBranchRun) {
      const active = existing.unknownActiveBranchRun;
      return {
        action: 'waiting',
        provider: this.name,
        runId: active.runId,
        number: active.number,
        executionProgress: active.executionProgress,
      };
    }

    const pullRequest = intent.pullRequest
      ? await this.asc.getWorkflowPullRequest(intent.workflowId, intent.pullRequest)
      : null;
    const reference = await this.asc.getWorkflowBranchReference(intent.workflowId, intent.branch);
    if (intent.pullRequest && !pullRequest) {
      const error = new Error(`Xcode Cloud pull request is not available yet: #${intent.pullRequest}`);
      error.code = 'SOURCE_PULL_REQUEST_NOT_FOUND';
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

    let run;
    let source = pullRequest ? 'pull_request' : 'branch';
    try {
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
