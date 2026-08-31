# merge4appstore

Automated iOS App Store deployment and release sync. Monitors TestFlight builds from Xcode Cloud, submits them for App Store review, and tags releases when they go live.

## What it does

1. **Deploy Check** - Monitors TestFlight for new builds from specific Xcode Cloud workflows, automatically submits them to App Store review, extracts release notes from merged GitHub PRs, and comments on PRs when builds are submitted or cancelled. A newer eligible production build always supersedes the build currently in review: merge4appstore withdraws the existing submission, waits for the version to become editable, selects the newer build, and resubmits it. Replacement does not depend on GitHub successfully attributing the commit to a PR.

2. **Release Sync** - Monitors App Store Connect for builds that went live (READY_FOR_SALE), creates git tags (e.g., `v1.4-1400`) for released versions, and comments on PRs when builds are released.

3. **Closed PR Cleanup** - Expires TestFlight builds from feature branches after their PR is merged or closed against the configured beta branch. Builds from the beta or production branch and builds selected for an App Store version are always protected.

4. **Missed Trigger Recovery** - Optionally starts the configured production Xcode Cloud workflow when a merged production PR has no build run. Active and completed runs are detected first so the five-minute cron cannot create duplicates.

5. **Managed Build Triggering** - Converts a provider-neutral build intent into
   an Xcode Cloud build, reusing an existing run for the same workflow and
   commit and refusing to duplicate an active run whose commit metadata is not
   available yet.

6. **Release PR Maintenance** - Creates or updates the configured beta-to-production
   pull request after branch pushes. Its body lists the merged pull requests in
   the release range rather than their individual commits.

7. **Automatic PR Rebasing** - Rebases every open pull request targeting the
   beta branch whenever that branch advances. Conflicted or otherwise
   non-updatable pull requests receive an automation comment and are skipped
   without blocking the rest.

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

