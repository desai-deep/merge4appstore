# Reusable Xcode Cloud workflow onboarding

Use the same PR, beta, and production archive workflows for any new app, with the app's own scheme, container, branches, Apple product/repository, and toolchain IDs. This packages the API-created Jams On Toast workflow into supported templates; no existing app IDs, workflow IDs, project paths, or schemes are embedded in the implementation.

The command is explicit and is not run by normal deployment, webhooks, or cron. Preview is the default. Applying creates or updates workflows and writes their returned IDs into the repository profile. It does not start builds, configure distribution groups, create the App Store app record, submit a version, or publish an app.

## Prerequisites

- Create the App Store app record and onboard its repository/product to Xcode Cloud first. This command requires an existing Apple `ciProduct` and connected primary `scmRepository`.
- Supply an API key authorized to manage that Xcode Cloud product, using the existing `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and base64 `APP_STORE_CONNECT_API_KEY_CONTENT` variables. Keep credentials outside profile YAML and Git.
- Select compatible `ciXcodeVersions` and `ciMacOsVersions` IDs. Do not copy toolchain IDs blindly from another team or assume the Xcode and macOS IDs are equal.
- The scheme must be shared in the app repo. The container path is relative to its repository root. For generated projects, retain the appropriate `ci_post_clone.sh` setup.

All discovery can use the public API: `/v1/ciProducts?include=app`, `/v1/ciProducts/{id}/primaryRepositories`, `/v1/ciXcodeVersions`, and `/v1/ciXcodeVersions/{id}/macOsVersions`. The planner checks that the selected product belongs to the app, its primary repository matches the profile GitHub repository, and the macOS version is compatible with the Xcode version. Missing products require initial Xcode Cloud setup; it will not substitute a similarly named app.

## Configure a new profile

Start with a profile that identifies the app but has no automation enabled:

```yaml
version: 1
instance: my-new-app
repository:
  owner: my-account
  name: my-new-app
  production_branch: main
  beta_branch: develop
versioning:
  initial_version: "1.0"
apps:
  prod:
    app_id: "APPLE_APP_ID"
    bundle_id: com.example.mynewapp
    name: My New App

workflow_onboarding:
  prod:
    product_id: APPLE_CI_PRODUCT_ID
    repository_id: APPLE_SCM_REPOSITORY_ID
    xcode_version_id: APPLE_XCODE_VERSION_ID
    mac_os_version_id: APPLE_MACOS_VERSION_ID
    scheme: My New App
    container_file_path: My New App.xcworkspace
    trigger_mode: managed
    workflows:
      pull_requests:
        template: pull_request
        name: Internal PR
      beta:
        template: beta
        name: Make Beta
      production:
        template: production
        name: Publish to App Store
```

Names may be omitted to use the defaults shown. Keys such as `pull_requests` are profile workflow aliases; use those same aliases when configuring build purposes and automation later. Configure only the templates you need. `workflow_onboarding` supports `prod`, `uat`, and `internal`; each target must have its own corresponding `apps` entry. Use `--app internal` or `--app uat` to reconcile that role explicitly. Separate app roles can choose different schemes, containers, products, repositories, and names.

### Trigger behavior

| Template | Archive audience | Branch | `managed` | `native` |
| --- | --- | --- | --- | --- |
| `pull_request` | `INTERNAL_ONLY` | PRs targeting the beta branch | Manual PR start | Automatic PR start with auto-cancel |
| `beta` | `APP_STORE_ELIGIBLE` | Beta branch | Manual branch start | Automatic branch start with auto-cancel |
| `production` | `APP_STORE_ELIGIBLE` | Production branch | Manual branch start | Automatic branch start with auto-cancel |

All actions use `ARCHIVE`, iOS, the configured scheme/container, a clean build, and require success. This matches the original API-created production archive action. `managed` is appropriate for merge4appstore-managed triggers; `native` lets Apple start builds directly. There is no `shadow` onboarding mode. Select a trigger mode deliberately and match the eventual `build.trigger_mode` and purpose overrides to it.

Templates own the workflow's name, description, archive actions, clean/enabled flags, container, toolchain and start conditions. An update explicitly clears other start conditions to avoid duplicate automatic and managed triggers. Existing properties outside those fields are left alone. No workflow is deleted, and workflows absent from the onboarding mapping are untouched. Test actions, TestFlight groups and other post-build settings are separate from these archive templates.

## Preview and apply

From the merge4appstore checkout:

```sh
# READ ONLY: prints create/update/reuse decisions and complete intended payloads.
npm run onboard:workflows -- --profile /path/to/my-new-app.yml

# Reconcile only when the preview is correct; writes the returned IDs into YAML.
npm run onboard:workflows -- --profile /path/to/my-new-app.yml --apply

# Optional private credential file and separate app role.
npm run onboard:workflows -- --profile /path/to/my-new-app.yml \
  --config /private/path/apple.env --app internal --apply
```

Environment credentials may be supplied without an `.env` file. `DRY_RUN=true` forces preview even if `--apply` is present. Preview never writes a profile.

Once all workflows have been verified, apply saves their IDs under `apps.<role>.workflows`, preserving YAML comments and unrelated fields. Then configure the existing `build.purposes` and `automation` sections using those aliases, following `profiles/example.yml`. Do not put unresolved workflow references into enabled build/automation configuration before onboarding: the normal profile validator rejects them.

## Reconciliation and recovery

- With a configured workflow ID, that workflow is authoritative; changing its template name updates it in place.
- Without an ID, one exact-name match within the selected product is adopted. Missing names are created; ambiguous/conflicting names fail the whole preflight before writes.
- Repeated apply reuses matching workflows. A timeout after creation triggers a read-back by name; POST is never automatically retried, avoiding duplicate creation after a lost response.
- Every create/update is read back and verified before its ID is returned. Failed or partial apply does not save a partial profile. Rerun to adopt the workflows already created and finish the remaining ones.
- A concurrent local profile edit prevents overwriting the YAML. Keep the edited file and rerun; exact-name discovery can recover the Apple IDs.
- Coordinate onboarding runs across machines. Apple's API has no cross-machine transaction for this multi-workflow operation. Do not run two apply operations against the same product at once.

The SDK exports `workflowDefinitions`, `planWorkflowOnboarding`, and `applyWorkflowOnboarding` for other onboarding tools. Planning requires the same validated repository profile and uses read requests only. Application accepts explicit API/profile objects, without changing global app selection or process environment.

## Verification

The tests cover native/managed starts and archive audiences, previews, idempotent reruns, renames, per-app ownership, ambiguity, partial failure recovery, lost POST responses, profile persistence, and API request shapes. The existing Jams production workflow's archive action, repository relationship and toolchain compatibility were read through Apple's API during implementation. No new workflow was created or existing workflow changed for verification.
