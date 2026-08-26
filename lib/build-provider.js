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

    const reference = await this.asc.getWorkflowBranchReference(
      intent.workflowId,
      intent.branch,
    );
    if (!reference) {
      const error = new Error(`Xcode Cloud source branch is not available yet: ${intent.branch}`);
      error.code = 'SOURCE_REFERENCE_NOT_FOUND';
      throw error;
    }

    if (dryRun) {
      return {
        action: 'would_start',
        provider: this.name,
        workflowId: intent.workflowId,
        sourceReferenceId: reference.id,
      };
    }

    const run = await this.asc.startWorkflowBuild(intent.workflowId, reference.id);
    return {
      action: 'started',
      provider: this.name,
      ...run,
    };
  }
}