release_pull_request: true # optional; maintained centrally after branch pushes
auto_rebase_pull_requests: true # optional; defaults to false

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
can call the same provider-neutral path. `native` (the default) leaves starts to
the provider and enqueues no API start. `shadow` evaluates the webhook intent in
dry-run mode without starting anything. Use `managed` only after all native
automatic triggers have been removed. A direct non-dry `trigger` is rejected
for `native` and is always forced to dry-run for `shadow`.

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
*/5 * * * * umask 077; cd /srv/merge4appstore.state/current && PATH='/absolute/node/bin:/absolute/gh/bin:/absolute/git/bin:/absolute/flock/bin:/absolute/logrotate/bin:/usr/bin:/bin' MERGE4APPSTORE_ENV=/srv/merge4appstore/.env MERGE4APPSTORE_STATE_DIR=/srv/merge4appstore.state DRY_RUN=false RECONCILE_METADATA=false /absolute/node/bin/node index.js --profile profiles/runningorder.yml >> /srv/merge4appstore.state/logs/cron.log 2>&1
*/5 * * * * umask 077; cd /srv/merge4appstore.state/current && PATH='/absolute/node/bin:/absolute/gh/bin:/absolute/git/bin:/absolute/flock/bin:/absolute/logrotate/bin:/usr/bin:/bin' MERGE4APPSTORE_ENV=/srv/merge4appstore/.env MERGE4APPSTORE_STATE_DIR=/srv/merge4appstore.state DRY_RUN=false RECONCILE_METADATA=false /absolute/node/bin/node index.js --profile profiles/jamsontoast.yml >> /srv/merge4appstore.state/logs/cron.log 2>&1
```

Every CLI, cron, and webhook process for the same installation must use the
same absolute `MERGE4APPSTORE_STATE_DIR`. This makes repository locks, delivery
deduplication, mirror data, and logs independent of the deployed release.
Process locks are kernel-held and disappear with their owner: Linux uses GNU
`flock`, macOS uses `lockf`, and both keep mode-`0600` lock files below a private
mode-`0700` directory. Windows uses an exclusive named pipe. Other operating
systems are rejected instead of falling back to an unsafe stale lock file.

Cron is the reconciliation fallback. The primary event path is `npm run
webhooks`, exposed behind HTTPS:

- `POST /webhooks/github/:instance` verifies GitHub's raw-body HMAC SHA-256
  signature and handles PR open/update/close plus beta and production pushes.
- `POST /webhooks/xcode-cloud/:instance/:token` accepts Xcode Cloud build
  lifecycle events. Because Apple doesn't document a signing header for these
  events, use a high-entropy URL token and never store it in profile YAML.
- `GET /health` reports the configured instances without exposing secrets.

The listener returns `202` only after the delivery intent is fsynced below
`MERGE4APPSTORE_STATE_DIR/deliveries`. Workers resume pending receipts after a
crash, retain their job cursor so completed steps are not repeated, and move a
delivery to the failed queue after the bounded attempt limit. `/health` keeps
`ok: true` when the service can accept work and sets `degraded: true` plus the
pending/failed/corrupt counts and oldest pending age when operator recovery is
needed. A receipt pending for 15 minutes, a durable migration gate, or a stale
incomplete deployment transaction makes health degraded; unreadable runtime
state makes the endpoint return `503`. Each spawned job also has a 20-minute
hard deadline; on expiry the worker terminates its entire process group, records
the attempt as failed, and lets the durable retry/dead-letter policy take over.
Presigned App Store screenshot and preview uploads have their own five-minute
request deadline, so a stalled upload cannot consume that whole job window.

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

The deployment workflow also exposes a constrained `reconcile_profile` choice
for an auditable one-off live reconciliation on the VPS. It defaults to `none`;
selecting a repository runs its deploy reconciliation only after the rollout and
health checks succeed. A normal main-branch deployment installs reconciliation
cron after the first-generation drain; a manual deployment can deliberately
leave the managed cron entries paused.

Webhook jobs for one repository are serialized. If cron or a manual command
already holds that repository's lock, a later job waits instead of being
reported as a successful no-op. The default wait is ten minutes and can be
overridden with `MERGE4APPSTORE_LOCK_WAIT_MS`; a timeout exits nonzero so the
incomplete operation remains visible.

### Webhook failure recovery

The scheduled GitHub Actions health monitor opens or updates a marked issue if
the public endpoint is unreachable, reports `ok: false`, or has a degraded
delivery queue. Xcode Cloud failures for pull-request, beta, and production
workflows also open marked issues; an older completion can never overwrite a
newer status, and a newer successful build closes the alert. Deployment,
service-health, and Xcode Cloud failure issues are best-effort assigned to the
repository owner so GitHub can deliver an assignment notification. A failed
deployment's issue also records a bounded, sanitized public-health snapshot, which confirms
whether the previous release remained available after recovery. To inspect and
requeue durable failures on the VPS:

```bash
curl --fail-with-body https://api.runningorder.app/merge4appstore/health
cd /srv/merge4appstore.state/current
MERGE4APPSTORE_STATE_DIR=/srv/merge4appstore.state npm run retry:deliveries
```

For proxy failures, inspect the private sanitized upstream log and the rotation
contract. The JSON records contain only a request ID, method, response status,
upstream address/status/timings, total request time, and bytes sent. They never
contain a URI, query string, webhook token, header, body, client address,
referrer, or user agent; Nginx's location error log remains disabled because an
error can reproduce the token-bearing request line.

```bash
tail -n 50 /srv/merge4appstore.state/logs/nginx-upstream.log
logrotate --debug \
  --state /srv/merge4appstore.state/logrotate.state \
  /srv/merge4appstore.state/logrotate.conf
crontab -l | grep -F '# merge4appstore-logrotate'
```

The retry command requeues every readable failed receipt from its first
unfinished job. If it exits `2`, inspect the preserved corrupt evidence and
then quarantine it explicitly:

```bash
MERGE4APPSTORE_STATE_DIR=/srv/merge4appstore.state \
  npm run retry:deliveries -- --quarantine-corrupt
```

After quarantine, use GitHub’s webhook delivery page to redeliver the original
GitHub event, or rerun the affected Xcode Cloud build. Receipt keys are stable,
so ordinary sender retries are deduplicated while a completed receipt is within
retention. The external alert closes on the next healthy scheduled check.

When `release_pull_request` is enabled, beta and production pushes also
reconcile the open pull request from `repository.beta_branch` to
`repository.production_branch`. The default title is “Bug fixes and performance
improvements”, and the default body limit is 100 merged pull requests. A mapping
can override either value:

```yaml
release_pull_request:
  title: Monthly release
  note_limit: 50
