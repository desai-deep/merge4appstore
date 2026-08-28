# Product and Xcode Cloud CI ownership plan

Status: implementation plan informed by the deployed PR #19 baseline

Last reviewed: 2026-08-27

Baseline: PR #19 merged and deployed; app adapters merged in JamsOnToast #54
and runningorder-ios #131

## Executive summary

`merge4appstore` can become the control plane for an iOS release while Xcode
Cloud remains the build plane. The app repository should retain only Apple's
required custom-script entrypoint and the project-specific command needed to
make the checkout buildable, such as installing Tuist and generating an Xcode
project.

The target product is not another hosted macOS build farm. It augments Xcode
Cloud with release lifecycle automation across GitHub, TestFlight, and App
Store Connect:

- prepare builds consistently across production, UAT, and internal apps;
- derive versions and TestFlight notes without placing Apple or GitHub keys in
  Xcode Cloud;
- expire builds belonging to closed pull requests without touching beta or
  production builds;
- recover missed Xcode Cloud triggers without starting duplicate builds;
- submit the correct build for App Store review and synchronize the eventual
  release back to GitHub;
- expose dry runs, decision reasons, approvals, and an audit trail.

GitHub and Xcode Cloud webhooks are the primary execution model. Signed App
Store Connect webhooks supply subsequent build, TestFlight, and app-version
state changes. Scheduled polling remains only as a slower reconciliation path
for missed, delayed, or unsupported events.

The existing code is a useful single-tenant implementation of the core release
algorithms. Productizing it requires durable jobs, tenant isolation, an
encrypted credential store, GitHub App authentication, onboarding and
discovery, webhook ingestion, observability, and removal of local repository
checkout dependencies.

## What the PR #19 implementation proved

The plan is no longer based only on code inspection. The following paths have
been exercised against GitHub, Xcode Cloud, and App Store Connect:

- both apps use manual Xcode Cloud start conditions and builds are started from
  signed GitHub webhooks;
- PR open/synchronize produces one real archive per head commit, while the
  separate push event for a PR branch does not produce a duplicate;
- push to `develop` starts the beta workflow for the exact merge commit;
- PR close expires the matching TestFlight build and leaves other workflows
  and App Store-selected builds untouched;
- Running Order routes PR builds and cleanup to UAT while beta and production
  remain on the production app; Jams routes every purpose to one app;
- the thin preparation API returns a centrally selected marketing version and
  notes without assuming Tuist;
- PR notes contain the body plus all commits since the latest published
  ancestor build by default, and body edits can refresh notes without a build;
- production submission, rejection reconciliation, review-draft reuse, live
  release sync, and tag logic remain the existing modules and passed dry runs;
- GitHub and Xcode Cloud webhook endpoints, HTTPS routing, PM2 health, profile
  validation, and deployment all work on the current VPS.

The merge test exposed two production-relevant gaps, both mitigated in PR #21:

1. GitHub sends PR-closed and base-branch push deliveries close together. The
   listener originally launched both, but the per-instance filesystem lock let
   one exit successfully rather than waiting. Jobs are now serialized per
   repository, and cross-process lock contention waits with a visible timeout.
2. Apple stopped reporting the source branch for one completed UAT PR build
   after merge. Cleanup now requires the configured PR workflow plus one exact
   commit association to a closed PR targeting the configured beta branch;
   ambiguous or wrong-workflow builds remain protected.

The original test was recovered manually: Jams beta build #160 and Running beta
build #1688 were started for their merge commits; Jams PR build #158 and Running
UAT PR build #556 were expired. PR #21 then replayed Jams' simultaneous PR-close
and develop-push deliveries against the VPS: cleanup completed first, the beta
trigger ran second, and build #160 was reused without a duplicate or skipped
job. This is the correct single-process baseline. The hosted product still
needs durable acceptance/queueing and persisted build provenance across
restarts.

## Current responsibility boundaries

| Owner | Current responsibility |
| --- | --- |
| App repository | Thin post-clone adapter, applying the returned marketing version and notes, project-specific setup such as Tuist, and the `develop` to `main` release PR workflow |
| Xcode Cloud | Repository checkout, manually startable workflows, build/test/archive, signing, upload, TestFlight distribution, and the repository-scoped preparation token |
| `merge4appstore` | Signed GitHub webhook routing, managed Xcode build starts, version and notes policy, production submission, live-release synchronization and tagging, closed-PR build expiration, missed-production-trigger recovery, and GitHub comments |
| Repository profile | Branches, app roles, App Store Connect identifiers, Xcode Cloud workflow identifiers, and operation routing |
| VPS | Runtime credentials, webhook service, cron reconciliation, locks, logs, and the optional checkout used by legacy beta-branch synchronization |

PR #19 makes operation routing declarative, gives `prod`, `uat`, and `internal`
consistent meanings, and centralizes the shared version and note policy. It
does not remove the operational coupling to one VPS or make webhook processing
durable.

## Current cross-dependencies to remove

1. The two app repositories still vendor similar HTTP/response adapters and
   project-mutation code rather than consuming a pinned shared CI client.
2. Xcode Cloud workflow IDs and manual start conditions are configured manually and can
   drift from the tracked profile.
3. GitHub operations shell out to `gh` using a long-lived personal token.
4. Release synchronization can use `IOS_REPO_PATH` to mutate and push from a
   persistent local checkout.
5. Webhook jobs are serialized per repository in-process, and other processes
   wait on one filesystem lock per repository. This prevents concurrent skips
   but does not survive a webhook-process restart.
6. Webhook delivery deduplication is an in-memory 24-hour map and is lost on
   restart; accepted work is not durably recorded before the response.
7. Apple source-branch metadata is queried at cleanup time rather than retained
   when the build is created. Exact commit-to-PR association is a safe fallback,
   but durable provenance would be faster and independent of later provider data.
