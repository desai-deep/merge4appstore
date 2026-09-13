# Core and hosted app boundary

This repository is the MIT-licensed, self-hostable release engine. The private
[merge2fly-app repository](https://github.com/desai-deep/merge2fly-app) owns the
local onboarding web UI and future hosted service. The app consumes an exact
Git commit of this package; it does not copy release logic.

## MVP SDK

The package root exports `ReleaseClient`, `GitHubAppAuthenticator`,
`AppStoreConnectAPI`, and `XcodeCloudBuildProvider`. Existing CLI entrypoints
remain unchanged. `ReleaseClient` takes explicit credentials, avoiding changes
to process-wide configuration. Its first vertical slice intentionally supports
internal-testing archive workflows only:

```js
import { ReleaseClient } from 'merge4appstore';
const client = new ReleaseClient({
  github: { appId, privateKey: githubPrivateKeyPem },
  apple: { keyId, issuerId, privateKey: applePrivateKeyPem },
});
const repositories = await client.repositories();
const products = await client.catalogue();
const selection = await client.validate({
  repository: 'owner/ios-app', appId: '1234567890', workflowId,
  branch: 'develop', pullRequest: null,
});
const run = await client.trigger(selection);
const status = await client.status(run.runId, selection);
```

`validate` verifies Apple app/workflow membership, internal-only archive
configuration, matching GitHub repository, and source availability. `trigger`
uses the existing Xcode Cloud provider's reconciliation before starting a build.
It does not add tags, merge branches, or submit an App Store version.
Workflows and their existing scripts/post-actions remain customer-controlled.
A configured Xcode Cloud workflow, signing, and internal TestFlight post-action
are prerequisites; this SDK does not provision them.

Existing CLI automation (versioning, metadata, releases, webhooks and durable
jobs) remains available to self-hosters. It still has process-global configuration,
so hosted integrations should isolate executions rather than mutate environment
variables concurrently. The app MVP does this using a fresh worker process for
each SDK operation.

## Deployment ownership and migration

The former active hosted workflow and real app profiles have moved to
`merge2fly-app/infra/legacy`. Core CI now only tests the engine. Historical copies
under `tests/fixtures/hosted` preserve regression coverage, not active deployment
configuration. Generic bootstrap tools and the existing VPS deployment helper
remain here for self-hosters and migration compatibility. The helper retains
legacy defaults; configure the public endpoint explicitly for a new deployment.

This is a repository split, not a production runtime migration. The current VPS
continues running its existing release. Do not activate the archived workflow in
the app repository unchanged: it assumes this repository's layout, main branch,
profiles and repository-local secrets. The app's infrastructure README records
the cutover work. Merging this core PR removes the old scheduled GitHub monitor;
replace it in the service repository before merge if production still depends
on it. The PR stays unmerged until that deployment handoff is ready.

The bootstrap work from PR #73 is included in this PR and need not be merged
separately. Managed secret storage remains a future service concern. File-based
credentials continue to work for self-hosters.