```

This policy and its GitHub writes live in merge4appstore; app repositories do
not need a release-PR workflow or checkout script.

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

Preparation uses a persistent, blobless bare Git mirror for commit ancestry and
subjects. The mirror has no working tree and does not check out repository
source files. It downloads refs, commit objects, and tree metadata, but its
initial and refresh fetches omit file-content blobs. A request performs at most
one bounded mirror refresh instead of up to 20 sequential GitHub compare API
calls, then evaluates eligible local ancestor candidates in newest-first order,
hard-capped at 20 total. Identical preparations across both PM2 workers share a
kernel lock and a private 60-second result cache; published-build history also
has a 60-second cache, and a failed refresh is surfaced instead of serving a
stale result. File-lock startup avoids a second Node.js cold start, waits for a
timed-out helper to exit before retrying, and retries only helper-readiness
timeouts; lock contention and permanent helper failures retain their distinct
outcomes.

The service returns dependency timeouts as `503 Service Unavailable` with a
`Retry-After` header before the reverse proxy's deadline. Repository adapters
should retry transient HTTP and transport failures with a bounded backoff,
re-sending the same preparation payload. A completed 4xx response is not
transient. If all retries fail, the Xcode Cloud build remains failed and can be
rerun safely after service recovery; preparation does not make repository or
App Store mutations.

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

For pull-request builds, TestFlight notes contain every commit since the newest
uploaded build from the same workflow whose commit is an ancestor of the
current head, followed by the current PR body. The commit heading identifies
that ancestor by marketing version and build number. The first build of a PR
keeps the PR body first, labels the commits as belonging to the pull request,
and falls back to all commits in that PR.
`build.purposes.<purpose>.include_commits` overrides
the default: `true` for `pull_request`, `false` for `beta` and `production`.
When a PR body is edited, the signed GitHub webhook refreshes the English
TestFlight localization for every active uploaded build of that PR commit; no
rebuild is required. Feature PRs refresh builds from the pull-request workflow.
The configured `develop`-to-`main` release PR refreshes builds from the beta
workflow for its head commit, using the contents of its `Release Notes` section.

## Automatic VPS Deploy

This repo can deploy itself to the VPS on every push to `main` using `.github/workflows/deploy.yml`.

Required GitHub Actions secrets:

| Secret | Description |
|--------|-------------|
| `VPS_HOST` | VPS hostname or IP |
| `VPS_USER` | SSH user |
| `VPS_SSH_KEY` | Private SSH key for deployment |
| `VPS_SSH_HOST_ED25519_SHA256` | Pinned VPS ed25519 host-key fingerprint (`SHA256:...`), obtained from the provider console or an already trusted session |
| `SERVER_DIR` | Absolute path to this repo on the VPS |

The checkout at `SERVER_DIR` is a control repository: deployments fetch into
its Git object database but never reset its working tree. A deployment extracts
the requested commit with `git archive` into the private sibling state root at
`${SERVER_DIR}.state/releases/<sha>-<run>`. The required Node 20 Actions job runs
the complete test suite and validates every profile on that exact commit before
the deployment job can start. The VPS then installs the lockfile with a bounded
deadline, validates the packaged profiles, dry-runs each profile, and warms the
shared bare mirrors. It does not rerun source-layout unit tests inside the live
production state or from the `.git`-free archive. Only a fully verified immutable
release is started by PM2. `current` and `previous` symlinks identify the retained
releases; cron always runs `current` and writes locks and logs below the state
root.

The state root must be a real, deployment-user-owned directory with mode
`0700`, under a non-writable real parent. The workflow creates it only when the
exact path is absent and empty, then installs a private ownership marker before
opening its deployment lock. It refuses symlinks, foreign ownership, permissive
modes, and an unmarked nonempty directory. A first deployment may migrate owned
regular `.env` and `.webhook.env` control files that are owner-readable and
neither writable by another user nor executable; it tightens them to `0600`
before reading any secret. Unsafe legacy modes fail closed. After migration,
`.webhook.env` is a validated symlink to the active private release credential.

PM2 runs the permanent `merge4appstore-webhooks-v2` app as two cluster workers
on loopback port 8788. Workers receive only non-secret settings and paths to the
control `.env` and a release-specific `0600` webhook environment file; they load
those files themselves. Secret values are filtered from PM2's environment and
validated as absent before `pm2 save`. PM2's kill timeout stays ten seconds
above `MERGE4APPSTORE_DRAIN_TIMEOUT_MS`, so acknowledged background jobs get the
same graceful-shutdown window as the application. Deployment and inspect mode
both require the deployment user's enabled, active `pm2-<user>.service` startup
unit to own the live PM2 daemon, resurrect the saved dump with the same
`PM2_HOME`, and run both the daemon and managed apps on Node.js 20 or newer.
PM2's merged stdout and stderr, profile logs, cron output, and the sanitized
Nginx upstream log all live below the private state root. The PM2 daemon's
`pm2.log` and optional `agent.log` remain below the deployment user's private
`PM2_HOME` and are covered by the same rotation policy. A deployment-user
`logrotate` job checks them every five minutes, rotates daily or at 10 MiB,
keeps seven rotations for at most fourteen days, and compresses old files. Its
configuration, state file, and execution lock are owned by that user with mode
`0600`; deployment runs one serialized rootless rotation pass before commit.
Rotation uses `copytruncate` so neither Nginx nor PM2 needs privileged reopen
commands; a few lines can be lost in the narrow copy/truncate window. The
private rotation configuration is never installed under `/etc/logrotate.d`,
where an application-writable file would otherwise be executed by root.

Every rollout snapshots the exact crontab and removes all managed
`merge4appstore` entries before starting or reloading the candidate. The first
migration does not disturb the legacy app on port 8787; it starts and
authenticates the new app on 8788 after cron is quiesced. A private, durable gate
file lets the new listener acknowledge arrivals into its queue but prevents
their execution regardless of how long preparation takes.
The deployment persists both PM2 apps for reboot safety, switches nginx
transactionally, verifies public health, commits the release pointers, and
verifies that the legacy PM2 process has no descendant jobs or live legacy lock
holders for a continuous quiet window. It then removes the legacy app, installs v2 cron, and
clears the gate. If observable quiescence is not reached before the drain
deadline, the committed v2 service and transaction are preserved with delivery
paused for a safe rerun; the legacy process is not killed. A crash leaves the
gate closed and health
degraded until journal recovery safely finishes or restores the legacy service.
Later releases use a PM2 rolling reload on the permanent port.

Before the release pointers are committed, any error or termination restores
the prior PM2 release, nginx files, secret pointer, `current`/`previous` links,
and the exact saved crontab. A failure after commit (for example, while
reconciling GitHub hooks or cron) intentionally leaves the already healthy
release serving traffic; fix the external or transient cause and rerun the
failed jobs so the transaction journal can finish idempotently. If the deployed
main commit itself is bad, revert that commit on `main` and let the resulting
push deploy the revert. Do not switch release pointers manually: PM2, nginx,
credentials, cron, and pointers move as one transaction. The retained previous
release and webhook file are recovery evidence and transaction inputs, not a
standalone pointer-only rollback mechanism; do not delete them until a later
deployment has succeeded.

Every switch phase is fsynced to a private transaction journal. A later
deployment detects an interrupted nginx/pointer switch and either rolls forward
to the still-healthy candidate or retains the healthy previous service; the
first migration can restore the saved legacy nginx route. Automatic rollback
deletes candidate code and credentials only after PM2, nginx, pointers, and
cron are positively restored. Otherwise it preserves the release, secret, and
journal paths in the failed run log for manual recovery.

The Nginx log format and private rotation configuration are part of that same
transactional snapshot. A pre-commit failure restores or removes them exactly;
a committed rollout retains and revalidates them before cron resumes. Before
dependency installation and again before proxy cutover, deployment requires at
least 1 GiB and 10% of the state filesystem to remain available. This leaves
room for the journal, mirrors, delivery receipts, dependencies, and bounded
logs instead of discovering a full disk during cutover.

The workflow retries idempotent GitHub, authenticated preparation, and public
health probes with bounded exponential backoff. Before cutover, it prewarms
every configured Git mirror sequentially with the longer clone budget. Each
repository has a six-minute deadline and one retry after a mirror reports a
transient `503`; request-time mirror initialization is never retried. An
exhausted or permanent mirror failure rejects the candidate while the previous
production release remains selected, so the deployment-alert issue makes the
degraded optimization visible; rerun the failed workflow after the reported
cause clears. Runtime requests retain the shorter mirror-command budget and
safe provider fallback.
A persistent test/deploy failure opens a marked GitHub issue containing the
Actions run and rerun instructions, without masking the failed job; a later
successful deployment closes it. A separate five-minute workflow checks public
health and reconciles the latest completed main-branch deployment result even
when no deployment is running. Set repository variable
`MERGE4APPSTORE_HEALTH_URL` only when the public endpoint differs from the
documented default.

Webhook credentials never transit GitHub Actions during a normal deployment.
The deployer copies the VPS's existing control `.webhook.env` into the candidate
release before changing any pointers, then compares it with the active rollback
credentials. Credential rotation is therefore a separate coordinated
maintenance operation: rotate the active and retained rollback files together,
reload and authenticate the service, update GitHub/Xcode Cloud senders, and
only then resume normal deployment. This prevents a code rollback from silently
restoring credentials that senders no longer use.

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
| `MERGE4APPSTORE_WEBHOOK_ENV` | Private webhook-only environment file loaded after `MERGE4APPSTORE_ENV`, overriding duplicate values; deployments point this at the active release credential |
| `MERGE4APPSTORE_PROFILE` | Alternative to the `--profile` command-line option |
| `MERGE4APPSTORE_LOCK_WAIT_MS` | Maximum time to wait for another job for the same repository (default `600000`) |
| `MERGE4APPSTORE_STATE_DIR` | Absolute private directory for persistent Git mirrors and deployment coordination (default `~/.local/state/merge4appstore`) |
| `MERGE4APPSTORE_MIRROR_TTL_MS` | Minimum interval between successful mirror refreshes (default `60000`) |
| `MERGE4APPSTORE_MIRROR_TIMEOUT_MS` | Timeout for each steady-state mirror Git command (default `15000`) |
| `MERGE4APPSTORE_MIRROR_CLONE_TIMEOUT_MS` | Timeout used by `prepare:mirrors` for each first-time blobless clone (default `120000`); request-time initialization retains the shorter command timeout so provider fallback fits inside the request deadline |
| `MERGE4APPSTORE_MIRROR_LOCK_TIMEOUT_MS` | Maximum wait for a concurrent mirror mutation (default `60000`) |
| `MERGE4APPSTORE_MIRROR_RETRY_BACKOFF_MS` | Backoff before retrying an unavailable mirror (default `5000`) |
| `MERGE4APPSTORE_MIRROR_CANDIDATE_LIMIT` | Maximum eligible local build ancestors to check in newest-first order, including branch-unknown candidates (default and maximum `20`) |
| `MERGE4APPSTORE_PREPARE_TIMEOUT_MS` | Build-preparation HTTP deadline, kept below the proxy timeout (default `45000`) |
| `MERGE4APPSTORE_DRAIN_TIMEOUT_MS` | Maximum graceful wait for acknowledged webhook work during PM2 reload/shutdown (default `600000`) |
| `MERGE4APPSTORE_LEGACY_DRAIN_QUIET_SECONDS` | Continuous no-child/no-live-lock window required before deleting the first-generation webhook process (default `30`) |
| `MERGE4APPSTORE_MIN_FREE_BYTES` | Absolute free-space floor enforced by VPS deployment (default and minimum `1073741824`, 1 GiB) |
| `MERGE4APPSTORE_MIN_FREE_PERCENT` | Percentage free-space floor enforced in addition to the byte floor (default and minimum `10`) |
| `MERGE4APPSTORE_DELIVERY_PAUSE_FILE` | Private regular file whose presence durably pauses execution while continuing to accept and persist deliveries; deployment manages this during first migration |
| `MERGE4APPSTORE_RECOVERY_INTERVAL_MS` | Pending-delivery recovery scan interval (default `5000`) |
| `MERGE4APPSTORE_JOB_RETRY_MS` | Delay before retrying a failed webhook job (default `5000`) |
| `MERGE4APPSTORE_JOB_MAX_ATTEMPTS` | Attempts before a webhook delivery enters the failed queue (default `8`) |
| `DRY_RUN` | Set to `true` to run without making changes |

## Requirements

- Node.js 20 LTS or newer
- Git with reliable `GIT_NO_LAZY_FETCH` support: 2.39.4+, 2.40.2+, 2.41.1+,
  2.42.2+, 2.43.4+, 2.44.1+, or 2.45.1+ on those maintenance branches;
  Git 2.46.0 or newer is also supported
- `gh` CLI (for GitHub PR operations)
- Nginx, PM2, GNU `flock`, `logrotate`, and `gzip` on the deployment VPS
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