8. Logs are local files without customer-visible history, alerting, or an audit
   model.
9. Release behavior assumes specific branches, one release PR, English notes,
   and an opinionated App Store submission policy. Release type is not yet
   profile data; the supervised Jams 1.2 release required an explicit ASC patch
   to `AFTER_APPROVAL` before submission.

## Target responsibility boundaries

### App repository: a thin, reproducible adapter

The repository keeps:

- `ci_scripts/ci_post_clone.sh`, because Xcode Cloud only recognizes custom
  scripts from the checked-out repository;
- a project preparation command, such as Tuist installation and generation;
- a small non-secret configuration identifying the product/profile and a
  pinned CI client version;
- app-specific build transformations that cannot be generalized safely.

Example target footprint:

```text
ci_scripts/
  ci_post_clone.sh
  prepare_project.sh
.merge4appstore.yml
```

Example repository configuration:

```yaml
version: 1
profile: jamsontoast
ci_client: 1.2.0

project:
  prepare: ./ci_scripts/prepare_project.sh
```

`prepare_project.sh` is allowed to install and run Tuist for these applications.
Other customers may use a committed project, Swift Package Manager, XcodeGen,
or another generator. Tuist must not be a product requirement.

### Xcode Cloud: build execution

Xcode Cloud continues to own:

- repository checkout and Apple-provided CI environment;
- workflow definitions and actions, with manual/provider-managed start
  conditions when `merge4appstore` owns triggering;
- Xcode build, test, archive, and analysis;
- signing, entitlements, and distribution groups;
- upload to App Store Connect and TestFlight;
- execution of the thin in-repository entrypoint.

The product may discover, validate, monitor, and start workflows where App
Store Connect APIs permit it. It should not claim to provision all Apple
signing and workflow configuration.

### `merge4appstore`: release control plane

The service should own:

- GitHub-event-to-build intent and provider trigger policy;
- app-role and workflow resolution;
- environment classification (`prod`, `uat`, and `internal`);
- marketing-version policy and App Store version lookup;
- PR and commit lookup;
- TestFlight note generation;
- closed-PR build expiration;
- build recovery and duplicate prevention;
- App Store submission, rejection-state handling, and release synchronization;
- GitHub release PRs, comments, tags, and optional API-based branch triggers;
- validation, dry runs, approval gates, decision explanations, and audit events.

## Build preparation protocol

The Xcode Cloud entrypoint should call a versioned, narrow client rather than
containing release policy. The client sends Xcode Cloud's predefined context to
the service:

```http
POST /v1/builds/prepare
Authorization: Bearer <repository-scoped build token>
Idempotency-Key: <xcode-cloud-build-id>
```

```json
{
  "repository": "example/example-ios",
  "commit": "abc123",
  "branch": "develop",
  "pull_request": 49,
  "workflow_id": "WORKFLOW-ID",
  "build_number": "812"
}
```

The response contains non-secret build inputs:

```json
{
  "role": "prod",
  "marketing_version": "1.4.0",
  "testflight_notes": "Freshen playback controls",
  "warnings": []
}
```

The client applies the version, writes the localized TestFlight notes, executes
the configured project preparation command, and emits structured diagnostics.
The service uses its own GitHub App installation and centrally stored App Store
Connect credential. Xcode Cloud therefore needs only a repository-scoped
`MERGE4APPSTORE_BUILD_TOKEN`, not Apple or GitHub credentials.

The endpoint must fail closed for an unknown repository, workflow, commit, or
role. A configurable fallback may allow project generation to continue using a
version committed in the repository, but submission automation must not treat
that build as eligible until it is reconciled.

## Webhook-first event model

The hosted product must react to provider events instead of running every
automation for every repository every five minutes.

### [GitHub webhooks](https://docs.github.com/en/webhooks/about-webhooks)

Subscribe only to the events required by enabled modules:

| GitHub event | Product action |
| --- | --- |
| Pull request opened, synchronized, reopened, or closed | Track the expected PR build; on close or merge, enqueue workflow-scoped TestFlight cleanup |
| Push to the production or beta branch | Reconcile the expected Xcode Cloud workflow run and recover a missed trigger when policy permits |
| Release PR merged | Associate the production commit, expected workflow, release notes, and later submission |
| Installation, repository, or permission changed | Refresh access and suspend jobs that are no longer authorized |

Validate GitHub's HMAC signature before accepting a delivery. Persist
`X-GitHub-Delivery` as the idempotency key, acknowledge quickly, and process the
event asynchronously. A duplicate delivery must resolve to the same stored
event and must never repeat a mutation.

### [Xcode Cloud webhooks](https://developer.apple.com/documentation/xcode/configuring-webhooks-in-xcode-cloud)

Configure a product webhook for each connected Xcode Cloud product. Apple sends
events when a build is created, starts, and completes; the payload includes app,
workflow, build, repository, and source-control context.

| Xcode Cloud event | Product action |
| --- | --- |
| `BUILD_CREATED` | Match the run to the expected repository commit, PR, app role, and workflow; cancel any pending recovery timer |
| `BUILD_STARTED` | Mark the build active and expose progress without polling |
| `BUILD_COMPLETED` | Fetch authoritative build/run state, record provenance, then enqueue submission or cleanup evaluation as appropriate |

Xcode Cloud retries retryable failures, so ingestion must be idempotent and
respond promptly after durable acceptance. Apple supports up to five webhooks
per Xcode Cloud product. Onboarding must verify that a product webhook points to
the correct tenant endpoint and perform a test build/delivery check.

Apple's Xcode Cloud webhook documentation does not describe an HMAC signing
secret. Treat its payload as a notification, not authorization: validate its
shape and configured product/workflow IDs, deduplicate it, then confirm the
build through the authenticated App Store Connect API before any mutation.
Rate-limit and monitor the public endpoint. Never submit or expire a build based
only on an unauthenticated Xcode Cloud payload.

