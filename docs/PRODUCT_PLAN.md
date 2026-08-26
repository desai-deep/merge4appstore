# Product and Xcode Cloud CI ownership plan

Status: proposal  
Last reviewed: 2026-08-26  
Depends on: repository app-role profiles introduced by PR #19

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

The existing code is a useful single-tenant implementation of the core release
algorithms. Productizing it requires durable jobs, tenant isolation, an
encrypted credential store, GitHub App authentication, onboarding and
discovery, webhook ingestion, observability, and removal of local repository
checkout dependencies.

## Current responsibility boundaries

| Owner | Current responsibility |
| --- | --- |
| App repository | Version lookup and mutation, TestFlight notes, Tuist installation/project generation, and the `develop` to `main` release PR workflow |
| Xcode Cloud | Repository checkout, workflow triggers, build/test/archive, signing, upload, TestFlight distribution, and workflow environment secrets |
| `merge4appstore` | Production submission, live-release synchronization and tagging, closed-PR build expiration, missed-trigger recovery, and GitHub comments |
| Repository profile | Branches, app roles, App Store Connect identifiers, Xcode Cloud workflow identifiers, and operation routing |
| VPS | Runtime credentials, cron scheduling, locks, logs, and the persistent checkout used by optional beta-branch synchronization |

PR #19 makes operation routing declarative and gives `prod`, `uat`, and
`internal` consistent meanings. It does not yet remove duplicated CI logic or
the operational coupling to one VPS.

## Current cross-dependencies to remove

1. The two app repositories contain similar but divergent version and
   TestFlight-note scripts.
2. Xcode Cloud holds App Store Connect credentials so build scripts can resolve
   the marketing version.
3. Xcode Cloud may also hold a GitHub token for PR-title lookup.
4. The same App Store Connect credential is duplicated between Xcode Cloud and
   the VPS.
5. Xcode Cloud workflow IDs and trigger rules are configured manually and can
   drift from the tracked profile.
6. GitHub operations shell out to `gh` using a long-lived token.
7. Release synchronization can use `IOS_REPO_PATH` to mutate and push from a
   persistent local checkout.
8. Each profile is polled every five minutes and coordinated using filesystem
   locks rather than durable jobs and idempotency records.
9. Logs are local files without customer-visible history, alerting, or an audit
   model.
10. Release behavior assumes specific branches, one release PR, English notes,
    and an opinionated App Store submission policy.

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
- workflow start conditions and actions;
- Xcode build, test, archive, and analysis;
- signing, entitlements, and distribution groups;
- upload to App Store Connect and TestFlight;
- execution of the thin in-repository entrypoint.

The product may discover, validate, monitor, and start workflows where App
Store Connect APIs permit it. It should not claim to provision all Apple
signing and workflow configuration.

### `merge4appstore`: release control plane

The service should own:

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
| Xcode Cloud shared environment | ASC key ID, issuer ID, and `.p8` content | Marketing-version lookup from app-side scripts |
| Xcode Cloud shared environment | `GITHUB_TOKEN`/`GH_TOKEN` | PR metadata fallback for TestFlight notes |
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

## Customer onboarding

The intended setup is:

1. Install the GitHub App and choose repositories.
2. Upload App Store Connect API credentials.
3. Discover accessible apps, bundle IDs, Xcode Cloud products, and workflows.
4. Assign apps to `prod`, `uat`, and `internal`; `prod` is the default when
   optional roles are absent.
5. Map pull-request, beta, and production workflows and select branches.
6. Choose modules: build preparation, PR expiration, trigger recovery,
   submission, release synchronization, and release PR maintenance.
7. Run read-only credential and configuration checks.
8. Run an explainable dry run against recent builds.
9. Open a bootstrap PR containing the thin CI adapter when build preparation is
   enabled.
10. Enable mutations only after validation succeeds.

This can be low setup, but not zero setup. Customers must already have a valid
Apple Developer membership, app records, signing, schemes, repository access,
and working Xcode Cloud workflows.

## Runtime architecture required for a product

