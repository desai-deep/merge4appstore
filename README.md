# merge4appstore

Automated iOS build and release orchestration around GitHub, Xcode Cloud,
TestFlight, and App Store Connect. It starts the correct Xcode Cloud workflow,
prepares versions and TestFlight notes centrally, removes obsolete PR builds,
submits production builds for review, and tags releases when they go live.

See the [product and Xcode Cloud CI ownership plan](docs/PRODUCT_PLAN.md) for the
path from the current two-repository deployment to a reusable service.

## Current production status

The webhook-managed baseline from PR #19 is deployed for JamsOnToast and
Running Order. It has been exercised with real PR open, synchronize, close, and
merge events and real Xcode Cloud archives. Xcode Cloud workflows use manual
start conditions, so GitHub is the only source of build intent and a push to a
PR branch does not independently create a second build.

The current deployment is still a single-tenant VPS service. Webhook delivery
deduplication is in memory, jobs are child processes serialized per repository
and protected across processes by waiting filesystem locks, credentials are
shared runtime secrets, and cron remains a five-minute reconciliation fallback.
These are operational limitations, not the target hosted architecture; see the
product plan for the migration sequence.

## What it does

1. **Deploy Check** - Monitors TestFlight for new builds from specific Xcode Cloud workflows, automatically submits them to App Store review, extracts release notes from merged GitHub PRs, and comments on PRs when builds are submitted or cancelled.

2. **Release Sync** - Monitors App Store Connect for builds that went live (READY_FOR_SALE), creates git tags (e.g., `v1.4-1400`) for released versions, and comments on PRs when builds are released.

3. **Closed PR Cleanup** - Expires TestFlight builds from feature branches after their PR is merged or closed against the configured beta branch. Builds from the beta or production branch and builds selected for an App Store version are always protected.

4. **Missed Trigger Recovery** - Optionally starts the configured production Xcode Cloud workflow when a merged production PR has no build run. Active and completed runs are detected first so the five-minute cron cannot create duplicates.

5. **Managed Build Triggering** - Converts a provider-neutral build intent into
   an Xcode Cloud build, reusing an existing run for the same workflow and
   commit and refusing to duplicate an active run whose commit metadata is not
   available yet.

## Features

- Direct App Store Connect API calls (no Fastlane/Ruby dependency)
- 10x faster than Fastlane-based solutions (~8s vs ~60s)
- Repository profiles can route deploy, sync, and cleanup to different App Store Connect apps
- Standard `prod`, `uat`, and `internal` app roles, with `prod` as the default
- Single combined script for both operations

## Responsibility boundaries

| Owner | What it owns now |
| --- | --- |
| App repository | Apple's required `ci_scripts/ci_post_clone.sh`, reading and applying the current marketing version, writing returned TestFlight notes, and project-specific setup such as installing Tuist and generating the Xcode project |
| Repository profile in this repo | GitHub branches, logical app roles, App Store Connect app IDs, workflow IDs, build-purpose routing, cleanup policy, and note-generation switches |
| `merge4appstore` | GitHub/Xcode webhook handling, managed build starts, version policy, note generation, PR-build cleanup, production submission, rejected-version handling, release synchronization, Git tags, and GitHub comments |
| Xcode Cloud | Checkout, build/test/archive, signing, upload, and TestFlight distribution; workflows are manually startable and do not react directly to Git pushes or PRs |
| VPS | The webhook process, runtime secrets, HTTPS proxy, five-minute reconciliation cron, locks, and logs |
| GitHub Actions in this repo | Tests/profile validation on PRs and deployment of `main` to the VPS |

Tuist is not assumed by the control plane. It is only a project-preparation
detail in the two current app repositories. A repository may instead use a
committed Xcode project, XcodeGen, Swift Package Manager, or another adapter.

## Event flow

