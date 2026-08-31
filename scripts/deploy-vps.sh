#!/usr/bin/env bash

# Transactional VPS rollout for an immutable merge4appstore release.
# The workflow creates CANDIDATE_RELEASE with git archive while holding the
# deployment lock; this script validates, tests, starts, switches, and commits it.

set -Eeuo pipefail
umask 077
shopt -s nullglob

SERVICE_NAME="${MERGE4APPSTORE_PM2_NAME:-merge4appstore-webhooks-v2}"
LEGACY_SERVICE_NAME="merge4appstore-webhooks"
SERVICE_HOST="127.0.0.1"
SERVICE_PORT="8788"
PREPARE_TIMEOUT_MS="${MERGE4APPSTORE_PREPARE_TIMEOUT_MS:-45000}"
DRAIN_TIMEOUT_MS="${MERGE4APPSTORE_DRAIN_TIMEOUT_MS:-600000}"
LEGACY_DRAIN_QUIET_SECONDS="${MERGE4APPSTORE_LEGACY_DRAIN_QUIET_SECONDS:-30}"
PUBLIC_BASE_URL="${MERGE4APPSTORE_PUBLIC_BASE_URL:-https://api.runningorder.app/merge4appstore}"
NGINX_SERVER_NAME="${MERGE4APPSTORE_NGINX_SERVER_NAME:-api.runningorder.app}"
NGINX_SNIPPET="/etc/nginx/snippets/merge4appstore-webhooks.conf"
NGINX_OBSERVABILITY_CONFIG="/etc/nginx/conf.d/merge4appstore-observability.conf"
MIN_FREE_BYTES="${MERGE4APPSTORE_MIN_FREE_BYTES:-1073741824}"
MIN_FREE_PERCENT="${MERGE4APPSTORE_MIN_FREE_PERCENT:-10}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_environment() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "$name is required"
}

for required_name in \
  DEPLOY_DIR DEPLOY_SHA DEPLOY_RUN_ID CANDIDATE_RELEASE \
  MERGE4APPSTORE_STATE_DIR PAUSE_CRON RECONCILE_PROFILE; do
  require_environment "$required_name"
done

case "$DEPLOY_SHA" in
  ''|*[!0-9a-fA-F]*) fail "DEPLOY_SHA must be a hexadecimal commit" ;;
esac
[ "${#DEPLOY_SHA}" -eq 40 ] || fail "DEPLOY_SHA must be a full SHA-1"
case "$DEPLOY_RUN_ID" in
  ''|*[!0-9-]*) fail "DEPLOY_RUN_ID is invalid" ;;
esac
case "$PAUSE_CRON" in true|false) ;; *) fail "PAUSE_CRON must be true or false" ;; esac
case "$RECONCILE_PROFILE" in none|jamsontoast|runningorder) ;; *) fail "Unsupported reconciliation profile: $RECONCILE_PROFILE" ;; esac
case "$NGINX_SERVER_NAME" in
  ''|.*|*.|*[!A-Za-z0-9.-]*) fail "MERGE4APPSTORE_NGINX_SERVER_NAME must be one DNS hostname" ;;
esac
case "$PREPARE_TIMEOUT_MS" in ''|*[!0-9]*) fail "MERGE4APPSTORE_PREPARE_TIMEOUT_MS must be an integer" ;; esac
case "$DRAIN_TIMEOUT_MS" in ''|*[!0-9]*) fail "MERGE4APPSTORE_DRAIN_TIMEOUT_MS must be an integer" ;; esac
case "$LEGACY_DRAIN_QUIET_SECONDS" in ''|*[!0-9]*) fail "MERGE4APPSTORE_LEGACY_DRAIN_QUIET_SECONDS must be an integer" ;; esac
case "$MIN_FREE_BYTES" in ''|*[!0-9]*) fail "MERGE4APPSTORE_MIN_FREE_BYTES must be an integer" ;; esac
case "$MIN_FREE_PERCENT" in ''|*[!0-9]*) fail "MERGE4APPSTORE_MIN_FREE_PERCENT must be an integer" ;; esac
if [ "$PREPARE_TIMEOUT_MS" -le 0 ] || [ "$PREPARE_TIMEOUT_MS" -gt 45000 ]; then
  fail "MERGE4APPSTORE_PREPARE_TIMEOUT_MS must be between 1 and 45000"
fi
if [ "$DRAIN_TIMEOUT_MS" -lt 1000 ] || [ "$DRAIN_TIMEOUT_MS" -gt 3600000 ]; then
  fail "MERGE4APPSTORE_DRAIN_TIMEOUT_MS must be between 1000 and 3600000"
fi
if [ "$LEGACY_DRAIN_QUIET_SECONDS" -lt 5 ] || [ "$LEGACY_DRAIN_QUIET_SECONDS" -gt 300 ]; then
  fail "MERGE4APPSTORE_LEGACY_DRAIN_QUIET_SECONDS must be between 5 and 300"
fi
if [ "${#MIN_FREE_BYTES}" -gt 18 ] || [ "$MIN_FREE_BYTES" -lt 1073741824 ]; then
  fail "MERGE4APPSTORE_MIN_FREE_BYTES must be at least 1073741824"
fi
if [ "${#MIN_FREE_PERCENT}" -gt 3 ] || [ "$MIN_FREE_PERCENT" -lt 10 ] || [ "$MIN_FREE_PERCENT" -gt 100 ]; then
  fail "MERGE4APPSTORE_MIN_FREE_PERCENT must be between 10 and 100"
