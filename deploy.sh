#!/usr/bin/env bash
#
# Transactional deploy for the XenForo AI chatpage (windowsforum.com/chatpage).
#
# Usage: deploy.sh [deploy|rollback|verify]
#
# Guarantees:
#   - Exclusive deploy lock (flock on $DEPLOY_LOCK_FILE); concurrent runs fail fast.
#   - Clean-worktree enforcement (override with DEPLOY_ALLOW_DIRTY=1, logged loudly).
#   - SHA-256 release inventories (RELEASE-INVENTORY.sha256) written at staging
#     time and validated locally and on the peer before anything is switched.
#   - Recovery state ($DEPLOY_STATE_FILE, JSON) rewritten atomically after every
#     irreversible step so a crashed deploy can be diagnosed and reconciled.
#   - XenForo chat template payloads are bundled into every release
#     ($release/xenforo-templates/<style>/<template>); the live templates are
#     snapshotted before any switch, and both forward activation and rollback
#     apply the selected release's bundle + designer sync on BOTH nodes.
#   - Any failure after activation begins restores the previous assets AND the
#     snapshotted templates, re-runs designer sync, re-purges Cloudflare and
#     re-verifies the restored state before exiting nonzero.
#   - Ambiguous SSH failures (rc=255) are reconciled by re-probing the peer
#     (peer_probe_state -> switched / not-switched / unreachable).
#   - Fresh links created by a failed activation are unlinked, never left dangling.
#   - Pruning resolves current/previous per host and prunes each host with its
#     own keep-set.
#
# State file schema ($DEPLOY_STATE_FILE):
#   {
#     "version": 1,
#     "action": "deploy" | "rollback",
#     "phase": "<last completed checkpoint>",
#     "status": "in-progress" | "complete" | "failed" | "rolling-back"
#               | "rolled-back" | "rollback-incomplete",
#     "release": "<target release dir>",
#     "previous_local": "...", "previous_remote": "...",
#     "legacy_local": "...", "legacy_remote": "...",
#     "template_snapshot": "<dir under $DEPLOY_RECOVERY_ROOT>",
#     "migrated_local": bool, "migrated_remote": bool,
#     "fresh_local": bool, "fresh_remote": bool,
#     "local_switched": bool, "remote_switched": bool,
#     "templates_applied": bool, "purged": bool,
#     "pid": <pid>, "note": "...", "updated_at": "<ISO8601 UTC>"
#   }
# Phases (deploy): started, staged, peer-staged, templates-snapshotted,
#   local-prepared, local-switched, remote-prepared, remote-switched,
#   templates-synced, purged, verified, previous-recorded, pruned, complete.
# Phases (rollback): rollback-started, then the same activation phases.

set -Eeuo pipefail
IFS=$'\n\t'
umask 022

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly APP_ROOT
readonly DIST_DIR="${DIST_DIR:-$APP_ROOT/dist}"
readonly RELEASE_ROOT="${RELEASE_ROOT:-/web/releases/xenforo-ai-chatpage}"
readonly PUBLIC_LINK="${PUBLIC_LINK:-/web/public_html/chatpage}"
readonly XENFORO_ROOT="${XENFORO_ROOT:-/web/public_html}"
readonly XENFORO_STYLES_ROOT="${XENFORO_STYLES_ROOT:-/web/public_html/src/styles}"
readonly LIVE_ORIGIN="${LIVE_ORIGIN:-https://windowsforum.com}"
readonly ORIGIN_IP="${ORIGIN_IP:-127.0.0.1}"
readonly PEER_HOST="${PEER_HOST:-root@10.10.0.3}"
readonly PEER_ORIGIN_IP="${PEER_ORIGIN_IP:-10.10.0.3}"
readonly PEER_SSH_KEY="${PEER_SSH_KEY:-/web/.oci/id_rsa}"
readonly DEPLOY_OWNER="${DEPLOY_OWNER:-nobody:nobody}"
readonly RETAIN_RELEASES="${RETAIN_RELEASES:-5}"
readonly CLOUDFLARE_ENV_FILE="${CLOUDFLARE_ENV_FILE:-/web/.env}"
readonly DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-$RELEASE_ROOT/.deploy.lock}"
readonly DEPLOY_STATE_FILE="${DEPLOY_STATE_FILE:-$RELEASE_ROOT/.deploy-state.json}"
readonly DEPLOY_RECOVERY_ROOT="${DEPLOY_RECOVERY_ROOT:-$RELEASE_ROOT/.recovery}"
readonly DEPLOY_ALLOW_DIRTY="${DEPLOY_ALLOW_DIRTY:-0}"
readonly DEPLOY_RETRY_DELAY="${DEPLOY_RETRY_DELAY:-2}"
readonly DEPLOY_PUBLIC_RETRY_DELAY="${DEPLOY_PUBLIC_RETRY_DELAY:-5}"
readonly DEPLOY_SSH_CONNECT_TIMEOUT="${DEPLOY_SSH_CONNECT_TIMEOUT:-10}"
readonly DEPLOY_PROBE_ATTEMPTS="${DEPLOY_PROBE_ATTEMPTS:-3}"
readonly INVENTORY_NAME="RELEASE-INVENTORY.sha256"

readonly -a XF_STYLES=(wf3 wf3_domperf)
readonly -a XF_CHAT_TEMPLATES=(_page_node.313 _widget_ai_chat.html react_chat_container.html)

ACTION=""
STATE_ENABLED=0
LAST_PHASE="none"
SUCCEEDED=0
LOCAL_SWITCHED=0
REMOTE_SWITCHED=0
MIGRATED_LOCAL=0
MIGRATED_REMOTE=0
FRESH_LOCAL=0
FRESH_REMOTE=0
TEMPLATES_APPLIED=0
PURGED=0
PREVIOUS_TARGET=""
REMOTE_PREVIOUS_TARGET=""
LEGACY_LOCAL=""
LEGACY_REMOTE=""
TEMPLATE_SNAPSHOT_DIR=""
TARGET_RELEASE=""
PREPARED_RELEASE=""
PEER_STATE_NOTE=""
NEXT_LINK=""
TEMP_FILES=()

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARNING: %s\n' "$*" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# State file
# ---------------------------------------------------------------------------

