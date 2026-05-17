# merge4appstore

Automated iOS App Store deployment and release sync. Monitors TestFlight builds from Xcode Cloud, submits them for App Store review, and tags releases when they go live.

## What it does

1. **Deploy Check** - Monitors TestFlight for new builds from specific Xcode Cloud workflows, automatically submits them to App Store review, extracts release notes from merged GitHub PRs, and comments on PRs when builds are submitted or cancelled.

2. **Release Sync** - Monitors App Store Connect for builds that went live (READY_FOR_SALE), creates git tags (e.g., `v1.4-1400`) for released versions, and comments on PRs when builds are released.

## Features

- Direct App Store Connect API calls (no Fastlane/Ruby dependency)
- 10x faster than Fastlane-based solutions (~8s vs ~60s)
- Configurable for multiple apps via environment variables
- Single combined script for both operations
- Optional webhook server for Xcode Cloud build completion events

## How It Works

```text
Xcode Cloud                          Your VPS
┌─────────────────┐                  ┌────────────────────────────┐
│ Build Workflow  │                  │ merge4appstore             │
│ "Publish to     │──► webhook ────► │ webhook server (deploy)    │
│  App Store"     │                  │ 1. Receive BUILD_COMPLETED │
└─────────────────┘                  │ 2. Trigger deploy check    │
                                     └────────────────────────────┘

App Store Connect                    Your VPS
┌─────────────────┐                  ┌────────────────────────────┐
│ Production live │                  │ cron / manual sync         │
│ status changes  │────────────────► │ 1. Check READY_FOR_SALE    │
└─────────────────┘                  │ 2. Tag release             │
                                     │ 3. Comment on PR           │
                                     └────────────────────────────┘
```

## Setup

### 1. Install

```bash
git clone https://github.com/desai-deep/merge4appstore.git
cd merge4appstore
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### 3. Run

```bash
# Run both operations (deploy + sync)
node index.js

# Run only deployment check
node index.js deploy

# Run webhook server for Xcode Cloud build completions
node server.js

# Run only release sync
node index.js sync

# Dry run modes
DRY_RUN=true node index.js
DRY_RUN=true node index.js deploy
DRY_RUN=true node index.js sync
```

Or use npm scripts:

```bash
npm start              # Run both
npm run deploy         # Deploy only
npm run server         # Webhook server
npm run sync           # Sync only
npm run start:dry      # Dry run both
npm run deploy:dry     # Dry run deploy
npm run server:dry     # Dry run webhook server
npm run sync:dry       # Dry run sync
```

### 4. Webhook server

Configure Xcode Cloud to send `BUILD_COMPLETED` events to this service:

```bash
WEBHOOK_PORT=3000
WEBHOOK_PATH=/webhooks/xcode-cloud
WEBHOOK_SECRET_TOKEN=replace-with-a-random-token
npm run server
```

The webhook endpoint path becomes:

```text
/webhooks/xcode-cloud/replace-with-a-random-token
```

The server responds immediately and runs the existing deploy flow in the background. It only triggers for successful `BUILD_COMPLETED` events, and if `XCODE_WORKFLOW_ID` is set it will ignore other workflows.

Apple requires an HTTPS endpoint for Xcode Cloud webhooks. In production, run this behind a reverse proxy such as Nginx or Caddy and publish the proxied HTTPS URL in App Store Connect.

### 5. Schedule (cron)

The webhook server can replace frequent deploy polling. Keep cron for the release sync path, or as a low-frequency fallback:

```bash
# Run release sync every 15 minutes
*/15 * * * * cd /path/to/merge4appstore && node index.js sync >> logs/cron.log 2>&1

# Optional: fallback deploy check every hour
0 * * * * cd /path/to/merge4appstore && node index.js deploy >> logs/cron.log 2>&1
```

## Automatic VPS Deploy

This repo can deploy itself to the VPS on every push to `main` using `.github/workflows/deploy.yml`.

Required GitHub Actions secrets:

| Secret | Description |
|--------|-------------|
| `VPS_HOST` | VPS hostname or IP |
| `VPS_USER` | SSH user |
| `VPS_SSH_KEY` | Private SSH key for deployment |
| `MERGE4APPSTORE_DIR` | Absolute path to this repo on the VPS |

The deploy workflow SSHes into the VPS, hard-resets the checkout to `origin/main`, runs `npm ci --omit=dev` when dependencies changed, and executes `node --test tests/github.test.js`.

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
| `DRY_RUN` | Set to `true` to run without making changes |
| `WEBHOOK_HOST` | Host interface for the webhook server (default: `0.0.0.0`) |
| `WEBHOOK_PORT` | Port for the webhook server (default: `3000`) |
| `WEBHOOK_PATH` | Base path for the Xcode Cloud webhook (default: `/webhooks/xcode-cloud`) |
| `WEBHOOK_SECRET_TOKEN` | Appended path token used to make the webhook URL unguessable |

## Requirements

- Node.js 18+
- `gh` CLI (for GitHub PR operations)
- App Store Connect API key with App Manager permissions

## How It Filters Builds

The script only processes builds from the specified Xcode Cloud workflow (default: "Publish to App Store"). Other workflows like "Public Beta" or "UAT" are skipped - they're for TestFlight distribution only, not App Store submission.

## Webhook setup in App Store Connect

1. Start the webhook server behind HTTPS.
2. In App Store Connect, choose your app and open `Xcode Cloud > Settings > Webhooks`.
3. Add a webhook that points to `https://your-domain.example/webhooks/xcode-cloud/<token>`.
4. Trigger a test build from the publish workflow and inspect the delivery report in App Store Connect.
5. Keep `XCODE_WORKFLOW_ID` set so non-publish workflows are ignored.

## License

MIT