fi
case "$DEPLOY_DIR" in /*) ;; *) fail "DEPLOY_DIR must be absolute" ;; esac
case "$MERGE4APPSTORE_STATE_DIR" in /*) ;; *) fail "MERGE4APPSTORE_STATE_DIR must be absolute" ;; esac
case "$CANDIDATE_RELEASE" in "$MERGE4APPSTORE_STATE_DIR/releases/$DEPLOY_SHA-$DEPLOY_RUN_ID") ;;
  *) fail "CANDIDATE_RELEASE is outside the expected immutable release path" ;;
esac

for command_name in node npm pm2 curl gh git flock nginx systemctl crontab stat readlink sync timeout cmp ps logrotate gzip tail; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name not found"
done
resolve_required_executable() {
  local name="$1"
  local executable
  executable="$(readlink -f -- "$(command -v "$name")")" || return 1
  case "$executable" in /*) ;; *) return 1 ;; esac
  case "$executable" in *:*|*%*|*$'\n'*) return 1 ;; esac
  [ -f "$executable" ] && [ -x "$executable" ] || return 1
  printf '%s' "$executable"
}
NODE_BINARY="$(resolve_required_executable node)" || fail "Could not resolve a safe Node.js executable"
GH_BINARY="$(resolve_required_executable gh)" || fail "Could not resolve a safe GitHub CLI executable"
GIT_BINARY="$(resolve_required_executable git)" || fail "Could not resolve a safe Git executable"
FLOCK_BINARY="$(resolve_required_executable flock)" || fail "Could not resolve a safe flock executable"
LOGROTATE_BINARY="$(resolve_required_executable logrotate)" || fail "Could not resolve a safe logrotate executable"
CRON_COMMAND_PATH=""
for command_directory in \
  "$(dirname -- "$NODE_BINARY")" \
  "$(dirname -- "$GH_BINARY")" \
  "$(dirname -- "$GIT_BINARY")" \
  "$(dirname -- "$FLOCK_BINARY")" \
  "$(dirname -- "$LOGROTATE_BINARY")" \
  /usr/bin /bin; do
  case ":$CRON_COMMAND_PATH:" in *":$command_directory:"*) continue ;; esac
  CRON_COMMAND_PATH="${CRON_COMMAND_PATH:+$CRON_COMMAND_PATH:}$command_directory"
done
"$NODE_BINARY" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20) {
    console.error(`Node.js 20.0.0 or newer is required; found ${process.versions.node}`);
    process.exit(1);
  }
'
validate_git_version() {
  local version_output
  version_output="$("$GIT_BINARY" --version)" || return 1
  GIT_VERSION_OUTPUT="$version_output" "$NODE_BINARY" -e '
    const match = /^git version (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(process.env.GIT_VERSION_OUTPUT || "");
    if (!match) throw new Error(`Could not parse Git version: ${process.env.GIT_VERSION_OUTPUT || "empty"}`);
    const [major, minor, patch] = match.slice(1).map(Number);
    const maintenanceFloors = new Map([[39, 4], [40, 2], [41, 1], [42, 2], [43, 4], [44, 1], [45, 1]]);
    const supported = major > 2 || (major === 2
      && (minor >= 46 || (maintenanceFloors.has(minor) && patch >= maintenanceFloors.get(minor))));
    if (!supported) {
      throw new Error(`Git ${major}.${minor}.${patch} lacks reliable GIT_NO_LAZY_FETCH support`);
    }
  '
}
validate_git_version || fail "Git lacks required GIT_NO_LAZY_FETCH support"
PM2_STARTUP_UNIT="${MERGE4APPSTORE_PM2_STARTUP_UNIT:-pm2-$(id -un).service}"
case "$PM2_STARTUP_UNIT" in
  *.service) ;;
  *) fail "MERGE4APPSTORE_PM2_STARTUP_UNIT must name one systemd service" ;;
esac
case "$PM2_STARTUP_UNIT" in
  *[!A-Za-z0-9_.@-]*) fail "MERGE4APPSTORE_PM2_STARTUP_UNIT contains unsafe characters" ;;
esac

STATE_DIR="$MERGE4APPSTORE_STATE_DIR"
RELEASES_DIR="$STATE_DIR/releases"
SECRETS_DIR="$STATE_DIR/secrets"
LOGS_DIR="$STATE_DIR/logs"
JOBS_DIR="$STATE_DIR/jobs"
TRANSACTIONS_DIR="$STATE_DIR/transactions"
DELIVERY_PAUSE_FILE="$STATE_DIR/delivery.pause"
NGINX_ACCESS_LOG="$LOGS_DIR/nginx-upstream.log"
LOGROTATE_CONFIG="$STATE_DIR/logrotate.conf"
LOGROTATE_STATE="$STATE_DIR/logrotate.state"
LOGROTATE_LOCK="$STATE_DIR/logrotate.lock"
CONTROL_ENV="$DEPLOY_DIR/.env"
CONTROL_WEBHOOK_ENV="$DEPLOY_DIR/.webhook.env"

for configuration_path in "$DEPLOY_DIR" "$STATE_DIR" "${PM2_HOME:-$HOME/.pm2}"; do
  case "$configuration_path" in
    *$'\n'*|*$'\r'*|*\\*|*\"*|*%*|*'$'*) fail "Configuration path contains characters unsafe for generated service configuration" ;;
  esac
done

ensure_private_directory() {
  local directory="$1"
  if [ -L "$directory" ]; then
    fail "Private directory is a symlink: $directory"
  fi
  if [ -e "$directory" ]; then
    [ -d "$directory" ] || fail "Private path is not a directory: $directory"
  else
    mkdir -m 700 -- "$directory"
  fi
  [ -O "$directory" ] || fail "Private directory is not owned by the deployment user: $directory"
  local permissions
  permissions="$(stat -c '%a' "$directory")"
  [ "$permissions" = "700" ] || fail "Private directory must have mode 700: $directory"
}

validate_private_file() {
  local file="$1"
  [ ! -L "$file" ] || { echo "ERROR: Private file is a symlink: $file" >&2; return 1; }
  [ -f "$file" ] || { echo "ERROR: Private file is missing: $file" >&2; return 1; }
  [ -O "$file" ] || { echo "ERROR: Private file is not owned by the deployment user: $file" >&2; return 1; }
  local permissions
  permissions="$(stat -c '%a' "$file")" || return 1
  [ "$permissions" = "600" ] \
    || { echo "ERROR: Private file must have mode 600: $file" >&2; return 1; }
}

validate_owned_regular_file() {
  local file="$1"
  [ ! -L "$file" ] || return 1
  [ -f "$file" ] || return 1
  [ -O "$file" ]
}

secure_migratable_private_file() {
  local file="$1"
  local permissions numeric_permissions
  validate_owned_regular_file "$file" \
    || { echo "ERROR: Private control file is missing, linked, or not owned: $file" >&2; return 1; }
  permissions="$(stat -c '%a' "$file")" || return 1
  case "$permissions" in
    ''|*[!0-7]*) echo "ERROR: Private control file has invalid permissions: $file" >&2; return 1 ;;
  esac
  numeric_permissions=$((8#$permissions))
  if [ "$numeric_permissions" -gt $((8#777)) ] \
    || [ $((numeric_permissions & 8#400)) -eq 0 ] \
    || [ $((numeric_permissions & 8#133)) -ne 0 ]; then
    echo "ERROR: Private control file is writable by another user, executable, or unreadable by its owner: $file" >&2
    return 1
  fi
  if [ "$permissions" != "600" ]; then
    echo "Tightening legacy private control file to mode 0600: $file"
    chmod 600 "$file" || return 1
    sync -f "$file" || return 1
  fi
  validate_private_file "$file"
}

ensure_private_log_file() {
  local file="$1"
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ ! -L "$file" ] && [ -f "$file" ] && [ -O "$file" ] \
      || { echo "ERROR: Unsafe managed log file: $file" >&2; return 1; }
    chmod 600 -- "$file" || return 1
  else
    (umask 077; : > "$file") || return 1
  fi
  validate_private_file "$file"
}

ensure_disk_headroom() {
  local path="$1"
  DISK_PATH="$path" DISK_MIN_FREE_BYTES="$MIN_FREE_BYTES" \
    DISK_MIN_FREE_PERCENT="$MIN_FREE_PERCENT" "$NODE_BINARY" -e '
    const fs = require("fs");
    const absolute = BigInt(process.env.DISK_MIN_FREE_BYTES);
    const percent = BigInt(process.env.DISK_MIN_FREE_PERCENT);
    if (absolute <= 0n || percent <= 0n || percent > 100n) {
      throw new Error("Invalid disk-headroom threshold");
    }
    const stats = fs.statfsSync(process.env.DISK_PATH);
    const available = BigInt(stats.bavail) * BigInt(stats.bsize);
    const total = BigInt(stats.blocks) * BigInt(stats.bsize);
    const percentage = (total * percent + 99n) / 100n;
    const required = absolute > percentage ? absolute : percentage;
    console.log(`disk_available_bytes=${available} disk_total_bytes=${total} disk_required_bytes=${required}`);
    if (available < required) {
      throw new Error(`Insufficient disk headroom: ${available} bytes available; ${required} required`);
    }
  '
}

install_atomic_copy() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local directory temporary source_uid source_gid
  validate_owned_regular_file "$source" || return 1
  source_uid="$(stat -c '%u' "$source")" || return 1
  source_gid="$(stat -c '%g' "$source")" || return 1
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ ! -L "$destination" ] && [ -f "$destination" ] || return 1
  fi
  directory="$(dirname -- "$destination")" || return 1
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  temporary="$(mktemp "$directory/.merge4appstore-managed.XXXXXX")" || return 1
  if ! cp -p -- "$source" "$temporary" || ! chmod "$mode" "$temporary" \
    || [ "$(stat -c '%u:%g:%a' "$temporary" 2>/dev/null || true)" != "$source_uid:$source_gid:$mode" ] \
    || ! sync -f "$temporary" || ! mv -T -- "$temporary" "$destination" \
    || ! sync -f "$directory"; then
    rm -f -- "$temporary"
    return 1
  fi
  validate_owned_regular_file "$destination" \
    && [ "$(stat -c '%u:%g:%a' "$destination" 2>/dev/null || true)" = "$source_uid:$source_gid:$mode" ] \
    && cmp -s -- "$source" "$destination"
}

restore_optional_managed_file() {
  local source="$1"
  local destination="$2"
  local existed="$3"
  local mode="$4"
  case "$existed" in
    1) install_atomic_copy "$source" "$destination" "$mode" ;;
    0)
      if [ -e "$destination" ] || [ -L "$destination" ]; then
        [ ! -L "$destination" ] && [ -f "$destination" ] || return 1
        rm -f -- "$destination" || return 1
        sync -f "$(dirname -- "$destination")" || return 1
      fi
      ;;
    *) return 1 ;;
  esac
}

write_nginx_observability_configuration() {
  local output="$1"
  cat > "$output" <<'NGINX'
log_format merge4appstore_upstream_v1 escape=json
  '{"timestamp":"$time_iso8601","request_id":"$request_id","method":"$request_method","status":"$status","upstream_status":"$upstream_status","upstream_addr":"$upstream_addr","upstream_connect_time":"$upstream_connect_time","upstream_header_time":"$upstream_header_time","upstream_response_time":"$upstream_response_time","request_time":"$request_time","bytes_sent":"$bytes_sent"}';
NGINX
}

write_logrotate_configuration() {
  local output="$1"
  local pm2_home="${PM2_HOME:-$HOME/.pm2}"
  case "$pm2_home" in /*) ;; *) return 1 ;; esac
  printf '"%s/*.log" "%s/pm2.log" "%s/agent.log" "%s/logs/%s-out*.log" "%s/logs/%s-error*.log" "%s/logs/%s-out*.log" "%s/logs/%s-error*.log" {\n' \
    "$LOGS_DIR" "$pm2_home" "$pm2_home" \
    "$pm2_home" "$SERVICE_NAME" "$pm2_home" "$SERVICE_NAME" \
    "$pm2_home" "$LEGACY_SERVICE_NAME" "$pm2_home" "$LEGACY_SERVICE_NAME" > "$output" || return 1
  cat >> "$output" <<'LOGROTATE'
  daily
  maxsize 10M
  rotate 7
  maxage 14
  missingok
  notifempty
  compress
  delaycompress
  copytruncate
}
LOGROTATE
}

validate_logrotate_configuration() {
  local configuration="$1"
  local debug_state="$2"
  validate_private_file "$configuration" || return 1
  rm -f -- "$debug_state" || return 1
  "$LOGROTATE_BINARY" --debug --state "$debug_state" "$configuration" >/dev/null
}

validate_active_logrotate_configuration() {
  local configuration="$1"
  validate_private_file "$configuration" || return 1
  validate_private_file "$LOGROTATE_STATE" || return 1
  validate_private_file "$LOGROTATE_LOCK" || return 1
  "$LOGROTATE_BINARY" --debug --state "$LOGROTATE_STATE" "$configuration" >/dev/null
}

run_logrotate_configuration() {
  local configuration="$1"
  validate_active_logrotate_configuration "$configuration" || return 1
  "$FLOCK_BINARY" -w 30 "$LOGROTATE_LOCK" \
    "$LOGROTATE_BINARY" --state "$LOGROTATE_STATE" "$configuration" >/dev/null || return 1
  validate_active_logrotate_configuration "$configuration"
}

validate_state_link() {
  local link="$1"
  local parent="$2"
  if [ -L "$link" ]; then
    local target
    target="$(readlink -f -- "$link")"
    case "$target" in "$parent"/*) ;; *) fail "State link escapes $parent: $link" ;; esac
    [ -e "$target" ] || fail "State link is dangling: $link"
    printf '%s' "$target"
  elif [ -e "$link" ]; then
    fail "State pointer must be a symlink: $link"
  fi
}

replace_link() {
  local target="$1"
  local link="$2"
  local temporary="$link.new.$DEPLOY_RUN_ID.$$"
  rm -f -- "$temporary" || return 1
  ln -s -- "$target" "$temporary" || return 1
  mv -Tf -- "$temporary" "$link" || return 1
}

restore_link() {
  local link="$1"
  local target="$2"
  if [ -L "$link" ]; then
    rm -f -- "$link" || return 1
  elif [ -e "$link" ]; then
    echo "WARNING: Refusing to replace unexpected non-symlink $link during rollback" >&2
    return 1
  fi
  if [ -n "$target" ]; then
    replace_link "$target" "$link" || return 1
  fi
  if [ -n "$target" ]; then
    [ -L "$link" ] && [ "$(readlink -f -- "$link")" = "$target" ] || return 1
  else
    [ ! -e "$link" ] && [ ! -L "$link" ] || return 1
  fi
  return 0
}

for directory in "$STATE_DIR" "$RELEASES_DIR" "$SECRETS_DIR" "$LOGS_DIR" "$JOBS_DIR" "$TRANSACTIONS_DIR"; do
  ensure_private_directory "$directory"
done
for managed_log in "$NGINX_ACCESS_LOG" "$LOGS_DIR/webhook-out.log" "$LOGS_DIR/webhook-error.log" \
  "$LOGS_DIR/cron.log" "$LOGS_DIR/logrotate.log"; do
  ensure_private_log_file "$managed_log" || fail "Could not secure managed log file: $managed_log"
done
# An empty state file is a supported first-run state. Precreate it because
# logrotate otherwise creates custom state files as 0640 instead of private 0600.
ensure_private_log_file "$LOGROTATE_STATE" || fail "Could not secure private logrotate state"
ensure_private_log_file "$LOGROTATE_LOCK" || fail "Could not secure private logrotate lock"
validate_private_file "$STATE_DIR/.merge4appstore-state"
[ "$(cat "$STATE_DIR/.merge4appstore-state")" = "merge4appstore-state-v1" ] \
  || fail "Persistent state directory has an invalid ownership marker"

[ -d "$CANDIDATE_RELEASE" ] && [ ! -L "$CANDIDATE_RELEASE" ] \
  || fail "Candidate release is missing or unsafe"
[ -O "$CANDIDATE_RELEASE" ] || fail "Candidate release is not owned by the deployment user"
[ "$(cat "$CANDIDATE_RELEASE/.merge4appstore-release" 2>/dev/null || true)" = "merge4appstore-release-v1" ] \
  || fail "Candidate release marker is invalid"
[ "$(cat "$CANDIDATE_RELEASE/.merge4appstore-deployment-sha" 2>/dev/null || true)" = "$DEPLOY_SHA" ] \
  || fail "Candidate release SHA is invalid"
secure_migratable_private_file "$CONTROL_ENV"
if [ -L "$CONTROL_WEBHOOK_ENV" ]; then
  resolved_control_secret="$(readlink -f -- "$CONTROL_WEBHOOK_ENV")" \
    || fail "Control webhook environment link is dangling"
  case "$resolved_control_secret" in
    "$SECRETS_DIR"/*) ;;
    *) fail "Control webhook environment link escapes the private secrets directory" ;;
  esac
  secure_migratable_private_file "$resolved_control_secret"
else
  secure_migratable_private_file "$CONTROL_WEBHOOK_ENV"
fi

transaction_dir="$(mktemp -d "$TRANSACTIONS_DIR/$DEPLOY_RUN_ID.XXXXXX")"
printf 'merge4appstore-deployment-transaction-v1\n' > "$transaction_dir/.merge4appstore-transaction"
printf 'created\n' > "$transaction_dir/phase"
chmod 600 "$transaction_dir/.merge4appstore-transaction" "$transaction_dir/phase"
sync -f "$transaction_dir/.merge4appstore-transaction"
sync -f "$transaction_dir/phase"
sync -f "$transaction_dir"
candidate_secret="$SECRETS_DIR/webhook-$DEPLOY_RUN_ID.env"
candidate_secret_new="$candidate_secret.new"
nginx_config=""
nginx_config_backup=""
snippet_existed=0
had_v2=0
had_legacy=0
legacy_sha=""
topology_snapshotted=0
rollback_preserve=0

old_current="$(validate_state_link "$STATE_DIR/current" "$RELEASES_DIR")"
old_previous="$(validate_state_link "$STATE_DIR/previous" "$RELEASES_DIR")"
old_current_secret="$(validate_state_link "$STATE_DIR/current-webhook.env" "$SECRETS_DIR")"
old_previous_secret="$(validate_state_link "$STATE_DIR/previous-webhook.env" "$SECRETS_DIR")"

write_transaction_value_for() {
  local destination="$1"
  local name="$2"
  local value="$3"
  printf '%s\n' "$value" > "$destination/$name.new" || return 1
  chmod 600 "$destination/$name.new" || return 1
  sync -f "$destination/$name.new" || return 1
  mv -Tf -- "$destination/$name.new" "$destination/$name" || return 1
  sync -f "$destination"
}

write_transaction_value() {
  local name="$1"
  local value="$2"
  write_transaction_value_for "$transaction_dir" "$name" "$value"
}

write_transaction_phase() {
  write_transaction_value phase "$1" || return 1
  sync -f "$transaction_dir"
}

write_transaction_phase_for() {
  local destination="$1"
  local phase="$2"
  write_transaction_value_for "$destination" phase "$phase" || return 1
  sync -f "$destination"
}

write_transaction_value candidate-release "$CANDIDATE_RELEASE"
write_transaction_value candidate-secret "$candidate_secret"
write_transaction_value candidate-sha "$DEPLOY_SHA"
write_transaction_value old-current "$old_current"
write_transaction_value old-previous "$old_previous"
write_transaction_value old-current-secret "$old_current_secret"
write_transaction_value old-previous-secret "$old_previous_secret"
sync -f "$transaction_dir"

control_secret_kind="missing"
control_secret_target=""
if [ -L "$CONTROL_WEBHOOK_ENV" ]; then
  control_secret_kind="link"
  control_secret_target="$(readlink -- "$CONTROL_WEBHOOK_ENV")"
  [ -f "$CONTROL_WEBHOOK_ENV" ] || fail "Control webhook environment link is dangling"
  resolved_control_secret="$(readlink -f -- "$CONTROL_WEBHOOK_ENV")"
  case "$resolved_control_secret" in "$SECRETS_DIR"/*) ;; *) fail "Control webhook environment link escapes the private secrets directory" ;; esac
  validate_private_file "$resolved_control_secret"
elif [ -e "$CONTROL_WEBHOOK_ENV" ]; then
  validate_private_file "$CONTROL_WEBHOOK_ENV"
  control_secret_kind="file"
  install -m 600 -- "$CONTROL_WEBHOOK_ENV" "$transaction_dir/control-webhook.env"
  sync -f "$transaction_dir/control-webhook.env"
  cmp -s -- "$CONTROL_WEBHOOK_ENV" "$transaction_dir/control-webhook.env" \
    || fail "Control webhook environment snapshot does not match its source"
else
  fail "Control webhook environment is missing: $CONTROL_WEBHOOK_ENV"
fi
write_transaction_value control-secret-kind "$control_secret_kind"
write_transaction_value control-secret-target "$control_secret_target"
sync -f "$transaction_dir"

secure_pm2_home() {
  local pm2_home="${PM2_HOME:-$HOME/.pm2}"
  if [ -e "$pm2_home" ]; then
    [ ! -L "$pm2_home" ] \
      || { echo "ERROR: PM2 home is a symlink: $pm2_home" >&2; return 1; }
    [ -d "$pm2_home" ] && [ -O "$pm2_home" ] \
      || { echo "ERROR: PM2 home is not a private owned directory" >&2; return 1; }
    chmod 700 -- "$pm2_home" || return 1
    local dump_file
    for dump_file in "$pm2_home/dump.pm2" "$pm2_home/dump.pm2.bak"; do
      if [ -e "$dump_file" ]; then
        [ ! -L "$dump_file" ] && [ -f "$dump_file" ] && [ -O "$dump_file" ] \
          || { echo "ERROR: Unsafe PM2 dump file: $dump_file" >&2; return 1; }
        chmod 600 -- "$dump_file" || return 1
        sync -f "$dump_file" || return 1
      fi
    done
  fi
}

validate_pm2_dumps_no_secrets() {
  local pm2_home="${PM2_HOME:-$HOME/.pm2}"
  local dump_file
  for dump_file in "$pm2_home/dump.pm2" "$pm2_home/dump.pm2.bak"; do
    [ -e "$dump_file" ] || continue
    PM2_DUMP_FILE="$dump_file" PM2_SERVICE_NAME="$SERVICE_NAME" \
      PM2_LEGACY_SERVICE_NAME="$LEGACY_SERVICE_NAME" "$NODE_BINARY" -e '
      const fs = require("fs");
      const file = process.env.PM2_DUMP_FILE;
      const document = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(document)) throw new Error(`PM2 dump ${file} must contain an array`);
      const managedNames = new Set([
        process.env.PM2_SERVICE_NAME,
        process.env.PM2_LEGACY_SERVICE_NAME,
      ]);
      const forbidden = name => (
        name === "GH_TOKEN"
        || name === "GH_WEBHOOK_SECRET"
        || name === "XCODE_CLOUD_WEBHOOK_TOKEN"
        || name.startsWith("APP_STORE_CONNECT_API_")
        || name.startsWith("MERGE4APPSTORE_BUILD_TOKEN_")
      );
      const inspect = value => {
        if (!value || typeof value !== "object") return;
        for (const [name, child] of Object.entries(value)) {
          if (forbidden(name)) {
            throw new Error(`PM2 dump ${file} persisted forbidden secret ${name}`);
          }
          inspect(child);
        }
      };
      for (const processInfo of document) {
        if (processInfo?.name === process.env.PM2_LEGACY_SERVICE_NAME) {
          throw new Error(`PM2 dump ${file} still contains the retired legacy process`);
        }
        if (managedNames.has(processInfo?.name)) inspect(processInfo);
      }
    ' || return 1
  done
}

persist_pm2_without_legacy_secrets() {
  [ "$(pm2_app_count "$LEGACY_SERVICE_NAME")" = "0" ] || return 1
  # PM2 copies the previous dump into dump.pm2.bak before each save. The first
  # save removes the legacy process from the current dump; the second replaces
  # its secret-bearing backup with that clean topology as well.
  pm2 save --force >/dev/null || return 1
  pm2 save --force >/dev/null || return 1
  secure_pm2_home || return 1
  validate_pm2_dumps_no_secrets || return 1
}

read_process_environment_value() {
  local pid="$1"
  local name="$2"
  PROCESS_ENVIRONMENT_FILE="/proc/$pid/environ" PROCESS_ENVIRONMENT_NAME="$name" "$NODE_BINARY" -e '
    const fs = require("fs");
    const prefix = `${process.env.PROCESS_ENVIRONMENT_NAME}=`;
    const entry = fs.readFileSync(process.env.PROCESS_ENVIRONMENT_FILE, "utf8")
      .split("\0")
      .find(value => value.startsWith(prefix));
    if (entry) process.stdout.write(entry.slice(prefix.length));
  '
}

read_pm2_daemon_executable() {
  readlink -f -- "/proc/$1/exe"
}

validate_pm2_startup_contract() {
  local pm2_home="${PM2_HOME:-$HOME/.pm2}"
  local deployment_user enabled active unit_user main_pid daemon_pid
  local daemon_executable daemon_pm2_home expected_pm2_home exec_start
  case "$pm2_home" in /*) ;; *) { echo "ERROR: PM2_HOME must be absolute" >&2; return 1; } ;; esac
  [ -d "$pm2_home" ] && [ ! -L "$pm2_home" ] && [ -O "$pm2_home" ] \
    || { echo "ERROR: PM2_HOME is not an owned real directory: $pm2_home" >&2; return 1; }
  expected_pm2_home="$(readlink -f -- "$pm2_home")" || return 1
  deployment_user="$(id -un)" || return 1
  enabled="$(systemctl is-enabled "$PM2_STARTUP_UNIT" 2>/dev/null || true)"
  [ "$enabled" = "enabled" ] \
    || { echo "ERROR: PM2 startup unit is not durably enabled: $PM2_STARTUP_UNIT" >&2; return 1; }
  active="$(systemctl is-active "$PM2_STARTUP_UNIT" 2>/dev/null || true)"
  [ "$active" = "active" ] \
    || { echo "ERROR: PM2 startup unit is not active: $PM2_STARTUP_UNIT" >&2; return 1; }
  unit_user="$(systemctl show "$PM2_STARTUP_UNIT" --property=User --value)" || return 1
  [ "$unit_user" = "$deployment_user" ] \
    || { echo "ERROR: $PM2_STARTUP_UNIT runs as $unit_user, expected $deployment_user" >&2; return 1; }
  main_pid="$(systemctl show "$PM2_STARTUP_UNIT" --property=MainPID --value)" || return 1
  case "$main_pid" in ''|*[!0-9]*) { echo "ERROR: $PM2_STARTUP_UNIT has no valid MainPID" >&2; return 1; } ;; esac
  [ "$main_pid" -gt 1 ] || return 1
  daemon_pid="$(cat "$pm2_home/pm2.pid" 2>/dev/null || true)"
  [ "$daemon_pid" = "$main_pid" ] \
    || { echo "ERROR: $PM2_STARTUP_UNIT does not own the active PM2 daemon" >&2; return 1; }
  daemon_executable="$(read_pm2_daemon_executable "$main_pid")" || return 1
  [ "$daemon_executable" = "$NODE_BINARY" ] \
    || { echo "ERROR: PM2 daemon uses $daemon_executable, expected Node.js runtime $NODE_BINARY" >&2; return 1; }
  daemon_pm2_home="$(read_process_environment_value "$main_pid" PM2_HOME)" || return 1
  [ -n "$daemon_pm2_home" ] && [ "$(readlink -f -- "$daemon_pm2_home")" = "$expected_pm2_home" ] \
    || { echo "ERROR: PM2 startup unit does not use $expected_pm2_home" >&2; return 1; }
  exec_start="$(systemctl show "$PM2_STARTUP_UNIT" --property=ExecStart --value)" || return 1
  case "$exec_start" in *pm2*resurrect*) ;; *) { echo "ERROR: $PM2_STARTUP_UNIT does not resurrect the PM2 dump" >&2; return 1; } ;; esac
}

configure_process_environment() {
  local release="$1"
  local secret_file="$2"
  local deployment_sha="$3"
  export MERGE4APPSTORE_PM2_NAME="$SERVICE_NAME"
  export MERGE4APPSTORE_ENV="$CONTROL_ENV"
  export MERGE4APPSTORE_WEBHOOK_ENV="$secret_file"
  export MERGE4APPSTORE_STATE_DIR="$STATE_DIR"
  export MERGE4APPSTORE_DEPLOY_SHA="$deployment_sha"
  export MERGE4APPSTORE_PREPARE_TIMEOUT_MS="$PREPARE_TIMEOUT_MS"
  export MERGE4APPSTORE_DRAIN_TIMEOUT_MS="$DRAIN_TIMEOUT_MS"
  export MERGE4APPSTORE_DELIVERY_PAUSE_FILE="$DELIVERY_PAUSE_FILE"
  export WEBHOOK_AUTOSTART=true WEBHOOK_HOST="$SERVICE_HOST" WEBHOOK_PORT="$SERVICE_PORT"
  export NODE_ENV=production

  # Secrets are loaded from private files by the child. They must never enter
  # PM2's process environment or dump.pm2.
  local environment_name
  while IFS='=' read -r environment_name _; do
    case "$environment_name" in
      APP_STORE_CONNECT_API_*|GH_TOKEN|GH_WEBHOOK_SECRET|XCODE_CLOUD_WEBHOOK_TOKEN|MERGE4APPSTORE_BUILD_TOKEN_*|BUILD_*|RECONCILE_METADATA)
        unset "$environment_name"
        ;;
    esac
  done < <(env)
  # Production workers must never inherit a shell or job's simulation/context
  # flags. Individual webhook jobs add only the context they actually require.
  export DRY_RUN=false RECONCILE_METADATA=false
  export EXPECTED_PM2_CWD="$release"
  export EXPECTED_PM2_SCRIPT="$release/webhook-server.js"
  export EXPECTED_PM2_SECRET_FILE="$secret_file"
  export EXPECTED_PM2_SHA="$deployment_sha"
  export EXPECTED_PM2_OUT_LOG="$LOGS_DIR/webhook-out.log"
  export EXPECTED_PM2_ERROR_LOG="$LOGS_DIR/webhook-error.log"
  unset EXPECTED_PM2_IDS
}

pm2_app_ids() {
  local name="$1"
  pm2 jlist | PM2_APP_NAME="$name" "$NODE_BINARY" -e '
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const ids = JSON.parse(source || "[]")
        .filter(item => item.name === process.env.PM2_APP_NAME)
        .map(item => item.pm_id)
        .sort((left, right) => left - right);
      if (ids.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(ids).size !== ids.length) {
        throw new Error(`Unsafe PM2 worker IDs for ${process.env.PM2_APP_NAME}`);
      }
      process.stdout.write(ids.join(","));
    });
  '
}

pm2_new_app_ids() {
  local name="$1"
  local existing_ids="$2"
  pm2 jlist | PM2_APP_NAME="$name" PM2_EXISTING_IDS="$existing_ids" "$NODE_BINARY" -e '
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const existingSource = process.env.PM2_EXISTING_IDS || "";
      if (existingSource && !/^\d+(?:,\d+)*$/.test(existingSource)) {
        throw new Error("Unsafe existing PM2 worker IDs");
      }
      const existing = new Set(existingSource ? existingSource.split(",").map(Number) : []);
      if ([...existing].some(id => !Number.isSafeInteger(id) || id < 0)
        || existing.size !== (existingSource ? existingSource.split(",").length : 0)) {
        throw new Error("Unsafe existing PM2 worker IDs");
      }
      const managedIds = JSON.parse(source || "[]")
        .filter(item => item.name === process.env.PM2_APP_NAME)
        .map(item => item.pm_id);
      if (managedIds.some(id => !Number.isSafeInteger(id) || id < 0)
        || new Set(managedIds).size !== managedIds.length) {
        throw new Error(`Unsafe PM2 worker IDs for ${process.env.PM2_APP_NAME}`);
      }
      const missing = [...existing].filter(id => !managedIds.includes(id));
      if (missing.length > 0) {
        throw new Error(`Captured ${process.env.PM2_APP_NAME} workers disappeared: ${missing.join(",")}`);
      }
      const created = managedIds
        .filter(id => !existing.has(id))
        .sort((left, right) => left - right);
      if (created.length !== 2
        || created.some(id => !Number.isSafeInteger(id) || id < 0)
        || new Set(created).size !== created.length) {
        throw new Error(`Expected two new ${process.env.PM2_APP_NAME} workers, found ${created.length}`);
      }
      process.stdout.write(created.join(","));
    });
  '
}

pm2_unhealthy_target_ids() {
  local name="$1"
  local target_script="$2"
  pm2 jlist | PM2_APP_NAME="$name" PM2_TARGET_SCRIPT="$target_script" "$NODE_BINARY" -e '
    const path = require("path");
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const expectedScript = path.resolve(process.env.PM2_TARGET_SCRIPT);
      const ids = JSON.parse(source || "[]")
        .filter(item => item.name === process.env.PM2_APP_NAME
          && item.pm2_env?.status !== "online"
          && path.resolve(String(item.pm2_env?.pm_exec_path || "")) === expectedScript)
        .map(item => item.pm_id)
        .sort((left, right) => left - right);
      if (ids.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(ids).size !== ids.length) {
        throw new Error(`Unsafe unhealthy PM2 worker IDs for ${process.env.PM2_APP_NAME}`);
      }
      process.stdout.write(ids.join(","));
    });
  '
}

pm2_id_belongs_to_app() {
  local name="$1"
  local id="$2"
  pm2 jlist | PM2_APP_NAME="$name" PM2_APP_ID="$id" "$NODE_BINARY" -e '
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const id = Number(process.env.PM2_APP_ID);
      if (!Number.isSafeInteger(id) || id < 0) process.exit(1);
      const matches = JSON.parse(source || "[]").filter(item => item.pm_id === id);
      if (matches.length !== 1 || matches[0].name !== process.env.PM2_APP_NAME) process.exit(1);
    });
  '
}

delete_pm2_ids() {
  local name="$1"
  local ids="$2"
  local id
  [ -n "$ids" ] || return 0
  case "$ids" in *[!0-9,]*|,*|*,|*,,*) return 1 ;; esac
  local parsed_ids=()
  IFS=',' read -r -a parsed_ids <<< "$ids"
  for id in "${parsed_ids[@]}"; do
    pm2_id_belongs_to_app "$name" "$id" || return 1
    pm2 delete "$id" >/dev/null || return 1
  done
}

verify_pm2_worker_health() {
  local ids="$1"
  local expected_sha="$2"
  local require_worker_ids="$3"
  local seen_ids=""
  local response updated_seen attempt
  case "$ids" in ''|*[!0-9,]*|,*|*,|*,,*) return 1 ;; esac
  case "$require_worker_ids" in true|false) ;; *) return 1 ;; esac
  for attempt in {1..12}; do
    if response="$(curl --fail-with-body --silent --show-error --connect-timeout 2 --max-time 5 \
      "http://$SERVICE_HOST:$SERVICE_PORT/health?deployment=$expected_sha" 2>/dev/null)"; then
      if updated_seen="$(HEALTH="$response" EXPECTED_SHA="$expected_sha" EXPECTED_PM2_IDS="$ids" \
        REQUIRE_PM2_WORKER_IDS="$require_worker_ids" SEEN_PM2_IDS="$seen_ids" "$NODE_BINARY" -e '
          const health = JSON.parse(process.env.HEALTH || "{}");
          const expected = (process.env.EXPECTED_PM2_IDS || "").split(",").map(Number);
          const seen = new Set((process.env.SEEN_PM2_IDS || "").split(",").filter(Boolean).map(Number));
          if (health.ok && health.deployment_sha === process.env.EXPECTED_SHA) {
            if (process.env.REQUIRE_PM2_WORKER_IDS === "false") {
              for (const id of expected) seen.add(id);
            } else if (Number.isSafeInteger(health.worker_id) && expected.includes(health.worker_id)) {
              seen.add(health.worker_id);
            }
          }
          process.stdout.write([...seen].sort((left, right) => left - right).join(","));
        ' 2>/dev/null)"; then
        seen_ids="$updated_seen"
        [ "$seen_ids" = "$ids" ] && return 0
      fi
    fi
    [ "$attempt" -eq 12 ] || sleep 1
  done
  echo "ERROR: Staged PM2 workers $ids did not both report deployment $expected_sha" >&2
  return 1
}

start_release() {
  local release="$1"
  local secret_file="$2"
  local deployment_sha="$3"
  local existing_ids created_ids unhealthy_target_ids worker_health_mode
  local start_seconds start_elapsed_seconds
  local kill_timeout_ms=$((DRAIN_TIMEOUT_MS + 10000))
  configure_process_environment "$release" "$secret_file" "$deployment_sha"

  worker_health_mode=false
  if [ -e "$release/.merge4appstore-worker-health-v1" ] || [ -L "$release/.merge4appstore-worker-health-v1" ]; then
    [ -f "$release/.merge4appstore-worker-health-v1" ] \
      && [ ! -L "$release/.merge4appstore-worker-health-v1" ] \
      && [ -O "$release/.merge4appstore-worker-health-v1" ] \
      && [ "$(cat "$release/.merge4appstore-worker-health-v1")" = "merge4appstore-worker-health-v1" ] \
      || return 1
    worker_health_mode=true
  elif [ "$release" = "${CANDIDATE_RELEASE:-}" ]; then
    echo "ERROR: Candidate release lacks PM2 worker health capability" >&2
    return 1
  fi

  # PM2 restarts every same-name process instead of creating fresh IDs when it
  # finds a stopped same-path process, even with --force. Removing only those
  # non-serving target entries keeps the generation handoff convergent.
  unhealthy_target_ids="$(pm2_unhealthy_target_ids "$SERVICE_NAME" "$release/webhook-server.js")" || return 1
  delete_pm2_ids "$SERVICE_NAME" "$unhealthy_target_ids" || return 1
  existing_ids="$(pm2_app_ids "$SERVICE_NAME")" || return 1

  # PM2 startOrReload retains pm_cwd and pm_exec_path from the old generation
  # when an ecosystem file changes cwd. Start a complete target generation
  # beside the old workers, verify it, and only then retire the captured IDs.
  start_seconds="$SECONDS"
  # Keep the script cwd-relative: PM2 rewrites absolute script paths containing
  # spaces through `bash -c`, which loses argument boundaries.
  pm2 start webhook-server.js \
    --name "$SERVICE_NAME" \
    --cwd "$release" \
    --instances 2 \
    --wait-ready \
    --listen-timeout 60000 \
    --kill-timeout "$kill_timeout_ms" \
    --merge-logs \
    --output "$LOGS_DIR/webhook-out.log" \
    --error "$LOGS_DIR/webhook-error.log" \
    --filter-env APP_STORE_CONNECT_API_ \
    --filter-env BUILD_ \
    --filter-env GH_TOKEN \
    --filter-env GH_WEBHOOK_SECRET \
    --filter-env XCODE_CLOUD_WEBHOOK_TOKEN \
    --filter-env MERGE4APPSTORE_BUILD_TOKEN_ \
    --force || return 1
  start_elapsed_seconds=$((SECONDS - start_seconds))
  if [ "$start_elapsed_seconds" -ge 60 ]; then
    echo "ERROR: PM2 generation start reached the wait-ready timeout (${start_elapsed_seconds}s)" >&2
    return 1
  fi

  created_ids="$(pm2_new_app_ids "$SERVICE_NAME" "$existing_ids")" || return 1
  EXPECTED_PM2_IDS="$created_ids" validate_pm2_release || return 1
  verify_pm2_worker_health "$created_ids" "$deployment_sha" "$worker_health_mode" || return 1
  delete_pm2_ids "$SERVICE_NAME" "$existing_ids" || return 1
  validate_pm2_release
}

validate_pm2_release() {
  pm2 jlist | "$NODE_BINARY" -e '
    const fs = require("fs");
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const allProcesses = JSON.parse(source || "[]").filter(
        item => item.name === process.env.MERGE4APPSTORE_PM2_NAME
      );
      const expectedIdsSource = process.env.EXPECTED_PM2_IDS || "";
      if (expectedIdsSource && !/^\d+(?:,\d+)*$/.test(expectedIdsSource)) {
        throw new Error("Unsafe expected PM2 worker IDs");
      }
      const expectedIds = expectedIdsSource ? expectedIdsSource.split(",").map(Number) : [];
      if (expectedIds.some(id => !Number.isSafeInteger(id) || id < 0)
        || (expectedIds.length > 0 && (expectedIds.length !== 2 || new Set(expectedIds).size !== 2))) {
        throw new Error(`Expected exactly two staged PM2 worker IDs, found ${expectedIds.length}`);
      }
      const expectedIdSet = new Set(expectedIds);
      const processes = expectedIds.length > 0
        ? allProcesses.filter(item => expectedIdSet.has(item.pm_id))
        : allProcesses;
      if (processes.length !== 2) throw new Error(`Expected two ${process.env.MERGE4APPSTORE_PM2_NAME} workers, found ${processes.length}`);
      const actualIds = processes.map(item => item.pm_id).sort((left, right) => left - right);
      if (actualIds.some(id => !Number.isSafeInteger(id) || id < 0)
        || new Set(actualIds).size !== actualIds.length
        || (expectedIds.length > 0
          && actualIds.join(",") !== [...expectedIds].sort((left, right) => left - right).join(","))) {
        throw new Error("PM2 worker selection did not exactly match the expected IDs");
      }
      const expectedCwd = fs.realpathSync(process.env.EXPECTED_PM2_CWD);
      const expectedScript = fs.realpathSync(process.env.EXPECTED_PM2_SCRIPT);
      const expectedOutLog = fs.realpathSync(process.env.EXPECTED_PM2_OUT_LOG);
      const expectedErrorLog = fs.realpathSync(process.env.EXPECTED_PM2_ERROR_LOG);
      const buildContextNames = [
        "BUILD_BRANCH",
        "BUILD_COMMIT_SHA",
        "BUILD_COMPLETED_AT",
        "BUILD_NUMBER",
        "BUILD_PULL_REQUEST",
        "BUILD_PURPOSE",
        "BUILD_RUN_ID",
        "BUILD_SOURCE_DELIVERY_ID",
        "BUILD_STATUS",
        "BUILD_WAIT_FOR_COMPLETION",
        "BUILD_WORKFLOW_ID",
      ];
      const forbidden = name => (
        name === "GH_TOKEN"
        || name === "GH_WEBHOOK_SECRET"
        || name === "XCODE_CLOUD_WEBHOOK_TOKEN"
        || name.startsWith("APP_STORE_CONNECT_API_")
        || name.startsWith("MERGE4APPSTORE_BUILD_TOKEN_")
      );
      for (const processInfo of processes) {
        const pm2Environment = processInfo.pm2_env || {};
        const appEnvironment = pm2Environment.env || {};
        if (pm2Environment.status !== "online" || pm2Environment.exec_mode !== "cluster_mode") {
          throw new Error(`PM2 worker ${processInfo.pm_id} is not an online cluster worker`);
        }
        const expectedKillTimeout = Number(process.env.MERGE4APPSTORE_DRAIN_TIMEOUT_MS) + 10000;
        const requiredFilters = [
          "APP_STORE_CONNECT_API_",
          "BUILD_",
          "GH_TOKEN",
          "GH_WEBHOOK_SECRET",
          "XCODE_CLOUD_WEBHOOK_TOKEN",
          "MERGE4APPSTORE_BUILD_TOKEN_",
        ];
        if (pm2Environment.wait_ready !== true
          || pm2Environment.listen_timeout !== 60000
          || pm2Environment.kill_timeout !== expectedKillTimeout
          || pm2Environment.autorestart !== true
          || !Array.isArray(pm2Environment.filter_env)
          || requiredFilters.some(filter => !pm2Environment.filter_env.includes(filter))) {
          throw new Error(`PM2 worker ${processInfo.pm_id} has an invalid runtime configuration`);
        }
        const workerNodeMajor = Number(String(pm2Environment.node_version || "").split(".")[0]);
        if (!Number.isSafeInteger(workerNodeMajor) || workerNodeMajor < 20) {
          throw new Error(`PM2 worker ${processInfo.pm_id} uses unsupported Node.js ${pm2Environment.node_version || "unknown"}`);
        }
        if (fs.realpathSync(pm2Environment.pm_cwd) !== expectedCwd || fs.realpathSync(pm2Environment.pm_exec_path) !== expectedScript) {
          throw new Error(`PM2 worker ${processInfo.pm_id} is not serving the candidate immutable release`);
        }
        if (fs.realpathSync(pm2Environment.pm_out_log_path) !== expectedOutLog
          || fs.realpathSync(pm2Environment.pm_err_log_path) !== expectedErrorLog
          || pm2Environment.merge_logs !== true) {
          throw new Error(`PM2 worker ${processInfo.pm_id} does not use the bounded private logs`);
        }
        const value = name => pm2Environment[name] ?? appEnvironment[name];
        if (value("MERGE4APPSTORE_STATE_DIR") !== process.env.MERGE4APPSTORE_STATE_DIR
          || value("MERGE4APPSTORE_ENV") !== process.env.MERGE4APPSTORE_ENV
          || value("MERGE4APPSTORE_WEBHOOK_ENV") !== process.env.EXPECTED_PM2_SECRET_FILE
          || value("MERGE4APPSTORE_DEPLOY_SHA") !== process.env.EXPECTED_PM2_SHA
          || value("MERGE4APPSTORE_DRAIN_TIMEOUT_MS") !== process.env.MERGE4APPSTORE_DRAIN_TIMEOUT_MS
          || value("MERGE4APPSTORE_DELIVERY_PAUSE_FILE") !== process.env.MERGE4APPSTORE_DELIVERY_PAUSE_FILE
          || value("MERGE4APPSTORE_PM2_NAME") !== process.env.MERGE4APPSTORE_PM2_NAME
          || value("MERGE4APPSTORE_PREPARE_TIMEOUT_MS") !== process.env.MERGE4APPSTORE_PREPARE_TIMEOUT_MS
          || value("DRY_RUN") !== "false"
          || value("NODE_ENV") !== "production"
          || value("RECONCILE_METADATA") !== "false"
          || value("WEBHOOK_AUTOSTART") !== "true"
          || value("WEBHOOK_HOST") !== "127.0.0.1"
          || value("WEBHOOK_PORT") !== "8788") {
          throw new Error(`PM2 worker ${processInfo.pm_id} has an invalid deployment contract`);
        }
        for (const environment of [pm2Environment, appEnvironment]) {
          const leaked = Object.keys(environment).find(forbidden);
          if (leaked) throw new Error(`PM2 worker ${processInfo.pm_id} persisted forbidden secret ${leaked}`);
          const unknownBuildContext = Object.keys(environment).find(
            name => name.startsWith("BUILD_") && !buildContextNames.includes(name)
          );
          if (unknownBuildContext) throw new Error(`PM2 worker ${processInfo.pm_id} persisted unknown build context ${unknownBuildContext}`);
          const staleBuildContext = buildContextNames.find(name => (environment[name] ?? "") !== "");
          if (staleBuildContext) throw new Error(`PM2 worker ${processInfo.pm_id} persisted stale build context ${staleBuildContext}`);
        }
      }
    });
  '
}

pm2_app_count() {
  local name="$1"
  pm2 jlist | PM2_APP_NAME="$name" node -e '
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(JSON.parse(source || "[]").filter(item => item.name === process.env.PM2_APP_NAME).length)));
  '
}

retry_capture() {
  local result_name="$1"
  local description="$2"
  local max_attempts="$3"
  shift 3
  local attempt output status delay_seconds
  local error_file="${retry_directory:-$transaction_dir}/retry-error-$$"
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    status=0
    output="$("$@" 2>"$error_file")" || status=$?
    if [ "$status" -eq 0 ]; then
      printf -v "$result_name" '%s' "$output"
      rm -f -- "$error_file"
      return 0
    fi
    echo "WARNING: $description failed (attempt $attempt/$max_attempts, exit $status)" >&2
    sed -n '1,20p' "$error_file" >&2 || true
    if [ -n "$output" ]; then printf '%s\n' "$output" | sed -n '1,20p' >&2; fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      delay_seconds=$((2 ** (attempt - 1)))
      sleep "$delay_seconds"
    fi
  done
  rm -f -- "$error_file"
  return 1
}

read_transaction_value() {
  local source="$1"
  local name="$2"
  cat "$source/$name" 2>/dev/null || true
}

read_env_value_from_release() {
  local release="$1"
  local environment_file="$2"
  local key="$3"
  ENVIRONMENT_FILE="$environment_file" ENVIRONMENT_KEY="$key" RELEASE_DIRECTORY="$release" node --input-type=module -e '
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const { readEnvironmentFile } = await import(pathToFileURL(path.join(process.env.RELEASE_DIRECTORY, "lib/secret-environment.js")));
    const parsed = readEnvironmentFile(process.env.ENVIRONMENT_FILE);
    process.stdout.write(parsed[process.env.ENVIRONMENT_KEY] || "");
  '
}

validate_production_environment() {
  local release="$1"
  local environment_file="$2"
  ENVIRONMENT_FILE="$environment_file" RELEASE_DIRECTORY="$release" "$NODE_BINARY" --input-type=module -e '
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const { readEnvironmentFile } = await import(pathToFileURL(path.join(process.env.RELEASE_DIRECTORY, "lib/secret-environment.js")));
    const parsed = readEnvironmentFile(process.env.ENVIRONMENT_FILE);
    if (parsed.DRY_RUN !== undefined && parsed.DRY_RUN !== "false") {
      throw new Error("Production control environment must not enable DRY_RUN");
    }
    const transient = Object.keys(parsed).find(name => name === "RECONCILE_METADATA" || name.startsWith("BUILD_"));
    if (transient) throw new Error(`Production control environment contains transient job context ${transient}`);
  '
}

validate_webhook_environment() {
  local release="$1"
  local environment_file="$2"
  ENVIRONMENT_FILE="$environment_file" RELEASE_DIRECTORY="$release" "$NODE_BINARY" --input-type=module -e '
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const module = await import(pathToFileURL(path.join(process.env.RELEASE_DIRECTORY, "lib/secret-environment.js")));
    const parsed = module.readEnvironmentFile(process.env.ENVIRONMENT_FILE);
    module.validateEnvironmentNames(parsed, module.WEBHOOK_SECRET_NAMES, { requireAll: true });
  '
}

verify_health_url() {
  local url="$1"
  local expected_sha="$2"
  local description="$3"
  local response attempt
  for attempt in 1 2 3 4; do
    if response="$(curl --fail-with-body --silent --show-error --connect-timeout 3 --max-time 15 "$url" 2>/dev/null)"; then
      if HEALTH="$response" EXPECTED_SHA="$expected_sha" node -e '
        const health = JSON.parse(process.env.HEALTH || "{}");
        if (!health.ok || health.deployment_sha !== process.env.EXPECTED_SHA) process.exit(1);
      ' 2>/dev/null; then
        return 0
      fi
    fi
    [ "$attempt" -eq 4 ] || sleep "$attempt"
  done
  echo "ERROR: $description did not report deployment $expected_sha" >&2
  return 1
}

install_nginx_include() {
  local config="$1"
  NGINX_CONFIG="$config" NGINX_SERVER_NAME="$NGINX_SERVER_NAME" NGINX_SNIPPET="$NGINX_SNIPPET" \
    node --input-type=module <<'NODE'
import crypto from 'node:crypto';
import fs, { constants } from 'node:fs';
import path from 'node:path';

const config = process.env.NGINX_CONFIG;
const serverName = process.env.NGINX_SERVER_NAME;
const snippet = process.env.NGINX_SNIPPET;
const stat = fs.lstatSync(config);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe nginx configuration: ${config}`);
const source = fs.readFileSync(config, 'utf8');
const newline = source.includes('\r\n') ? '\r\n' : '\n';
const lines = source.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
const candidates = [];
let depth = 0;
let block = null;

for (let index = 0; index < lines.length; index += 1) {
  const code = lines[index].replace(/#.*/, '');
  if (!block && /\bserver\s*\{/.test(code)) {
    block = { startDepth: depth, listen443: false, serverNameLine: -1, includesSnippet: false };
  }
  if (block) {
    if (/^\s*listen\s+(?:(?:\[[^\]]+\]|[^;\s:]+):)?443(?:\s|;)/.test(code)) {
      block.listen443 = true;
    }
    const names = code.match(/^\s*server_name\s+([^;]+);/);
    if (names && names[1].trim().split(/\s+/).includes(serverName)) block.serverNameLine = index;
    if (code.trim() === `include ${snippet};`) block.includesSnippet = true;
  }
  depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
  if (block && depth <= block.startDepth) {
    if (block.listen443 && block.serverNameLine >= 0) candidates.push(block);
    block = null;
  }
}

