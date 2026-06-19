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

## How It Works

```
Xcode Cloud                          Your VPS
┌─────────────────┐   webhook /      ┌─────────────────────────┐
│ Build Workflow  │   cron trigger   │  merge4appstore         │
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
npm run sync           # Sync only
npm run start:dry      # Dry run both
npm run deploy:dry     # Dry run deploy
npm run sync:dry       # Dry run sync
```

### 4. Run continuously (webhook server)

Instead of polling on a cron, run the webhook server so submissions are triggered
the moment a release build is produced:

```bash
node server.js          # or: npm run serve
DRY_RUN=true npm run serve:dry
```

The server listens on `127.0.0.1:$WEBHOOK_PORT` (default `8090`) and exposes:

- `POST /webhook/xcode-cloud` — triggers a deploy check (authenticated by `XCODE_WEBHOOK_SECRET`)
- `GET  /healthz` — liveness probe

Because Xcode Cloud fires its webhook when **CI finishes**, the TestFlight build
is usually still processing on Apple's side for several minutes afterward. The
server therefore retries the deploy check on a fixed interval
(`WEBHOOK_RETRY_INTERVAL_MS`, default 3 min) up to `WEBHOOK_RETRY_MAX_ATTEMPTS`
times (default 20 ≈ 1 hour) until the build becomes submittable, then stops.

**Authentication.** Xcode Cloud webhooks are unsigned, so the caller is
authenticated with a shared secret. Provide it as a trailing path segment
(`/webhook/xcode-cloud/<secret>`), an `X-Webhook-Secret` header, or a
`?token=<secret>` query parameter.

Run it under a process manager (e.g. PM2) and reverse-proxy it behind TLS:

```bash
pm2 start server.js --name merge4appstore-webhook
pm2 save
```

### 4b. Schedule (cron, legacy)

```bash
# Run every 5 minutes
*/5 * * * * cd /path/to/merge4appstore && node index.js >> logs/cron.log 2>&1
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

The deploy workflow SSHes into the VPS, hard-resets the checkout to `origin/main`, runs `npm ci --omit=dev`, executes the test suite (`node --test tests/`), and reloads the `merge4appstore-webhook` PM2 process.

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
| `XCODE_WEBHOOK_SECRET` | Shared secret authenticating Xcode Cloud webhooks (**required** to run `server.js`) |
| `WEBHOOK_PORT` | Port the webhook server binds to on `127.0.0.1` (default `8090`) |
| `WEBHOOK_RETRY_INTERVAL_MS` | Delay between deploy retries while a build finishes processing (default `180000`) |
| `WEBHOOK_RETRY_MAX_ATTEMPTS` | Max deploy attempts per webhook trigger (default `20`) |

## Requirements

- Node.js 18+
- `gh` CLI (for GitHub PR operations)
- App Store Connect API key with App Manager permissions

## How It Filters Builds

The script only processes builds from the specified Xcode Cloud workflow (default: "Publish to App Store"). Other workflows like "Public Beta" or "UAT" are skipped - they're for TestFlight distribution only, not App Store submission.

## License

MIT
