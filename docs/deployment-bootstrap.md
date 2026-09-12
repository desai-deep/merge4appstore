# Deployment bootstrap and domain migration

This prepares configuration for a dedicated domain on the existing host or a replacement Linux VPS. It does not purchase a domain, change DNS, provision a server, install credentials, or deploy. No domain has been selected yet.

Generate a reviewable bundle once a hostname is known:

```sh
npm run bootstrap:deployment -- --domain hooks.example.com --environment production --output /tmp/merge4appstore-production
```

The output directory must not exist. It contains HTTP certificate-bootstrap and TLS Nginx configurations, Actions variables, an endpoint manifest, and an ordered setup checklist. The `/merge4appstore` prefix is retained so moving the domain does not also change the callback path layout. A domain at its root is not supported by this bootstrap.

## Host prerequisites

Use a Linux host with systemd, Nginx, a supported Node.js runtime (at least 20), npm, Git (at least 2.47 for mirror support), GitHub CLI, PM2, curl, tar, util-linux/flock, cron, logrotate, gzip, and Certbot. Install from trusted distribution/vendor packages and verify versions. The existing deployment requires permission to manage Nginx, PM2 startup and cron; it is not currently an unprivileged self-contained container deployment. The current production host uses root. Restrict the deployment SSH key and protect its Actions configuration accordingly.

Prepare an owned, real control checkout at `/srv/merge4appstore` with origin pointing to this repository. Authenticate fetching it independently of runtime App credentials. Existing workflows archive releases from its Git object database; they do not overwrite its working tree. Provision the supported private `.env` and `.webhook.env` runtime files out of band, as described in README and secret-storage.md. Do not copy their contents into the bootstrap bundle. Create trusted SSH access and obtain the ed25519 host fingerprint from the provider console or an already trusted session, not unauthenticated keyscan alone.

Allow inbound HTTPS, HTTP for ACME if using the generated webroot configuration, and restricted SSH. Keep the Node listener on `127.0.0.1:8788`. Install the generated HTTP site first, obtain its certificate, then enable the TLS site. Validate `nginx -t` before every reload. Configure certificate renewal and its reload hook. Match one enabled TLS virtual host to the chosen hostname.

## Actions configuration

Existing secrets remain `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_SSH_HOST_ED25519_SHA256`, and `SERVER_DIR`.

Set repository variable `MERGE4APPSTORE_PUBLIC_BASE_URL` to `https://YOUR-HOST/merge4appstore` without a trailing slash. The workflow validates it, transports it safely to SSH, derives the Nginx hostname, and uses it for webhook reconciliation and public health. Both deployment alerts and the scheduled monitor derive `/health` from this value. The legacy `MERGE4APPSTORE_HEALTH_URL` override is retained; remove or update it during migration to avoid monitoring the old domain. Unset variables preserve the existing production endpoint.

A manually invoked deploy script must set both `MERGE4APPSTORE_PUBLIC_BASE_URL` and matching `MERGE4APPSTORE_NGINX_SERVER_NAME`; mismatches are rejected before host changes.

## Existing host, new domain

1. Keep the old domain and TLS virtual host serving while setting up the new domain on the same listener.
2. Install the new TLS virtual host. Do not copy the managed snippet into it manually; deployment adds it transactionally.
3. Set the public-base-URL repository variable, and deploy main with `pause_cron: true`, `reconcile_profile: none` during a controlled migration window. Pausing cron does not stop webhook-triggered release actions.
4. Verify public health reports the intended SHA. Classic GitHub hook URLs are reconciled by the deployer. Update the GitHub App webhook URL separately if enabled. Keep it shadowed until verified.
5. Update Xcode Cloud callbacks and CI version-service URLs to the new base URL. Xcode callback URLs can contain a secret token: change them through a trusted session, never paste them into logs or issues.
6. Run an internal build and verify completion, notes, version reads and an empty delivery queue. Resume cron through a normal deployment only after validation.
7. Retain the old endpoint until all senders have migrated and their retries are drained. Then retire it deliberately.

The managed proxy snippet is global and shared by the two domain aliases. They must point to the same service and use the same prefix; do not repurpose the old alias for UAT.

## Replacement host

Treat the move as a stateful migration, not a fresh parallel deployment. Drain and stop writers on the source, take a consistent private backup, and restore durable deliveries, version state and required runtime state with correct ownership. Host/process lock identity and in-progress deployment journals need explicit migration handling; copying the whole state directory while processes run is not a safe migration procedure. Validate the restore on the target before changing senders. Keep exactly one active owner of production jobs and cron. A tested cross-host transfer/rollback procedure is still required before moving the live service; this PR only prepares endpoint and host configuration.

## Production and UAT

The existing development GitHub App may be promoted to production, preserving its installation, or retained as UAT. Its name is not a security boundary. Once promoted, use a separate App/key/webhook secret for experiments. UAT must use test repositories, separate Apple workflows or apps and credentials, and an independent state directory.

The generator's `--environment` value labels the bundle only. Current Actions deploy main and all tracked profiles. This PR does not add UAT deployment scheduling or profile selection. Service port, PM2/legacy process names, cron markers, logrotate and Nginx snippet names still assume one service installation per host. Use a separate host for an eventual second runtime; same-host dual production/UAT needs additional namespacing first. Never point this production workflow at an isolated UAT host and assume the environment label prevents production jobs.

See [secret-storage.md](secret-storage.md) for the SOPS/age proposal for our credentials and OpenBao plan for customer secrets.