if (candidates.length !== 1) {
  throw new Error(`Expected one TLS nginx server block for ${serverName}; found ${candidates.length}`);
}
if (candidates[0].includesSnippet) process.exit(0);
const index = candidates[0].serverNameLine;
const indent = lines[index].match(/^\s*/)[0];
lines.splice(index + 1, 0, `${indent}include ${snippet};${newline}`);

const temporary = path.join(
  path.dirname(config),
  `.${path.basename(config)}.${process.pid}.${crypto.randomUUID()}.tmp`,
);
let fd;
try {
  fd = fs.openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    stat.mode & 0o777,
  );
  fs.writeFileSync(fd, lines.join(''));
  fs.fchownSync(fd, stat.uid, stat.gid);
  fs.fchmodSync(fd, stat.mode & 0o777);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.renameSync(temporary, config);
  const directoryFd = fs.openSync(
    path.dirname(config),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try { fs.fsyncSync(directoryFd); } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally { fs.closeSync(directoryFd); }
} finally {
  if (fd !== undefined) fs.closeSync(fd);
  try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
NODE
}

activate_delivery_pause() {
  local owner="$1"
  local temporary="$DELIVERY_PAUSE_FILE.new.$DEPLOY_RUN_ID.$$"
  if [ -e "$DELIVERY_PAUSE_FILE" ] || [ -L "$DELIVERY_PAUSE_FILE" ]; then
    validate_private_file "$DELIVERY_PAUSE_FILE" || return 1
    [ "$(cat "$DELIVERY_PAUSE_FILE")" = "$owner" ] \
      || { echo "ERROR: Delivery pause is owned by another deployment" >&2; return 1; }
    return 0
  fi
  printf '%s\n' "$owner" > "$temporary" || return 1
  chmod 600 "$temporary" || return 1
  sync -f "$temporary" || return 1
  mv -Tf -- "$temporary" "$DELIVERY_PAUSE_FILE" || return 1
  sync -f "$STATE_DIR" || return 1
  validate_private_file "$DELIVERY_PAUSE_FILE" || return 1
  [ "$(cat "$DELIVERY_PAUSE_FILE")" = "$owner" ]
}

