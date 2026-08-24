# merge4appstore

Automated iOS App Store deployment and release sync. Monitors TestFlight builds from Xcode Cloud, submits them for App Store review, and tags releases when they go live.

## What it does

1. **Deploy Check** - Monitors TestFlight for new builds from specific Xcode Cloud workflows, automatically submits them to App Store review, extracts release notes from merged GitHub PRs, and comments on PRs when builds are submitted or cancelled.

2. **Release Sync** - Monitors App Store Connect for builds that went live (READY_FOR_SALE), creates git tags (e.g., `v1.4-1400`) for released versions, and comments on PRs when builds are released.

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

For multiple apps, keep one ignored environment file per app. A Jams On Toast
starter is included:

```bash
mkdir -p profiles
cp profiles/jamsontoast.env.example profiles/jamsontoast.env
```

Each profile should set a unique `INSTANCE_NAME`. That gives it an independent
lock and log file, so two cron invocations cannot block or overwrite one another.

### 3. Run

```bash
# Run both operations (deploy + sync)
node index.js

# Run only deployment check
node index.js deploy

# Run only release sync
node index.js sync

# Run one app profile
node index.js --config profiles/jamsontoast.env
node index.js deploy --config profiles/jamsontoast.env

# Dry run modes
DRY_RUN=true node index.js
DRY_RUN=true node index.js deploy
DRY_RUN=true node index.js sync
```

Or use npm scripts:

```bash
npm start              # Run both
npm run deploy         # Deploy only
npm run sync           # Sync only
npm run start:dry      # Dry run both
npm run deploy:dry     # Dry run deploy
npm run sync:dry       # Dry run sync
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
| `INSTANCE_NAME` | Unique lock/log basename for this app profile |
| `PRODUCTION_BRANCH` | Branch used to find merged release PRs (default `main`) |
| `BETA_BRANCH` | Branch to trigger after a release goes live (default `develop`) |
| `IOS_REPO_PATH` | Optional server checkout used to trigger the next beta build |
| `MERGE4APPSTORE_ENV` | Alternative to the `--config` command-line option |
| `DRY_RUN` | Set to `true` to run without making changes |

## Requirements

- Node.js 18+
- `gh` CLI (for GitHub PR operations)
- App Store Connect API key with App Manager permissions

## How It Filters Builds

The script only processes builds from the specified Xcode Cloud workflow (default: "Publish to App Store"). Other workflows like "Public Beta" or "UAT" are skipped - they're for TestFlight distribution only, not App Store submission.

## License

MIT
