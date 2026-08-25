# merge4appstore

Automated iOS App Store deployment and release sync. Monitors TestFlight builds from Xcode Cloud, submits them for App Store review, and tags releases when they go live.

## What it does

1. **Deploy Check** - Monitors TestFlight for new builds from specific Xcode Cloud workflows, automatically submits them to App Store review, extracts release notes from merged GitHub PRs, and comments on PRs when builds are submitted or cancelled.

2. **Release Sync** - Monitors App Store Connect for builds that went live (READY_FOR_SALE), creates git tags (e.g., `v1.4-1400`) for released versions, and comments on PRs when builds are released.

3. **Closed PR Cleanup** - Expires TestFlight builds from feature branches after their PR is merged or closed against the configured beta branch. Builds from the beta or production branch and builds selected for an App Store version are always protected.

4. **Missed Trigger Recovery** - Optionally starts the configured production Xcode Cloud workflow when a merged production PR has no build run. Active and completed runs are detected first so the five-minute cron cannot create duplicates.

## Features

- Direct App Store Connect API calls (no Fastlane/Ruby dependency)
- 10x faster than Fastlane-based solutions (~8s vs ~60s)
- Multiple app profiles can safely share one checkout, cron, and deployment
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

For one app, copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

For multiple apps, keep one ignored environment file per app. Running Order and
Jams On Toast starters are included:

```bash
mkdir -p profiles
cp profiles/runningorder.env.example profiles/runningorder.env
cp profiles/jamsontoast.env.example profiles/jamsontoast.env
```

Each profile should set a unique `INSTANCE_NAME`. That gives it an independent
lock and log file, so two cron invocations cannot block or overwrite one another.

Tracked `profiles/*.defaults` files are deployment-managed profiles. On each VPS
deploy, they inherit the shared credentials from `.env`, apply their non-secret
app settings, and install an idempotent five-minute cron entry. Generated
`profiles/*.env` files are ignored by Git and written with mode `600`.

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

# Run one app profile
node index.js --config profiles/jamsontoast.env
node index.js deploy --config profiles/jamsontoast.env

# Dry run modes
DRY_RUN=true node index.js
DRY_RUN=true node index.js deploy
DRY_RUN=true node index.js sync
DRY_RUN=true node index.js expire
```

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
```

### 4. Schedule (cron)

```bash
# Run every app every 5 minutes
*/5 * * * * cd /path/to/merge4appstore && node index.js >> logs/cron.log 2>&1
*/5 * * * * cd /path/to/merge4appstore && node index.js --config profiles/jamsontoast.env >> logs/cron.log 2>&1
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

The deploy workflow SSHes into the VPS, updates the checkout to `origin/main`, runs `npm ci --omit=dev`, and executes the full test suite. Ignored profile files remain on the server.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `APP_STORE_CONNECT_API_KEY_ID` | App Store Connect API Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect Issuer ID |
| `APP_STORE_CONNECT_API_KEY_CONTENT` | API private key (base64 encoded) |
| `GH_TOKEN` | GitHub token for PR comments |
| `APP_BUNDLE_ID` | Your app's bundle identifier |
| `APP_NAME` | App name (must match App Store Connect) |
| `GITHUB_REPO_OWNER` | GitHub org/user |
| `GITHUB_REPO_NAME` | GitHub repo name |

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
| `DRY_RUN` | Set to `true` to run without making changes |

## Requirements

- Node.js 18+
- `gh` CLI (for GitHub PR operations)
- App Store Connect API key with App Manager permissions

## How It Filters Builds

The script only processes builds from the specified Xcode Cloud workflow (default: "Publish to App Store"). Other workflows like "Public Beta" or "UAT" are skipped - they're for TestFlight distribution only, not App Store submission.

## Closed PR Build Expiry

The `expire` mode checks each valid, unexpired TestFlight build against its Xcode Cloud source branch. It expires the build only when that exact branch has one closed or merged PR targeting `BETA_BRANCH`. When a branch name has been reused by multiple closed PRs, the source commit must identify exactly one of them. A currently open PR for the branch always protects its builds.

The cleanup skips builds when their source cannot be identified, their PR is still open or ambiguous, they came from `BETA_BRANCH` or `PRODUCTION_BRANCH`, or they are selected for an App Store version. Use `npm run expire:dry` to preview every decision. It runs in scheduled default executions unless `EXPIRE_MERGED_BUILDS=false` is set.

## License

MIT