clear_delivery_pause() {
  local owner="$1"
  if [ -L "$DELIVERY_PAUSE_FILE" ]; then
    echo "ERROR: Delivery pause gate is a symlink" >&2
    return 1
  fi
  if [ -e "$DELIVERY_PAUSE_FILE" ]; then
    validate_private_file "$DELIVERY_PAUSE_FILE" || return 1
    [ "$(cat "$DELIVERY_PAUSE_FILE")" = "$owner" ] \
      || { echo "ERROR: Refusing to clear another deployment's pause gate" >&2; return 1; }
    rm -f -- "$DELIVERY_PAUSE_FILE" || return 1
    sync -f "$STATE_DIR" || return 1
  fi
  [ ! -e "$DELIVERY_PAUSE_FILE" ] && [ ! -L "$DELIVERY_PAUSE_FILE" ]
}

restore_crontab_exact() {
  local backup="$1"
  local verification
  validate_private_file "$backup" || return 1
  crontab "$backup" || return 1
  verification="$(mktemp "$STATE_DIR/.crontab-verify.XXXXXX")" || return 1
  chmod 600 "$verification" || { rm -f -- "$verification"; return 1; }
  crontab -l > "$verification" 2>/dev/null || :
  if ! cmp -s -- "$backup" "$verification"; then
    echo "ERROR: Restored crontab does not match its durable snapshot" >&2
    rm -f -- "$verification"
    return 1
  fi
  rm -f -- "$verification"
}