```text
GitHub webhooks ----\
                     -> API / event ingestion -> durable job queue -> workers
ASC/Xcode events ---/                              |              |
                                                   |              +-> GitHub App
Xcode CI client -----------------------------------+              +-> ASC API
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

## Pricing hypothesis to validate

Do not finalize pricing before interviewing users and measuring release volume.
A plausible initial structure, intentionally below full release-management
platforms, is:

| Tier | Hypothesis | Intended user |
| --- | --- | --- |
| Hobby | Free for 1 app, limited monthly releases, dry runs and PR cleanup | Solo developer validating the integration |
| Indie | $12-20/app/month | Small apps wanting unattended cleanup, recovery, and submission |
| Team | $49-79/month including several apps, then per-app overage | Teams needing approvals, audit history, alerts, and shared policies |
| Self-hosted/Enterprise | Annual or contact-sales | Organizations requiring their own infrastructure, SSO, retention, and support |

Charge for a logical product/repository or its release automation, not build
minutes or each ASC app record: Apple already charges for Xcode Cloud compute,
and customers should not pay three times because one product uses separate
`prod`, `uat`, and `internal` apps. A clear ceiling and limits are important
because the nearest transparent competitor, Tramline, charges $50/month/app for
its Team tier while offering a broader release-management surface.

## Delivery phases

### Phase 0: consolidate the current system

- Merge and deploy the role-based profiles.
- Restrict each PR workflow to the intended target branch.
- Remove confirmed-unused repository secrets.
- Document current credential ownership and rotation.
- Disable or explicitly configure `IOS_REPO_PATH` per profile so one app cannot
  inherit another app's checkout.
- Add structured decision output to all dry runs.

Exit criteria:

- both existing apps deploy, synchronize, recover, and expire through profiles;
- cleanup cannot inspect or expire a build outside its configured PR workflow;
- no app silently inherits another app's repository path or optional behavior.

### Phase 1: shared CI kit

- Extract environment classification, version resolution, note generation, and
  diagnostics into a versioned client.
- Leave only Tuist/project preparation and Apple's required wrapper in app
  repositories.
- Vendor and pin the first client release.
- Add contract tests using captured Xcode Cloud environment combinations.
- Let the bot open client-update PRs.

Exit criteria:

- JamsOnToast and Running Order use the same CI policy implementation;
- UAT/internal differences are profile data rather than divergent shell code;
- a client upgrade can be reviewed and rolled back independently.

### Phase 2: central build preparation and GitHub App

- Implement GitHub App installation authentication and replace `gh` calls.
- Add the repository-scoped build preparation endpoint and idempotency.
- Store ASC credentials centrally and return only non-secret build inputs.
- Remove ASC and GitHub credentials from Xcode Cloud after migration.
- Move release PR maintenance into GitHub webhooks.
- Replace local-checkout tag/branch mutations with GitHub API operations.

Exit criteria:

- Xcode Cloud holds only a scoped product build token;
- no hosted operation depends on a persistent app checkout;
- revoking a GitHub installation or ASC credential stops only that tenant.

### Phase 3: hosted multi-tenant control plane

- Add tenant/profile storage, encrypted secrets, job queue, worker isolation,
  webhooks, reconciliation, rate limiting, and audit history.
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

## Decisions required before implementation

1. Hosted SaaS, self-hosted product, or a shared core supporting both.
2. Whether build preparation may fall back when the service is unavailable.
3. Whether beta triggering by empty commit remains a supported behavior.
4. Whether profiles remain Git-tracked, become database records, or use Git as
   an optional configuration source.
5. Which submission and cancellation operations require explicit approval.
6. Whether the first commercial target is indie developers or mobile teams.
7. Whether the CI client is vendored first or downloaded as a signed artifact.
8. Required audit retention and regional/security expectations for ASC keys.

## Immediate next work

1. Complete Phase 0 and verify both existing apps end to end.
2. Specify a JSON schema for the build preparation request and response.
3. Extract a pure, tested environment-classification module from the two app
   script variants.
4. Prototype a vendored CI client and migrate one app before centralizing
   credentials.
5. Prototype GitHub App permissions and installation-token operations.
6. Interview five Xcode Cloud users before committing to hosted architecture or
   pricing.
7. Test the positioning against Runway and Tramline users: the question is not
   whether automation is possible, but whether this narrower Xcode Cloud-native
   workflow is easier, safer, and cheaper enough to switch or supplement their
   current process.
