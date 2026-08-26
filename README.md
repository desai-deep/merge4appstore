# merge4appstore

Automated iOS App Store deployment and release sync. Monitors TestFlight builds from Xcode Cloud, submits them for App Store review, and tags releases when they go live.

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

## How It Works

```
Xcode Cloud                          Your VPS
┌─────────────────┐                  ┌─────────────────────────┐
│ Build Workflow  │                  │  merge4appstore (cron)  │
│ "Publish to     │──► TestFlight ──►│                         │
│  App Store"     │                  │  1. Check new builds    │
└─────────────────┘                  │  2. Find merged PR      │
                                     │  3. Extract release notes│
                                     │  4. Submit for review   │
                                     │  5. Tag when live       │
                                     │  6. Comment on PR       │
                                     └─────────────────────────┘
```

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
  trigger_mode: managed # default; each purpose may override it
  purposes:
    pull_request:
      app: internal
      workflow: pull_requests
      trigger_mode: managed # requires Xcode Cloud's Manual Start PR option
    beta:
      workflow: beta
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

`trigger` is an explicit API/CLI operation in this change. A webhook listener
can call the same provider-neutral path. Use `shadow` while comparing webhook
intents with a build provider's native triggers, and `managed` after native
triggers can safely be removed.

Xcode Cloud is a special case for pull-request builds. Apple rejects API-started
PR builds when the workflow is deactivated or its enabled start conditions do
not allow that PR. For fully managed operation, replace the automatic **Pull
Request Changes** condition with **Manual Start**, enable its **Pull Request**
option, and select the allowed source and target branches. This keeps the
workflow API-startable without Apple also reacting directly to Git events. Use
`shadow` while the automatic PR condition is still present. Branch-based beta
and production purposes can use `managed` independently.

### 4. Schedule (cron)

```bash
# Run every repository every 5 minutes
*/5 * * * * cd /path/to/merge4appstore && node index.js --profile profiles/runningorder.yml >> logs/cron.log 2>&1
*/5 * * * * cd /path/to/merge4appstore && node index.js --profile profiles/jamsontoast.yml >> logs/cron.log 2>&1
```

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