json_str() {
  local s="${1-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

json_bool() {
  if (($1)); then printf 'true'; else printf 'false'; fi
}

# record_state <phase> [status] [note]
record_state() {
  ((STATE_ENABLED)) || return 0
  local phase="$1" status="${2:-in-progress}" note="${3:-}" tmp
  LAST_PHASE="$phase"
  tmp="$(mktemp "${DEPLOY_STATE_FILE}.XXXXXX")" || return 1
  {
    printf '{\n'
    printf '  "version": 1,\n'
    printf '  "action": %s,\n' "$(json_str "$ACTION")"
    printf '  "phase": %s,\n' "$(json_str "$phase")"
    printf '  "status": %s,\n' "$(json_str "$status")"
    printf '  "release": %s,\n' "$(json_str "$TARGET_RELEASE")"
    printf '  "previous_local": %s,\n' "$(json_str "$PREVIOUS_TARGET")"
    printf '  "previous_remote": %s,\n' "$(json_str "$REMOTE_PREVIOUS_TARGET")"
    printf '  "legacy_local": %s,\n' "$(json_str "$LEGACY_LOCAL")"
    printf '  "legacy_remote": %s,\n' "$(json_str "$LEGACY_REMOTE")"
    printf '  "template_snapshot": %s,\n' "$(json_str "$TEMPLATE_SNAPSHOT_DIR")"
    printf '  "migrated_local": %s,\n' "$(json_bool "$MIGRATED_LOCAL")"
    printf '  "migrated_remote": %s,\n' "$(json_bool "$MIGRATED_REMOTE")"
    printf '  "fresh_local": %s,\n' "$(json_bool "$FRESH_LOCAL")"
    printf '  "fresh_remote": %s,\n' "$(json_bool "$FRESH_REMOTE")"
    printf '  "local_switched": %s,\n' "$(json_bool "$LOCAL_SWITCHED")"
    printf '  "remote_switched": %s,\n' "$(json_bool "$REMOTE_SWITCHED")"
    printf '  "templates_applied": %s,\n' "$(json_bool "$TEMPLATES_APPLIED")"
    printf '  "purged": %s,\n' "$(json_bool "$PURGED")"
    printf '  "pid": %s,\n' "$$"
    printf '  "note": %s,\n' "$(json_str "$note")"
    printf '  "updated_at": %s\n' "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
    printf '}\n'
  } >"$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$DEPLOY_STATE_FILE" || return 1
}

# ---------------------------------------------------------------------------
# Locking and preconditions
# ---------------------------------------------------------------------------

acquire_lock() {
  mkdir -p -- "$RELEASE_ROOT" || die "Cannot create $RELEASE_ROOT"
  exec 9>"$DEPLOY_LOCK_FILE" || die "Cannot open lock file $DEPLOY_LOCK_FILE"
  if ! flock -n 9; then
    die "Another deployment is already running (lock held on $DEPLOY_LOCK_FILE); refusing to start"
  fi
}

ensure_clean_worktree() {
  local dirty
  dirty="$(git -C "$APP_ROOT" status --porcelain -- .)" \
    || die "git status failed in $APP_ROOT"
  if [[ -n "$dirty" ]]; then
    if [[ "$DEPLOY_ALLOW_DIRTY" == 1 ]]; then
      warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
      warn "!!! DEPLOY_ALLOW_DIRTY=1: deploying from a DIRTY worktree. !!!"
      warn "!!! The release id will not correspond to committed code.  !!!"
      warn "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
      printf '%s\n' "$dirty" >&2
    else
      printf '%s\n' "$dirty" >&2
      die "Worktree is dirty; commit your changes or set DEPLOY_ALLOW_DIRTY=1 for an emergency deploy"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

atomic_link() {
  local target="$1" link="$2" next
  next="${link}.next.$$"
  rm -f -- "$next" || return 1
  ln -s -- "$target" "$next" || return 1
  if ! mv -Tf -- "$next" "$link"; then
    rm -f -- "$next"
    return 1
  fi
}

peer_ssh() {
  ssh -i "$PEER_SSH_KEY" \
    -o BatchMode=yes \
    -o "ConnectTimeout=$DEPLOY_SSH_CONNECT_TIMEOUT" \
    -o StrictHostKeyChecking=no \
    "$PEER_HOST" "$@"
}

# --checksum: template payloads and rebuilt assets can legitimately change
# content while keeping the same size within the same mtime second, which the
# rsync quick-check would silently skip.
peer_rsync() {
  rsync -a --checksum "$@" \
    -e "ssh -i $PEER_SSH_KEY -o BatchMode=yes -o ConnectTimeout=$DEPLOY_SSH_CONNECT_TIMEOUT -o StrictHostKeyChecking=no"
}

# generate_inventory <dir>  — sorted sha256 of every file, relative paths.
generate_inventory() {
  local dir="$1" tmp
  tmp="$dir/.$INVENTORY_NAME.tmp"
  (
    cd "$dir" || exit 1
    find . -type f ! -name "$INVENTORY_NAME" ! -name ".$INVENTORY_NAME.tmp" -print0 \
      | sort -z | xargs -0 -r sha256sum
  ) >"$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$dir/$INVENTORY_NAME" || return 1
}

# verify_inventory <dir> — strict: every listed file matches, no extras.
verify_inventory() {
  local dir="$1" expected actual
  [[ -f "$dir/$INVENTORY_NAME" ]] || { fail "$dir has no $INVENTORY_NAME"; return 1; }
  (cd "$dir" && sha256sum --check --quiet "$INVENTORY_NAME") \
    || { fail "Release inventory mismatch in $dir"; return 1; }
  expected="$(wc -l <"$dir/$INVENTORY_NAME")" || return 1
  actual="$(cd "$dir" && find . -type f ! -name "$INVENTORY_NAME" | wc -l)" || return 1
  [[ "$expected" == "$actual" ]] \
    || { fail "Release inventory file count mismatch in $dir ($expected listed, $actual present)"; return 1; }
}

# ---------------------------------------------------------------------------
# Cleanup / failure rollback
# ---------------------------------------------------------------------------

cleanup() {
  local status=$?
  trap - EXIT
  set +e

  if [[ -n "$NEXT_LINK" ]]; then
    rm -f -- "$NEXT_LINK"
  fi
  if ((${#TEMP_FILES[@]})); then
    rm -f -- "${TEMP_FILES[@]}"
  fi

  if ((SUCCEEDED == 1)); then
    exit "$status"
  fi

  if ((STATE_ENABLED == 1)); then
    if ((LOCAL_SWITCHED || REMOTE_SWITCHED || MIGRATED_LOCAL || MIGRATED_REMOTE || TEMPLATES_APPLIED)) \
      || [[ -n "$PEER_STATE_NOTE" ]]; then
      restore_after_failure
    else
      record_state "$LAST_PHASE" failed "aborted before activation began"
    fi
  fi

  if ((status == 0)) && [[ -n "$ACTION" ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

restore_local_public_link() {
  if ((MIGRATED_LOCAL)); then
    if [[ -L "$PUBLIC_LINK" ]]; then
      rm -f -- "$PUBLIC_LINK" || return 1
    fi
    if [[ -e "$PUBLIC_LINK" ]]; then
      fail "$PUBLIC_LINK unexpectedly exists; cannot restore migrated directory"
      return 1
    fi
    [[ -d "$LEGACY_LOCAL" ]] || { fail "Legacy directory $LEGACY_LOCAL is missing"; return 1; }
    rm -f -- "$LEGACY_LOCAL/$INVENTORY_NAME" || return 1
    if [[ -f "$LEGACY_LOCAL/.htaccess.pre-migrate" ]]; then
      mv -f -- "$LEGACY_LOCAL/.htaccess.pre-migrate" "$LEGACY_LOCAL/.htaccess" || return 1
    else
      rm -f -- "$LEGACY_LOCAL/.htaccess" || return 1
    fi
    mv -- "$LEGACY_LOCAL" "$PUBLIC_LINK" || return 1
    log "Restored the original directory at $PUBLIC_LINK"
  elif ((FRESH_LOCAL)); then
    if [[ -L "$PUBLIC_LINK" ]]; then
      rm -f -- "$PUBLIC_LINK" || return 1
      log "Unlinked freshly created $PUBLIC_LINK (no previous target existed)"
    fi
  elif [[ -n "$PREVIOUS_TARGET" ]]; then
    atomic_link "$PREVIOUS_TARGET" "$PUBLIC_LINK" || return 1
    log "Restored $PUBLIC_LINK -> $PREVIOUS_TARGET"
  fi
}

restore_peer_public_link() {
  local mode="link"
  if ((MIGRATED_REMOTE)); then
    mode="migrated"
  elif ((FRESH_REMOTE)) || [[ -z "$REMOTE_PREVIOUS_TARGET" ]]; then
    mode="fresh"
  fi
  peer_ssh bash -s -- "$mode" "$PUBLIC_LINK" "$REMOTE_PREVIOUS_TARGET" "$LEGACY_REMOTE" "$INVENTORY_NAME" <<'REMOTE' || return 1
# wf-peer-restore
set -Eeuo pipefail
mode="$1"; link="$2"; previous="$3"; legacy="$4"; inv="$5"
case "$mode" in
  migrated)
    if [[ -L "$link" ]]; then rm -f -- "$link"; fi
    [[ ! -e "$link" ]]
    [[ -d "$legacy" ]]
    rm -f -- "$legacy/$inv"
    if [[ -f "$legacy/.htaccess.pre-migrate" ]]; then
      mv -f -- "$legacy/.htaccess.pre-migrate" "$legacy/.htaccess"
    else
      rm -f -- "$legacy/.htaccess"
    fi
    mv -- "$legacy" "$link"
    ;;
  fresh)
    if [[ -L "$link" ]]; then rm -f -- "$link"; fi
    ;;
  link)
    next="${link}.next.$$"
    rm -f -- "$next"
    ln -s -- "$previous" "$next"
    mv -Tf -- "$next" "$link"
    ;;
esac
REMOTE
  log "Restored the peer public link state on $PEER_HOST"
}

restore_after_failure() {
  local notes=()

  warn "================================================================"
  warn "Activation failed; rolling back assets and templates on both nodes"
  warn "================================================================"
  record_state "$LAST_PHASE" rolling-back

  if ((REMOTE_SWITCHED || MIGRATED_REMOTE)) || [[ -n "$PEER_STATE_NOTE" ]]; then
    if ! restore_peer_public_link; then
      notes+=("peer-restore-failed")
    fi
  fi
  if ((LOCAL_SWITCHED || MIGRATED_LOCAL)); then
    if ! restore_local_public_link; then
      notes+=("local-restore-failed")
    fi
  fi

  if [[ -n "$TEMPLATE_SNAPSHOT_DIR" ]]; then
    if ! apply_template_bundle "$TEMPLATE_SNAPSHOT_DIR"; then
      notes+=("template-restore-failed")
    fi
  fi

  if ! purge_chatpage_prefix; then
    notes+=("repurge-failed")
  fi

  local verify_root=""
  if ((MIGRATED_LOCAL)); then
    verify_root="$PUBLIC_LINK"
  elif [[ -n "$PREVIOUS_TARGET" ]]; then
    verify_root="$PREVIOUS_TARGET"
  fi
  if [[ -n "$verify_root" ]] && ((${#notes[@]} == 0)); then
    if verify_live_release "$verify_root"; then
      log "Re-verified the restored release on both origins."
    else
      notes+=("reverify-failed")
    fi
  fi

  if [[ -n "$PEER_STATE_NOTE" ]]; then
    notes+=("$PEER_STATE_NOTE")
  fi

  if ((${#notes[@]})); then
    local joined
    joined="$(IFS='; '; printf '%s' "${notes[*]}")"
    warn "Rollback finished with problems: $joined — inspect $DEPLOY_STATE_FILE"
    record_state "$LAST_PHASE" rollback-incomplete "$joined"
  else
    record_state "$LAST_PHASE" rolled-back "restored previous assets and templates"
    warn "Rollback complete; previous release and templates are live again."
  fi
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

verify_release() {
  local release="$1"
  node "$APP_ROOT/scripts/verify-dist.mjs" "$release"
}

verify_rollback_release() {
  local release="$1"
  [[ -f "$release/index.html" ]] || { fail "Rollback release is missing index.html"; return 1; }
  [[ -f "$release/bot-avatar.webp" ]] || { fail "Rollback release is missing bot-avatar.webp"; return 1; }
  [[ -f "$release/static/js/main.js" ]] || { fail "Rollback release is missing main.js"; return 1; }
  [[ -f "$release/static/css/main.css" ]] || { fail "Rollback release is missing main.css"; return 1; }
}

verify_xenforo_templates() {
  node "$APP_ROOT/scripts/verify-xenforo-templates.mjs" "$XENFORO_STYLES_ROOT"
}

verify_peer_template_sources() {
  local style template source local_hash remote_hash attempt matched

  for style in "${XF_STYLES[@]}"; do
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      local_hash="$(sha256sum -- "$source" | awk '{print $1}')" \
        || { fail "Cannot hash $source"; return 1; }
      matched=0
      for attempt in 1 2 3 4 5; do
        if remote_hash="$(peer_ssh sha256sum -- "$source" 2>/dev/null | awk '{print $1}')" \
          && [[ "$remote_hash" == "$local_hash" ]]; then
          matched=1
          break
        fi
        if ((attempt < 5)); then
          sleep "$DEPLOY_RETRY_DELAY"
        fi
      done
      ((matched == 1)) || { fail "Peer template source is stale: $source"; return 1; }
    done
  done

  log "Verified matching XenForo chat template sources on $PEER_HOST."
}

run_release_checks() {
  cd "$APP_ROOT" || die "Cannot cd to $APP_ROOT"
  log "Running lint, typecheck, tests, build, and artifact verification..."
  npm run check || die "npm run check failed"
  verify_xenforo_templates || die "XenForo template verification failed"
  verify_peer_template_sources || die "Peer template source verification failed"
}

# ---------------------------------------------------------------------------
# Cloudflare purge and live verification
# ---------------------------------------------------------------------------

read_env_value() {
  local key="$1" value
  value="$(sed -n "s/^${key}=//p" "$CLOUDFLARE_ENV_FILE" | tail -n 1)"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

purge_chatpage_prefix() {
  local token="${CLOUDFLARE_PURGE_TOKEN:-}"
  local zone="${CLOUDFLARE_ZONE_ID:-}"
  local response_file

  if [[ -f "$CLOUDFLARE_ENV_FILE" ]]; then
    [[ -n "$token" ]] || token="$(read_env_value CLOUDFLARE_PURGE_TOKEN)"
    [[ -n "$zone" ]] || zone="$(read_env_value CLOUDFLARE_ZONE_ID)"
  fi

  [[ -n "$token" ]] || { fail "CLOUDFLARE_PURGE_TOKEN is required for a production deployment"; return 1; }
  [[ -n "$zone" ]] || { fail "CLOUDFLARE_ZONE_ID is required for a production deployment"; return 1; }

  response_file="$(mktemp)" || return 1
  TEMP_FILES+=("$response_file")
  curl --fail-with-body --silent --show-error \
    --request POST \
    "https://api.cloudflare.com/client/v4/zones/$zone/purge_cache" \
    --header "Authorization: Bearer $token" \
    --header 'Content-Type: application/json' \
    --data '{"prefixes":["windowsforum.com/chatpage"]}' \
    --output "$response_file" \
    || { fail "Cloudflare purge request failed"; return 1; }

  node --input-type=module - "$response_file" <<'NODE' || { fail "Cloudflare purge was not acknowledged"; return 1; }
import { readFile } from 'node:fs/promises';

const response = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (response.success !== true) {
  throw new Error(`Cloudflare prefix purge failed: ${JSON.stringify(response.errors || response)}`);
}
NODE

  log "Purged only the windowsforum.com/chatpage Cloudflare prefix."
}

assert_header() {
  local url="$1" expected="$2" mode="${3:-public}" headers

  if [[ "$mode" == origin ]]; then
    headers="$(curl --fail --silent --show-error --head \
      --resolve "windowsforum.com:443:$ORIGIN_IP" "$url")" || { fail "HEAD $url failed on origin"; return 1; }
  elif [[ "$mode" == peer ]]; then
    headers="$(curl --fail --silent --show-error --head \
      --resolve "windowsforum.com:443:$PEER_ORIGIN_IP" "$url")" || { fail "HEAD $url failed on peer"; return 1; }
  else
    headers="$(curl --fail --silent --show-error --head "$url")" || { fail "HEAD $url failed"; return 1; }
  fi

  printf '%s\n' "$headers" | tr -d '\r' | grep -Eiq "$expected" \
    || { fail "$url is missing the expected Cache-Control policy: $expected"; return 1; }
}

assert_origin_hash() {
  local relative="$1" expected_file="$2" origin_ip="$3"
  local expected_hash actual_hash download

  expected_hash="$(sha256sum -- "$expected_file" | awk '{print $1}')" \
    || { fail "Cannot hash $expected_file"; return 1; }
  download="$(mktemp)" || return 1
  TEMP_FILES+=("$download")
  curl --fail --silent --show-error \
    --resolve "windowsforum.com:443:$origin_ip" \
    "$LIVE_ORIGIN/chatpage/$relative?v=2" --output "$download" \
    || { fail "GET $relative failed on origin $origin_ip"; return 1; }
  actual_hash="$(sha256sum -- "$download" | awk '{print $1}')"
  [[ "$actual_hash" == "$expected_hash" ]] \
    || { fail "$relative hash does not match on origin $origin_ip"; return 1; }
}

assert_public_hash() {
  local relative="$1" expected_file="$2"
  local expected_hash actual_hash download attempt

  expected_hash="$(sha256sum -- "$expected_file" | awk '{print $1}')" \
    || { fail "Cannot hash $expected_file"; return 1; }
  download="$(mktemp)" || return 1
  TEMP_FILES+=("$download")

  for attempt in 1 2 3 4 5 6; do
    if curl --fail --silent --show-error \
      "$LIVE_ORIGIN/chatpage/$relative?v=2" --output "$download"; then
      actual_hash="$(sha256sum -- "$download" | awk '{print $1}')"
      if [[ "$actual_hash" == "$expected_hash" ]]; then
        return 0
      fi
    fi
    if ((attempt < 6)); then
      sleep "$DEPLOY_PUBLIC_RETRY_DELAY"
    fi
  done

  fail "Public $relative did not converge to the activated release"
}

verify_live_release() {
  local release="$1" hashed_file hashed_relative

  assert_origin_hash 'static/js/main.js' "$release/static/js/main.js" "$ORIGIN_IP" || return 1
  assert_origin_hash 'static/css/main.css' "$release/static/css/main.css" "$ORIGIN_IP" || return 1
  assert_origin_hash 'bot-avatar.webp' "$release/bot-avatar.webp" "$ORIGIN_IP" || return 1
  assert_origin_hash 'static/js/main.js' "$release/static/js/main.js" "$PEER_ORIGIN_IP" || return 1
  assert_origin_hash 'static/css/main.css' "$release/static/css/main.css" "$PEER_ORIGIN_IP" || return 1
  assert_origin_hash 'bot-avatar.webp' "$release/bot-avatar.webp" "$PEER_ORIGIN_IP" || return 1
  assert_public_hash 'static/js/main.js' "$release/static/js/main.js" || return 1
  assert_public_hash 'static/css/main.css' "$release/static/css/main.css" || return 1
  assert_public_hash 'bot-avatar.webp' "$release/bot-avatar.webp" || return 1

  assert_header "$LIVE_ORIGIN/chatpage/static/js/main.js?v=2" \
    'cache-control:.*no-cache.*must-revalidate' public || return 1
  assert_header "$LIVE_ORIGIN/chatpage/static/css/main.css?v=2" \
    'cache-control:.*no-cache.*must-revalidate' origin || return 1
  assert_header "$LIVE_ORIGIN/chatpage/static/js/main.js?v=2" \
    'cache-control:.*no-cache.*must-revalidate' peer || return 1
  assert_header "$LIVE_ORIGIN/chatpage/bot-avatar.webp?v=2" \
    'cache-control:.*no-cache.*must-revalidate' origin || return 1
  assert_header "$LIVE_ORIGIN/chatpage/bot-avatar.webp?v=2" \
    'cache-control:.*no-cache.*must-revalidate' peer || return 1

  hashed_file="$(find "$release/static/js" -maxdepth 1 -type f -name '*.chunk.js' -print -quit 2>/dev/null)" || hashed_file=""
  if [[ -n "$hashed_file" && "$(basename "$hashed_file")" =~ -[A-Za-z0-9_-]{8,}\.chunk\.js$ ]]; then
    hashed_relative="${hashed_file#"$release/"}"
    assert_header "$LIVE_ORIGIN/chatpage/$hashed_relative" \
      'cache-control:.*max-age=31536000.*immutable' origin || return 1
    assert_header "$LIVE_ORIGIN/chatpage/$hashed_relative" \
      'cache-control:.*max-age=31536000.*immutable' peer || return 1
  fi

  log "Verified both origins, public hashes, and stable/immutable cache headers."
}

# ---------------------------------------------------------------------------
# XenForo template bundles
# ---------------------------------------------------------------------------

stage_template_bundle() {
  local release="$1" style template source

  for style in "${XF_STYLES[@]}"; do
    mkdir -p -- "$release/xenforo-templates/$style" || return 1
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      [[ -f "$source" ]] || { fail "Missing XenForo template source: $source"; return 1; }
      cp -f -- "$source" "$release/xenforo-templates/$style/$template" || return 1
    done
  done
}

snapshot_active_templates() {
  local stamp style template source
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  TEMPLATE_SNAPSHOT_DIR="$DEPLOY_RECOVERY_ROOT/templates-$stamp"
  for style in "${XF_STYLES[@]}"; do
    mkdir -p -- "$TEMPLATE_SNAPSHOT_DIR/$style" || return 1
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      [[ -f "$source" ]] || { fail "Missing live XenForo template: $source"; return 1; }
      cp -f -- "$source" "$TEMPLATE_SNAPSHOT_DIR/$style/$template" || return 1
    done
  done
  log "Snapshotted the live XenForo chat templates to $TEMPLATE_SNAPSHOT_DIR"
}

# apply_template_bundle <bundle_root> — copy payloads into the styles roots on
# both nodes and run the designer sync on both nodes. Written with explicit
# error chaining so it also works in errexit-suppressed (restore) contexts.
apply_template_bundle() {
  local bundle_root="$1" style template source dest
  local -a payloads

  for style in "${XF_STYLES[@]}"; do
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$bundle_root/$style/$template"
      [[ -f "$source" ]] || { fail "Template bundle is missing $source"; return 1; }
      dest="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      cp -f -- "$source" "$dest" || { fail "Cannot install $dest"; return 1; }
    done
  done

  for style in "${XF_STYLES[@]}"; do
    payloads=()
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      payloads+=("$XENFORO_STYLES_ROOT/$style/templates/public/$template")
    done
    peer_rsync "${payloads[@]}" \
      "$PEER_HOST:$XENFORO_STYLES_ROOT/$style/templates/public/" \
      || { fail "Cannot push $style template payloads to $PEER_HOST"; return 1; }
  done

  (
    cd "$XENFORO_ROOT" || exit 1
    php cmd.php xf-designer:sync-templates wf3 || exit 1
    php cmd.php xf-designer:sync-templates wf3_domperf || exit 1
  ) || { fail "Local xf-designer:sync-templates failed"; return 1; }

  for style in "${XF_STYLES[@]}"; do
    peer_rsync "$XENFORO_STYLES_ROOT/$style/templates/_metadata.json" \
      "$PEER_HOST:$XENFORO_STYLES_ROOT/$style/templates/_metadata.json" \
      || { fail "Cannot push $style template metadata to $PEER_HOST"; return 1; }
  done

  peer_ssh bash -s -- "$XENFORO_ROOT" <<'REMOTE' || { fail "Peer xf-designer:sync-templates failed"; return 1; }
# wf-peer-sync-templates
set -Eeuo pipefail
cd "$1"
php cmd.php xf-designer:sync-templates wf3
php cmd.php xf-designer:sync-templates wf3_domperf
REMOTE

  log "Applied the XenForo chat template bundle and synced designer templates on both nodes."
}

# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------

stage_peer_release() {
  local release="$1"

  peer_ssh mkdir -p -- "$release" || die "Cannot create $release on $PEER_HOST"
  peer_rsync --delete "$release/" "$PEER_HOST:$release/" \
    || die "Cannot stage the release on $PEER_HOST"
  peer_ssh bash -s -- "$release" "$DEPLOY_OWNER" "$INVENTORY_NAME" <<'REMOTE' \
    || die "Peer release staging verification failed (divergent or incomplete peer release)"
# wf-peer-stage-verify
set -Eeuo pipefail
release="$1"; owner="$2"; inv="$3"
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod 644 {} +
chown -R "$owner" "$release"
test -f "$release/.htaccess"
test -f "$release/index.html"
test -f "$release/static/js/main.js"
test -f "$release/static/css/main.css"
test -f "$release/$inv"
cd "$release"
sha256sum --check --quiet "$inv"
expected="$(wc -l <"$inv")"
actual="$(find . -type f ! -name "$inv" | wc -l)"
if [[ "$expected" != "$actual" ]]; then
  echo "peer inventory count mismatch: $expected listed, $actual present" >&2
  exit 1
fi
REMOTE

  log "Staged and verified the release inventory on $PEER_HOST."
}

prepare_release() {
  local release_id release

  run_release_checks

  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$APP_ROOT" rev-parse --short HEAD)-$$"
  release="$RELEASE_ROOT/$release_id"
  TARGET_RELEASE="$release"
  mkdir -p -- "$release" || die "Cannot create $release"
  cp -a "$DIST_DIR"/. "$release"/ || die "Cannot copy $DIST_DIR into $release"
  stage_template_bundle "$release" || die "Cannot stage the XenForo template bundle"
  find "$release" -type d -exec chmod 755 {} + || die "chmod failed on $release"
  find "$release" -type f -exec chmod 644 {} + || die "chmod failed on $release"
  chown -R "$DEPLOY_OWNER" "$release" || die "chown failed on $release"
  generate_inventory "$release" || die "Cannot generate the release inventory"
  verify_release "$release" || die "Staged release failed artifact verification"
  verify_inventory "$release" || die "Staged release failed inventory verification"
  record_state staged
  stage_peer_release "$release"
  record_state peer-staged

  PREPARED_RELEASE="$release"
}

# ---------------------------------------------------------------------------
# Switching
# ---------------------------------------------------------------------------

local_prepare_switch() {
  local release="$1" legacy="$2"

  if [[ -L "$PUBLIC_LINK" ]]; then
    PREVIOUS_TARGET="$(readlink -f -- "$PUBLIC_LINK")"
    [[ -d "$PREVIOUS_TARGET" ]] || die "Current public symlink target is missing: $PREVIOUS_TARGET"
  elif [[ -d "$PUBLIC_LINK" ]]; then
    [[ ! -e "$legacy" ]] || die "Legacy release path already exists: $legacy"
    mv -- "$PUBLIC_LINK" "$legacy" || die "Cannot migrate $PUBLIC_LINK to $legacy"
    if [[ -f "$legacy/.htaccess" ]]; then
      cp -f -- "$legacy/.htaccess" "$legacy/.htaccess.pre-migrate" \
        || die "Cannot preserve the legacy .htaccess"
    fi
    cp -f -- "$release/.htaccess" "$legacy/.htaccess" || die "Cannot install .htaccess into $legacy"
    generate_inventory "$legacy" || die "Cannot generate an inventory for $legacy"
    PREVIOUS_TARGET="$legacy"
    LEGACY_LOCAL="$legacy"
    MIGRATED_LOCAL=1
    log "Migrated the legacy directory $PUBLIC_LINK to $legacy (inventory generated)"
  elif [[ -e "$PUBLIC_LINK" ]]; then
    die "$PUBLIC_LINK exists but is neither a directory nor symlink"
  else
    PREVIOUS_TARGET=""
    FRESH_LOCAL=1
  fi
}

local_switch() {
  local release="$1"

  NEXT_LINK="${PUBLIC_LINK}.next.$$"
  rm -f -- "$NEXT_LINK" || die "Cannot clear $NEXT_LINK"
  ln -s -- "$release" "$NEXT_LINK" || die "Cannot create $NEXT_LINK"
  mv -Tf -- "$NEXT_LINK" "$PUBLIC_LINK" || die "Cannot switch $PUBLIC_LINK"
  NEXT_LINK=""
  LOCAL_SWITCHED=1
  [[ "$(readlink -f -- "$PUBLIC_LINK")" == "$release" ]] \
    || die "Public symlink did not activate the staged release"
}

peer_reconcile_prepare() {
  local legacy="$1" out
  if out="$(peer_ssh bash -s -- "$PUBLIC_LINK" "$legacy" "$INVENTORY_NAME" <<'REMOTE'
# wf-peer-reconcile
set -Eeuo pipefail
link="$1"; legacy="$2"; inv="$3"
if [[ -e "$link" || -L "$link" ]]; then
  echo intact
elif [[ -d "$legacy" ]]; then
  rm -f -- "$legacy/$inv"
  if [[ -f "$legacy/.htaccess.pre-migrate" ]]; then
    mv -f -- "$legacy/.htaccess.pre-migrate" "$legacy/.htaccess"
  fi
  mv -- "$legacy" "$link"
  echo restored
else
  echo missing
fi
REMOTE
  )"; then
    log "Peer prepare reconcile result: $out"
    if [[ "$out" == missing ]]; then
      PEER_STATE_NOTE="peer public path missing after interrupted prepare; manual reconcile required"
    fi
  else
    PEER_STATE_NOTE="peer unreachable while reconciling an interrupted prepare"
    warn "$PEER_STATE_NOTE"
  fi
}

peer_prepare_switch() {
  local release="$1" legacy="$2" out rc=0

  out="$(peer_ssh bash -s -- "$release" "$PUBLIC_LINK" "$legacy" "$INVENTORY_NAME" <<'REMOTE'
# wf-peer-prepare
set -Eeuo pipefail
release="$1"; link="$2"; legacy="$3"; inv="$4"
if [[ -L "$link" ]]; then
  previous="$(readlink -f -- "$link")"
  if [[ ! -d "$previous" ]]; then
    echo "broken:$previous"
    exit 1
  fi
  printf 'link:%s\n' "$previous"
elif [[ -d "$link" ]]; then
  if [[ -e "$legacy" ]]; then
    echo "legacy-exists:$legacy"
    exit 1
  fi
  mv -- "$link" "$legacy"
  if [[ -f "$legacy/.htaccess" ]]; then
    cp -f -- "$legacy/.htaccess" "$legacy/.htaccess.pre-migrate"
  fi
  cp -f -- "$release/.htaccess" "$legacy/.htaccess"
  (
    cd "$legacy"
    find . -type f ! -name "$inv" -print0 | sort -z | xargs -0 -r sha256sum
  ) >"$legacy/$inv"
  printf 'dir:%s\n' "$legacy"
elif [[ -e "$link" ]]; then
  echo "other:"
  exit 1
else
  printf 'none:\n'
fi
REMOTE
  )" || rc=$?

  if ((rc == 255)); then
    warn "Peer connection lost while preparing the switch; reconciling"
    peer_reconcile_prepare "$legacy"
    die "Peer connection lost while preparing the switch"
  elif ((rc != 0)); then
    die "Peer switch preparation failed: ${out:-rc=$rc}"
  fi

  case "$out" in
    link:*)
      REMOTE_PREVIOUS_TARGET="${out#link:}"
      ;;
    dir:*)
      REMOTE_PREVIOUS_TARGET="${out#dir:}"
      LEGACY_REMOTE="${out#dir:}"
      MIGRATED_REMOTE=1
      log "Peer migrated its legacy directory to $LEGACY_REMOTE (inventory generated)"
      ;;
    none:*)
      REMOTE_PREVIOUS_TARGET=""
      FRESH_REMOTE=1
      ;;
    *)
      die "Unexpected peer prepare output: $out"
      ;;
  esac
}

# peer_probe_state <release> — prints: switched | not-switched | unreachable
peer_probe_state() {
  local release="$1" out attempt
  for attempt in $(seq 1 "$DEPLOY_PROBE_ATTEMPTS"); do
    if out="$(peer_ssh bash -s -- "$release" "$PUBLIC_LINK" <<'REMOTE'
# wf-peer-probe
set -Eeuo pipefail
release="$1"; link="$2"
if [[ -L "$link" && "$(readlink -f -- "$link")" == "$(readlink -f -- "$release")" ]]; then
  echo switched
else
  echo not-switched
fi
REMOTE
    )"; then
      printf '%s' "$out"
      return 0
    fi
    if ((attempt < DEPLOY_PROBE_ATTEMPTS)); then
      sleep "$DEPLOY_RETRY_DELAY"
    fi
  done
  printf 'unreachable'
}

peer_switch_once() {
  local release="$1"
  peer_ssh bash -s -- "$release" "$PUBLIC_LINK" <<'REMOTE'
# wf-peer-switch
set -Eeuo pipefail
release="$1"; link="$2"
next="${link}.next.$$"
rm -f -- "$next"
ln -s -- "$release" "$next"
mv -Tf -- "$next" "$link"
[[ "$(readlink -f -- "$link")" == "$(readlink -f -- "$release")" ]]
REMOTE
}

peer_switch_with_reconcile() {
  local release="$1" rc=0 retry_rc=0 probe

  peer_switch_once "$release" || rc=$?
  if ((rc == 0)); then
    REMOTE_SWITCHED=1
    return 0
  fi

  if ((rc == 255)); then
    warn "Peer switch SSH failed ambiguously (rc=255); probing the peer state"
    probe="$(peer_probe_state "$release")"
    case "$probe" in
      switched)
        warn "Peer probe: the switch completed before the connection dropped; continuing"
        REMOTE_SWITCHED=1
        return 0
        ;;
      not-switched)
        warn "Peer probe: the switch never happened; retrying once"
        peer_switch_once "$release" || retry_rc=$?
        if ((retry_rc == 0)); then
          REMOTE_SWITCHED=1
          return 0
        fi
        if ((retry_rc == 255)) && [[ "$(peer_probe_state "$release")" == switched ]]; then
          REMOTE_SWITCHED=1
          return 0
        fi
        die "Peer symlink switch failed after retry (rc=$retry_rc)"
        ;;
      unreachable)
        PEER_STATE_NOTE="peer unreachable after ambiguous switch failure; peer state unknown — reconcile manually against $DEPLOY_STATE_FILE"
        die "Peer became unreachable mid-switch; aborting (peer state unknown)"
        ;;
    esac
  fi

  # Clean nonzero exit: the remote script reported failure. Probe anyway so a
  # half-applied switch is rolled back by the failure handler.
  if [[ "$(peer_probe_state "$release")" == switched ]]; then
    REMOTE_SWITCHED=1
  fi
  die "Peer symlink switch failed (rc=$rc)"
}

# ---------------------------------------------------------------------------
# Previous pointers and pruning (per host)
# ---------------------------------------------------------------------------

record_previous_releases() {
  local previous="$1" remote_previous="$2"

  if [[ -n "$previous" ]]; then
    atomic_link "$previous" "$RELEASE_ROOT/previous" \
      || die "Cannot record the local previous release"
  fi
  if [[ -n "$remote_previous" ]]; then
    peer_ssh bash -s -- "$remote_previous" "$RELEASE_ROOT/previous" <<'REMOTE' \
      || die "Cannot record the previous release on the peer"
# wf-peer-record-previous
set -Eeuo pipefail
target="$1"; link="$2"
next="${link}.next.$$"
rm -f -- "$next"
ln -s -- "$target" "$next"
mv -Tf -- "$next" "$link"
REMOTE
  fi
}

prune_local_releases() {
  local current previous candidate kept=0
  local releases=()

  current="$(readlink -f -- "$PUBLIC_LINK" 2>/dev/null || true)"
  previous="$(readlink -f -- "$RELEASE_ROOT/previous" 2>/dev/null || true)"

  mapfile -t releases < <(
    find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -printf '%T@ %p\n' \
      | sort -rn | cut -d' ' -f2-
  )

  for candidate in "${releases[@]}"; do
    if [[ -n "$current" && "$candidate" == "$current" ]]; then continue; fi
    if [[ -n "$previous" && "$candidate" == "$previous" ]]; then continue; fi
    kept=$((kept + 1))
    if ((kept > RETAIN_RELEASES)); then
      [[ "$candidate" == "$RELEASE_ROOT"/* ]] \
        || { fail "Refusing to prune a release outside $RELEASE_ROOT"; return 1; }
      rm -rf -- "$candidate" || return 1
      log "Pruned local release $candidate"
    fi
  done
}

prune_peer_releases() {
  peer_ssh bash -s -- "$RELEASE_ROOT" "$PUBLIC_LINK" "$RETAIN_RELEASES" <<'REMOTE' || return 1
# wf-peer-prune
set -Eeuo pipefail
release_root="$1"; public_link="$2"; retain="$3"
current="$(readlink -f -- "$public_link" 2>/dev/null || true)"
previous="$(readlink -f -- "$release_root/previous" 2>/dev/null || true)"
kept=0
while IFS= read -r candidate; do
  [[ -n "$candidate" ]] || continue
  if [[ -n "$current" && "$candidate" == "$current" ]]; then continue; fi
  if [[ -n "$previous" && "$candidate" == "$previous" ]]; then continue; fi
  kept=$((kept + 1))
  if ((kept > retain)); then
    [[ "$candidate" == "$release_root"/* ]]
    rm -rf -- "$candidate"
    echo "Pruned peer release $candidate"
  fi
done < <(
  find "$release_root" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -printf '%T@ %p\n' \
    | sort -rn | cut -d' ' -f2-
)
REMOTE
}

prune_template_snapshots() {
  local snapshots=() snapshot index=0
  mapfile -t snapshots < <(
    find "$DEPLOY_RECOVERY_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'templates-*' -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn | cut -d' ' -f2-
  )
  for snapshot in "${snapshots[@]}"; do
    index=$((index + 1))
    if ((index > RETAIN_RELEASES)) && [[ "$snapshot" != "$TEMPLATE_SNAPSHOT_DIR" ]]; then
      rm -rf -- "$snapshot" || return 1
    fi
  done
}

prune_old_releases() {
  [[ "$RETAIN_RELEASES" =~ ^[1-9][0-9]*$ ]] \
    || { fail "RETAIN_RELEASES must be a positive integer"; return 1; }
  prune_local_releases || return 1
  prune_peer_releases || return 1
  prune_template_snapshots || return 1
}

# ---------------------------------------------------------------------------
# Activation and rollback
# ---------------------------------------------------------------------------

activate_release() {
  local release="$1" legacy

  legacy="$RELEASE_ROOT/legacy-$(date -u +%Y%m%dT%H%M%SZ)-$$"

  snapshot_active_templates || die "Cannot snapshot the live XenForo templates"
  record_state templates-snapshotted

  local_prepare_switch "$release" "$legacy"
  record_state local-prepared
  local_switch "$release"
  record_state local-switched

  peer_prepare_switch "$release" "$legacy"
  record_state remote-prepared
  peer_switch_with_reconcile "$release"
  record_state remote-switched

  apply_template_bundle "$release/xenforo-templates" \
    || die "Applying the release template bundle failed"
  TEMPLATES_APPLIED=1
  record_state templates-synced

  purge_chatpage_prefix || die "Cloudflare purge failed"
  PURGED=1
  record_state purged

  verify_live_release "$release" || die "Live verification of the activated release failed"
  record_state verified

  record_previous_releases "$PREVIOUS_TARGET" "$REMOTE_PREVIOUS_TARGET"
  record_state previous-recorded

  if prune_old_releases; then
    record_state pruned
  else
    warn "Pruning old releases failed; continuing (deployment itself succeeded)"
    record_state pruned in-progress "prune-failed"
  fi

  SUCCEEDED=1
  record_state complete complete
  log "Deployment complete: $release"
}

rollback_release() {
  local rollback_target current remote_current remote_rollback_target out

  [[ -L "$PUBLIC_LINK" ]] || die "$PUBLIC_LINK is not a managed release symlink"
  [[ -L "$RELEASE_ROOT/previous" ]] || die "No previous release is recorded"
  current="$(readlink -f -- "$PUBLIC_LINK")"
  rollback_target="$(readlink -f -- "$RELEASE_ROOT/previous")"
  [[ -d "$rollback_target" ]] || die "Recorded previous release is missing"
  [[ "$rollback_target" != "$current" ]] || die "Previous release is already active"

  if [[ -f "$rollback_target/$INVENTORY_NAME" ]]; then
    verify_inventory "$rollback_target" \
      || die "Rollback refused: the recorded previous release failed inventory verification"
  else
    warn "Previous release has no $INVENTORY_NAME (pre-transactional); falling back to basic artifact checks"
    verify_rollback_release "$rollback_target" || die "Rollback refused: previous release is incomplete"
  fi

  out="$(peer_ssh bash -s -- "$PUBLIC_LINK" "$RELEASE_ROOT" "$INVENTORY_NAME" <<'REMOTE'
# wf-peer-rollback-check
set -Eeuo pipefail
link="$1"; release_root="$2"; inv="$3"
[[ -L "$link" ]]
current="$(readlink -f -- "$link")"
[[ -L "$release_root/previous" ]]
target="$(readlink -f -- "$release_root/previous")"
[[ -d "$target" ]]
[[ "$target" != "$current" ]]
if [[ -f "$target/$inv" ]]; then
  cd "$target"
  sha256sum --check --quiet "$inv"
  expected="$(wc -l <"$inv")"
  actual="$(find . -type f ! -name "$inv" | wc -l)"
  [[ "$expected" == "$actual" ]]
fi
printf 'current:%s\n' "$current"
printf 'target:%s\n' "$target"
REMOTE
  )" || die "Rollback refused: peer previous-release verification failed"

  remote_current="$(printf '%s\n' "$out" | sed -n 's/^current://p')"
  remote_rollback_target="$(printf '%s\n' "$out" | sed -n 's/^target://p')"
  [[ -n "$remote_current" && -n "$remote_rollback_target" ]] \
    || die "Rollback refused: could not read the peer link state"

  TARGET_RELEASE="$rollback_target"
  PREVIOUS_TARGET="$current"
  REMOTE_PREVIOUS_TARGET="$remote_current"
  record_state rollback-started

  snapshot_active_templates || die "Cannot snapshot the live XenForo templates"
  record_state templates-snapshotted

  local_switch "$rollback_target"
  record_state local-switched

  peer_switch_with_reconcile "$remote_rollback_target"
  record_state remote-switched

  if [[ -d "$rollback_target/xenforo-templates" ]]; then
    apply_template_bundle "$rollback_target/xenforo-templates" \
      || die "Applying the rollback template bundle failed"
    TEMPLATES_APPLIED=1
  else
    warn "Rollback release has no xenforo-templates bundle (pre-transactional); leaving the live templates in place"
  fi
  record_state templates-synced

  purge_chatpage_prefix || die "Cloudflare purge failed"
  PURGED=1
  record_state purged

  verify_live_release "$rollback_target" || die "Live verification of the rollback release failed"
  record_state verified

  record_previous_releases "$current" "$remote_current"
  record_state previous-recorded

  SUCCEEDED=1
  record_state complete complete
  log "Rollback complete: $rollback_target"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

main() {
  local command="${1:-deploy}"

  case "$command" in
    deploy)
      ACTION=deploy
      acquire_lock
      mkdir -p -- "$DEPLOY_RECOVERY_ROOT" || die "Cannot create $DEPLOY_RECOVERY_ROOT"
      STATE_ENABLED=1
      record_state started
      ensure_clean_worktree
      prepare_release
      activate_release "$PREPARED_RELEASE"
      ;;
    rollback|--rollback)
      ACTION=rollback
      [[ -d "$RELEASE_ROOT" ]] || die "No release directory exists at $RELEASE_ROOT"
      acquire_lock
      mkdir -p -- "$DEPLOY_RECOVERY_ROOT" || die "Cannot create $DEPLOY_RECOVERY_ROOT"
      STATE_ENABLED=1
      rollback_release
      ;;
    verify|--verify)
      ACTION=verify
      run_release_checks
      SUCCEEDED=1
      ;;
    *)
      die "Usage: $0 [deploy|rollback|verify]"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