### [App Store Connect webhooks](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications)

Create signed per-app App Store Connect webhooks for supported lifecycle events,
including build-upload state, external beta state, and App Store version state.
Verify `x-apple-signature` using the configured HMAC secret before accepting the
event.

These events close the gap between Xcode Cloud finishing and App Store Connect
finishing build processing, beta review, App Review, and release. They should
drive submission continuation, release synchronization, and status updates
without frequent polling.

### Reconciliation remains mandatory

Webhooks can be delayed, duplicated, misconfigured, or missed during an outage.
A scheduled reconciler should therefore:

- run much less frequently than the current five-minute full scan, initially
  every 30–60 minutes;
- prioritize builds or releases with an expected transition overdue;
- read provider rate-limit headers and defer low-priority work;
- compare stored state with GitHub, Xcode Cloud, TestFlight, and App Store
  Connect;
- repair missing jobs without repeating completed external mutations;
- expose the reason and source (`webhook` or `reconciliation`) for every job.

## Managed build triggers and modular build providers

GitHub should become the source of build intent. Once a connected repository is
in managed-trigger mode, its push and pull-request webhooks select a configured
build purpose (`pull_request`, `beta`, or `production`) and enqueue exactly one
provider build for the relevant commit.

For Xcode Cloud, configure workflows with manual branch or pull-request start
conditions and call Apple's [Start a build
endpoint](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-cibuildruns).
Apple explicitly supports reading and managing Xcode Cloud workflows and
starting builds through the App Store Connect API. Native automatic Git start
conditions must be disabled after cutover so the same GitHub event cannot also
start a second Apple-managed build.

The flow is:

```text
GitHub push / PR webhook
          |
          v
derive immutable BuildIntent
          |
          v
deduplicate repository + workflow + commit + purpose
          |
          v
selected BuildProvider.trigger(intent)
          |
          v
provider result webhook -> normalized BuildEvent -> lifecycle automation
```

A `BuildIntent` should be provider-neutral:

```json
{
  "repository": "example/example-ios",
  "commit": "abc123",
  "ref": "refs/heads/develop",
  "pull_request": 49,
  "purpose": "pull_request",
  "app_role": "uat",
  "workflow": "pull_requests",
  "source_delivery_id": "github-delivery-id"
}
```

The durable uniqueness key is the repository, provider, workflow, commit, and
purpose. Before starting a build, the provider must also check for an existing
pending, running, or completed run so webhook retries, service restarts, and
reconciliation cannot create duplicates.

GitHub may deliver an event before Xcode Cloud's repository mirror exposes the
new branch, pull request, or commit. Treat a missing source reference as a
transient condition: retry it with bounded backoff and reconciliation, while
retaining the same idempotency key, rather than falling back to another ref.

### Build provider contract

The release policy must depend on a small provider interface rather than Xcode
Cloud response objects:

- `discover()` lists products, workflows, repositories, and supported trigger
  types;
- `validate(config)` checks credentials, repository access, workflow mapping,
  and webhook health;
- `trigger(buildIntent)` starts or returns the existing provider run;
- `getRun(providerRunId)` returns normalized status and provenance;
- `findRun(buildIntent)` supports reconciliation and duplicate prevention;
- `cancel(providerRunId)` cancels when the provider supports it;
- `normalizeWebhook(payload)` produces a normalized `BuildEvent`;
- `resolveArtifacts(providerRunId)` links archives, logs, and uploaded store
  builds where supported.

Normalized states should be deliberately small: `queued`, `running`,
`succeeded`, `failed`, and `cancelled`. Provider-specific details remain in
diagnostics rather than leaking into release policy.

### Initial Xcode Cloud provider

Xcode Cloud is the only provider required for the first release. It uses the
customer's own App Store Connect API key; there is no separate Xcode Cloud API
token. `merge4appstore` generates short-lived ASC JWTs and uses them to:

- discover Xcode Cloud products, workflows, Git references, and pull requests;
- start a build for the selected manual workflow and source reference;
- read run state, commit provenance, actions, and artifacts;
- corroborate Xcode Cloud webhook payloads;
- continue into TestFlight and App Store lifecycle automation.

The customer's Apple account continues to own and pay for Xcode Cloud compute,
signing, and distribution. The hosted service stores the ASC private key using
the tenant-isolated secret controls described below.

Target profile shape:

```yaml
build:
  provider: xcode_cloud
  trigger_mode: managed
  credential: customer_asc
  workflows:
    pull_request:
      app: uat
      id: PR-WORKFLOW-ID
    beta:
      app: prod
      id: BETA-WORKFLOW-ID
    production:
      app: prod
      id: PRODUCTION-WORKFLOW-ID
```

`trigger_mode: native` remains available during migration or when a customer
prefers Xcode Cloud's own start conditions. Provider ownership and release
automation are independent switches.

Pull requests from forks or source references that Xcode Cloud cannot access
must fail validation without attempting a different commit. The provider
capability result should tell onboarding whether branch, tag, and pull-request
manual triggers are supported for the selected workflow.

### Later providers

GitHub Actions, Bitrise, Codemagic, or a self-hosted runner can be added behind
the same contract. Each supplies its own credential, trigger API, result
webhook, and provenance mapping. Store automation remains separate: a provider
is not considered successful for submission until the resulting build is
authoritatively linked to the expected commit and visible in App Store Connect.

Modularity must not delay the initial product. Implement and contract-test one
Xcode Cloud adapter first, while keeping provider-specific data out of the core
job and release models.

## CI client distribution

Never execute an unpinned script directly from the default branch. Builds must
remain reproducible and reviewable.

Recommended sequence:

1. Publish immutable, checksummed CI client releases.
2. Pin the client version in `.merge4appstore.yml` or the wrapper.
3. Have the GitHub App open dependency-style update PRs in connected app
   repositories.