```
GitHub push / PR event
        |
        v
signed webhook -> profile -> build intent -> Xcode Cloud manual workflow
                                      |                 |
                                      |                 v
                                      |        post-clone preparation API
                                      |                 |
                                      |                 v
                                      +---------- TestFlight build
                                                        |
Xcode Cloud completion webhook -------------------------+
                                                        v
                               submission / cleanup / release sync
                                                        |
                                                        v
                                       GitHub comment and release tag
```

GitHub event routing is deliberately narrow:

| Event | Action |
| --- | --- |
| PR opened, reopened, or synchronized against `beta_branch` | Start or reuse one `pull_request` workflow for the PR head commit |
| Push to `beta_branch` | Start or reuse one `beta` workflow |
| Push to `production_branch` | Start or reuse one `production` workflow |
| PR body edited | Refresh notes on active uploaded builds for that PR commit without rebuilding |
| PR closed or merged | Run workflow-scoped TestFlight expiry |
| Successful configured production Xcode workflow | Evaluate App Store submission |

The uniqueness decision is repository + provider + workflow + commit + purpose.
The trigger path also queries Xcode Cloud before starting a run. This prevents
GitHub delivery retries and simultaneous PR/push event shapes from starting the
same workflow twice. A new commit on an open PR does create a new PR build; a
plain push event for that PR branch does not.

### Current app routing

| Repository | PR builds / cleanup | Beta builds | Production builds / submission / sync |
| --- | --- | --- | --- |
| JamsOnToast | `prod` app, PR workflow | `prod` app, beta workflow | `prod` app, production workflow |
| Running Order | `uat` app, PR workflow | `prod` app, beta workflow | `prod` app, production workflow |

An omitted app selection means `prod`. `internal` is supported exactly like
`uat`; every build purpose and every automation may override its app independently.

## Setup

### 1. Install

```bash
git clone https://github.com/desai-deep/merge4appstore.git
cd merge4appstore
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and add the shared App Store Connect and GitHub credentials:

```bash
cp .env.example .env
```

Then select one of the tracked repository profiles:

```bash
node index.js --profile profiles/runningorder.yml
node index.js --profile profiles/jamsontoast.yml
```

When a profile is supplied, `.env` is optional if the required shared
credentials are already injected into the process environment, as they are in
GitHub Actions or another secret-aware runner.

Each repository profile has a required `prod` app and may add `uat` and
`internal` apps. Every automation can select an app role; omitted selections
default to `prod`. This keeps the common single-app case terse while allowing a
repository such as Running Order to deploy from its production app and clean up
PR builds from its separate UAT app.

Cleanup must name an exact workflow. That prevents a cleanup job from expiring
beta or production builds when one App Store Connect app serves several roles.

```yaml
version: 1
instance: example-ios

repository:
  owner: example
  name: example-ios
  production_branch: main
  beta_branch: develop

apps:
  prod:
    app_id: "123456789"
    bundle_id: com.example.app
    name: Example
    workflows:
      pull_requests: PR-WORKFLOW-ID
      production: PROD-WORKFLOW-ID

  internal: # optional; `uat` is also supported
    app_id: "987654321"
    bundle_id: com.example.app.internal
    name: Example Internal
    workflows:
      pull_requests: INTERNAL-PR-WORKFLOW-ID

automation:
  deploy:
    workflow: production # app defaults to prod
  sync: true             # boolean shorthand, also defaults to prod
  expire:
    app: internal
    workflow: pull_requests

build:
  provider: xcode_cloud
  trigger_mode: managed # opt in to webhook-managed starts; default is native
  purposes:
    pull_request:
      app: internal
      workflow: pull_requests
      trigger_mode: managed # requires Xcode Cloud's Manual Start PR option
      include_commits: true  # default for pull-request builds
    beta:
      workflow: beta
      include_commits: false # default for beta and production builds
    production:
      workflow: production
```

An automation may also set `app_id`, `bundle_id`, or `app_name` directly as an
override. Prefer app roles when several values travel together.

### 3. Run

```bash
# Run both operations (deploy + sync)
node index.js

# Run only deployment check
node index.js deploy