restore_control_secret_snapshot() {
  local source="$1"
  local kind target resolved temporary
  kind="$(read_transaction_value "$source" control-secret-kind)"
  target="$(read_transaction_value "$source" control-secret-target)"
  if [ -e "$CONTROL_WEBHOOK_ENV" ] && [ ! -L "$CONTROL_WEBHOOK_ENV" ]; then
    case "$kind" in
      file) ;;
      *) echo "ERROR: Refusing to replace unexpected control secret" >&2; return 1 ;;
    esac
  fi
  case "$kind" in
    missing) rm -f -- "$CONTROL_WEBHOOK_ENV" || return 1 ;;
    link)
      temporary="$source/control-webhook.restore-link"
      rm -f -- "$temporary" || return 1
      ln -s -- "$target" "$temporary" || return 1
      mv -Tf -- "$temporary" "$CONTROL_WEBHOOK_ENV" || return 1
      ;;
    file)
      temporary="$source/control-webhook.restore-file"
      rm -f -- "$temporary" || return 1
      install -m 600 -- "$source/control-webhook.env" "$temporary" || return 1
      sync -f "$temporary" || return 1
      mv -Tf -- "$temporary" "$CONTROL_WEBHOOK_ENV" || return 1
      ;;
    *) echo "ERROR: Invalid control secret snapshot" >&2; return 1 ;;
  esac
  case "$kind" in
    missing) [ ! -e "$CONTROL_WEBHOOK_ENV" ] && [ ! -L "$CONTROL_WEBHOOK_ENV" ] ;;
    link)
      [ -L "$CONTROL_WEBHOOK_ENV" ] && [ "$(readlink -- "$CONTROL_WEBHOOK_ENV")" = "$target" ] || return 1
      resolved="$(readlink -f -- "$CONTROL_WEBHOOK_ENV")" || return 1
      case "$resolved" in "$SECRETS_DIR"/*) ;; *) return 1 ;; esac
      validate_private_file "$resolved"
      ;;
    file)
      validate_private_file "$CONTROL_WEBHOOK_ENV" || return 1
      cmp -s -- "$source/control-webhook.env" "$CONTROL_WEBHOOK_ENV" || return 1
      sync -f "$CONTROL_WEBHOOK_ENV"
      ;;
  esac
}

restore_pointer_snapshot() {
  local source="$1"
  restore_link "$STATE_DIR/current" "$(read_transaction_value "$source" old-current)" || return 1
  restore_link "$STATE_DIR/previous" "$(read_transaction_value "$source" old-previous)" || return 1
  restore_link "$STATE_DIR/current-webhook.env" "$(read_transaction_value "$source" old-current-secret)" || return 1
  restore_link "$STATE_DIR/previous-webhook.env" "$(read_transaction_value "$source" old-previous-secret)" || return 1
  restore_control_secret_snapshot "$source" || return 1
  sync -f "$STATE_DIR" || return 1
  sync -f "$DEPLOY_DIR"
}

restore_nginx_snapshot() {
  local source="$1"
  local config config_mode snippet_mode snippet_was_present managed_snapshot_version observability_was_present logrotate_was_present
  config="$(read_transaction_value "$source" nginx-config)"
  snippet_was_present="$(read_transaction_value "$source" snippet-existed)"
  case "$config" in /etc/nginx/*) ;; *) echo "ERROR: Invalid nginx snapshot path" >&2; return 1 ;; esac
  [ "$(readlink -f -- "$config" 2>/dev/null || true)" = "$config" ] || return 1
  [ -f "$config" ] && [ ! -L "$config" ] || return 1
  validate_owned_regular_file "$source/nginx-site.conf" || return 1
  config_mode="$(stat -c '%a' "$source/nginx-site.conf")" || return 1
  install_atomic_copy "$source/nginx-site.conf" "$config" "$config_mode" || return 1
  case "$snippet_was_present" in
    1)
      validate_owned_regular_file "$source/nginx-snippet.conf" || return 1
      snippet_mode="$(stat -c '%a' "$source/nginx-snippet.conf")" || return 1
      install_atomic_copy "$source/nginx-snippet.conf" "$NGINX_SNIPPET" "$snippet_mode" || return 1
      ;;
    0)
      rm -f -- "$NGINX_SNIPPET" || return 1
      sync -f "$(dirname "$NGINX_SNIPPET")" || return 1
      ;;
    *) return 1 ;;
  esac
  managed_snapshot_version="$(read_transaction_value "$source" managed-config-snapshot-version)"
  case "$managed_snapshot_version" in
    '') ;;
    1)
      observability_was_present="$(read_transaction_value "$source" nginx-observability-existed)"
      logrotate_was_present="$(read_transaction_value "$source" logrotate-config-existed)"
      restore_optional_managed_file "$source/nginx-observability.before" \
        "$NGINX_OBSERVABILITY_CONFIG" "$observability_was_present" 644 || return 1
      restore_optional_managed_file "$source/logrotate.before" \
        "$LOGROTATE_CONFIG" "$logrotate_was_present" 600 || return 1
      if [ "$logrotate_was_present" = "1" ]; then
        validate_private_file "$LOGROTATE_CONFIG" || return 1
      fi
      ;;
    *) return 1 ;;
  esac
  nginx -t || return 1
  systemctl reload nginx || return 1
}

validate_logging_contract() {
  local source="$1"
  local managed_snapshot_version
  managed_snapshot_version="$(read_transaction_value "$source" managed-config-snapshot-version)"
  case "$managed_snapshot_version" in
    '') return 0 ;;
    1) ;;
    *) return 1 ;;
  esac
  validate_private_file "$source/nginx-observability.candidate" || return 1
  validate_private_file "$source/logrotate.candidate" || return 1
  [ -f "$NGINX_OBSERVABILITY_CONFIG" ] && [ ! -L "$NGINX_OBSERVABILITY_CONFIG" ] \
    && [ -O "$NGINX_OBSERVABILITY_CONFIG" ] \
    && [ "$(stat -c '%a' "$NGINX_OBSERVABILITY_CONFIG")" = "644" ] || return 1
  cmp -s -- "$source/nginx-observability.candidate" "$NGINX_OBSERVABILITY_CONFIG" || return 1
  validate_private_file "$LOGROTATE_CONFIG" || return 1
  cmp -s -- "$source/logrotate.candidate" "$LOGROTATE_CONFIG" || return 1
  for managed_log in "$NGINX_ACCESS_LOG" "$LOGS_DIR/webhook-out.log" "$LOGS_DIR/webhook-error.log" \
    "$LOGS_DIR/cron.log" "$LOGS_DIR/logrotate.log"; do
    validate_private_file "$managed_log" || return 1
  done
  validate_active_logrotate_configuration "$LOGROTATE_CONFIG"
}

verify_nginx_diagnostic_log() {
  local previous_line="$1"
  local probe_url="$2"
  local attempt line
  for attempt in 1 2 3 4 5; do
    validate_private_file "$NGINX_ACCESS_LOG" || return 1
    line="$(tail -n 1 -- "$NGINX_ACCESS_LOG")" || return 1
    if [ -n "$line" ] && [ "$line" != "$previous_line" ]; then
      if NGINX_DIAGNOSTIC_LINE="$line" "$NODE_BINARY" -e '
        const value = JSON.parse(process.env.NGINX_DIAGNOSTIC_LINE);
        const expected = [
          "bytes_sent", "method", "request_id", "request_time", "status", "timestamp",
          "upstream_addr", "upstream_connect_time", "upstream_header_time",
          "upstream_response_time", "upstream_status",
        ];
        const actual = Object.keys(value).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
        if (!actual.every(name => typeof value[name] === "string")) process.exit(1);
      '; then
        return 0
      fi
    fi
    curl --fail-with-body --silent --show-error --connect-timeout 3 --max-time 15 \
      "$probe_url" >/dev/null 2>&1 || true
    sleep 1
  done
  echo "ERROR: Nginx did not write a valid sanitized upstream diagnostic" >&2
  return 1
}

print_sanitized_nginx_diagnostics() {
  validate_private_file "$NGINX_ACCESS_LOG" >/dev/null 2>&1 || return 0
  tail -n 20 -- "$NGINX_ACCESS_LOG" | "$NODE_BINARY" -e '
    const readline = require("readline");
    const expected = [
      "bytes_sent", "method", "request_id", "request_time", "status", "timestamp",
      "upstream_addr", "upstream_connect_time", "upstream_header_time",
      "upstream_response_time", "upstream_status",
    ];
    const input = readline.createInterface({ input: process.stdin });
    input.on("line", line => {
      try {
        const value = JSON.parse(line);
        const actual = Object.keys(value).sort();
        if (JSON.stringify(actual) === JSON.stringify(expected)
          && actual.every(name => typeof value[name] === "string")) {
          console.error(JSON.stringify(value));
        }
      } catch {}
    });
  ' || true
}

cleanup_candidate_artifacts() {
  local release="$1"
  local secret="$2"
  local pointer resolved release_identity secret_identity
  release_identity="$(readlink -f -- "$release" 2>/dev/null || printf '%s' "$release")"
  secret_identity="$(readlink -f -- "$secret" 2>/dev/null || printf '%s' "$secret")"
  if pm2 jlist | CANDIDATE_RELEASE="$release" CANDIDATE_RELEASE_REAL="$release_identity" \
    CANDIDATE_SECRET="$secret" CANDIDATE_SECRET_REAL="$secret_identity" node -e '
    let source="";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const referenced = JSON.parse(source || "[]").some(item => {
        const environment = item.pm2_env || {};
        const appEnvironment = environment.env || {};
        const isCandidatePath = value => typeof value === "string"
          && [process.env.CANDIDATE_RELEASE, process.env.CANDIDATE_RELEASE_REAL]
            .some(candidate => value === candidate || value.startsWith(`${candidate}/`));
        return isCandidatePath(environment.pm_cwd)
          || isCandidatePath(environment.pm_exec_path)
          || [process.env.CANDIDATE_SECRET, process.env.CANDIDATE_SECRET_REAL].includes(environment.MERGE4APPSTORE_WEBHOOK_ENV)
          || [process.env.CANDIDATE_SECRET, process.env.CANDIDATE_SECRET_REAL].includes(appEnvironment.MERGE4APPSTORE_WEBHOOK_ENV);
      });
      process.exit(referenced ? 1 : 0);
    });
  '; then :; else
    echo "ERROR: Candidate release or secret is still referenced by PM2" >&2
    return 1
  fi
  case "$secret" in "$SECRETS_DIR"/*) ;; *) return 1 ;; esac
  case "$release" in "$RELEASES_DIR"/*) ;; *) return 1 ;; esac
  for pointer in "$STATE_DIR/current" "$STATE_DIR/previous"; do
    if [ -L "$pointer" ]; then
      resolved="$(readlink -f -- "$pointer")" || return 1
      [ "$resolved" != "$release_identity" ] || { echo "ERROR: Candidate release is still referenced by $pointer" >&2; return 1; }
    elif [ -e "$pointer" ]; then
      return 1
    fi
  done
  for pointer in "$STATE_DIR/current-webhook.env" "$STATE_DIR/previous-webhook.env" "$CONTROL_WEBHOOK_ENV"; do
    if [ -L "$pointer" ]; then
      resolved="$(readlink -f -- "$pointer")" || return 1
      [ "$resolved" != "$secret_identity" ] || { echo "ERROR: Candidate secret is still referenced by $pointer" >&2; return 1; }
    fi
  done
  if [ -e "$secret" ] || [ -L "$secret" ]; then validate_private_file "$secret" || return 1; fi
  if [ -e "$secret.new" ] || [ -L "$secret.new" ]; then validate_private_file "$secret.new" || return 1; fi
  rm -f -- "$secret" "$secret.new" || return 1
  if [ -e "$release" ]; then
    [ -d "$release" ] && [ ! -L "$release" ] && [ -O "$release" ] \
      && [ "$(cat "$release/.merge4appstore-release" 2>/dev/null || true)" = "merge4appstore-release-v1" ] \
      || return 1
    rm -rf -- "$release" || return 1
  fi
}

shell_quote() {
  local value="$1"
  local escaped
  escaped="$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
  printf "'%s'" "$escaped"
}

pause_managed_cron() {
  local snapshot="$1"
  local current_crontab crontab_without_managed verification
  validate_private_file "$snapshot" || return 1
  current_crontab="$(crontab -l 2>/dev/null || true)"
  crontab_without_managed="$(printf '%s\n' "$current_crontab" | grep -Fv '# merge4appstore:' || true)"
  printf '%s\n' "$crontab_without_managed" | sed '/^[[:space:]]*$/d' | crontab - || return 1
  verification="$(crontab -l 2>/dev/null || true)"
  [ -z "$(printf '%s\n' "$verification" | grep '# merge4appstore:' || true)" ]
}

install_managed_cron() {
  local release="$1"
  local pause_cron="$2"
  local current_crontab profile_file profile_name profile_relative profile_quoted marker cron_line managed_cron
  local current_release_quoted control_env_quoted state_dir_quoted cron_log_quoted node_binary_quoted cron_path_quoted verification
  local flock_binary_quoted logrotate_binary_quoted logrotate_config_quoted logrotate_state_quoted logrotate_lock_quoted
  local logrotate_log_quoted rotation_line
  local profiles=("$release"/profiles/*.yml "$release"/profiles/*.yaml)
  [ "${#profiles[@]}" -gt 0 ] || return 1
  current_crontab="$(crontab -l 2>/dev/null || true)"
  current_crontab="$(printf '%s\n' "$current_crontab" \
    | grep -Fv '# merge4appstore:' | grep -Fv '# merge4appstore-logrotate' || true)"
  current_release_quoted="$(shell_quote "$STATE_DIR/current")"
  control_env_quoted="$(shell_quote "$CONTROL_ENV")"
  state_dir_quoted="$(shell_quote "$STATE_DIR")"
  cron_log_quoted="$(shell_quote "$LOGS_DIR/cron.log")"
  node_binary_quoted="$(shell_quote "$NODE_BINARY")"
  cron_path_quoted="$(shell_quote "$CRON_COMMAND_PATH")"
  if [ -e "$LOGROTATE_CONFIG" ] || [ -L "$LOGROTATE_CONFIG" ]; then
    validate_private_file "$LOGROTATE_CONFIG" || return 1
    validate_active_logrotate_configuration "$LOGROTATE_CONFIG" || return 1
    logrotate_binary_quoted="$(shell_quote "$LOGROTATE_BINARY")"
    logrotate_config_quoted="$(shell_quote "$LOGROTATE_CONFIG")"
    logrotate_state_quoted="$(shell_quote "$LOGROTATE_STATE")"
    logrotate_lock_quoted="$(shell_quote "$LOGROTATE_LOCK")"
    flock_binary_quoted="$(shell_quote "$FLOCK_BINARY")"
    logrotate_log_quoted="$(shell_quote "$LOGS_DIR/logrotate.log")"
    rotation_line="*/5 * * * * umask 077; PATH=$cron_path_quoted $flock_binary_quoted -n $logrotate_lock_quoted $logrotate_binary_quoted --state $logrotate_state_quoted $logrotate_config_quoted >> $logrotate_log_quoted 2>&1 # merge4appstore-logrotate"
    current_crontab="$(printf '%s\n%s\n' "$current_crontab" "$rotation_line")"
  fi
  if [ "$pause_cron" = "false" ]; then
    for profile_file in "${profiles[@]}"; do
      profile_name="$(basename "$profile_file")"
      profile_name="${profile_name%.*}"
      profile_relative="profiles/$(basename "$profile_file")"
      profile_quoted="$(shell_quote "$profile_relative")"
      marker="# merge4appstore:$profile_name"
      cron_line="*/5 * * * * umask 077; cd $current_release_quoted && PATH=$cron_path_quoted MERGE4APPSTORE_ENV=$control_env_quoted MERGE4APPSTORE_STATE_DIR=$state_dir_quoted DRY_RUN=false RECONCILE_METADATA=false $node_binary_quoted index.js --profile $profile_quoted >> $cron_log_quoted 2>&1 $marker"
      current_crontab="$(printf '%s\n%s\n' "$current_crontab" "$cron_line")"
    done
  fi
  printf '%s\n' "$current_crontab" | sed '/^[[:space:]]*$/d' | crontab - || return 1
  verification="$(crontab -l 2>/dev/null || true)"
  managed_cron="$(printf '%s\n' "$verification" | grep '# merge4appstore:' || true)"
  if [ -e "$LOGROTATE_CONFIG" ]; then
    [ "$(printf '%s\n' "$verification" | grep -Fc '# merge4appstore-logrotate' || true)" -eq 1 ] || return 1
  else
    [ -z "$(printf '%s\n' "$verification" | grep '# merge4appstore-logrotate' || true)" ] || return 1
  fi
  if [ "$pause_cron" = "true" ]; then
    [ -z "$managed_cron" ] || return 1
  else
    [ "$(printf '%s\n' "$verification" | grep -Fc '# merge4appstore:' || true)" -eq "${#profiles[@]}" ] || return 1
    [ -z "$(printf '%s\n' "$managed_cron" | grep -v 'MERGE4APPSTORE_STATE_DIR=' || true)" ] || return 1
    [ -z "$(printf '%s\n' "$managed_cron" | grep -v 'MERGE4APPSTORE_ENV=' || true)" ] || return 1
    for profile_file in "${profiles[@]}"; do
      profile_name="$(basename "$profile_file")"
      profile_name="${profile_name%.*}"
      [ "$(printf '%s\n' "$managed_cron" | grep -Fc "# merge4appstore:$profile_name" || true)" -eq 1 ] || return 1
    done
  fi
}

read_hook_id() {
  local hooks_file="$1"
  local webhook_url="$2"
  HOOKS_FILE="$hooks_file" WEBHOOK_URL="$webhook_url" node -e '
    const fs=require("fs");
    const pages=JSON.parse(fs.readFileSync(process.env.HOOKS_FILE));
    if(!Array.isArray(pages)||pages.some(page=>!Array.isArray(page)))throw new Error("Unexpected paginated hooks response");
    const hooks=pages.flat().filter(value=>value.config?.url===process.env.WEBHOOK_URL);
    if(hooks.length>1){
      const ids=hooks.map(hook=>String(hook.id??"unknown")).join(", ");
      throw new Error(`Duplicate GitHub hooks for ${process.env.WEBHOOK_URL}: ${ids}`);
    }
    if(hooks.length===1){
      const id=String(hooks[0].id??"");
      if(!/^[1-9]\d*$/.test(id))throw new Error("GitHub hook has an invalid id");
      process.stdout.write(id);
    }
  '
}

create_repository_hook_safely() {
  local token="$1"
  local repository="$2"
  local webhook_url="$3"
  local payload="$4"
  local output_directory="$5"
  local instance="$6"
  local result="" hooks_file="$output_directory/hooks-create-check-$instance.json" hook_id="" attempt
  for attempt in 1 2 3 4; do
    if [ "$attempt" -gt 1 ]; then
      result=""
      if ! GH_TOKEN="$token" retry_directory="$output_directory" retry_capture result \
        "GitHub hook post-failure verification for $repository ($attempt/4)" 1 \
        timeout 30s gh api --paginate --slurp "repos/$repository/hooks"; then
        sleep "$((2 ** (attempt - 2)))" || return 1
        continue
      fi
      printf '%s' "$result" > "$hooks_file" || return 1
      hook_id="$(read_hook_id "$hooks_file" "$webhook_url")" || return 1
      if [ -n "$hook_id" ]; then
        echo "Recovered an ambiguously completed GitHub webhook creation for $repository" >&2
        return 0
      fi
    fi
    result=""
    if GH_TOKEN="$token" retry_directory="$output_directory" retry_capture result \
      "GitHub hook creation for $repository ($attempt/4)" 1 \
      timeout 30s gh api --method POST "repos/$repository/hooks" --input "$payload"; then
      return 0
    fi
    sleep "$((2 ** (attempt - 1)))" || return 1
  done

  # A timed-out final POST may still have committed server-side. Verify once
  # more before surfacing failure so recovery never creates a duplicate hook.
  result=""
  GH_TOKEN="$token" retry_directory="$output_directory" retry_capture result \
    "final GitHub hook creation verification for $repository" 2 \
    timeout 30s gh api --paginate --slurp "repos/$repository/hooks" \
    || return 1
  printf '%s' "$result" > "$hooks_file" || return 1
  hook_id="$(read_hook_id "$hooks_file" "$webhook_url")" || return 1
  [ -n "$hook_id" ]
}