4. Verify the release checksum before execution.
5. Retain supported client releases long enough to roll back safely.

An initial implementation may vendor the client into each repository and use
automated update PRs. A signed downloadable artifact is preferable once the
release pipeline and key management are mature.

## Authentication and secret placement

### Credentials used by the current deployment

| Location | Credential | Purpose |
| --- | --- | --- |
| VPS `.env` | ASC key ID, issuer ID, and base64 `.p8` content | Build inspection, expiration, workflow recovery, submission, and release synchronization |
| VPS `.env` | `GH_TOKEN` | GitHub reads, comments, tags, and optional pushes through `gh` |
| VPS `.webhook.env` | GitHub webhook secret, Xcode webhook URL token, and one repository-scoped preparation token per app repository | Authenticate inbound events and post-clone preparation requests |
| Xcode Cloud shared environment | `MERGE4APPSTORE_URL` and the repository-scoped preparation token | Call the thin preparation endpoint; no ASC or GitHub credential is required |
| Deployment repository secrets | VPS host, user, SSH key, and server directory | Deploy the service, not customer automation |

Profiles contain identifiers and policy, not secrets.

### Product credentials

Customers should provide:

1. A GitHub App installation on selected repositories. Avoid customer personal
   access tokens.
2. An App Store Connect API key ID, issuer ID, and `.p8` private key. Current
   submission and TestFlight mutations require an appropriately privileged key;
   App Manager is the conservative supported role.
3. A one-time mapping of discovered Apple apps and workflows if discovery is
   ambiguous.

The provider owns hosting and deployment credentials. Customer ASC keys must be
envelope-encrypted with a managed key service, separated by tenant, excluded
from logs, rotatable, and revocable. Decrypted material should exist only in
the worker handling the authorized operation.

The GitHub App should request the smallest permissions for enabled modules:

- metadata, commits, branches, and pull requests: read;
- pull-request comments: write;
- tags/contents: write only when release synchronization is enabled;
- branch pushes: avoid; if retained, require a separate explicit permission and
  policy toggle.

Build tokens must be distinct from interactive/API sessions, scoped to one
installation and repository, short-lived or readily rotatable, and unable to
invoke release mutations.

## GitHub App implementation plan

The GitHub App is the next identity and onboarding boundary. It should replace
both the customer PAT and the deployment step that creates ordinary repository
webhooks. One installation supplies signed events and short-lived installation
tokens for only the repositories the customer selected.

### Registration and minimum permissions

Register separate development and production GitHub Apps so test callbacks and
secrets cannot affect production installations. Configure a setup URL for
onboarding, an optional user authorization callback only if user-level actions
become necessary, and the shared product webhook endpoint. Subscribe to:

- `installation` and `installation_repositories` for lifecycle and access
  changes;
- `pull_request` for build intent, note refresh, cleanup, and release-PR state;
- `push` for beta/production build intent and tag/branch reconciliation.

Request these repository permissions initially:

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read | Required by GitHub Apps and repository identity checks |
| Contents | Read by default; write when release sync is enabled | Commits, branches, comparisons, release-note ranges, and optional Git tag creation |
| Pull requests | Read and write | Read PR bodies/commits and post lifecycle comments |

GitHub does not offer separate read and write grants for one permission in the
same installation, so the product should publish a read-mostly base app and
decide whether release-tag creation justifies requesting `Contents: write` by
default. No Actions, Checks, Deployments, Administration, Members, Issues, or
Secrets permission is required for the baseline. A GitHub App receives its own
installation webhooks; it should not create a classic hook in every repository.

Avoid user OAuth at first. Installation tokens can perform every current
repository operation. Add user authorization only if the UI later needs to act
as a particular person or enumerate organizations before an installation is
selected.

### Authentication implementation

1. Store the App ID and private key as provider-owned deployment secrets.
2. Verify every webhook against the GitHub App webhook secret before parsing
   tenant-controlled fields.
3. Map `installation.id` plus repository node ID to one tenant/repository
   record; never select a tenant from a URL slug alone.
4. Mint a JWT for the GitHub App only long enough to request an installation
   token. Cache the installation token until shortly before expiry and refresh
   under a single-flight lock.
5. Replace `GitHubAPI`/`GitHubTags` shell calls with a typed HTTP client that
   always receives installation and repository scope explicitly.
6. Record the GitHub request ID, rate-limit headers, installation ID, repository
   ID, and operation result in the audit event without recording credentials.
7. On suspension, uninstall, or repository removal, reject new build tokens,
   cancel queued mutations for that scope, and retain only the configured audit
   history.

### Persistent data model

The first database schema should include:

- `tenants` and `github_installations`;
- `repositories` keyed by immutable GitHub repository ID, with owner/name as
  mutable display data;
- versioned `profiles` and module flags;
- encrypted `asc_credentials` and their validated provider/team metadata;
- hashed, rotatable `build_tokens` scoped to one repository;
- `webhook_deliveries` keyed by provider + installation/product + delivery ID;
- `build_intents` with the durable repository/provider/workflow/commit/purpose
  uniqueness constraint;
- `provider_runs` and immutable build-to-PR/workflow/app provenance;
- `jobs`, attempts, next-run time, terminal reason, and dead-letter state;
- `audit_events` describing policy version, input IDs, decision, mutation, and
  external response IDs.

Store accepted webhook delivery and its derived jobs in one transaction before
returning `202`. Workers should serialize mutations by repository while still
allowing safe reads in parallel. A PR close and base-branch push must both be
retained and run in order; neither may be converted into a successful no-op by
lock contention.

### Onboarding flow

1. User installs the GitHub App on selected repositories.
2. Setup callback creates or selects the tenant and displays only repositories
   present in that installation.
3. User uploads an ASC issuer ID, key ID, and `.p8`; the service encrypts it
   before persistence and performs read-only validation.