# Run only release sync
node index.js sync

# Expire TestFlight builds from branches merged to the beta branch
node index.js expire

# Start or reuse a configured build for an immutable GitHub event intent
BUILD_PURPOSE=pull_request \
BUILD_BRANCH=feature/example \
BUILD_COMMIT_SHA=abcdef1234567890 \
BUILD_SOURCE_DELIVERY_ID=github-delivery-id \
node index.js trigger --profile profiles/runningorder.yml

# Run one repository profile
node index.js --profile profiles/jamsontoast.yml
node index.js deploy --profile profiles/jamsontoast.yml

# Dry run modes
DRY_RUN=true node index.js
DRY_RUN=true node index.js deploy
DRY_RUN=true node index.js sync
DRY_RUN=true node index.js expire
```

Set `BUILD_WAIT_FOR_COMPLETION=true` for a credentialed smoke test that should
remain active until the provider reports success or failure.

Or use npm scripts:

```bash
npm start              # Run both
npm run deploy         # Deploy only
npm run sync           # Sync only
npm run start:dry      # Dry run both
npm run deploy:dry     # Dry run deploy
npm run sync:dry       # Dry run sync
npm run expire         # Expire merged feature-branch builds
npm run expire:dry     # Preview merged feature-branch expiry
npm run trigger        # Start/reuse the configured build purpose
npm run trigger:dry    # Resolve a build intent without starting it
```

The webhook listener calls the same provider-neutral trigger path as the CLI.
Use `shadow` while comparing webhook intents with native triggers, and
`managed` after all native automatic triggers have been removed.

Xcode Cloud is a special case for pull-request builds. Apple rejects API-started
PR builds when the workflow is deactivated or its enabled start conditions do
not allow that PR. For fully managed operation, replace the automatic **Pull
Request Changes** condition with **Manual Start**, enable its **Pull Request**
option, and select the allowed source and target branches. This keeps the
workflow API-startable without Apple also reacting directly to Git events.
Branch-based beta and production workflows use **Manual Start - Branch**.
Pull-request workflows use **Manual Start - Branch, Pull Request**.

### 4. Schedule (cron)

```bash
# Run every repository every 5 minutes
*/5 * * * * cd /path/to/merge4appstore && node index.js --profile profiles/runningorder.yml >> logs/cron.log 2>&1
*/5 * * * * cd /path/to/merge4appstore && node index.js --profile profiles/jamsontoast.yml >> logs/cron.log 2>&1
```

Cron is the reconciliation fallback. The primary event path is `npm run
webhooks`, exposed behind HTTPS:

- `POST /webhooks/github/:instance` verifies GitHub's raw-body HMAC SHA-256
  signature and handles PR open/update/close plus beta and production pushes.
- `POST /webhooks/xcode-cloud/:instance/:token` accepts Xcode Cloud build
  lifecycle events. Because Apple doesn't document a signing header for these
  events, use a high-entropy URL token and never store it in profile YAML.
- `GET /health` reports the configured instances without exposing secrets.

Each profile can select environment variable names without containing values:

```yaml
webhooks:
  github:
    secret_env: GH_WEBHOOK_SECRET
  xcode_cloud:
    token_env: XCODE_CLOUD_WEBHOOK_TOKEN
```

The VPS deployment starts the listener with PM2, creates or updates the signed
GitHub hooks, and proxies it at `https://api.runningorder.app/merge4appstore/`.
Normal deployment enables the fallback cron; a manual deployment can set
`pause_cron: true` for an isolated webhook test.

### Thin Xcode Cloud preparation

App repositories no longer need App Store Connect or GitHub credentials in
Xcode Cloud. Their post-clone hook sends build context and the committed
marketing version to:

```http
POST /v1/builds/prepare/:instance
Authorization: Bearer <repository-scoped token>
```

