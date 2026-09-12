# Secret storage plan

Status: proposed architecture. The bootstrap PR does not migrate or rotate live credentials.

## Our deployments now: SOPS and age

Use SOPS with age for encrypted operator-managed configuration and backups. Keep encrypted files in a separate private operations repository, not this application repository. Separate production and UAT files and age identities; a UAT host must not decrypt production secrets. Public configuration (domains, app IDs, workflow IDs, repository IDs) belongs in ordinary configuration.

Provision the production age identity once through a trusted administrator session. Store it outside the application checkout with restrictive ownership and permissions, and keep an offline recovery copy separately. GitHub Actions should retain only deployment access, not Apple credentials or the GitHub App signing key. The service host decrypts only its environment's configuration. The existing deployer consumes private `.env` and encoded `.webhook.env` files; use those supported files for the first migration. Base64 encoding is not encryption. SOPS protects the stored configuration and backups; the materialized runtime files remain plaintext and must remain private. Runtime credential paths should later support a supervised `/run` mount if needed; do not put plaintext in an ephemeral location without accounting for cron and service restarts.

The VPS must be able to read credentials to use them. Encrypting a file on the same host as its decryption key does not protect against a compromised root account. Use a dedicated service host before customer onboarding, minimize human SSH access, and keep independently protected backups. Do not propagate secrets into PM2 saved environments, build subprocesses, logs, PRs, or command arguments. The current subprocess filtering and deployment checks remain in place.

Rotation is separate from code deployment: publish the replacement credential, verify authentication, coordinate active and retained rollback secret files, reload, then revoke the old provider credential. Re-encrypting SOPS data alone does not revoke a copied GitHub or Apple credential. Test restoring an encrypted backup plus recovery identity onto a replacement host.

## Customer credentials: OpenBao before onboarding

Use self-hosted OpenBao for runtime secret retrieval, policy enforcement, and auditing. Initially use its KV store for credentials and retain only opaque secret references and nonsecret metadata in the application database. Do not implement custom encryption or store customer keys in Git, even encrypted. An alternative for later scale is ciphertext in PostgreSQL with OpenBao Transit managing encryption; this is a separate implementation choice, not a requirement to start.

Proposed logical layout:

- `production/platform/github-app`: our GitHub App private key; never customer supplied.
- `production/tenants/<tenant-id>/apple/<connection-id>`: customer Apple credential.
- `production/tenants/<tenant-id>/webhooks/<connection-id>`: tenant-specific webhook/build credentials.
- Separate UAT mount, authentication roles and policies; no production policy inheritance.

Paths alone do not isolate customers. The authenticated application must resolve tenant ownership server-side, and a job must receive only the capability for its tenant's connection. Never let client input select an arbitrary secret path. Separate onboarding write privileges from job read privileges. Do not give every worker a wildcard credential to every tenant. A narrowly trusted broker may issue short-lived scoped access after checking the persisted tenant/job binding. Platform GitHub signing can be isolated behind that broker as well.

Customers install our GitHub App and select repositories; they do not upload GitHub App private keys. Apple authorization is separate. Apple team API keys are not scoped to one app; verify the credential's role and the supported individual-key alternative before accepting it. Do not describe profile routing as provider-enforced Apple isolation.

Keep GitHub installation tokens in memory and let them expire. Store long-lived Apple and platform keys in the secret manager. Expiry of an OpenBao read token does not revoke an Apple or GitHub credential that has already been retrieved. Revocation and deletion must include the upstream provider where applicable, active jobs and caches, and a documented encrypted-backup retention period.

## Operating OpenBao

No software subscription is needed for OpenBao, but hosting, updates, recovery and availability are our responsibility. Run it on a private endpoint, ideally on a separate host/security boundary from customer job workers. Never run development mode in production or give the application an administrative root token.

Choose an explicit unseal plan: manual unseal adds recovery work after a restart; automated unseal needs an independent trust anchor. Do not save all unseal material beside the encrypted database. Back up storage, protect recovery material independently, enable audit logging without secret values, test restore/unseal, and alert on failures. Start with a documented single-node availability tradeoff only if acceptable; design quorum/HA when the service needs it. If the manager is unavailable, queue/retry work rather than falling back to another tenant's credentials.

## References

- SOPS: https://github.com/getsops/sops
- OpenBao concepts and policies: https://openbao.org/docs/what-is-openbao/
- OpenBao seal and recovery: https://openbao.org/docs/concepts/seal/
- OpenBao Transit: https://openbao.org/docs/secrets/transit/
- Apple API keys: https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api