4. Discovery lists Apple apps, bundle IDs, Xcode Cloud products/workflows, and
   their supported manual start conditions.
5. User maps `prod`, optional `uat`/`internal`, branches, and the three build
   purposes. Each omitted purpose app defaults to `prod`.
6. Validation checks exact GitHub repository linkage, app/workflow ownership,
   workflow manual branch/PR support, webhook health, and required GitHub App
   permissions for the enabled modules.
7. The App opens a bootstrap PR containing the pinned thin adapter and a
   repository-scoped build token is added to Xcode Cloud by the user.
8. Shadow mode records the build that each GitHub event would start. Once the
   mapping is proven, onboarding instructs the user to remove native automatic
   Xcode triggers and enables managed mode.
9. A guided PR open/update/close test proves one build per commit, note refresh,
   and cleanup. A beta test proves the merge push. Production remains dry-run
   until explicitly enabled.

GitHub cannot configure Xcode Cloud secrets or all workflow/start-condition UI
through GitHub permissions. Those Apple steps remain a short guided checklist
unless future App Store Connect APIs expose safe complete management.

### Delivery slices and acceptance criteria

1. **App identity spike:** authenticate one development installation, list its
   selected repositories, read a PR/commit, and create/delete a test tag using
   installation tokens. Prove token refresh and uninstall handling.
2. **GitHub client migration:** implement a transport interface, contract-test
   it, replace all `gh` subprocess reads/comments/tags, and run current dry runs
   with PAT and App transports for comparison.
3. **Durable ingress and queue:** add the data model, transactional webhook
   acceptance, per-repository serialization, retries, dead-letter/replay, and
   durable delivery/build-intent uniqueness.
4. **Provenance capture:** on intent and Xcode `BUILD_CREATED`, persist the PR,
   source/target refs, exact commit, app, workflow, provider run, and uploaded
   build ID. Cleanup must succeed from stored provenance even after Apple drops
   source metadata, while still corroborating the build through ASC.
5. **Single-repository shadow migration:** install on JamsOnToast, receive App
   webhooks alongside the existing hook without mutating twice, compare every
   derived decision, then remove its classic hook and PAT access.
6. **Second-app and role test:** migrate Running Order and prove UAT PR cleanup
   plus production beta/submission isolation.
7. **Self-service onboarding:** add ASC discovery, profile editor, validation,
   bootstrap PR, health checks, credential rotation, and disconnect/delete.
8. **Pilot hardening:** per-tenant quotas, rate-limit/backoff behavior,
   observability, backups, incident procedures, billing, and several external
   indie repositories.

The GitHub App milestone is complete only when duplicate deliveries and
simultaneous close/push events survive worker restarts without a lost or
duplicated external mutation, revoking one installation affects no other
tenant, and the VPS no longer needs a customer PAT.

## Customer onboarding

The intended setup is:

1. Install the GitHub App and choose repositories.
2. Upload App Store Connect API credentials.
3. Discover accessible apps, bundle IDs, Xcode Cloud products, and workflows.
4. Assign apps to `prod`, `uat`, and `internal`; `prod` is the default when
   optional roles are absent.
5. Map pull-request, beta, and production workflows and select branches.
6. Choose whether `merge4appstore` owns build triggers. For managed Xcode Cloud
   triggering, validate manual branch/PR support and explicitly approve
   disabling overlapping native automatic start conditions.
7. Choose modules: build preparation, PR expiration, trigger recovery,
   submission, release synchronization, and release PR maintenance.
8. Run read-only credential and configuration checks.
9. Run an explainable dry run against recent builds.
10. Register and verify the GitHub App webhook, configure and test the Xcode
   Cloud product webhook, and create signed App Store Connect app webhooks where
   supported.
11. Open a bootstrap PR containing the thin CI adapter when build preparation is
   enabled.
12. Run managed triggers in shadow mode, proving that each GitHub event maps to
    the expected workflow and commit without starting it.
13. Disable overlapping native Xcode Cloud automatic triggers and enable the
    provider trigger only after the shadow comparison succeeds.
14. Enable remaining mutations only after webhook delivery and reconciliation validation
    succeed.

This can be low setup, but not zero setup. Customers must already have a valid
Apple Developer membership, app records, signing, schemes, repository access,
and working Xcode Cloud workflows.

## Runtime architecture required for a product

```text
GitHub webhooks ---------\
Xcode Cloud webhooks -----+-> event ingestion -> durable job queue -> workers
signed ASC webhooks -----/                            |              |
                                                       |              +-> GitHub App
                                                       |              +-> ASC API/store
                                                       |              +-> BuildProvider
Xcode CI client ---------------------------------------+
                                                       |
                                 tenant/profile DB <---+
                                 encrypted secret vault
                                 audit and decision log

Scheduled reconciler -> detects missed events and repairs drift
```

Required properties:

- durable idempotency for every external mutation;
- retry with bounded exponential backoff and provider-aware rate limiting;
- per-tenant concurrency and isolation;
- immutable audit events containing inputs, decisions, and external IDs, but no
  secrets;
- webhook-first execution plus periodic reconciliation;
- signature verification where providers support it, API corroboration where
  they do not, and durable delivery deduplication for every source;
- dry-run parity with live decision logic;
- approval gates for submission cancellation and App Store review submission;
- customer-visible health, errors, and remediation instructions;
- explicit feature flags and policy versions per installation.

The current synchronous `gh` subprocesses, cron entries, filesystem locks,
local logs, and optional local app checkout should be retired from the hosted
path. A self-hosted mode may retain simpler scheduling while sharing the same
provider clients and decision engine.

## Product scope and positioning

### Proposed wedge

`merge4appstore` should initially be positioned as an Xcode Cloud release
automation layer, not a replacement CI service:

> Keep Xcode Cloud for building and signing. Add safe, explainable automation
> for GitHub pull requests, TestFlight hygiene, App Store submission, and
> release synchronization.