The app client sends repository, commit, branch, and pull-request context. The
service infers the build purpose from the repository profile, verifies that
context and any optional purpose or workflow supplied by older clients, and
returns the centrally selected marketing version, app role, and TestFlight
notes as a versioned, provider-neutral response:

```json
{
  "schema_version": 1,
  "role": "internal",
  "purpose": "pull_request",
  "marketing_version": "1.5",
  "testflight_notes": "Verify playback controls\n\n• Fix lock-screen state",
  "warnings": []
}
```

The checked-out repository owns adapters that read its current marketing
version and consume this response. That adapter may update an Xcode project,
an xcconfig, a Tuist definition, or another project format; merge4appstore does
not assume a project-generation tool. It should validate `schema_version` and
`marketing_version` before applying the non-secret values, then run whatever
project preparation command the app needs. The only
Xcode Cloud secrets/configuration required for this adapter are:

- `MERGE4APPSTORE_BUILD_TOKEN`: repository-scoped preparation credential;
- `MERGE4APPSTORE_URL`: HTTPS service base URL.

Profiles select the runtime secret name without storing its value:

```yaml
ci:
  prepare:
    token_env: MERGE4APPSTORE_BUILD_TOKEN_MY_REPOSITORY
```

For pull-request builds, TestFlight notes contain the current PR body followed
by every commit since the newest uploaded build from the same workflow whose
commit is an ancestor of the current head. The first build of a PR falls back
to all commits in that PR. `build.purposes.<purpose>.include_commits` overrides
the default: `true` for `pull_request`, `false` for `beta` and `production`.
When a PR body is edited, the signed GitHub webhook refreshes the English
TestFlight localization for every active uploaded build of that PR commit; no
rebuild is required.

### Marketing-version policy

The app adapter reports its committed marketing version. The preparation
service validates that value and compares it with App Store Connect for the app
role selected by the build purpose:

- PR and beta builds consider active and live App Store versions;
- production builds use the latest live version as the reference;
- if the repository version is already newer, it is preserved;
- otherwise the service selects the next minor version.

The service returns the result; the app repository remains responsible for
applying it to its own project format. No Tuist-specific parsing exists in
`merge4appstore`.

## App Store release lifecycle

Production processing remains the established `deploy` and `sync` path:

1. A production workflow build is matched to its exact app and workflow.
2. The corresponding App Store version is found or created, the build is
   selected, notes are derived from the merged release PR, and review submission
   is created or resumed.
3. Existing empty review drafts are reused. Rejected versions and unresolved
   review issues are reconciled so a later build can continue without creating
   duplicate submissions.
4. `sync` watches for `READY_FOR_SALE`, creates the release tag (for example
   `v1.4-1400`), and updates the corresponding GitHub PR.

Builds selected for any App Store version, builds from permanent branches, and
builds whose provenance is ambiguous are never expired automatically.

## Known operational limitations

- The webhook server acknowledges after in-memory deduplication, then launches
  child jobs. Delivery state and jobs do not survive a process restart.
- Jobs are serialized per repository inside the webhook process. CLI, cron,
  and webhook processes also wait for the repository filesystem lock rather
  than treating contention as successful completion. This prevents the
  observed simultaneous PR-close/base-push loss, but it is not a durable queue:
  accepted work can still be lost if the process restarts.
- Apple can stop returning a source branch for an uploaded PR build after the
  PR is merged. Cleanup can now use the exact source commit only when it maps to
  one closed PR targeting the configured beta branch and the build came from
  the configured PR workflow. Ambiguous matches still fail safe. The hosted
  design should persist build-to-PR provenance when `BUILD_CREATED` arrives so
  later expiry does not depend on mutable provider metadata or extra API calls.
- The deployment uses one shared GitHub token and ASC credential set. It is not
  tenant-isolated and should not be offered as hosted SaaS in this form.
- Xcode Cloud completion payloads are treated as notifications and actionable
  state is re-read through App Store Connect. The Xcode URL token is an endpoint
  secret, not equivalent to a signed provider payload.