configure_repository_hooks() {
  local release="$1"
  local secret="$2"
  local output_directory="$3"
  local token profile_file instance repository webhook_url hooks_file hook_id hook_payload hook_create_payload result
  local profiles=("$release"/profiles/*.yml "$release"/profiles/*.yaml)
  token="$(read_env_value_from_release "$release" "$CONTROL_ENV" GH_TOKEN)"
  [ -n "$token" ] || return 1
  for profile_file in "${profiles[@]}"; do
    instance="$(cd "$release" && node -e "import('./lib/profile.js').then(({loadRepositoryProfile})=>console.log(loadRepositoryProfile(process.argv[1]).instance))" "$profile_file")" || return 1
    repository="$(cd "$release" && node -e "import('./lib/profile.js').then(({loadRepositoryProfile})=>{const p=loadRepositoryProfile(process.argv[1]);console.log(p.repository.owner+'/'+p.repository.name)})" "$profile_file")" || return 1
    [ -n "$instance" ] && [ -n "$repository" ] || return 1
    webhook_url="$PUBLIC_BASE_URL/webhooks/github/$instance"
    hooks_file="$output_directory/hooks-$instance.json"
    GH_TOKEN="$token" retry_directory="$output_directory" retry_capture result "GitHub hook listing for $repository" 4 \
      timeout 30s gh api --paginate --slurp "repos/$repository/hooks" \
      || return 1
    printf '%s' "$result" > "$hooks_file" || return 1
    hook_id="$(read_hook_id "$hooks_file" "$webhook_url")" || return 1
    hook_payload="$output_directory/hook-payload-$instance.json"
    WEBHOOK_ENV="$secret" WEBHOOK_URL="$webhook_url" HOOK_PAYLOAD="$hook_payload" RELEASE_DIRECTORY="$release" node --input-type=module -e '
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const { readEnvironmentFile } = await import(pathToFileURL(path.join(process.env.RELEASE_DIRECTORY, "lib/secret-environment.js")));
      const webhookSecret = readEnvironmentFile(process.env.WEBHOOK_ENV).GH_WEBHOOK_SECRET;
      const payload = { active: true, events: ["push", "pull_request"], config: { url: process.env.WEBHOOK_URL, content_type: "json", secret: webhookSecret } };
      fs.writeFileSync(process.env.HOOK_PAYLOAD, JSON.stringify(payload), { mode: 0o600 });
    ' || return 1
    result=""
    if [ -n "$hook_id" ]; then
      GH_TOKEN="$token" retry_directory="$output_directory" retry_capture result "GitHub hook update for $repository" 4 \
        timeout 30s gh api --method PATCH "repos/$repository/hooks/$hook_id" --input "$hook_payload" \
        || return 1
    else
      hook_create_payload="$output_directory/hook-create-$instance.json"
      HOOK_PAYLOAD="$hook_payload" HOOK_CREATE_PAYLOAD="$hook_create_payload" node -e '
        const fs=require("fs");const payload=JSON.parse(fs.readFileSync(process.env.HOOK_PAYLOAD));payload.name="web";fs.writeFileSync(process.env.HOOK_CREATE_PAYLOAD,JSON.stringify(payload),{mode:0o600});
      ' || return 1
      create_repository_hook_safely "$token" "$repository" "$webhook_url" \
        "$hook_create_payload" "$output_directory" "$instance" || return 1
    fi
    echo "Configured GitHub webhook for $repository"
  done
}

legacy_descendant_count() {
  local roots
  roots="$(pm2 jlist | PM2_APP_NAME="$LEGACY_SERVICE_NAME" node -e '
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const roots = JSON.parse(source || "[]")
        .filter(item => item.name === process.env.PM2_APP_NAME)
        .map(item => Number(item.pid))
        .filter(pid => Number.isSafeInteger(pid) && pid > 1);
      process.stdout.write(roots.join(" "));
    });
  ')" || return 1
  if [ -z "$roots" ]; then
    printf '0'
    return 0
  fi
  LEGACY_ROOT_PIDS="$roots" ps -eo pid=,ppid= | LEGACY_ROOT_PIDS="$roots" node -e '
    let source = "";
    process.stdin.on("data", chunk => { source += chunk; });
    process.stdin.on("end", () => {
      const roots = new Set((process.env.LEGACY_ROOT_PIDS || "").trim().split(/\s+/).filter(Boolean).map(Number));
      const rows = source.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
        .filter(([pid, parent]) => Number.isSafeInteger(pid) && Number.isSafeInteger(parent));
      const descendants = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows) {
          if (!descendants.has(pid) && (roots.has(parent) || descendants.has(parent))) {
            descendants.add(pid);
            changed = true;
          }
        }
      }
      process.stdout.write(String(descendants.size));
    });
  '
}

legacy_live_lock_count() {
  local file pid count=0
  for file in "$DEPLOY_DIR"/.merge4appstore-*.lock; do
    [ ! -L "$file" ] && [ -f "$file" ] && [ -O "$file" ] || return 1
    pid="$(cat "$file")" || return 1
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    if kill -0 "$pid" 2>/dev/null || [ -d "/proc/$pid" ]; then
      count=$((count + 1))
    fi
  done
  printf '%s' "$count"
}

legacy_activity_count() {
  local descendants locks
  descendants="$(legacy_descendant_count)" || return 1
  locks="$(legacy_live_lock_count)" || return 1
  case "$descendants:$locks" in *[!0-9:]*) return 1 ;; esac
  printf '%s' "$((descendants + locks))"
}

wait_for_legacy_drain() {
  local seconds elapsed=0 quiet=0 step=2 activity
  seconds=$(( (DRAIN_TIMEOUT_MS + 999) / 1000 ))
  [ "$seconds" -ge "$LEGACY_DRAIN_QUIET_SECONDS" ] || {
    echo "ERROR: Legacy drain deadline is shorter than the required quiet window" >&2
    return 1
  }
  while [ "$elapsed" -le "$seconds" ]; do
    activity="$(legacy_activity_count)" || return 1
    case "$activity" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$activity" -eq 0 ]; then
      if [ "$quiet" -ge "$LEGACY_DRAIN_QUIET_SECONDS" ]; then
        echo "Legacy drain verified: no child jobs or live legacy locks for ${quiet}s"
        return 0
      fi
    else
      quiet=0
    fi
    [ "$elapsed" -lt "$seconds" ] || break
    step=2
    [ "$((elapsed + step))" -le "$seconds" ] || step=$((seconds - elapsed))
    [ "$step" -gt 0 ] || break
    sleep "$step" || return 1
    elapsed=$((elapsed + step))
    if [ "$activity" -eq 0 ]; then quiet=$((quiet + step)); fi
    echo "Legacy drain: activity=$activity quiet=${quiet}s elapsed=${elapsed}s/${seconds}s"
  done
  echo "ERROR: Legacy webhook work did not become observably quiescent before the drain deadline" >&2
  return 1
}

validate_transaction_envelope() {
  local source="$1"
  [ -d "$source" ] && [ ! -L "$source" ] && [ -O "$source" ] || return 1
  [ "$(read_transaction_value "$source" .merge4appstore-transaction)" = "merge4appstore-deployment-transaction-v1" ] || return 1
  validate_private_file "$source/.merge4appstore-transaction" || return 1
  validate_private_file "$source/phase"
}

validate_interrupted_transaction() {
  local source="$1"
  local release secret sha phase old_release old_previous old_secret old_previous_secret control_kind control_target metadata
  local had_v2_snapshot had_legacy_snapshot legacy_sha_snapshot pause_cron_snapshot reconcile_profile_snapshot old_sha
  local managed_snapshot_version observability_was_present logrotate_was_present
  validate_transaction_envelope "$source" || return 1
  for metadata in candidate-release candidate-secret candidate-sha old-current old-previous old-current-secret old-previous-secret control-secret-kind control-secret-target; do
    validate_private_file "$source/$metadata" || return 1
  done
  release="$(read_transaction_value "$source" candidate-release)"
  secret="$(read_transaction_value "$source" candidate-secret)"
  sha="$(read_transaction_value "$source" candidate-sha)"
  phase="$(read_transaction_value "$source" phase)"
  case "$release" in "$RELEASES_DIR"/*) ;; *) return 1 ;; esac
  case "$secret" in "$SECRETS_DIR"/*) ;; *) return 1 ;; esac
  case "$sha" in ''|*[!0-9a-fA-F]*) return 1 ;; esac
  [ "${#sha}" -eq 40 ] || return 1
  if [ "$phase" != "untouched-cleanup" ] && [ "$phase" != "rollback-verified" ] \
    && [ "$phase" != "recovered-rolled-back" ]; then
    [ -d "$release" ] && [ ! -L "$release" ] && [ -O "$release" ] \
      && [ "$(cat "$release/.merge4appstore-release" 2>/dev/null || true)" = "merge4appstore-release-v1" ] \
      && [ "$(cat "$release/.merge4appstore-deployment-sha" 2>/dev/null || true)" = "$sha" ] \
      || return 1
  elif [ -e "$release" ] || [ -L "$release" ]; then
    [ -d "$release" ] && [ ! -L "$release" ] && [ -O "$release" ] \
      && [ "$(cat "$release/.merge4appstore-release" 2>/dev/null || true)" = "merge4appstore-release-v1" ] \
      && [ "$(cat "$release/.merge4appstore-deployment-sha" 2>/dev/null || true)" = "$sha" ] \
      || return 1
  fi
  if [ -e "$secret" ] || [ -L "$secret" ]; then validate_private_file "$secret" || return 1; fi

  old_release="$(read_transaction_value "$source" old-current)"
  old_previous="$(read_transaction_value "$source" old-previous)"
  old_secret="$(read_transaction_value "$source" old-current-secret)"
  old_previous_secret="$(read_transaction_value "$source" old-previous-secret)"
  case "$old_release" in ''|"$RELEASES_DIR"/*) ;; *) return 1 ;; esac
  case "$old_previous" in ''|"$RELEASES_DIR"/*) ;; *) return 1 ;; esac
  case "$old_secret" in ''|"$SECRETS_DIR"/*) ;; *) return 1 ;; esac
  case "$old_previous_secret" in ''|"$SECRETS_DIR"/*) ;; *) return 1 ;; esac
  control_kind="$(read_transaction_value "$source" control-secret-kind)"
  control_target="$(read_transaction_value "$source" control-secret-target)"
  case "$control_kind" in
    missing|file) [ -z "$control_target" ] || return 1 ;;
    link) [ -n "$control_target" ] || return 1 ;;
    *) return 1 ;;
  esac
  if [ "$control_kind" = "file" ]; then validate_private_file "$source/control-webhook.env" || return 1; fi
  case "$phase" in
    topology-snapshotted|legacy-cron-pausing|legacy-cron-paused|candidate-starting|candidate-ready|nginx-switching|nginx-switched|pointers-switching|service-committed|committed|legacy-draining|legacy-stopped|cron-configured|hooks-configured|reconciled|rollback-verified)
      for metadata in had-v2 had-legacy legacy-sha pause-cron reconcile-profile; do
        validate_private_file "$source/$metadata" || return 1
      done
      validate_private_file "$source/crontab.before" || return 1
      had_v2_snapshot="$(read_transaction_value "$source" had-v2)"
      had_legacy_snapshot="$(read_transaction_value "$source" had-legacy)"
      legacy_sha_snapshot="$(read_transaction_value "$source" legacy-sha)"
      pause_cron_snapshot="$(read_transaction_value "$source" pause-cron)"
      reconcile_profile_snapshot="$(read_transaction_value "$source" reconcile-profile)"
      case "$had_v2_snapshot:$had_legacy_snapshot" in 1:0|0:1) ;; *) return 1 ;; esac
      case "$pause_cron_snapshot" in true|false) ;; *) return 1 ;; esac
      case "$reconcile_profile_snapshot" in none|jamsontoast|runningorder) ;; *) return 1 ;; esac
      if [ "$had_v2_snapshot" = "1" ]; then
        [ -n "$old_release" ] && [ -n "$old_secret" ] || return 1
        [ -d "$old_release" ] && [ ! -L "$old_release" ] && [ -O "$old_release" ] || return 1
        [ "$(cat "$old_release/.merge4appstore-release" 2>/dev/null || true)" = "merge4appstore-release-v1" ] || return 1
        old_sha="$(cat "$old_release/.merge4appstore-deployment-sha" 2>/dev/null || true)"
        case "$old_sha" in ''|*[!0-9a-fA-F]*) return 1 ;; esac
        [ "${#old_sha}" -eq 40 ] || return 1
        validate_private_file "$old_secret" || return 1
        [ -z "$legacy_sha_snapshot" ] || return 1
      else
        [ -z "$old_release" ] && [ -z "$old_secret" ] || return 1
        case "$legacy_sha_snapshot" in ''|*[!0-9a-fA-F]*) return 1 ;; esac
        [ "${#legacy_sha_snapshot}" -eq 40 ] || return 1
      fi
      ;;
  esac
  case "$phase" in
    nginx-switching|nginx-switched|pointers-switching|service-committed|committed|legacy-draining|legacy-stopped|cron-configured|hooks-configured|reconciled)
      validate_private_file "$source/nginx-config" || return 1
      validate_private_file "$source/snippet-existed" || return 1
      validate_owned_regular_file "$source/nginx-site.conf" || return 1
      if [ "$(read_transaction_value "$source" snippet-existed)" = "1" ]; then
        validate_owned_regular_file "$source/nginx-snippet.conf" || return 1
      fi
      managed_snapshot_version="$(read_transaction_value "$source" managed-config-snapshot-version)"
      case "$managed_snapshot_version" in
        '') ;;
        1)
          for metadata in managed-config-snapshot-version nginx-observability-existed logrotate-config-existed; do
            validate_private_file "$source/$metadata" || return 1
          done
          validate_private_file "$source/nginx-observability.candidate" || return 1
          validate_private_file "$source/logrotate.candidate" || return 1
          observability_was_present="$(read_transaction_value "$source" nginx-observability-existed)"
          logrotate_was_present="$(read_transaction_value "$source" logrotate-config-existed)"
          case "$observability_was_present:$logrotate_was_present" in
            0:0|0:1|1:0|1:1) ;;
            *) return 1 ;;
          esac
          if [ "$observability_was_present" = "1" ]; then
            validate_private_file "$source/nginx-observability.before" || return 1
          fi
          if [ "$logrotate_was_present" = "1" ]; then
            validate_private_file "$source/logrotate.before" || return 1
          fi
          ;;
        *) return 1 ;;
      esac
      ;;
  esac
}

select_commit_previous() {
  local candidate_sha="$1"
  local old_release="$2"
  local old_secret="$3"
  local old_previous_release="$4"
  local old_previous_secret="$5"
  local old_sha=""
  commit_previous_release="$old_release"
  commit_previous_secret="$old_secret"
  if [ -n "$old_release" ]; then
    old_sha="$(cat "$old_release/.merge4appstore-deployment-sha" 2>/dev/null || true)"
  fi
  if [ -n "$old_release" ] && [ "$old_sha" = "$candidate_sha" ]; then
    # Re-deploying identical code must not consume both rollback slots with
    # same-SHA release directories. Retain the last distinct predecessor.
    commit_previous_release="$old_previous_release"
    commit_previous_secret="$old_previous_secret"
  fi
  if { [ -n "$commit_previous_release" ] && [ -z "$commit_previous_secret" ]; } \
    || { [ -z "$commit_previous_release" ] && [ -n "$commit_previous_secret" ]; }; then
    return 1
  fi
}

normalize_committed_pointers() {
  local source="$1"
  local release secret sha old_release old_secret old_previous_release old_previous_secret
  release="$(read_transaction_value "$source" candidate-release)"
  secret="$(read_transaction_value "$source" candidate-secret)"
  sha="$(read_transaction_value "$source" candidate-sha)"
  old_release="$(read_transaction_value "$source" old-current)"
  old_secret="$(read_transaction_value "$source" old-current-secret)"
  old_previous_release="$(read_transaction_value "$source" old-previous)"
  old_previous_secret="$(read_transaction_value "$source" old-previous-secret)"
  select_commit_previous \
    "$sha" "$old_release" "$old_secret" "$old_previous_release" "$old_previous_secret" \
    || return 1
  restore_link "$STATE_DIR/previous" "$commit_previous_release" || return 1
  restore_link "$STATE_DIR/previous-webhook.env" "$commit_previous_secret" || return 1
  restore_link "$STATE_DIR/current" "$release" || return 1
  restore_link "$STATE_DIR/current-webhook.env" "$secret" || return 1
  if [ -e "$CONTROL_WEBHOOK_ENV" ] && [ ! -L "$CONTROL_WEBHOOK_ENV" ]; then
    echo "ERROR: Control webhook environment is not a symlink during commit recovery" >&2
    return 1
  fi
  replace_link "$STATE_DIR/current-webhook.env" "$CONTROL_WEBHOOK_ENV" || return 1
  [ "$(readlink -f -- "$CONTROL_WEBHOOK_ENV")" = "$secret" ] || return 1
  sync -f "$STATE_DIR" || return 1
  sync -f "$DEPLOY_DIR"
}

rollback_interrupted_transaction() {
  local source="$1"
  local release secret had_old_v2 old_release old_secret old_sha legacy_sha phase
  release="$(read_transaction_value "$source" candidate-release)"
  secret="$(read_transaction_value "$source" candidate-secret)"
  had_old_v2="$(read_transaction_value "$source" had-v2)"
  old_release="$(read_transaction_value "$source" old-current)"
  old_secret="$(read_transaction_value "$source" old-current-secret)"
  legacy_sha="$(read_transaction_value "$source" legacy-sha)"
  phase="$(read_transaction_value "$source" phase)"

  if [ "$had_old_v2" = "1" ]; then
    [ -n "$old_release" ] && [ -n "$old_secret" ] || return 1
    [ -d "$old_release" ] && [ ! -L "$old_release" ] && [ -O "$old_release" ] || return 1
    [ "$(cat "$old_release/.merge4appstore-release" 2>/dev/null || true)" = "merge4appstore-release-v1" ] || return 1
    validate_private_file "$old_secret" || return 1
    old_sha="$(cat "$old_release/.merge4appstore-deployment-sha" 2>/dev/null || true)"
    case "$old_sha" in ''|*[!0-9a-fA-F]*) return 1 ;; esac
    [ "${#old_sha}" -eq 40 ] || return 1
    start_release "$old_release" "$old_secret" "$old_sha" || return 1
    validate_pm2_release || return 1
    verify_health_url "http://$SERVICE_HOST:$SERVICE_PORT/health" "$old_sha" "Previous local service" || return 1
    case "$phase" in nginx-switching|nginx-switched|pointers-switching) restore_nginx_snapshot "$source" || return 1 ;; esac
    verify_health_url "$PUBLIC_BASE_URL/health" "$old_sha" "Previous public service" || return 1
  else
    [ "$(read_transaction_value "$source" had-legacy)" = "1" ] || return 1
    [ -n "$legacy_sha" ] || return 1
    [ "$(pm2_app_count "$LEGACY_SERVICE_NAME")" -gt 0 ] || return 1
    verify_health_url "http://$SERVICE_HOST:8787/health" "$legacy_sha" "Legacy local service" || return 1
    case "$phase" in nginx-switching|nginx-switched|pointers-switching) restore_nginx_snapshot "$source" || return 1 ;; esac
    verify_health_url "$PUBLIC_BASE_URL/health" "$legacy_sha" "Legacy public service" || return 1
    if [ "$(pm2_app_count "$SERVICE_NAME")" -gt 0 ]; then
      pm2 delete "$SERVICE_NAME" >/dev/null 2>&1 || return 1
    fi
    [ "$(pm2_app_count "$SERVICE_NAME")" = "0" ] || return 1
  fi

  restore_pointer_snapshot "$source" || return 1
  restore_crontab_exact "$source/crontab.before" || return 1
  clear_delivery_pause "$source" || return 1
  pm2 save --force >/dev/null || return 1
  secure_pm2_home || return 1
  write_transaction_phase_for "$source" rollback-verified || return 1
  cleanup_candidate_artifacts "$release" "$secret" || return 1
  write_transaction_phase_for "$source" recovered-rolled-back || return 1
  echo "Recovered pre-commit deployment $source by restoring the exact previous topology ($phase)"
}

finish_committed_transaction() {
  local source="$1"
  local release secret sha had_legacy_snapshot pause_cron reconcile_profile phase
  release="$(read_transaction_value "$source" candidate-release)"
  secret="$(read_transaction_value "$source" candidate-secret)"
  sha="$(read_transaction_value "$source" candidate-sha)"
  had_legacy_snapshot="$(read_transaction_value "$source" had-legacy)"
  pause_cron="$(read_transaction_value "$source" pause-cron)"
  reconcile_profile="$(read_transaction_value "$source" reconcile-profile)"
  phase="$(read_transaction_value "$source" phase)"
  case "$pause_cron" in true|false) ;; *) return 1 ;; esac
  case "$reconcile_profile" in none|jamsontoast|runningorder) ;; *) return 1 ;; esac

  if [ "$had_legacy_snapshot" = "1" ] && [ "$phase" != "legacy-stopped" ] \
    && [ "$phase" != "cron-configured" ] && [ "$phase" != "hooks-configured" ] \
    && [ "$phase" != "reconciled" ] && [ "$phase" != "complete" ]; then
    activate_delivery_pause "$source" || return 1
  fi
  configure_process_environment "$release" "$secret" "$sha"
  if ! validate_pm2_release >/dev/null 2>&1; then
    start_release "$release" "$secret" "$sha" || return 1
    validate_pm2_release || return 1
  fi
  verify_health_url "http://$SERVICE_HOST:$SERVICE_PORT/health" "$sha" "Committed local service" || return 1
  verify_health_url "$PUBLIC_BASE_URL/health" "$sha" "Committed public service" || return 1
  normalize_committed_pointers "$source" || return 1
  pm2 save --force >/dev/null || return 1
  secure_pm2_home || return 1

  if [ "$had_legacy_snapshot" = "1" ] && [ "$phase" != "legacy-stopped" ] \
    && [ "$phase" != "cron-configured" ] && [ "$phase" != "hooks-configured" ] \
    && [ "$phase" != "reconciled" ] && [ "$phase" != "complete" ]; then
    write_transaction_phase_for "$source" legacy-draining || return 1
    if [ "$(pm2_app_count "$LEGACY_SERVICE_NAME")" -gt 0 ]; then
      wait_for_legacy_drain || return 1
      [ "$(legacy_activity_count)" = "0" ] || return 1
      pm2 delete "$LEGACY_SERVICE_NAME" >/dev/null || return 1
    fi
    [ "$(pm2_app_count "$LEGACY_SERVICE_NAME")" = "0" ] || return 1
    persist_pm2_without_legacy_secrets || return 1
    write_transaction_phase_for "$source" legacy-stopped || return 1
  fi

  validate_logging_contract "$source" || return 1
  install_managed_cron "$release" "$pause_cron" || return 1
  case "$phase" in
    hooks-configured|reconciled) ;;
    *) write_transaction_phase_for "$source" cron-configured || return 1 ;;
  esac
  clear_delivery_pause "$source" || return 1

  if [ "$phase" != "hooks-configured" ] && [ "$phase" != "reconciled" ]; then
    retry_directory="$source" configure_repository_hooks "$release" "$secret" "$source" || return 1
    write_transaction_phase_for "$source" hooks-configured || return 1
  fi
  if [ "$phase" != "reconciled" ]; then
    if [ "$reconcile_profile" != "none" ]; then
      (cd "$release" && env MERGE4APPSTORE_ENV="$CONTROL_ENV" MERGE4APPSTORE_STATE_DIR="$STATE_DIR" \
        timeout 10m node index.js deploy --profile "profiles/$reconcile_profile.yml") || return 1
    fi
    write_transaction_phase_for "$source" reconciled || return 1
  fi
  write_transaction_phase_for "$source" complete
}

finish_recovered_rerun() {
  local current_release current_sha current_name run_id
  current_release="$(validate_state_link "$STATE_DIR/current" "$RELEASES_DIR")" || return 1
  [ -n "$current_release" ] || return 2
  current_sha="$(cat "$current_release/.merge4appstore-deployment-sha" 2>/dev/null || true)"
  [ "$current_sha" = "$DEPLOY_SHA" ] || return 2
  run_id="${DEPLOY_RUN_ID%-*}"
  [ "$run_id" != "$DEPLOY_RUN_ID" ] || return 2
  current_name="$(basename -- "$current_release")"
  case "$current_name" in "$DEPLOY_SHA-$run_id-"*) ;; *) return 2 ;; esac
  [ -d "$current_release" ] && [ ! -L "$current_release" ] && [ -O "$current_release" ] \
    && [ "$(cat "$current_release/.merge4appstore-release" 2>/dev/null || true)" = "merge4appstore-release-v1" ] \
    || return 1
  verify_health_url "http://$SERVICE_HOST:$SERVICE_PORT/health" "$DEPLOY_SHA" "Recovered local service" \
    || return 2
  verify_health_url "$PUBLIC_BASE_URL/health" "$DEPLOY_SHA" "Recovered public service" \
    || return 2
  write_transaction_phase untouched-cleanup || return 1
  cleanup_candidate_artifacts "$CANDIDATE_RELEASE" "$candidate_secret" || return 1
  echo "Deployment attempt already recovered and committed for this run: $current_release"
  return 0
}

recover_interrupted_transactions() {
  local skip="$1"
  local stale phase
  for stale in "$TRANSACTIONS_DIR"/*; do
    [ -e "$stale" ] || continue
    [ "$stale" = "$skip" ] && continue
    validate_transaction_envelope "$stale" \
      || fail "Unsafe deployment transaction requires manual recovery: $stale"
    phase="$(read_transaction_value "$stale" phase)"
    if [ "$phase" = "created" ]; then
      # No external state can have changed in this phase. Its metadata may be
      # incomplete if power was lost while the journal itself was initialized.
      write_transaction_phase_for "$stale" recovered-rolled-back \
        || fail "Could not close untouched deployment transaction: $stale"
      rm -rf -- "$stale"
      continue
    fi
    if [ "$phase" = "recovered-rolled-back" ] || [ "$phase" = "complete" ]; then
      rm -rf -- "$stale"
      continue
    fi
    validate_interrupted_transaction "$stale" \
      || fail "Unsafe or incomplete deployment transaction requires manual recovery: $stale"
    case "$phase" in
      snapshot-complete)
        write_transaction_phase_for "$stale" untouched-cleanup \
          || fail "Could not journal untouched candidate cleanup: $stale"
        cleanup_candidate_artifacts "$(read_transaction_value "$stale" candidate-release)" "$(read_transaction_value "$stale" candidate-secret)" \
          || fail "Could not clean untouched deployment transaction: $stale"
        write_transaction_phase_for "$stale" recovered-rolled-back
        ;;
      untouched-cleanup|rollback-verified)
        cleanup_candidate_artifacts "$(read_transaction_value "$stale" candidate-release)" "$(read_transaction_value "$stale" candidate-secret)" \
          || fail "Could not finish candidate cleanup: $stale"
        write_transaction_phase_for "$stale" recovered-rolled-back
        ;;
      topology-snapshotted|legacy-cron-pausing|legacy-cron-paused|candidate-starting|candidate-ready|nginx-switching|nginx-switched|pointers-switching)
        rollback_interrupted_transaction "$stale" \
          || fail "Could not restore pre-commit deployment transaction: $stale"
        ;;
      service-committed|committed|legacy-draining|legacy-stopped|cron-configured|hooks-configured|reconciled)
        finish_committed_transaction "$stale" \
          || fail "Could not finish committed deployment transaction: $stale"
        ;;
      recovered-rolled-back|complete) ;;
      *) fail "Interrupted deployment has an unknown phase '$phase': $stale" ;;
    esac
    [ "$(read_transaction_value "$stale" phase)" = "complete" ] \
      || [ "$(read_transaction_value "$stale" phase)" = "recovered-rolled-back" ] \
      || fail "Interrupted deployment did not reach a terminal phase: $stale"
    rm -rf -- "$stale"
  done
}

rollback() {
  echo "Rolling back incomplete deployment..." >&2
  local phase rollback_ok=1
  if [ "$topology_snapshotted" -eq 1 ]; then
    rollback_interrupted_transaction "$transaction_dir" || rollback_ok=0
  else
    phase="$(read_transaction_value "$transaction_dir" phase)"
    if [ "$phase" != "untouched-cleanup" ] && [ "$phase" != "rollback-verified" ]; then
      write_transaction_phase untouched-cleanup || rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ]; then
      cleanup_candidate_artifacts "$CANDIDATE_RELEASE" "$candidate_secret" || rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ]; then
      write_transaction_phase recovered-rolled-back || rollback_ok=0
    fi
  fi
  if [ "$rollback_ok" -ne 1 ]; then
    rollback_preserve=1
    echo "ERROR: Rollback was incomplete. Preserving candidate release, secret, and transaction evidence:" >&2
    echo "  release: $CANDIDATE_RELEASE" >&2
    echo "  secret: $candidate_secret" >&2
    echo "  transaction: $transaction_dir" >&2
  else
    rollback_preserve=0
    if [ "$topology_snapshotted" -eq 1 ]; then
      echo "Deployment rollback completed; the previous service topology was verified and candidate artifacts were cleaned." >&2
    else
      echo "Deployment cleanup completed before service cutover; candidate artifacts were removed." >&2
    fi
  fi
  [ "$rollback_ok" -eq 1 ]
}

on_exit() {
  local status="$1"
  local phase
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    echo "Recent sanitized Nginx upstream diagnostics (URI and headers are never recorded):" >&2
    print_sanitized_nginx_diagnostics
    phase="$(read_transaction_value "$transaction_dir" phase)"
    case "$phase" in
      service-committed|committed|legacy-draining|legacy-stopped|cron-configured|hooks-configured|reconciled|complete)
        rollback_preserve=1
        echo "ERROR: Service cutover committed but deployment finalization failed; preserving transaction for idempotent recovery: $transaction_dir" >&2
        ;;
      *) rollback || true ;;
    esac
  fi
  rm -f -- "$candidate_secret_new"
  if [ "$rollback_preserve" -eq 0 ] && { [ "$status" -eq 0 ] || [ "$(read_transaction_value "$transaction_dir" phase)" = "recovered-rolled-back" ]; }; then
    case "$transaction_dir" in "$TRANSACTIONS_DIR"/*) rm -rf -- "$transaction_dir" ;; esac
  fi
  exit "$status"
}
trap 'on_exit $?' EXIT
trap 'exit 130' HUP INT TERM

# A new release is already staged by the workflow, but no service state has
# changed yet. Finish or roll back every older durable transaction before taking
# a fresh topology snapshot for this deployment.
secure_pm2_home || fail "Could not secure PM2 state before deployment"
validate_pm2_startup_contract || fail "PM2 reboot recovery contract is unsafe"
recover_interrupted_transactions "$transaction_dir"
[ ! -e "$DELIVERY_PAUSE_FILE" ] && [ ! -L "$DELIVERY_PAUSE_FILE" ] \
  || fail "An unowned delivery pause gate remains after transaction recovery: $DELIVERY_PAUSE_FILE"
if finish_recovered_rerun; then
  exit 0
else
  recovered_rerun_status=$?
  [ "$recovered_rerun_status" -eq 2 ] \
    || fail "Recovered deployment was committed, but redundant candidate cleanup failed"
fi
ensure_disk_headroom "$STATE_DIR" || fail "Persistent state does not have safe deployment headroom"

old_current="$(validate_state_link "$STATE_DIR/current" "$RELEASES_DIR")"
old_previous="$(validate_state_link "$STATE_DIR/previous" "$RELEASES_DIR")"
old_current_secret="$(validate_state_link "$STATE_DIR/current-webhook.env" "$SECRETS_DIR")"
old_previous_secret="$(validate_state_link "$STATE_DIR/previous-webhook.env" "$SECRETS_DIR")"
write_transaction_value old-current "$old_current"
write_transaction_value old-previous "$old_previous"
write_transaction_value old-current-secret "$old_current_secret"
write_transaction_value old-previous-secret "$old_previous_secret"

rm -f -- "$transaction_dir/control-webhook.env"
control_secret_kind="missing"
control_secret_target=""
if [ -L "$CONTROL_WEBHOOK_ENV" ]; then
  control_secret_kind="link"
  control_secret_target="$(readlink -- "$CONTROL_WEBHOOK_ENV")"
  [ -f "$CONTROL_WEBHOOK_ENV" ] || fail "Control webhook environment link is dangling"
  resolved_control_secret="$(readlink -f -- "$CONTROL_WEBHOOK_ENV")"
  case "$resolved_control_secret" in "$SECRETS_DIR"/*) ;; *) fail "Control webhook environment link escapes the private secrets directory" ;; esac
  validate_private_file "$resolved_control_secret"
elif [ -e "$CONTROL_WEBHOOK_ENV" ]; then
  validate_private_file "$CONTROL_WEBHOOK_ENV"
  control_secret_kind="file"
  install -m 600 -- "$CONTROL_WEBHOOK_ENV" "$transaction_dir/control-webhook.env"
  sync -f "$transaction_dir/control-webhook.env"
  cmp -s -- "$CONTROL_WEBHOOK_ENV" "$transaction_dir/control-webhook.env" \
    || fail "Control webhook environment snapshot does not match its source"
else
  fail "Control webhook environment is missing: $CONTROL_WEBHOOK_ENV"
fi
write_transaction_value control-secret-kind "$control_secret_kind"
write_transaction_value control-secret-target "$control_secret_target"
crontab -l > "$transaction_dir/crontab.before" 2>/dev/null || :
chmod 600 "$transaction_dir/crontab.before"
sync -f "$transaction_dir/crontab.before"
sync -f "$transaction_dir"
write_transaction_phase snapshot-complete

[ ! -e "$candidate_secret" ] && [ ! -L "$candidate_secret" ] \
  && [ ! -e "$candidate_secret_new" ] && [ ! -L "$candidate_secret_new" ] \
  || fail "Candidate webhook secret or staging path already exists: $candidate_secret"
install -m 600 -- "$CONTROL_WEBHOOK_ENV" "$candidate_secret_new"
sync -f "$candidate_secret_new"
mv -T -- "$candidate_secret_new" "$candidate_secret"
sync -f "$SECRETS_DIR"
validate_private_file "$candidate_secret"
cmp -s -- "$CONTROL_WEBHOOK_ENV" "$candidate_secret" \
  || fail "Candidate webhook environment does not match the server-side control file"

echo "Installing and verifying immutable release $DEPLOY_SHA..."
# The required Actions test job already runs the complete suite and profile
# validation on this exact DEPLOY_SHA with Node 20. Re-running source-layout
# tests from a git archive on the production host is both redundant and unsafe:
# the archive has no .git directory, the deployer intentionally uses umask 077,
# and the live transaction state must never become a unit-test fixture. Keep
# host verification bounded to installing the lockfile and validating the
# packaged profiles; the dry runs, candidate health, and authenticated prepare
# smokes below exercise the installed release before cutover.
(cd "$CANDIDATE_RELEASE" \
  && timeout --kill-after=30s 10m npm ci --omit=dev \
  && timeout --kill-after=10s 1m npm run validate:profiles)

read_env_value() {
  local environment_file="$1"
  local key="$2"
  read_env_value_from_release "$CANDIDATE_RELEASE" "$environment_file" "$key"
}

for required_key in APP_STORE_CONNECT_API_KEY_ID APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_API_KEY_CONTENT GH_TOKEN; do
  [ -n "$(read_env_value "$CONTROL_ENV" "$required_key")" ] || fail "$CONTROL_ENV is missing $required_key"
done
validate_production_environment "$CANDIDATE_RELEASE" "$CONTROL_ENV" \
  || fail "$CONTROL_ENV contains unsafe production execution flags"
for required_key in GH_WEBHOOK_SECRET XCODE_CLOUD_WEBHOOK_TOKEN MERGE4APPSTORE_BUILD_TOKEN_JAMSONTOAST MERGE4APPSTORE_BUILD_TOKEN_RUNNINGORDER_IOS; do
  [ -n "$(read_env_value "$candidate_secret" "$required_key")" ] || fail "$candidate_secret is missing $required_key"
done
validate_webhook_environment "$CANDIDATE_RELEASE" "$candidate_secret" \
  || fail "$candidate_secret contains unsafe or incomplete webhook configuration"

rotation_reference=""
if [ -n "$old_current_secret" ]; then
  rotation_reference="$old_current_secret"
elif [ -f "$CONTROL_WEBHOOK_ENV" ]; then
  rotation_reference="$(readlink -f -- "$CONTROL_WEBHOOK_ENV")"
fi
if [ -n "$rotation_reference" ]; then
  validate_private_file "$rotation_reference"
  for secret_key in GH_WEBHOOK_SECRET XCODE_CLOUD_WEBHOOK_TOKEN MERGE4APPSTORE_BUILD_TOKEN_JAMSONTOAST MERGE4APPSTORE_BUILD_TOKEN_RUNNINGORDER_IOS; do
    [ "$(read_env_value "$rotation_reference" "$secret_key")" = "$(read_env_value "$candidate_secret" "$secret_key")" ] \
      || fail "Webhook credential rotation must be completed separately before deployment ($secret_key differs)"
  done
fi

export MERGE4APPSTORE_ENV="$CONTROL_ENV"
export MERGE4APPSTORE_STATE_DIR="$STATE_DIR"
if ! (cd "$CANDIDATE_RELEASE" && timeout --kill-after=30s 15m npm run prepare:mirrors); then
  fail "Git mirror prewarming failed before cutover"
fi

shopt -s nullglob
repository_profiles=("$CANDIDATE_RELEASE"/profiles/*.yml "$CANDIDATE_RELEASE"/profiles/*.yaml)
[ "${#repository_profiles[@]}" -gt 0 ] || fail "Candidate release contains no repository profiles"
for profile_file in "${repository_profiles[@]}"; do
  (cd "$CANDIDATE_RELEASE" && env \
    MERGE4APPSTORE_ENV="$CONTROL_ENV" MERGE4APPSTORE_STATE_DIR="$STATE_DIR" DRY_RUN=true \
    timeout 5m node index.js deploy --profile "$profile_file")
  (cd "$CANDIDATE_RELEASE" && env \
    MERGE4APPSTORE_ENV="$CONTROL_ENV" MERGE4APPSTORE_STATE_DIR="$STATE_DIR" DRY_RUN=true \
    timeout 5m node index.js expire --profile "$profile_file")
done

v2_processes="$(pm2_app_count "$SERVICE_NAME")"
if [ "$v2_processes" -gt 0 ]; then
  had_v2=1
  [ -n "$old_current" ] && [ -n "$old_current_secret" ] \
    || fail "Existing $SERVICE_NAME has no rollback release and secret"
  [ -d "$old_current" ] && [ ! -L "$old_current" ] && [ -O "$old_current" ] \
    || fail "Current rollback release is unsafe"
  [ "$(cat "$old_current/.merge4appstore-release" 2>/dev/null)" = "merge4appstore-release-v1" ] \
    || fail "Current rollback release marker is invalid"
  validate_private_file "$old_current_secret"
  old_sha="$(cat "$old_current/.merge4appstore-deployment-sha" 2>/dev/null || true)"
  case "$old_sha" in ''|*[!0-9a-fA-F]*) fail "Current rollback release SHA is invalid" ;; esac
  [ "${#old_sha}" -eq 40 ] || fail "Current rollback release SHA is not full length"
  verify_health_url "http://$SERVICE_HOST:$SERVICE_PORT/health" "$old_sha" "Current local service" \
    || fail "Current v2 service is not a verified rollback target"
  verify_health_url "$PUBLIC_BASE_URL/health" "$old_sha" "Current public service" \
    || fail "Current public service is not a verified rollback target"
else
  [ -z "$old_current" ] && [ -z "$old_current_secret" ] \
    || fail "State has a current release but $SERVICE_NAME is not running"
  legacy_processes="$(pm2_app_count "$LEGACY_SERVICE_NAME")"
  [ "$legacy_processes" -gt 0 ] || fail "First migration requires a healthy legacy PM2 rollback target"
  legacy_health="$(curl --fail-with-body --silent --show-error --connect-timeout 3 --max-time 15 \
    "http://$SERVICE_HOST:8787/health")" || fail "Could not read legacy service health"
  legacy_sha="$(HEALTH="$legacy_health" node -e '
    const health=JSON.parse(process.env.HEALTH||"{}");
    if(!health.ok || !/^[0-9a-f]{40}$/i.test(health.deployment_sha||""))process.exit(1);
    process.stdout.write(health.deployment_sha);
  ')" || fail "Legacy service has no exact deployment identity"
  verify_health_url "$PUBLIC_BASE_URL/health" "$legacy_sha" "Legacy public service" \
    || fail "Legacy public service is not a verified rollback target"
  had_legacy=1
fi

write_transaction_value had-v2 "$had_v2"
write_transaction_value had-legacy "$had_legacy"
write_transaction_value legacy-sha "$legacy_sha"
write_transaction_value pause-cron "$PAUSE_CRON"
write_transaction_value reconcile-profile "$RECONCILE_PROFILE"
write_transaction_phase topology-snapshotted
topology_snapshotted=1

# Every candidate starts on the live v2 port. Gate durable execution before a
# first start or generation handoff so an uncommitted release can accept and persist
# webhook deliveries, but cannot perform repository or App Store mutations.
activate_delivery_pause "$transaction_dir" || fail "Could not create durable delivery pause gate"

# Quiesce every managed cron generation before starting the
# candidate. The journal phase names are retained for compatibility with
# already-written first-migration transactions. A pre-commit rollback restores
# the exact crontab snapshot captured above.
write_transaction_phase legacy-cron-pausing
pause_managed_cron "$transaction_dir/crontab.before" \
  || fail "Managed cron remained after quiescing"
write_transaction_phase legacy-cron-paused
echo "Paused managed cron; durable webhook execution is gated by $DELIVERY_PAUSE_FILE"

write_transaction_phase candidate-starting
start_release "$CANDIDATE_RELEASE" "$candidate_secret" "$DEPLOY_SHA"
validate_pm2_release

health=""
for attempt in {1..60}; do
  if health="$(curl --fail-with-body --silent --show-error --connect-timeout 2 --max-time 5 \
    "http://$SERVICE_HOST:$SERVICE_PORT/health?deployment=$DEPLOY_SHA")"; then
    if HEALTH="$health" EXPECTED_SHA="$DEPLOY_SHA" node -e '
      const health = JSON.parse(process.env.HEALTH || "{}");
      if (!health.ok || health.deployment_sha !== process.env.EXPECTED_SHA) process.exit(1);
    '; then
      break
    fi
  fi
  health=""
  sleep 1
done
[ -n "$health" ] || fail "Candidate PM2 service did not report the expected deployment SHA"

control_gh_token="$(read_env_value "$CONTROL_ENV" GH_TOKEN)"
for profile_file in "${repository_profiles[@]}"; do
  instance="$(cd "$CANDIDATE_RELEASE" && node -e "import('./lib/profile.js').then(({loadRepositoryProfile})=>console.log(loadRepositoryProfile(process.argv[1]).instance))" "$profile_file")"
  repository="$(cd "$CANDIDATE_RELEASE" && node -e "import('./lib/profile.js').then(({loadRepositoryProfile})=>{const p=loadRepositoryProfile(process.argv[1]);console.log(p.repository.owner+'/'+p.repository.name)})" "$profile_file")"
  beta_branch="$(cd "$CANDIDATE_RELEASE" && node -e "import('./lib/profile.js').then(({loadRepositoryProfile})=>{const p=loadRepositoryProfile(process.argv[1]);console.log(p.repository.beta_branch||'develop')})" "$profile_file")"
  token_env="$(cd "$CANDIDATE_RELEASE" && node -e "Promise.all([import('./lib/profile.js'),import('./lib/webhooks.js')]).then(([{loadRepositoryProfile},{webhookSettings}])=>console.log(webhookSettings(loadRepositoryProfile(process.argv[1])).buildTokenEnv))" "$profile_file")"
  build_token="$(read_env_value "$candidate_secret" "$token_env")"
  [ -n "$build_token" ] || fail "Candidate secret is missing $token_env"
  header_file="$transaction_dir/build-token-$instance.header"
  printf 'Authorization: Bearer %s\n' "$build_token" > "$header_file"
  encoded_beta_branch="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$beta_branch")"
  commit=""
  GH_TOKEN="$control_gh_token" retry_capture commit "GitHub branch-head lookup for $repository:$beta_branch" 4 \
    timeout 30s gh api "repos/$repository/commits/$encoded_beta_branch" --jq .sha \
    || fail "Could not resolve $repository:$beta_branch after bounded retries"
  payload="$(REPOSITORY="$repository" COMMIT="$commit" BRANCH="$beta_branch" node -e 'console.log(JSON.stringify({repository:process.env.REPOSITORY,commit:process.env.COMMIT,branch:process.env.BRANCH,target_branch:"",pull_request:null,current_marketing_version:"0.1"}))')"
  prepared=""
  retry_capture prepared "authenticated preparation smoke for $instance" 4 \
    curl --fail-with-body --silent --show-error --connect-timeout 3 --max-time 50 \
      --header "@$header_file" --header 'Content-Type: application/json' --data "$payload" \
      "http://$SERVICE_HOST:$SERVICE_PORT/v1/builds/prepare/$instance" \
    || fail "Preparation smoke for $instance failed after bounded retries"
  PREPARED="$prepared" node -e 'const value=JSON.parse(process.env.PREPARED);if(!value.marketing_version)throw new Error("Preparation smoke response has no version");console.log(`Prepared endpoint: ${value.role}/${value.purpose} version ${value.marketing_version}`)'
done
write_transaction_phase candidate-ready

if [ "$had_v2" -eq 0 ]; then
  # The legacy app still serves port 8787. Persist both processes before the
  # nginx switch so a reboot during the first migration remains recoverable.
  pm2 save --force
  secure_pm2_home
fi

ensure_disk_headroom "$STATE_DIR" || fail "Persistent state lost safe headroom before proxy cutover"
nginx_match="$(grep -RlsF -- "$NGINX_SERVER_NAME" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | head -1 || true)"
[ -n "$nginx_match" ] || fail "Could not find nginx configuration for $NGINX_SERVER_NAME"
nginx_config="$(readlink -f -- "$nginx_match")"
case "$nginx_config" in /etc/nginx/*) ;; *) fail "Unsafe nginx configuration path: $nginx_config" ;; esac
nginx_config_backup="$transaction_dir/nginx-site.conf"
cp -p -- "$nginx_config" "$nginx_config_backup"
sync -f "$nginx_config_backup"
if [ -e "$NGINX_SNIPPET" ]; then
  [ ! -L "$NGINX_SNIPPET" ] && [ -f "$NGINX_SNIPPET" ] || fail "Unsafe nginx snippet path"
  snippet_existed=1
  cp -p -- "$NGINX_SNIPPET" "$transaction_dir/nginx-snippet.conf"
  sync -f "$transaction_dir/nginx-snippet.conf"
fi
observability_existed=0
if [ -e "$NGINX_OBSERVABILITY_CONFIG" ] || [ -L "$NGINX_OBSERVABILITY_CONFIG" ]; then
  [ ! -L "$NGINX_OBSERVABILITY_CONFIG" ] && [ -f "$NGINX_OBSERVABILITY_CONFIG" ] \
    && [ -O "$NGINX_OBSERVABILITY_CONFIG" ] \
    && [ "$(stat -c '%a' "$NGINX_OBSERVABILITY_CONFIG")" = "644" ] \
    || fail "Unsafe existing Nginx observability configuration"
  observability_existed=1
  install -m 600 -- "$NGINX_OBSERVABILITY_CONFIG" "$transaction_dir/nginx-observability.before"
  sync -f "$transaction_dir/nginx-observability.before"
fi
logrotate_existed=0
if [ -e "$LOGROTATE_CONFIG" ] || [ -L "$LOGROTATE_CONFIG" ]; then
  validate_private_file "$LOGROTATE_CONFIG" || fail "Unsafe existing private logrotate configuration"
  logrotate_existed=1
  install -m 600 -- "$LOGROTATE_CONFIG" "$transaction_dir/logrotate.before"
  sync -f "$transaction_dir/logrotate.before"
fi
write_nginx_observability_configuration "$transaction_dir/nginx-observability.candidate"
write_logrotate_configuration "$transaction_dir/logrotate.candidate"
chmod 600 "$transaction_dir/nginx-observability.candidate" "$transaction_dir/logrotate.candidate"
sync -f "$transaction_dir/nginx-observability.candidate"
sync -f "$transaction_dir/logrotate.candidate"
validate_logrotate_configuration "$transaction_dir/logrotate.candidate" "$transaction_dir/logrotate-candidate.state" \
  || fail "Generated private logrotate configuration is invalid"
rm -f -- "$transaction_dir/logrotate-candidate.state"
write_transaction_value nginx-config "$nginx_config"
write_transaction_value snippet-existed "$snippet_existed"
write_transaction_value managed-config-snapshot-version 1
write_transaction_value nginx-observability-existed "$observability_existed"
write_transaction_value logrotate-config-existed "$logrotate_existed"
sync -f "$transaction_dir"
write_transaction_phase nginx-switching

install_atomic_copy "$transaction_dir/nginx-observability.candidate" \
  "$NGINX_OBSERVABILITY_CONFIG" 644 || fail "Could not install sanitized Nginx diagnostics"
install_atomic_copy "$transaction_dir/logrotate.candidate" \
  "$LOGROTATE_CONFIG" 600 || fail "Could not install private log rotation"
nginx_snippet_new="$(mktemp /etc/nginx/snippets/.merge4appstore-webhooks.XXXXXX)"
chmod 644 "$nginx_snippet_new"
printf '%s\n' \
  'location /merge4appstore/ {' \
  "    access_log \"$NGINX_ACCESS_LOG\" merge4appstore_upstream_v1;" \
  '    error_log /dev/null crit;' \
  '    add_header X-Merge4AppStore-Request-ID $request_id always;' \
  "    proxy_pass http://$SERVICE_HOST:$SERVICE_PORT/;" \
  '    proxy_http_version 1.1;' \
  '    proxy_connect_timeout 5s;' \
  '    proxy_send_timeout 50s;' \
  '    proxy_read_timeout 50s;' \
  '    proxy_set_header Host $host;' \
  '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  '    proxy_set_header X-Forwarded-Proto $scheme;' \
  '    proxy_set_header X-Merge4AppStore-Request-ID $request_id;' \
  '}' > "$nginx_snippet_new"
sync -f "$nginx_snippet_new"
mv -T -- "$nginx_snippet_new" "$NGINX_SNIPPET"
install_nginx_include "$nginx_config" || fail "Could not target nginx server block for $NGINX_SERVER_NAME"
grep -Fq 'include /etc/nginx/snippets/merge4appstore-webhooks.conf;' "$nginx_config" \
  || fail "Could not install the nginx webhook include"
sync -f "$NGINX_SNIPPET"
sync -f "$nginx_config"
validate_logging_contract "$transaction_dir" || fail "Managed logging contract is invalid"
run_logrotate_configuration "$LOGROTATE_CONFIG" \
  || fail "Private rootless log rotation could not run"
ensure_disk_headroom "$STATE_DIR" \
  || fail "Persistent state lost safe headroom during log rotation"
nginx_diagnostic_before="$(tail -n 1 -- "$NGINX_ACCESS_LOG" || true)"
nginx -t
systemctl reload nginx

public_health=""
retry_capture public_health "public deployment health check" 4 \
  curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 15 \
    "$PUBLIC_BASE_URL/health?deployment=$DEPLOY_SHA" \
  || fail "Public deployment health did not recover after bounded retries"
HEALTH="$public_health" EXPECTED_SHA="$DEPLOY_SHA" node -e '
  const health = JSON.parse(process.env.HEALTH || "{}");
  if (!health.ok || health.deployment_sha !== process.env.EXPECTED_SHA) {
    throw new Error(`Public webhook health reports ${health.deployment_sha || "unknown"}; expected ${process.env.EXPECTED_SHA}`);
  }
'
verify_nginx_diagnostic_log "$nginx_diagnostic_before" "$PUBLIC_BASE_URL/health?deployment=$DEPLOY_SHA" \
  || fail "Public request completed without a safe Nginx upstream diagnostic"

write_transaction_phase nginx-switched
write_transaction_phase pointers-switching
select_commit_previous \
  "$DEPLOY_SHA" "$old_current" "$old_current_secret" "$old_previous" "$old_previous_secret" \
  || fail "Release and credential rollback pointers do not match"
if [ -n "$commit_previous_release" ]; then replace_link "$commit_previous_release" "$STATE_DIR/previous"; else restore_link "$STATE_DIR/previous" ""; fi
if [ -n "$commit_previous_secret" ]; then replace_link "$commit_previous_secret" "$STATE_DIR/previous-webhook.env"; else restore_link "$STATE_DIR/previous-webhook.env" ""; fi
replace_link "$CANDIDATE_RELEASE" "$STATE_DIR/current"
replace_link "$candidate_secret" "$STATE_DIR/current-webhook.env"
replace_link "$STATE_DIR/current-webhook.env" "$CONTROL_WEBHOOK_ENV"
sync -f "$STATE_DIR"
sync -f "$DEPLOY_DIR"
pm2 save --force
secure_pm2_home
write_transaction_phase service-committed
finish_committed_transaction "$transaction_dir" \
  || fail "Service is committed but deployment finalization must be recovered"

current_release="$(readlink -f -- "$STATE_DIR/current")"
previous_release="$(readlink -f -- "$STATE_DIR/previous" 2>/dev/null || true)"
for release in "$RELEASES_DIR"/*; do
  [ -e "$release" ] || continue
  [ -d "$release" ] && [ ! -L "$release" ] || fail "Unsafe entry in releases directory: $release"
  [ "$release" = "$current_release" ] || [ "$release" = "$previous_release" ] || {
    [ "$(cat "$release/.merge4appstore-release" 2>/dev/null)" = "merge4appstore-release-v1" ] \
      || fail "Refusing to clean unmarked release: $release"
    rm -rf -- "$release"
  }
done
current_secret="$(readlink -f -- "$STATE_DIR/current-webhook.env")"
previous_secret="$(readlink -f -- "$STATE_DIR/previous-webhook.env" 2>/dev/null || true)"
for secret in "$SECRETS_DIR"/webhook-*.env; do
  [ -e "$secret" ] || continue
  [ "$secret" = "$current_secret" ] || [ "$secret" = "$previous_secret" ] || {
    validate_private_file "$secret"
    rm -f -- "$secret"
  }
done

write_transaction_phase complete
for stale_transaction in "$TRANSACTIONS_DIR"/*; do
  [ -e "$stale_transaction" ] || continue
  [ "$stale_transaction" = "$transaction_dir" ] && continue
  [ -d "$stale_transaction" ] && [ ! -L "$stale_transaction" ] \
    && [ "$(cat "$stale_transaction/.merge4appstore-transaction" 2>/dev/null || true)" = "merge4appstore-deployment-transaction-v1" ] \
    || fail "Refusing to clean unsafe deployment transaction: $stale_transaction"
  rm -rf -- "$stale_transaction"
done

echo "merge4appstore deployment complete: $DEPLOY_SHA"