The most distinctive initial capabilities are:

- workflow-scoped expiration of builds from closed PRs;
- protection of builds attached to App Store versions;
- missed-trigger recovery with duplicate-run prevention;
- different ASC apps for production, UAT, and internal roles;
- automatic build-to-PR-to-release traceability;
- minimal repository code and no Fastlane/Ruby runtime;
- centralized credentials rather than duplicated ASC/GitHub keys in Xcode
  Cloud.

### Non-goals for the first product release

- hosting macOS build workers;
- replacing Xcode Cloud build/test/archive;
- managing certificates and provisioning profiles;
- replacing Tuist or another project generator;
- App Store metadata and screenshot authoring;
- Android/Google Play parity;
- full release calendars, QA checklists, or product analytics;
- fully automatic Apple workflow/signing provisioning.

These boundaries keep the initial product smaller than comprehensive mobile
DevOps platforms and complementary to Apple's build service.

## Market comparison

Pricing below is public list pricing observed on 2026-08-26. Vendors can change
prices and several enterprise tiers require a quote.

| Product | Public price point | Relevant overlap | Difference from proposed offering |
| --- | --- | --- | --- |
| [Xcode Cloud](https://developer.apple.com/xcode-cloud/get-started/) | 25 compute hours/month included; 100 hours $49.99/month; 250 hours $99.99; 1,000 hours $399.99 | Native Apple build, test, signing, TestFlight, and App Store integration | It is the build plane we augment; it does not provide the GitHub/ASC release policy, explainable PR cleanup, or cross-app role control proposed here |
| [Runway](https://www.runway.team/pricing) | Basic is free for up to 2 apps and 4 read-write users; Team and Enterprise are contact-sales, priced per app | Closest commercial release-management competitor; release coordination, integrations, metrics, rollouts, and an explicit Xcode Cloud integration | Much broader collaborative release management; our proposed wedge is narrower, automation-first, Xcode Cloud-native, and focused on unattended lifecycle repair and TestFlight hygiene |
| [Tramline](https://tramline.app/pricing) | Hobby free for 2 apps/15 releases per app annually; Team $50/month/app; Enterprise starts at $600/month | Closest transparent-price competitor; mobile release trains, store automation, scheduling, synchronized releases, metrics, and open-source/self-hosting | More complete release-train product across mobile platforms; our opportunity is simpler Xcode Cloud onboarding, PR-build cleanup, trigger recovery, and a smaller price/operational footprint |
| [Bitrise](https://bitrise.io/pricing) | Release Management Standard is $250/app/month annually or $280 monthly; CI Starter is from $89/month annually or $99 monthly; enterprise custom | Full mobile CI plus release management, store submission, test distribution, and support for artifacts from another CI | Primarily a broad CI/mobile DevOps platform; using it alongside Xcode Cloud may duplicate build tooling. We should complement existing Xcode Cloud compute rather than sell compute |
| [Codemagic](https://codemagic.io/pricing/) | Individual includes 500 macOS M2 minutes/month; then $0.095/minute M2 or $0.114/minute M4; fixed plans start at $3,990/year | Hosted mobile CI/CD, signing and publishing with transparent compute pricing | Competes on build infrastructure and cross-platform pipelines, not the narrow Xcode Cloud lifecycle/reconciliation layer |
| [Appcircle](https://appcircle.io/pricing) | Starter free with 20 builds and 5 store publishes/month; Corporate pricing is tailored | Modular CI, signing, testing distribution, enterprise app store, and public-store publishing | Broader enterprise/mobile supply-chain platform. The proposed product is lighter and avoids migrating builds and signing away from Apple |
| [fastlane](https://docs.fastlane.tools/) | Open source with no license fee; teams pay infrastructure and maintenance costs | Mature CLI automation for versions, TestFlight, metadata, review submission, and build expiration | A toolkit rather than a managed control plane; our value must be onboarding, safe policy, reconciliation, hosted credentials, visibility, and reduced maintenance—not merely API calls |

Runway and Tramline show that mobile release orchestration is an established
category. Bitrise Release Management can also consume artifacts from another
CI, so “works with Xcode Cloud” alone is not defensible. The product must prove
that its Xcode Cloud-specific automation is materially easier and safer than a
general release dashboard or maintained Fastlane setup.

This scan found no major vendor publicly documenting automatic TestFlight build
expiration tied specifically to GitHub PR closure or merge. That is a promising
entry point, not a claim that no private or future implementation exists. Apple
documents [stopping TestFlight testing as a manual
operation](https://developer.apple.com/help/app-store-connect/test-a-beta-version/stop-testing-a-build).

## Pricing and infrastructure hypothesis to validate

The direct runtime cost is low because customer-owned Xcode Cloud performs the
macOS compute, signing, archive, and upload. The service handles small webhook
payloads, database rows, queue work, and comparatively light GitHub/ASC API
traffic. One modest application VPS plus managed database/queue can serve many
indie repositories initially; scale should be based on queued job latency and
provider calls, not one VPS per repository.

The expensive parts are engineering and support: securely holding ASC private
keys, backups and audit history, debugging Apple state transitions, customer
onboarding, and responding to provider changes. Payment fees and support can
also dominate a $10 annual invoice. Therefore `$10/year/repository` is viable
as a founding or hobby acquisition tier with fair use and limited support, but
is unlikely to fund the complete hosted product by itself.

The product should allow unlimited releases on paid indie tiers. We do not pay
the build-minute cost, so an artificial annual release count would reproduce
the main weakness of Tramline's hobby plan without protecting a meaningful
cost. Apply fair-use limits to webhook/API abuse, retained audit history, and
concurrency instead of charging per release.

A launch structure to test, intentionally below full release-management
platforms, is:

| Tier | Hypothesis | Intended user |
| --- | --- | --- |
| Self-hosted | Free/open core | Developers willing to operate credentials and infrastructure |
| Founding Indie | $10/year/repository, unlimited releases, fair use, short history, community support | Early solo developers validating onboarding and reliability |
| Indie | $29-49/year/repository, unlimited releases and longer history | Sustainable default for maintained hosted automation |
| Team | $99-199/year including several repositories, then a clear per-repo overage | Teams needing approvals, audit history, alerts, and shared policies |
| Self-hosted/Enterprise | Annual or contact-sales | Organizations requiring their own infrastructure, SSO, retention, and support |

Charge for a logical product/repository or its release automation, not build
minutes or each ASC app record: Apple already charges for Xcode Cloud compute,
and customers should not pay three times because one product uses separate
`prod`, `uat`, and `internal` apps. A clear ceiling and limits are important
because the nearest transparent competitor, Tramline, charges $50/month/app for
its Team tier while offering a broader release-management surface.

### Provider rate limits

Rate limits do not prevent this model if events are webhook-first and state is
cached. GitHub App installation tokens have a documented minimum REST budget of
5,000 requests per hour per installation, scaling for larger non-Enterprise
installations up to 12,500; Enterprise Cloud installations receive 15,000.
GitHub can also enforce secondary limits, so workers must respect
`x-ratelimit-*` and `retry-after`, use conditional requests, and avoid polling.
See [GitHub's current REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

App Store Connect reports the actual rolling-hour budget for the API key in
every `X-Rate-Limit` header; Apple's example is 3,500 requests/hour but the
documentation explicitly says actual limits vary. A `429 RATE_LIMIT_EXCEEDED`
must reschedule rather than spin. See [Apple's App Store Connect rate-limit
documentation](https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits).
Because the Apple budget is shared by calls using the same customer key, keep a
per-credential budget, coalesce build/version reads, cache immutable provider
objects, and reserve capacity for production submission over low-priority
reconciliation. This favors customer-owned ASC credentials and webhooks; it
does not require dedicated infrastructure per repository.

## Delivery phases

### Phase 0: consolidate the current system (baseline complete)

- Completed: merge and deploy role-based profiles for both repositories.
- Completed: make every Xcode workflow manually startable and route PR events
  only when the target is the configured beta branch.
- Completed: remove ASC/GitHub policy credentials from app-side preparation;
  Xcode keeps only the URL and scoped build token.
- Completed: document current credential ownership and behavior in the README.
- Completed: disable `IOS_REPO_PATH` for Jams and scope all optional behavior so
  one profile cannot
  inherit another app's checkout.
- Completed: validate profiles and run production submission/reconciliation dry
  runs without changing those established modules.
- Completed stabilization: serialize webhook jobs per repository, wait on
  cross-process locks, and safely recover source-less PR ownership from one
  exact commit association.
- Remaining stabilization: persist accepted jobs and build provenance across
  process restarts before treating the baseline as a multi-tenant service.

Exit criteria:

- both existing apps deploy, synchronize, recover, and expire through profiles;
- cleanup cannot inspect or expire a build outside its configured PR workflow;
- no app silently inherits another app's repository path or optional behavior.

### Phase 1: shared CI kit (policy centralized, client packaging remaining)

- Completed: centralize purpose inference, version resolution, note generation,
  app-role routing, and request validation in the service.
- Leave only Tuist/project preparation and Apple's required wrapper in app
  repositories.
- Extract the two remaining HTTP/apply adapters into one versioned CI client.
- Vendor and pin the first client release in both repositories.
- Add contract tests using captured Xcode Cloud environment combinations,
  including delayed Apple PR/source discovery and service-unavailable behavior.
- Let the bot open client-update PRs.

Exit criteria:

- JamsOnToast and Running Order use the same CI policy implementation;
- UAT/internal differences are profile data rather than divergent shell code;
- a client upgrade can be reviewed and rolled back independently.

### Phase 2: central build preparation and GitHub App (partially implemented)

- Implement GitHub App installation authentication and replace `gh` calls.
- Implemented baseline: signed GitHub webhook ingestion; remaining: durable delivery deduplication,
  and jobs for PR, push, installation, and permission events.
- Implemented baseline: token-protected Xcode completion ingestion; remaining:
  build-created, build-started, and
  build-completed events; corroborate every actionable event through ASC API.
- Implemented baseline: provider-neutral `BuildIntent` and Xcode provider;
  remaining: persist `BuildEvent` and provider contracts rather than process-local results.
- Continue to evolve the `BuildProvider`
  contracts and implement the Xcode Cloud provider using the customer's ASC
  credential.
- Implemented baseline: managed GitHub-webhook triggers for manual Xcode Cloud
  branch and PR workflows, shadow mode, and provider lookup before start;
  remaining: durable duplicate prevention and queued transient retries.
- Register signed App Store Connect app webhooks for build, beta, and version
  state changes.
- Implemented baseline: repository-scoped build preparation endpoint returning
  non-secret inputs; remaining: durable request idempotency.
- Implemented for current apps: ASC/GitHub credentials are centralized and no
  longer required for preparation in Xcode Cloud; remaining: encrypted
  per-tenant storage.
- Move release PR maintenance into GitHub webhooks.
- Replace local-checkout tag/branch mutations with GitHub API operations.

Exit criteria:

- Xcode Cloud holds only a scoped product build token;
- normal build and PR lifecycle automation is webhook-driven rather than
  dependent on the five-minute cron;
- Xcode Cloud native Git triggers can be disabled without losing push or PR
  builds, and one GitHub event cannot create duplicate provider runs;
- release policy has no dependency on raw Xcode Cloud response objects;
- duplicate GitHub, Xcode Cloud, or ASC deliveries cannot repeat a mutation;
- an Xcode Cloud payload not corroborated through ASC cannot submit or expire a
  build;
- no hosted operation depends on a persistent app checkout;
- revoking a GitHub installation or ASC credential stops only that tenant.

### Phase 3: hosted multi-tenant control plane

- Add tenant/profile storage, encrypted secrets, job queue, worker isolation,
  reconciliation, provider-aware rate limiting, and audit history.
- Build discovery and guided onboarding.
- Add approval policies and a customer operations dashboard.
- Add alerts and actionable remediation.
- Establish backup, retention, rotation, incident, and deletion procedures.

Exit criteria:

- a new customer can onboard without server access or manually editing service
  configuration;
- every mutation has an idempotency record and customer-visible audit event;
- failure of one tenant cannot block or expose another tenant;
- periodic reconciliation repairs missed webhook delivery.

### Phase 4: validate and expand the product

- Pilot with several repositories outside the two original apps.
- Measure setup time, avoided manual actions, erroneous-expiration rate, missed
  trigger recovery, submission success, and support burden.
- Validate willingness to pay against a maintained Fastlane setup, Tramline,
  and Runway.
- Consider Android, metadata, rollout health, and richer release coordination
  only after the Xcode Cloud wedge has repeat usage.

## Product success measures

- median time from GitHub App installation to successful dry run;
- percentage of customers that remove ASC/GitHub credentials from Xcode Cloud;
- percentage of eligible merged-PR builds safely expired;
- false-positive expiration count, with a target of zero;
- missed Xcode workflow triggers recovered without duplicate runs;
- median time from production merge to review submission;
- percentage of releases correctly linked to PR, build, App Store version, and
  Git tag;
- manual interventions per release;
- secret rotation completion and revoked-credential containment;
- monthly active managed apps and retained paid apps.

## Key risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Apple API gaps or behavior changes | Keep provider adapters isolated, reconcile state, version policies, and fail safely when provenance is incomplete |
| Incorrect build expiration | Require exact app and PR workflow, protect App Store-selected builds and permanent branches, expose dry-run reasons, and preserve zero-ambiguity rules |
| Duplicate submissions or workflow runs | Use external identifiers, durable idempotency, state preconditions, and reconciliation before mutation |
| Central service outage blocks builds | Keep a controlled repository-version fallback and make submission ineligible until reconciliation; publish client/service compatibility windows |
| CI client compromise | Immutable releases, checksums/signatures, pinned versions, update PRs, and restricted build tokens |
| ASC key compromise | Managed encryption, per-tenant access controls, log redaction, short decrypt lifetime, rotation, revocation, and audit alerts |
| Scope expands into full CI/release management | Maintain the initial Xcode Cloud lifecycle wedge and phase-gate broader roadmap items using customer evidence |
| Competitors add similar cleanup/recovery | Differentiate on Apple-specific correctness, explainable policy, minimal setup, and open/self-hostable components where valuable |

## Product decisions still required

1. Hosted SaaS, self-hosted product, or a shared core supporting both.
2. Whether build preparation may fall back when the service is unavailable.
3. Whether beta triggering by empty commit remains a supported behavior.
4. Whether profiles remain Git-tracked, become database records, or use Git as
   an optional configuration source.
5. Which submission and cancellation operations require explicit approval.
6. Confirm indie developers as the first commercial target and decide whether
   `$10/year/repository` is a founding tier or a permanent constrained tier.
7. Whether the CI client is vendored first or downloaded as a signed artifact.
8. Required audit retention and regional/security expectations for ASC keys.

## Immediate next work

1. Preserve the verified PR #21 baseline while adding durable ingress: accepted
   webhook deliveries and derived jobs must commit before `202`, retain the
   existing per-repository ordering, and resume after process restart. Keep the
   concurrent PR-close/merge-push replay as an acceptance test.
2. Persist build provenance at intent creation and `BUILD_CREATED`, then test
   cleanup after the Apple source branch disappears. Never weaken the existing
   fail-safe cleanup rule to infer from build number alone.
3. Register a private development GitHub App with the permissions and events in
   the GitHub App section. Implement JWT signing, installation-token caching,
   webhook verification, installation lifecycle handling, and typed PR/commit/
   comment/tag operations behind a transport interface.
4. Add Postgres-backed tenants, installations, repositories, delivery records,
   build intents/runs, jobs, encrypted ASC credential metadata, and audit
   events. The webhook transaction must commit the delivery and jobs before
   returning `202`.
5. Run the GitHub App in shadow mode on JamsOnToast next to the existing classic
   hook/PAT, compare decisions, then cut over without changing Xcode workflow or
   App Store submission logic. Repeat with Running Order to exercise split UAT
   and production roles.
6. Package and pin the shared CI client, migrate both app adapters, document
   rollback/service-unavailable behavior, and have the App create update PRs.
7. Replace five-minute full polling with overdue-state reconciliation every
   30–60 minutes after durable webhook operation is proven. Keep an explicit
   manual reconcile command and customer-visible reason for every repair.
8. Exercise a production submission dry run from stored intent through draft
   reuse, rejection reconciliation, version selection, release sync, and tag
   creation using the GitHub App transport. Use the next real release as the
   supervised live acceptance test with rollback/runbook ready.
9. Add declarative per-deployment App Store release policy (`manual`,
   `after_approval`, or `scheduled` plus date), default conservatively, validate
   it during onboarding, and set/verify `releaseType` before submission.
10. Build the minimum onboarding path: install App, upload/validate ASC key,
   discover apps/workflows, map roles/purposes, validate manual start
   conditions, open adapter PR, run shadow test, and enable modules.
11. Interview five Xcode Cloud indie developers and offer the `$10/year`
   founding tier to measure successful setup, retained use, support minutes,
   and willingness to pay before fixing long-term pricing.
12. Test positioning against Runway and Tramline users: the question is not
   whether automation is possible, but whether this narrower Xcode Cloud-native
   workflow is easier, safer, and cheaper enough to switch or supplement their
   current process.