- App Store version release policy is not yet a profile field. The supervised
  Jams 1.2 release was explicitly set to `AFTER_APPROVAL` through ASC before
  submission; unattended customers need a declarative `manual`,
  `after_approval`, or scheduled policy with a conservative default.
- Submission eligibility is currently discovered when Apple accepts or rejects
  the review item. The supervised Jams 1.2 run correctly stopped on Apple's
  missing 12.9-inch iPad screenshot error after the app added iPad support, but
  a product should preflight associated metadata/media errors before starting
  an expensive production build and surface every actionable requirement.

## Automatic VPS Deploy

This repo can deploy itself to the VPS on every push to `main` using `.github/workflows/deploy.yml`.

Required GitHub Actions secrets:

| Secret | Description |
|--------|-------------|
| `VPS_HOST` | VPS hostname or IP |
| `VPS_USER` | SSH user |
| `VPS_SSH_KEY` | Private SSH key for deployment |
| `SERVER_DIR` | Absolute path to this repo on the VPS |

The deploy workflow SSHes into the VPS, updates the checkout to `origin/main`,
runs `npm ci --omit=dev`, executes the full test suite, dry-runs deploy and
cleanup for every YAML profile, and installs one idempotent cron entry per
repository.

Pull requests run the test job in the deployment workflow and validate every
tracked repository profile without requiring production credentials. The VPS
deployment job is disabled for pull-request events.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `APP_STORE_CONNECT_API_KEY_ID` | App Store Connect API Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect Issuer ID |
| `APP_STORE_CONNECT_API_KEY_CONTENT` | API private key (base64 encoded) |
| `GH_TOKEN` | GitHub token for PR comments |
App and repository values live in YAML profiles. The legacy environment-only
configuration remains supported; when no `--profile` is supplied it still
requires `APP_BUNDLE_ID`, `APP_NAME`, `GITHUB_REPO_OWNER`, and
`GITHUB_REPO_NAME`.

### Optional

| Variable | Description |
|----------|-------------|
| `APP_ID` | App Store Connect app ID (use if bundle ID matches multiple apps) |
| `XCODE_WORKFLOW_ID` | Xcode Cloud workflow ID to filter builds |
| `RECOVER_MISSED_XCODE_BUILDS` | Recover missed production-branch workflow triggers (default `false`) |
| `INSTANCE_NAME` | Unique lock/log basename for this app profile |
| `PRODUCTION_BRANCH` | Branch used to find merged release PRs (default `main`) |
| `BETA_BRANCH` | Branch to trigger after a release goes live (default `develop`) |
| `EXPIRE_MERGED_BUILDS` | Run closed-PR expiry in the default `all` mode (default `true`) |
| `IOS_REPO_PATH` | Optional server checkout used to trigger the next beta build |
| `MERGE4APPSTORE_ENV` | Alternative to the `--config` command-line option |
| `MERGE4APPSTORE_PROFILE` | Alternative to the `--profile` command-line option |
| `DRY_RUN` | Set to `true` to run without making changes |

## Requirements

- Node.js 18+
- `gh` CLI (for GitHub PR operations)
- App Store Connect API key with App Manager permissions

## How It Filters Builds

Each automation resolves its own App Store Connect app and workflow from the
repository profile. App selections default to `prod`. Deployment only processes
the configured production workflow, while cleanup only processes the configured
PR workflow.

## Closed PR Build Expiry

The `expire` mode checks each valid, unexpired TestFlight build against its Xcode Cloud source branch. It expires the build only when that exact branch has one closed or merged PR targeting `BETA_BRANCH`. When a branch name has been reused by multiple closed PRs, the source commit must identify exactly one of them. A currently open PR for the branch always protects its builds.

The cleanup skips builds when their source cannot be identified, they came from
a workflow other than the configured PR workflow, their PR is still open or
ambiguous, they came from the beta or production branch, or they are selected
for an App Store version. Use `DRY_RUN=true node index.js expire --profile ...`
to preview every decision.

## License

MIT
