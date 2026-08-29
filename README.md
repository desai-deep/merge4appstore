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

metadata: # optional
  path: AppStore

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

### Repository-managed App Store metadata

An app repository may opt in by declaring a `metadata.path` directory in its
profile. Its filesystem is loaded from the current production-branch head
immediately before submission, so metadata can be corrected and retried without
producing another binary. No manifest file is required.

```text
AppStore/
├── copyright.txt
├── name.txt                    # default app localization
├── subtitle.txt
├── privacy_policy_url.txt
├── description.txt
├── screenshots/               # default app localization
│   └── 01-iphone-home.png
├── review/
│   ├── contact_first_name.txt
│   ├── contact_last_name.txt
│   ├── contact_phone.txt
│   ├── contact_email.txt
│   ├── notes.txt
│   ├── demo_account_name.txt
│   └── demo_account_password.txt
├── en-US/
│   ├── keywords.txt
│   ├── marketing_url.txt
│   ├── promotional_text.txt
│   ├── support_url.txt
│   ├── whats_new.txt
│   ├── screenshots/
│   │   ├── 01-iphone-home.png
│   │   ├── 02-iphone-player.png
│   │   ├── 01-ipad-library.png
│   │   └── APP_APPLE_TV/       # optional explicit override
│   │       └── 01-tv-home.png
│   └── previews/
│       └── IPHONE_65/
│           ├── 01-overview.mov
│           └── 02-playback.mp4
└── de-DE/
    └── description.txt
```

The filesystem supports these release-editable text fields:

| Scope | Files | App Store Connect fields |
| --- | --- | --- |
| Localized App Info | `[<locale>/]name.txt`, `[<locale>/]subtitle.txt`, `[<locale>/]privacy_policy_url.txt`, `[<locale>/]privacy_choices_url.txt`, `[<locale>/]privacy_policy_text.txt` | App name, subtitle, privacy-policy URL, privacy-choices URL, privacy-policy text |
| Localized version | `[<locale>/]description.txt`, `[<locale>/]keywords.txt`, `[<locale>/]marketing_url.txt`, `[<locale>/]promotional_text.txt`, `[<locale>/]support_url.txt`, `[<locale>/]whats_new.txt` | Description, keywords, marketing URL, promotional text, support URL, release notes |
| Version | `copyright.txt` | Copyright for this App Store version |
| App Review | `review/contact_first_name.txt`, `review/contact_last_name.txt`, `review/contact_phone.txt`, `review/contact_email.txt`, `review/notes.txt`, `review/demo_account_name.txt`, `review/demo_account_password.txt` | Review contact, notes, and optional demo credentials |

`name.txt` is required only when adding a new App Info locale; existing locales
may update any subset. Supplying either demo-credential file also reconciles
Apple's “sign-in required” flag when a nonempty credential is supplied. To
remove demo access, commit both credential files as empty files. Credentials
are stored as plaintext in Git, so use this only in a private repository with
appropriately restricted access. When creating App Review information for the
first time, all four contact files are required.

Localized text and media may be placed directly under `AppStore/`; those files
target the app's primary locale reported by App Store Connect. Locale folders
remain optional explicit overrides. If both forms manage the same field or
media set, the explicit locale folder wins.

Management is explicitly opt-in at every level:

- An omitted locale, text file, screenshot directory, or preview directory is
  left unchanged in App Store Connect.
- A present text file updates only that field. An empty file clears it.
- Screenshots may be placed directly in `<locale>/screenshots`. PNG and JPEG
  pixel dimensions select Apple's display type automatically, in portrait or
  landscape. Files are grouped by inferred type and ordered alphabetically, so
  use prefixes such as `01-`, `02-`, and `03-`.
- Explicit `<locale>/screenshots/<APPLE_DISPLAY_TYPE>/` directories remain
  available as an override for ambiguous or newly introduced dimensions. The
  directory must use Apple's `APP_...` display-type form; values are forwarded
  to App Store Connect so newly introduced Apple types do not require a
  merge4appstore release. Flat and explicit assets may coexist and are combined
  into the selected set.
- A present display-type directory is authoritative for that locale and type:
  files are uploaded or removed to match the repository. An inferred flat set
  is authoritative whenever at least one flat image resolves to that type.
- Git cannot track an empty directory. To clear a managed screenshot or preview
  set, leave a `.gitkeep` file in that display-type directory.
- Screenshots support PNG and JPEG. A flat image with unknown or ambiguous
  dimensions fails safely and names the explicit directory it needs. App
  Preview videos support MOV, MP4, and M4V and always require an explicit
  `<locale>/previews/<APPLE_PREVIEW_TYPE>/` directory; a misplaced flat preview
  fails with a clear error. App Store Connect still validates Apple's size,
  codec, duration, and device requirements during processing.

If `en-US/whats_new.txt` exists, it replaces the usual release-PR-title notes
for that submission. Other locales and omitted `whats_new` fields retain their
normal behavior.

A production push containing only files in the configured metadata directory
runs deployment reconciliation directly instead of starting Xcode Cloud. Mixed
code and metadata pushes still use the normal production build path. GitHub
webhook payloads that might have a truncated commit list also fall back to a
build, avoiding an unsafe metadata-only classification. The metadata webhook
sets a one-job reconciliation intent that retries the selected binary after a
metadata rejection and skips missed-build recovery. For a manual retry, run
`RECONCILE_METADATA=true node index.js deploy --profile profiles/example.yml`.

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
intents with a build provider's native triggers, and `managed` after all native
automatic triggers have been removed.

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

The VPS deployment starts the listener with PM2, configures the signed GitHub
hooks, and proxies it at `https://api.runningorder.app/merge4appstore/`. A
manual deployment can set `pause_cron: true` for an isolated webhook test.

Webhook jobs for one repository are serialized. If cron or a manual command
already holds that repository's lock, a later job waits instead of being
reported as a successful no-op. The default wait is ten minutes and can be
overridden with `MERGE4APPSTORE_LOCK_WAIT_MS`; a timeout exits nonzero so the
incomplete operation remains visible.

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
| `GH_TOKEN` | GitHub token for PR comments/issues and, when configured, read access to repository metadata/assets |
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
| `MERGE4APPSTORE_LOCK_WAIT_MS` | Maximum time to wait for another job for the same repository (default `600000`) |
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
for an App Store version. If Apple retains the exact commit and workflow but
drops only the source branch, cleanup requires exactly one closed PR associated
with that commit and targeting the configured beta branch. Use `DRY_RUN=true
node index.js expire --profile ...` to preview every decision.

## License

MIT
