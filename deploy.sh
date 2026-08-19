#!/usr/bin/env bash
#
# Transactional deploy for the XenForo AI chatpage (windowsforum.com/chatpage).
#
# Usage: deploy.sh [deploy|rollback|verify]
#
# Guarantees:
#   - Exclusive deploy lock (flock on $DEPLOY_LOCK_FILE); concurrent runs fail fast.
#   - Clean-worktree enforcement (override with DEPLOY_ALLOW_DIRTY=1, logged loudly).
#   - SHA-256 release inventories and metadata are stored under
#     $DEPLOY_PRIVATE_ROOT, outside the public release symlink, and validated
#     locally and on the peer before anything is switched.
#   - Recovery state ($DEPLOY_STATE_FILE, JSON) rewritten atomically after every
#     irreversible step so a crashed deploy can be diagnosed and reconciled.
#   - XenForo chat template payloads are bundled privately under
#     $DEPLOY_PRIVATE_ROOT/<release>/xenforo-templates. The live templates are
#     snapshotted before any switch, and both forward activation and rollback
#     apply the selected release's bundle on BOTH nodes. WF5/style 51 is synced
#     only for its two owned chat templates; it is never imported style-wide.
#   - Any failure after activation begins restores the previous assets AND the
#     snapshotted templates, re-runs designer import, re-purges Cloudflare and
#     re-verifies the restored state before exiting nonzero.
#   - The transaction boundary is frontend release assets plus XenForo chat
#     templates. Live backend PHP, additive database schema, systemd units,
#     and already-installed browser service-worker state are not rolled back.
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
#     "release_metadata": "<private RELEASE-METADATA.json path>",
#     "backend_hashes": {"chat.php":"...", "chat-product-contract.php":"...", ...},
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
PUBLIC_EDGE_IP="${PUBLIC_EDGE_IP:-}"
if [[ -z "$PUBLIC_EDGE_IP" ]] && command -v dig >/dev/null 2>&1; then
  PUBLIC_EDGE_IP="$(dig +short @1.1.1.1 windowsforum.com A 2>/dev/null \
    | grep -Em1 '^[0-9]+(\.[0-9]+){3}$' || true)"
fi
readonly PUBLIC_EDGE_IP
readonly PEER_SSH_KEY="${PEER_SSH_KEY:-/web/.oci/id_rsa}"
readonly DEPLOY_OWNER="${DEPLOY_OWNER:-nobody:nobody}"
readonly RETAIN_RELEASES="${RETAIN_RELEASES:-5}"
readonly CLOUDFLARE_ENV_FILE="${CLOUDFLARE_ENV_FILE:-/web/.env}"
readonly DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-$RELEASE_ROOT/.deploy.lock}"
readonly DEPLOY_STATE_FILE="${DEPLOY_STATE_FILE:-$RELEASE_ROOT/.deploy-state.json}"
readonly DEPLOY_RECOVERY_ROOT="${DEPLOY_RECOVERY_ROOT:-$RELEASE_ROOT/.recovery}"
readonly DEPLOY_PRIVATE_ROOT="${DEPLOY_PRIVATE_ROOT:-$RELEASE_ROOT/.private}"
readonly DEPLOY_ALLOW_DIRTY="${DEPLOY_ALLOW_DIRTY:-0}"
# Single-node topology (see /web/CLAUDE.md, 2026-07-13): the OCI peer no longer
# serves. It still answers SSH and completes a TLS handshake, but drops HTTPS
# requests that do not come from Cloudflare, so the peer origin probes below can
# never pass. With this set, every peer staging, import, and probe step is
# skipped; all local checks, the atomic switch, rollback, the XenForo template
# import, the Cloudflare purge, and local-origin/public-edge verification stay.
readonly DEPLOY_SINGLE_NODE="${DEPLOY_SINGLE_NODE:-1}"
readonly DEPLOY_RETRY_DELAY="${DEPLOY_RETRY_DELAY:-2}"
readonly DEPLOY_PUBLIC_RETRY_DELAY="${DEPLOY_PUBLIC_RETRY_DELAY:-5}"
readonly DEPLOY_SSH_CONNECT_TIMEOUT="${DEPLOY_SSH_CONNECT_TIMEOUT:-10}"
readonly DEPLOY_PROBE_ATTEMPTS="${DEPLOY_PROBE_ATTEMPTS:-3}"
readonly INVENTORY_NAME="RELEASE-INVENTORY.sha256"
readonly RELEASE_METADATA_NAME="RELEASE-METADATA.json"
readonly -a CURRENT_RELEASE_STABLE_ARTIFACTS=(
  index.html
  manifest.json
  offline.html
  legacy-service-worker.js
  service-worker.js
  bot-avatar.webp
  pwa-icon-192.png
  pwa-icon-512.png
  static/js/main.js
  static/css/main.css
)
readonly -a ROLLBACK_COMPAT_ARTIFACTS=(
  static/js/main.js
  static/css/main.css
  bot-avatar.webp
)

readonly -a XF_STYLES=(wf3 wf3_domperf)
readonly -a XF_CHAT_TEMPLATES=(_page_node.313 _widget_ai_chat.html react_chat_container.html)
readonly WF5_STYLE="wf5"
readonly WF5_STYLE_ID="${WF5_STYLE_ID:-51}"
readonly -a WF5_CHAT_TEMPLATES=(_page_node.313 _widget_ai_chat.html)
readonly LEGACY_CHAT_STYLE_ID="${LEGACY_CHAT_STYLE_ID:-17}"
readonly BACKEND_TEST_FILE="${BACKEND_TEST_FILE:-$(dirname "$XENFORO_ROOT")/tests/test_chat_predicates.php}"
readonly BACKEND_PRODUCT_TEST_FILE="${BACKEND_PRODUCT_TEST_FILE:-$(dirname "$XENFORO_ROOT")/tests/test_chat_product_contract.php}"
readonly BACKEND_PRODUCT_CONTRACT_FILE="${BACKEND_PRODUCT_CONTRACT_FILE:-$APP_ROOT/scripts/chat-product-contract.php}"
readonly BACKEND_PRODUCT_MIGRATION_FILE="${BACKEND_PRODUCT_MIGRATION_FILE:-$APP_ROOT/scripts/migrate-chat-product-foundation.php}"
readonly BACKEND_PRODUCT_PRUNER_FILE="${BACKEND_PRODUCT_PRUNER_FILE:-$APP_ROOT/scripts/prune-chat-product-data.php}"
readonly -a BACKEND_REQUIRED_PHP_FILES=(
  "$XENFORO_ROOT/chat.php"
  "$XENFORO_ROOT/wf_chat_predicates.php"
  "$BACKEND_PRODUCT_CONTRACT_FILE"
  "$BACKEND_PRODUCT_MIGRATION_FILE"
  "$BACKEND_PRODUCT_PRUNER_FILE"
)
readonly -a BACKEND_PHP_FILES=(
  "${BACKEND_REQUIRED_PHP_FILES[@]}"
  "$XENFORO_ROOT/tts.php"
)

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
RELEASE_METADATA_FILE=""
TARGET_RELEASE=""
PREPARED_RELEASE=""
PEER_STATE_NOTE=""
NEXT_LINK=""
TEMP_FILES=()
WORKTREE_DIRTY=0
BACKEND_CHAT_HASH=""
BACKEND_TTS_HASH=""
BACKEND_PREDICATES_HASH=""
BACKEND_PRODUCT_CONTRACT_HASH=""
BACKEND_PRODUCT_MIGRATION_HASH=""
BACKEND_PRODUCT_PRUNER_HASH=""

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

private_release_dir() {
  local release="$1"
  printf '%s/%s' "$DEPLOY_PRIVATE_ROOT" "$(basename -- "$release")"
}

inventory_for_release() {
  local release="$1" private
  private="$(private_release_dir "$release")"
  if [[ -f "$private/$INVENTORY_NAME" ]]; then
    printf '%s' "$private/$INVENTORY_NAME"
  elif [[ -f "$release/$INVENTORY_NAME" ]]; then
    printf '%s' "$release/$INVENTORY_NAME"
  fi
}

template_bundle_for_release() {
  local release="$1" private
  private="$(private_release_dir "$release")"
  if [[ -d "$private/xenforo-templates" ]]; then
    printf '%s' "$private/xenforo-templates"
  elif [[ -d "$release/xenforo-templates" ]]; then
    # Compatibility with releases created before private control data.
    printf '%s' "$release/xenforo-templates"
  fi
}

backend_hashes_json() {
  printf '{"chat.php":%s,"tts.php":%s,"wf_chat_predicates.php":%s,"chat-product-contract.php":%s,"migrate-chat-product-foundation.php":%s,"prune-chat-product-data.php":%s}' \
    "$(json_str "$BACKEND_CHAT_HASH")" \
    "$(json_str "$BACKEND_TTS_HASH")" \
    "$(json_str "$BACKEND_PREDICATES_HASH")" \
    "$(json_str "$BACKEND_PRODUCT_CONTRACT_HASH")" \
    "$(json_str "$BACKEND_PRODUCT_MIGRATION_HASH")" \
    "$(json_str "$BACKEND_PRODUCT_PRUNER_HASH")"
}

capture_backend_hashes() {
  local file hash
  for file in "${BACKEND_REQUIRED_PHP_FILES[@]}"; do
    [[ -f "$file" ]] || { fail "Required chat backend PHP file is missing: $file"; return 1; }
  done
  for file in "${BACKEND_PHP_FILES[@]}"; do
    hash=""
    if [[ -f "$file" ]]; then
      hash="$(sha256sum -- "$file" | awk '{print $1}')" || return 1
    fi
    case "$(basename -- "$file")" in
      chat.php) BACKEND_CHAT_HASH="$hash" ;;
      tts.php) BACKEND_TTS_HASH="$hash" ;;
      wf_chat_predicates.php) BACKEND_PREDICATES_HASH="$hash" ;;
      chat-product-contract.php) BACKEND_PRODUCT_CONTRACT_HASH="$hash" ;;
      migrate-chat-product-foundation.php) BACKEND_PRODUCT_MIGRATION_HASH="$hash" ;;
      prune-chat-product-data.php) BACKEND_PRODUCT_PRUNER_HASH="$hash" ;;
    esac
  done
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
    printf '  "release_metadata": %s,\n' "$(json_str "$RELEASE_METADATA_FILE")"
    printf '  "backend_hashes": %s,\n' "$(backend_hashes_json)"
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
    WORKTREE_DIRTY=1
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

# True when the peer participates in this deploy. Callers that parse peer output
# must gate on this rather than relying on peer_ssh/peer_rsync no-oping, because
# an empty response would be indistinguishable from a malformed one.
peer_enabled() {
  [[ "$DEPLOY_SINGLE_NODE" != 1 ]]
}

# skip_peer <what> — uniform log line for a step the single-node topology drops.
skip_peer() {
  log "Single-node mode: skipping $1."
}

peer_ssh() {
  peer_enabled || { fail "peer_ssh called in single-node mode"; return 1; }
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
  peer_enabled || { fail "peer_rsync called in single-node mode"; return 1; }
  rsync -a --checksum "$@" \
    -e "ssh -i $PEER_SSH_KEY -o BatchMode=yes -o ConnectTimeout=$DEPLOY_SSH_CONNECT_TIMEOUT -o StrictHostKeyChecking=no"
}

# generate_inventory <public-release-dir> — sorted SHA-256 records for every
# public artifact and private control file. Virtual public/ and private/
# prefixes keep the manifest portable between nodes while the manifest itself
# stays outside the public symlink.
generate_inventory() {
  local dir="$1" private tmp
  private="$(private_release_dir "$dir")"
  mkdir -p -- "$private" || return 1
  tmp="$private/.$INVENTORY_NAME.tmp"
  (
    cd "$dir" || exit 1
    while IFS= read -r -d '' file; do
      printf '%s  public/%s\n' \
        "$(sha256sum -- "$file" | awk '{print $1}')" "${file#./}"
    done < <(find . -type f ! -name "$INVENTORY_NAME" -print0 | sort -z)
    cd "$private" || exit 1
    while IFS= read -r -d '' file; do
      printf '%s  private/%s\n' \
        "$(sha256sum -- "$file" | awk '{print $1}')" "${file#./}"
    done < <(find . -type f ! -name "$INVENTORY_NAME" ! -name ".$INVENTORY_NAME.tmp" -print0 | sort -z)
  ) >"$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$private/$INVENTORY_NAME" || return 1
}

# A one-time migration of an unmanaged public directory retains the historical
# flat inventory format so the original directory can be restored byte-for-byte.
# The release .htaccess installed during migration denies this filename.
generate_legacy_inventory() {
  local dir="$1" tmp
  tmp="$dir/.$INVENTORY_NAME.tmp"
  (
    cd "$dir" || exit 1
    find . -type f ! -name "$INVENTORY_NAME" ! -name ".$INVENTORY_NAME.tmp" -print0 \
      | sort -z | xargs -0 -r sha256sum
  ) >"$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$dir/$INVENTORY_NAME"
}

# verify_inventory <public-release-dir> — strict: every public/private file is
# listed exactly once and matches. Flat, public inventories remain supported
# for rollback of pre-hardening releases.
verify_inventory() {
  local dir="$1" private inventory expected actual hash virtual relative file actual_hash
  local -A seen=()
  private="$(private_release_dir "$dir")"
  inventory="$private/$INVENTORY_NAME"

  if [[ ! -f "$inventory" ]]; then
    [[ -f "$dir/$INVENTORY_NAME" ]] || { fail "$dir has no private or legacy $INVENTORY_NAME"; return 1; }
    (cd "$dir" && sha256sum --check --quiet "$INVENTORY_NAME") \
      || { fail "Release inventory mismatch in $dir"; return 1; }
    expected="$(wc -l <"$dir/$INVENTORY_NAME")" || return 1
    actual="$(cd "$dir" && find . -type f ! -name "$INVENTORY_NAME" | wc -l)" || return 1
    [[ "$expected" == "$actual" ]] \
      || { fail "Release inventory file count mismatch in $dir ($expected listed, $actual present)"; return 1; }
    return 0
  fi

  expected=0
  while IFS=' ' read -r hash virtual; do
    [[ "$hash" =~ ^[0-9a-f]{64}$ ]] \
      || { fail "Malformed hash in $inventory"; return 1; }
    [[ -z "${seen[$virtual]+present}" ]] \
      || { fail "Duplicate path in $inventory: $virtual"; return 1; }
    seen["$virtual"]=1
    case "$virtual" in
      public/*)
        relative="${virtual#public/}"
        file="$dir/$relative"
        ;;
      private/*)
        relative="${virtual#private/}"
        file="$private/$relative"
        ;;
      *)
        fail "Malformed path in $inventory: $virtual"
        return 1
        ;;
    esac
    [[ -n "$relative" && "$relative" != /* && "$relative" != *'..'* ]] \
      || { fail "Unsafe path in $inventory: $virtual"; return 1; }
    [[ -f "$file" ]] || { fail "Inventory entry is missing: $virtual"; return 1; }
    actual_hash="$(sha256sum -- "$file" | awk '{print $1}')" || return 1
    [[ "$actual_hash" == "$hash" ]] \
      || { fail "Release inventory mismatch for $virtual"; return 1; }
    expected=$((expected + 1))
  done <"$inventory"

  actual="$(find "$dir" -type f ! -name "$INVENTORY_NAME" | wc -l)" || return 1
  actual=$((actual + $(find "$private" -type f ! -name "$INVENTORY_NAME" ! -name ".$INVENTORY_NAME.tmp" | wc -l)))
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
  peer_enabled || { skip_peer "the peer public-link restore"; return 0; }
  local mode="link"
  if ((MIGRATED_REMOTE)); then
    mode="migrated"
  elif ((FRESH_REMOTE)) || [[ -z "$REMOTE_PREVIOUS_TARGET" ]]; then
    mode="fresh"
  fi
  peer_ssh bash -s -- "$mode" "$PUBLIC_LINK" "${REMOTE_PREVIOUS_TARGET:--}" "${LEGACY_REMOTE:--}" "$INVENTORY_NAME" <<'REMOTE' || return 1
# wf-peer-restore
set -Eeuo pipefail
mode="$1"; link="$2"; previous="$3"; legacy="$4"; inv="$5"
[[ "$previous" == - ]] && previous=""
[[ "$legacy" == - ]] && legacy=""
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
    if ! apply_template_bundle "$TEMPLATE_SNAPSHOT_DIR" 0; then
      notes+=("template-restore-failed")
    fi
    if ! restore_pending_template_sources; then
      notes+=("template-source-restore-failed")
    fi
  fi

  if ! purge_origin_chat_page; then
    notes+=("origin-page-cache-repurge-failed")
  fi
  if ! purge_chat_surfaces; then
    notes+=("repurge-failed")
  fi

  local verify_root=""
  if ((MIGRATED_LOCAL)); then
    verify_root="$PUBLIC_LINK"
  elif [[ -n "$PREVIOUS_TARGET" ]]; then
    verify_root="$PREVIOUS_TARGET"
  fi
  if [[ -n "$verify_root" ]] && ((${#notes[@]} == 0)); then
    if verify_live_release "$verify_root" 0; then
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

verify_private_release_boundary() {
  local release="$1" private
  private="$(private_release_dir "$release")"
  [[ ! -e "$release/$INVENTORY_NAME" ]] \
    || { fail "Public release contains $INVENTORY_NAME"; return 1; }
  [[ ! -e "$release/$RELEASE_METADATA_NAME" ]] \
    || { fail "Public release contains $RELEASE_METADATA_NAME"; return 1; }
  [[ ! -e "$release/xenforo-templates" ]] \
    || { fail "Public release contains xenforo-templates"; return 1; }
  [[ -f "$private/$INVENTORY_NAME" ]] \
    || { fail "Private release inventory is missing"; return 1; }
  [[ -f "$private/$RELEASE_METADATA_NAME" ]] \
    || { fail "Private release metadata is missing"; return 1; }
  [[ -d "$private/xenforo-templates" ]] \
    || { fail "Private XenForo template bundle is missing"; return 1; }
  grep -Fq 'RELEASE-INVENTORY\.sha256' "$release/.htaccess" \
    || { fail "Public .htaccess does not deny legacy release inventories"; return 1; }
  grep -Fq 'xenforo-templates' "$release/.htaccess" \
    || { fail "Public .htaccess does not deny legacy template bundles"; return 1; }
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
  peer_enabled || { skip_peer "peer template-source verification"; return 0; }
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

  for template in "${WF5_CHAT_TEMPLATES[@]}"; do
    source="$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public/$template"
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

  log "Verified matching XenForo chat template sources on $PEER_HOST."
}

run_backend_checks() {
  local file linted=0

  for file in "${BACKEND_REQUIRED_PHP_FILES[@]}"; do
    [[ -f "$file" ]] || die "Required chat backend PHP file is missing: $file"
  done
  [[ -f "$BACKEND_TEST_FILE" ]] \
    || die "Required backend predicate test is missing: $BACKEND_TEST_FILE"
  [[ -f "$BACKEND_PRODUCT_TEST_FILE" ]] \
    || die "Required backend product contract test is missing: $BACKEND_PRODUCT_TEST_FILE"

  for file in "${BACKEND_PHP_FILES[@]}"; do
    [[ -f "$file" ]] || continue
    php -l "$file" >/dev/null \
      || die "PHP lint failed for $file"
    linted=$((linted + 1))
  done
  log "PHP lint passed for $linted chat backend files."

  php "$BACKEND_TEST_FILE" \
    || die "Backend predicate tests failed: $BACKEND_TEST_FILE"
  log "Backend predicate tests passed: $BACKEND_TEST_FILE"

  php "$BACKEND_PRODUCT_TEST_FILE" \
    || die "Backend product contract tests failed: $BACKEND_PRODUCT_TEST_FILE"
  log "Backend product contract tests passed: $BACKEND_PRODUCT_TEST_FILE"
}

run_release_checks() {
  local backend_before backend_after
  cd "$APP_ROOT" || die "Cannot cd to $APP_ROOT"
  run_backend_checks
  capture_backend_hashes || die "Cannot hash the chat backend files after validation"
  backend_before="$(backend_hashes_json)"
  log "Running lint, typecheck, tests, build, and artifact verification..."
  npm run check || die "npm run check failed"
  verify_xenforo_templates || die "XenForo template verification failed"
  verify_peer_template_sources || die "Peer template source verification failed"
  capture_backend_hashes || die "Cannot re-hash the chat backend files"
  backend_after="$(backend_hashes_json)"
  [[ "$backend_after" == "$backend_before" ]] \
    || die "Chat backend files changed while the release gate was running; retry from a stable checkout"
}

write_release_metadata() {
  local release="$1" private commit created_at dirty_json tmp
  private="$(private_release_dir "$release")"
  mkdir -p -- "$private" || return 1
  RELEASE_METADATA_FILE="$private/$RELEASE_METADATA_NAME"
  commit="$(git -C "$APP_ROOT" rev-parse HEAD)" || return 1
  created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  dirty_json="$(json_bool "$WORKTREE_DIRTY")"
  tmp="$(mktemp "$private/.${RELEASE_METADATA_NAME}.XXXXXX")" || return 1
  {
    printf '{\n'
    printf '  "version": 1,\n'
    printf '  "release_id": %s,\n' "$(json_str "$(basename -- "$release")")"
    printf '  "frontend_commit": %s,\n' "$(json_str "$commit")"
    printf '  "working_tree_dirty": %s,\n' "$dirty_json"
    printf '  "created_at": %s,\n' "$(json_str "$created_at")"
    printf '  "backend_hashes": %s\n' "$(backend_hashes_json)"
    printf '}\n'
  } >"$tmp" || { rm -f -- "$tmp"; return 1; }
  mv -f -- "$tmp" "$RELEASE_METADATA_FILE"
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

purge_chat_surfaces() {
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
    --data '{"prefixes":["windowsforum.com/chatpage","windowsforum.com/pages/ai"]}' \
    --output "$response_file" \
    || { fail "Cloudflare purge request failed"; return 1; }

  node --input-type=module - "$response_file" <<'NODE' || { fail "Cloudflare purge was not acknowledged"; return 1; }
import { readFile } from 'node:fs/promises';

const response = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (response.success !== true) {
  throw new Error(`Cloudflare prefix purge failed: ${JSON.stringify(response.errors || response)}`);
}
NODE

  log "Purged the chat assets and /pages/ai Cloudflare prefixes."
}

# `tag=public` does not evict /pages/ai/. pagecache.php only emits
# X-LiteSpeed-Tag on the PREBHIT path, so the page node's entry is stored
# untagged and a tag purge matches nothing — measured 2026-07-29: three
# consecutive tag=public purges returned 204 while `age` kept climbing, and
# only `*` produced a miss. httpjet's purge endpoint has exactly two forms
# (peer_purge.rs: Purge::All and Purge::Tags); there is no URL-targeted purge,
# so a full page-cache purge is the only one that reaches this page.
#
# Without it the origin kept serving a stale shell for the whole
# --xf-capsule-stale-secs window (3600s in the live ExecStart), which meant the
# chat-template contract probe below had never actually verified a *changed*
# template — it passed only because the markup string had never changed. The
# first deploy that altered it (100vh -> 100dvh) failed verification and rolled
# itself back, correctly, against a 50-minute-old cached page.
#
# Site-wide is the right blast radius here: the Redis FLUSHDB on the next line
# already drops every XenForo page-cache entry on the node, so the httpjet
# store is simply being kept consistent with it.
readonly PURGE_ALL_DIRECTIVE='x-litespeed-purge: *'

purge_origin_chat_page() {
  redis-cli -n 1 FLUSHDB >/dev/null \
    || { fail "Cannot flush the local Redis page cache"; return 1; }

  curl --fail --silent --show-error \
    --request POST \
    --header "$PURGE_ALL_DIRECTIVE" \
    'http://127.0.0.1/__hj_cache_purge' \
    --output /dev/null \
    || { fail "Cannot purge the local httpjet page cache"; return 1; }

  if ! peer_enabled; then
    skip_peer "the peer Redis and httpjet page-cache purge"
    log "Purged Redis DB1 and the httpjet page cache."
    return 0
  fi

  peer_ssh redis-cli -n 1 FLUSHDB >/dev/null \
    || { fail "Cannot flush the peer Redis page cache"; return 1; }
  peer_ssh bash -s <<'REMOTE' \
    || { fail "Cannot purge the peer httpjet page cache"; return 1; }
# wf-peer-purge-page-cache
set -Eeuo pipefail
curl --fail --silent --show-error \
  --request POST \
  --header 'x-litespeed-purge: *' \
  'http://127.0.0.1/__hj_cache_purge' \
  --output /dev/null
REMOTE

  log "Purged Redis DB1 and httpjet page caches on both nodes."
}

assert_header() {
  local url="$1" expected="$2" mode="${3:-public}" headers

  # Gated here rather than at each call site so every caller — including the
  # rollback path — drops its peer probes together.
  if [[ "$mode" == peer ]] && ! peer_enabled; then
    return 0
  fi

  if [[ "$mode" == origin ]]; then
    headers="$(curl --fail --silent --show-error --head \
      --resolve "windowsforum.com:443:$ORIGIN_IP" "$url")" || { fail "HEAD $url failed on origin"; return 1; }
  elif [[ "$mode" == peer ]]; then
    headers="$(curl --fail --silent --show-error --head \
      --resolve "windowsforum.com:443:$PEER_ORIGIN_IP" "$url")" || { fail "HEAD $url failed on peer"; return 1; }
  else
    [[ -n "$PUBLIC_EDGE_IP" ]] || { fail "Cannot resolve the public Cloudflare edge"; return 1; }
    headers="$(curl --fail --silent --show-error --head \
      --resolve "windowsforum.com:443:$PUBLIC_EDGE_IP" "$url")" \
      || { fail "HEAD $url failed at the public edge"; return 1; }
  fi

  printf '%s\n' "$headers" | tr -d '\r' | grep -Eiq "$expected" \
    || { fail "$url is missing the expected response header: $expected"; return 1; }
}

assert_origin_hash() {
  local relative="$1" expected_file="$2" origin_ip="$3"
  local expected_hash actual_hash download

  if [[ "$origin_ip" == "$PEER_ORIGIN_IP" ]] && ! peer_enabled; then
    return 0
  fi

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
  [[ -n "$PUBLIC_EDGE_IP" ]] || { fail "Cannot resolve the public Cloudflare edge"; return 1; }
  download="$(mktemp)" || return 1
  TEMP_FILES+=("$download")

  for attempt in 1 2 3 4 5 6; do
    if curl --fail --silent --show-error \
      --resolve "windowsforum.com:443:$PUBLIC_EDGE_IP" \
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

# Cloudflare may append its managed challenge bootstrap to HTML responses for
# non-browser deploy probes. Byte hashes therefore remain strict for scripts,
# styles, workers, manifests, icons, and media, while the two public HTML files
# are checked against their release contract after the exact origin hash has
# already passed.
assert_public_html_contract() {
  local relative="$1" download attempt

  [[ -n "$PUBLIC_EDGE_IP" ]] || { fail "Cannot resolve the public Cloudflare edge"; return 1; }
  download="$(mktemp)" || return 1
  TEMP_FILES+=("$download")

  for attempt in 1 2 3 4 5 6; do
    if curl --fail --silent --show-error \
      --resolve "windowsforum.com:443:$PUBLIC_EDGE_IP" \
      "$LIVE_ORIGIN/chatpage/$relative?v=2" --output "$download"; then
      if [[ "$relative" == index.html ]] \
        && grep -Fq '<div id="root" class="google-anno-skip" style="min-height:100dvh"></div>' "$download" \
        && grep -Fq 'src="/chatpage/static/js/main.js?v=2"' "$download" \
        && grep -Fq 'href="/chatpage/static/css/main.css?v=2"' "$download"; then
        return 0
      fi
      if [[ "$relative" == offline.html ]] \
        && grep -Fq '<title>WindowsForum AI is offline</title>' "$download" \
        && grep -Fq 'Private conversations are not stored in the offline cache.' "$download" \
        && grep -Fq 'onclick="location.reload()"' "$download"; then
        return 0
      fi
    fi
    if ((attempt < 6)); then
      sleep "$DEPLOY_PUBLIC_RETRY_DELAY"
    fi
  done

  fail "Public $relative did not satisfy the activated release HTML contract"
}

assert_chat_page_markup() {
  local mode="$1" download attempt max_attempts=1

  if [[ "$mode" == peer ]] && ! peer_enabled; then
    return 0
  fi

  download="$(mktemp)" || return 1
  TEMP_FILES+=("$download")
  [[ "$mode" == public ]] && max_attempts=6

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if [[ "$mode" == origin ]]; then
      curl --fail --silent --show-error \
        --resolve "windowsforum.com:443:$ORIGIN_IP" \
        "$LIVE_ORIGIN/pages/ai/" --output "$download" || return 1
    elif [[ "$mode" == peer ]]; then
      curl --fail --silent --show-error \
        --resolve "windowsforum.com:443:$PEER_ORIGIN_IP" \
        "$LIVE_ORIGIN/pages/ai/" --output "$download" || return 1
    else
      [[ -n "$PUBLIC_EDGE_IP" ]] || { fail "Cannot resolve the public Cloudflare edge"; return 1; }
      curl --fail --silent --show-error \
        --resolve "windowsforum.com:443:$PUBLIC_EDGE_IP" \
        "$LIVE_ORIGIN/pages/ai/" --output "$download" || true
    fi

    if grep -Fq '<div id="root" class="google-anno-skip" style="min-height:100dvh"></div>' "$download" \
      && grep -Fq 'href="https://windowsforum.com/chatpage/static/css/main.css?v=2"' "$download" \
      && grep -Fq 'type="module" src="https://windowsforum.com/chatpage/static/js/main.js?v=2"' "$download" \
      && ! grep -Eq 'chatpage/static/(css|js)/main\.(css|js)\?ver=' "$download"; then
      return 0
    fi

    if ((attempt < max_attempts)); then
      sleep "$DEPLOY_PUBLIC_RETRY_DELAY"
    fi
  done

  fail "$mode /pages/ai/ did not render the imported chat template contract"
}

verify_live_release() {
  local release="$1" require_chat_contract="${2:-1}" relative file basename
  local no_cache='cache-control:.*no-cache.*must-revalidate'
  local immutable='cache-control:.*max-age=31536000.*immutable'
  local -a stable_artifacts=()
  local -a hashed_files=()
  local -a hashed_artifacts=()

  if [[ "$require_chat_contract" == 1 ]]; then
    stable_artifacts=("${CURRENT_RELEASE_STABLE_ARTIFACTS[@]}")
    mapfile -d '' -t hashed_files < <(
      {
        find "$release/static/js" -maxdepth 1 -type f -name '*.js' ! -name main.js -print0
        find "$release/static/css" -maxdepth 1 -type f -name '*.css' ! -name main.css -print0
        if [[ -d "$release/static/media" ]]; then
          find "$release/static/media" -type f -print0
        fi
      } | sort -z
    )
    for file in "${hashed_files[@]}"; do
      basename="$(basename -- "$file")"
      if [[ ! "$basename" =~ -[A-Za-z0-9_-]{8,}\.(chunk\.js|css|avif|gif|ico|jpe?g|png|svg|webp|woff2?)$ ]]; then
        fail "Current release contains a non-content-hashed static artifact: ${file#"$release/"}"
        return 1
      fi
      hashed_artifacts+=("${file#"$release/"}")
    done
    ((${#hashed_artifacts[@]} > 0)) \
      || { fail "Current release contains no content-hashed static artifacts"; return 1; }
  else
    # Pre-PWA rollback releases legitimately lack the manifest, workers,
    # offline shell, icons, and possibly content-hashed chunks. Keep the
    # rollback verifier compatible with those releases while the forward
    # deploy path remains strict.
    stable_artifacts=("${ROLLBACK_COMPAT_ARTIFACTS[@]}")
  fi

  for relative in "${stable_artifacts[@]}" "${hashed_artifacts[@]}"; do
    file="$release/$relative"
    [[ -f "$file" ]] \
      || { fail "Release is missing required live artifact: $relative"; return 1; }
    assert_origin_hash "$relative" "$file" "$ORIGIN_IP" || return 1
    assert_origin_hash "$relative" "$file" "$PEER_ORIGIN_IP" || return 1
    if [[ "$relative" == index.html || "$relative" == offline.html ]]; then
      assert_public_html_contract "$relative" || return 1
    else
      assert_public_hash "$relative" "$file" || return 1
    fi
  done

  if [[ "$require_chat_contract" == 1 ]]; then
    assert_chat_page_markup origin || return 1
    assert_chat_page_markup peer || return 1
    assert_chat_page_markup public || return 1
  fi

  for relative in "${stable_artifacts[@]}"; do
    assert_header "$LIVE_ORIGIN/chatpage/$relative?v=2" "$no_cache" origin || return 1
    assert_header "$LIVE_ORIGIN/chatpage/$relative?v=2" "$no_cache" peer || return 1
    assert_header "$LIVE_ORIGIN/chatpage/$relative?v=2" "$no_cache" public || return 1
  done

  for relative in "${hashed_artifacts[@]}"; do
    assert_header "$LIVE_ORIGIN/chatpage/$relative" "$immutable" origin || return 1
    assert_header "$LIVE_ORIGIN/chatpage/$relative" "$immutable" peer || return 1
    assert_header "$LIVE_ORIGIN/chatpage/$relative" "$immutable" public || return 1
  done

  if [[ "$require_chat_contract" == 1 ]]; then
    assert_header "$LIVE_ORIGIN/chatpage/service-worker.js" \
      '^service-worker-allowed:[[:space:]]*/pages/ai/[[:space:]]*$' origin || return 1
    assert_header "$LIVE_ORIGIN/chatpage/service-worker.js" \
      '^service-worker-allowed:[[:space:]]*/pages/ai/[[:space:]]*$' peer || return 1
    assert_header "$LIVE_ORIGIN/chatpage/service-worker.js" \
      '^service-worker-allowed:[[:space:]]*/pages/ai/[[:space:]]*$' public || return 1
  fi

  local origins="both origins"
  peer_enabled || origins="the local origin"
  if [[ "$require_chat_contract" == 1 ]]; then
    log "Verified every current PWA/lazy artifact on $origins and the public edge, rendered /pages/ai markup, and cache/scope headers."
  else
    log "Verified rollback-compatible frontend assets on $origins and the public edge."
  fi
}

# ---------------------------------------------------------------------------
# XenForo template bundles
# ---------------------------------------------------------------------------

stage_template_bundle() {
  local release="$1" private bundle style template source
  private="$(private_release_dir "$release")"
  bundle="$private/xenforo-templates"

  for style in "${XF_STYLES[@]}"; do
    mkdir -p -- "$bundle/$style" || return 1
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      [[ -f "$source" ]] || { fail "Missing XenForo template source: $source"; return 1; }
      cp -f -- "$source" "$bundle/$style/$template" || return 1
    done
  done

  mkdir -p -- "$bundle/$WF5_STYLE" || return 1
  for template in "${WF5_CHAT_TEMPLATES[@]}"; do
    source="$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public/$template"
    [[ -f "$source" ]] || { fail "Missing XenForo template source: $source"; return 1; }
    cp -f -- "$source" "$bundle/$WF5_STYLE/$template" || return 1
  done
}

snapshot_active_templates() {
  local stamp style template source pending_root
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  TEMPLATE_SNAPSHOT_DIR="$DEPLOY_RECOVERY_ROOT/templates-$stamp"
  pending_root="$TEMPLATE_SNAPSHOT_DIR/pending-sources"

  for style in "${XF_STYLES[@]}"; do
    mkdir -p -- "$pending_root/$style" || return 1
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      [[ -f "$source" ]] || { fail "Missing designer template source: $source"; return 1; }
      cp -f -- "$source" "$pending_root/$style/$template" || return 1
    done
  done

  mkdir -p -- "$pending_root/$WF5_STYLE" || return 1
  for template in "${WF5_CHAT_TEMPLATES[@]}"; do
    source="$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public/$template"
    [[ -f "$source" ]] || { fail "Missing designer template source: $source"; return 1; }
    cp -f -- "$source" "$pending_root/$WF5_STYLE/$template" || return 1
  done

  php "$APP_ROOT/scripts/snapshot-xenforo-template-db.php" \
    "$XENFORO_ROOT" "$TEMPLATE_SNAPSHOT_DIR" \
    || return 1

  for style in "${XF_STYLES[@]}"; do
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$TEMPLATE_SNAPSHOT_DIR/$style/$template"
      [[ -f "$source" ]] || { fail "Missing database template snapshot: $source"; return 1; }
    done
  done
  for template in "${WF5_CHAT_TEMPLATES[@]}"; do
    source="$TEMPLATE_SNAPSHOT_DIR/$WF5_STYLE/$template"
    [[ -f "$source" ]] || { fail "Missing database template snapshot: $source"; return 1; }
  done
  log "Snapshotted the authoritative pre-import XenForo templates to $TEMPLATE_SNAPSHOT_DIR"
}

# After a failed activation, runtime is rolled back from the database-backed
# snapshot. Put the pre-deploy designer files back without importing them so a
# pending source edit is not destroyed and remains visible as FS/metadata drift.
restore_pending_template_sources() {
  local pending_root="$TEMPLATE_SNAPSHOT_DIR/pending-sources"
  local style template source dest
  local -a payloads

  for style in "${XF_STYLES[@]}"; do
    payloads=()
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$pending_root/$style/$template"
      dest="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      [[ -f "$source" ]] || { fail "Missing pending template snapshot: $source"; return 1; }
      cp -f -- "$source" "$dest" || return 1
      payloads+=("$dest")
    done
    peer_enabled || continue
    peer_rsync "${payloads[@]}" \
      "$PEER_HOST:$XENFORO_STYLES_ROOT/$style/templates/public/" \
      || { fail "Cannot restore pending $style sources on $PEER_HOST"; return 1; }
  done


  payloads=()
  for template in "${WF5_CHAT_TEMPLATES[@]}"; do
    source="$pending_root/$WF5_STYLE/$template"
    dest="$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public/$template"
    [[ -f "$source" ]] || { fail "Missing pending template snapshot: $source"; return 1; }
    cp -f -- "$source" "$dest" || return 1
    payloads+=("$dest")
  done
  if peer_enabled; then
    peer_rsync "${payloads[@]}" \
      "$PEER_HOST:$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public/" \
      || { fail "Cannot restore pending $WF5_STYLE sources on $PEER_HOST"; return 1; }
  fi

  log "Restored the pre-deploy designer sources without re-importing them."
}

# verify_compiled_template_runtime — prove that the imported designer sources,
# metadata, and every live language/style compiled consumer agree on both nodes.
verify_compiled_template_runtime() {
  local require_chat_contract="${1:-1}"
  local verifier="$APP_ROOT/scripts/verify-xenforo-compiled-templates.mjs"
  local remote_verifier="$XENFORO_ROOT/internal_data/.wf-chat-template-verify.$$.mjs"
  local -a verifier_args=()

  [[ "$require_chat_contract" == 1 ]] && verifier_args+=(--require-chat-contract)

  node "$verifier" "$XENFORO_ROOT" "$XENFORO_STYLES_ROOT" \
    "${verifier_args[@]}" \
    || { fail "Local compiled XenForo chat templates are stale"; return 1; }

  if ! peer_enabled; then
    skip_peer "the peer compiled-template verification"
    log "Verified imported and compiled XenForo chat templates."
    return 0
  fi

  peer_rsync "$verifier" "$PEER_HOST:$remote_verifier" \
    || { fail "Cannot stage the compiled-template verifier on $PEER_HOST"; return 1; }

  peer_ssh bash -s -- "$remote_verifier" "$XENFORO_ROOT" "$XENFORO_STYLES_ROOT" "$require_chat_contract" <<'REMOTE' \
    || { peer_ssh rm -f -- "$remote_verifier" >/dev/null 2>&1 || true; fail "Peer compiled XenForo chat templates are stale"; return 1; }
# wf-peer-verify-chat-templates
set -Eeuo pipefail
verifier="$1"; xenforo_root="$2"; styles_root="$3"; require_chat_contract="$4"
trap 'rm -f -- "$verifier"' EXIT
args=()
[[ "$require_chat_contract" == 1 ]] && args+=(--require-chat-contract)
node "$verifier" "$xenforo_root" "$styles_root" "${args[@]}"
REMOTE

  log "Verified imported and compiled XenForo chat templates on both nodes."
}

# Style 17 predates designer mode and keeps its templates only in XenForo's
# database. Mirror the canonical wf3 chat templates into that style on both
# nodes so a cached guest page and a member-selected style cannot bootstrap
# different stable entry URLs. The helper also recompiles unchanged rows on
# each node because compiled template storage is node-local.
sync_database_chat_style() {
  local syncer="$APP_ROOT/scripts/sync-xenforo-db-style.php"
  local source_root="$XENFORO_STYLES_ROOT/wf3/templates/public"
  local remote_syncer="$XENFORO_ROOT/internal_data/.wf-chat-db-style-sync.$$.php"

  php "$syncer" "$XENFORO_ROOT" "$source_root" "$LEGACY_CHAT_STYLE_ID" \
    || { fail "Local database-managed chat style sync failed"; return 1; }

  if ! peer_enabled; then
    skip_peer "the peer database-managed style sync"
    log "Synchronized database-managed chat style $LEGACY_CHAT_STYLE_ID."
    return 0
  fi

  peer_rsync "$syncer" "$PEER_HOST:$remote_syncer" \
    || { fail "Cannot stage the database-managed style sync helper on the peer"; return 1; }

  peer_ssh bash -s -- \
    "$remote_syncer" "$XENFORO_ROOT" "$source_root" "$LEGACY_CHAT_STYLE_ID" <<'REMOTE' \
    || { peer_ssh rm -f -- "$remote_syncer" >/dev/null 2>&1 || true; fail "Peer database-managed chat style sync failed"; return 1; }
# wf-peer-sync-database-chat-style
set -Eeuo pipefail
syncer="$1"; xenforo_root="$2"; source_root="$3"; style_id="$4"
trap 'rm -f -- "$syncer"' EXIT
php "$syncer" "$xenforo_root" "$source_root" "$style_id"
REMOTE

  log "Synchronized database-managed chat style $LEGACY_CHAT_STYLE_ID on both nodes."
}

# Style 51 is designer-managed, but this deploy owns only its page/widget chat
# bootstraps. Sync those two rows directly and recompile them on each node; do
# not run a style-wide WF5 designer import that could sweep unrelated drift.
sync_wf5_chat_style() {
  local syncer="$APP_ROOT/scripts/sync-xenforo-db-style.php"
  local source_root="$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public"
  local remote_syncer="$XENFORO_ROOT/internal_data/.wf-chat-wf5-sync.$$.php"

  php "$syncer" "$XENFORO_ROOT" "$source_root" "$WF5_STYLE_ID" bootstrap "$WF5_STYLE" \
    || { fail "Local scoped WF5 chat template sync failed"; return 1; }

  if ! peer_enabled; then
    skip_peer "the peer scoped WF5 chat template sync"
    log "Synchronized two scoped WF5/style $WF5_STYLE_ID chat templates."
    return 0
  fi

  peer_rsync "$syncer" "$PEER_HOST:$remote_syncer" \
    || { fail "Cannot stage the scoped WF5 sync helper on the peer"; return 1; }

  peer_ssh bash -s -- \
    "$remote_syncer" "$XENFORO_ROOT" "$source_root" "$WF5_STYLE_ID" "$WF5_STYLE" <<'REMOTE' \
    || { peer_ssh rm -f -- "$remote_syncer" >/dev/null 2>&1 || true; fail "Peer scoped WF5 chat template sync failed"; return 1; }
# wf-peer-sync-wf5-chat-style
set -Eeuo pipefail
syncer="$1"; xenforo_root="$2"; source_root="$3"; style_id="$4"; designer="$5"
trap 'rm -f -- "$syncer"' EXIT
php "$syncer" "$xenforo_root" "$source_root" "$style_id" bootstrap "$designer"
REMOTE

  log "Synchronized two scoped WF5/style $WF5_STYLE_ID chat templates on both nodes."
}

# apply_template_bundle <bundle_root> — copy payloads into the styles roots on
# both nodes and run the designer import on both nodes. Written with explicit
# error chaining so it also works in errexit-suppressed (restore) contexts.
apply_template_bundle() {
  local bundle_root="$1" verify_chat_contract="${2:-1}" style template source dest
  local wf5_available=1
  local -a payloads

  for style in "${XF_STYLES[@]}"; do
    for template in "${XF_CHAT_TEMPLATES[@]}"; do
      source="$bundle_root/$style/$template"
      [[ -f "$source" ]] || { fail "Template bundle is missing $source"; return 1; }
      dest="$XENFORO_STYLES_ROOT/$style/templates/public/$template"
      cp -f -- "$source" "$dest" || { fail "Cannot install $dest"; return 1; }
    done
  done

  for template in "${WF5_CHAT_TEMPLATES[@]}"; do
    [[ -f "$bundle_root/$WF5_STYLE/$template" ]] || wf5_available=0
  done
  if ((wf5_available)); then
    payloads=()
    for template in "${WF5_CHAT_TEMPLATES[@]}"; do
      source="$bundle_root/$WF5_STYLE/$template"
      dest="$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public/$template"
      cp -f -- "$source" "$dest" || { fail "Cannot install $dest"; return 1; }
      payloads+=("$dest")
    done
    if peer_enabled; then
      peer_rsync "${payloads[@]}" \
        "$PEER_HOST:$XENFORO_STYLES_ROOT/$WF5_STYLE/templates/public/" \
        || { fail "Cannot push scoped $WF5_STYLE template payloads to $PEER_HOST"; return 1; }
    fi
  else
    warn "Template bundle has no complete $WF5_STYLE payload (legacy release); leaving style $WF5_STYLE_ID unchanged"
  fi

  for style in "${XF_STYLES[@]}"; do
    peer_enabled || break
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
    php cmd.php xf-designer:import-templates wf3 || exit 1
    php cmd.php xf-designer:import-templates wf3_domperf || exit 1
    php cmd.php xf-designer:rebuild-metadata wf3 || exit 1
    php cmd.php xf-designer:rebuild-metadata wf3_domperf || exit 1
  ) || { fail "Local XenForo template import/metadata rebuild failed"; return 1; }

  if peer_enabled; then
    for style in "${XF_STYLES[@]}"; do
      peer_rsync "$XENFORO_STYLES_ROOT/$style/templates/_metadata.json" \
        "$PEER_HOST:$XENFORO_STYLES_ROOT/$style/templates/_metadata.json" \
        || { fail "Cannot push $style template metadata to $PEER_HOST"; return 1; }
    done

    peer_ssh bash -s -- "$XENFORO_ROOT" <<'REMOTE' || { fail "Peer xf-designer:import-templates failed"; return 1; }
# wf-peer-import-templates
set -Eeuo pipefail
cd "$1"
php cmd.php xf-designer:import-templates wf3
php cmd.php xf-designer:import-templates wf3_domperf
REMOTE
  else
    skip_peer "the peer template push and designer import"
  fi

  sync_database_chat_style || return 1
  if ((wf5_available)); then
    sync_wf5_chat_style || return 1
  fi
  verify_compiled_template_runtime "$verify_chat_contract" || return 1

  if peer_enabled; then
    log "Applied the XenForo chat template bundle and imported designer templates on both nodes."
  else
    log "Applied the XenForo chat template bundle and imported designer templates."
  fi
}

# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------

stage_peer_release() {
  local release="$1" private
  private="$(private_release_dir "$release")"

  peer_enabled || { skip_peer "peer release staging"; return 0; }
  peer_ssh mkdir -p -- "$release" "$private" || die "Cannot create release paths on $PEER_HOST"
  peer_rsync --delete "$release/" "$PEER_HOST:$release/" \
    || die "Cannot stage the release on $PEER_HOST"
  peer_rsync --delete "$private/" "$PEER_HOST:$private/" \
    || die "Cannot stage private release data on $PEER_HOST"
  peer_ssh bash -s -- "$release" "$private" "$DEPLOY_OWNER" "$INVENTORY_NAME" "$RELEASE_METADATA_NAME" <<'REMOTE' \
    || die "Peer release staging verification failed (divergent or incomplete peer release)"
# wf-peer-stage-verify
set -Eeuo pipefail
release="$1"; private="$2"; owner="$3"; inv="$4"; metadata="$5"
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod 644 {} +
find "$private" -type d -exec chmod 750 {} +
find "$private" -type f -exec chmod 640 {} +
chown -R "$owner" "$release"
chown -R "$owner" "$private"
test -f "$release/.htaccess"
test -f "$release/index.html"
test -f "$release/static/js/main.js"
test -f "$release/static/css/main.css"
test ! -e "$release/$inv"
test ! -e "$release/$metadata"
test ! -e "$release/xenforo-templates"
test -f "$private/$inv"
test -f "$private/$metadata"
test -f "$private/xenforo-templates/wf5/_page_node.313"
grep -Fq 'RELEASE-INVENTORY\.sha256' "$release/.htaccess"
grep -Fq 'xenforo-templates' "$release/.htaccess"
expected=0
declare -A seen=()
while IFS=' ' read -r hash virtual; do
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]]
  [[ -z "${seen[$virtual]+present}" ]]
  seen["$virtual"]=1
  case "$virtual" in
    public/*) relative="${virtual#public/}"; file="$release/$relative" ;;
    private/*) relative="${virtual#private/}"; file="$private/$relative" ;;
    *) echo "invalid inventory path: $virtual" >&2; exit 1 ;;
  esac
  [[ -n "$relative" && "$relative" != /* && "$relative" != *'..'* ]]
  [[ -f "$file" ]]
  [[ "$(sha256sum -- "$file" | awk '{print $1}')" == "$hash" ]]
  expected=$((expected + 1))
done <"$private/$inv"
actual="$(find "$release" -type f ! -name "$inv" | wc -l)"
actual=$((actual + $(find "$private" -type f ! -name "$inv" -not -name ".$inv.tmp" | wc -l)))
if [[ "$expected" != "$actual" ]]; then
  echo "peer inventory count mismatch: $expected listed, $actual present" >&2
  exit 1
fi
REMOTE

  log "Staged and verified the release inventory on $PEER_HOST."
}

prepare_release() {
  local release_id release private

  run_release_checks

  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$APP_ROOT" rev-parse --short HEAD)-$$"
  release="$RELEASE_ROOT/$release_id"
  private="$DEPLOY_PRIVATE_ROOT/$release_id"
  TARGET_RELEASE="$release"
  mkdir -p -- "$release" "$private" || die "Cannot create release staging paths"
  cp -a "$DIST_DIR"/. "$release"/ || die "Cannot copy $DIST_DIR into $release"
  stage_template_bundle "$release" || die "Cannot stage the XenForo template bundle"
  write_release_metadata "$release" || die "Cannot write private release metadata"
  generate_inventory "$release" || die "Cannot generate the release inventory"
  find "$release" -type d -exec chmod 755 {} + || die "chmod failed on $release"
  find "$release" -type f -exec chmod 644 {} + || die "chmod failed on $release"
  find "$private" -type d -exec chmod 750 {} + || die "chmod failed on $private"
  find "$private" -type f -exec chmod 640 {} + || die "chmod failed on $private"
  chown -R "$DEPLOY_OWNER" "$release" || die "chown failed on $release"
  chown -R "$DEPLOY_OWNER" "$private" || die "chown failed on $private"
  verify_release "$release" || die "Staged release failed artifact verification"
  verify_private_release_boundary "$release" || die "Staged release crossed the private/public boundary"
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
    generate_legacy_inventory "$legacy" || die "Cannot generate an inventory for $legacy"
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

  if ! peer_enabled; then
    skip_peer "the peer switch preparation"
    REMOTE_PREVIOUS_TARGET=""
    return 0
  fi

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

  peer_enabled || { skip_peer "the peer symlink switch"; return 0; }

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
  if [[ -n "$remote_previous" ]] && peer_enabled; then
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
  local current previous candidate private kept=0
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
      private="$(private_release_dir "$candidate")"
      if [[ -d "$private" ]]; then
        [[ "$private" == "$DEPLOY_PRIVATE_ROOT"/* ]] \
          || { fail "Refusing to prune private data outside $DEPLOY_PRIVATE_ROOT"; return 1; }
        rm -rf -- "$private" || return 1
      fi
      log "Pruned local release $candidate"
    fi
  done
}

prune_peer_releases() {
  peer_enabled || { skip_peer "peer release pruning"; return 0; }
  peer_ssh bash -s -- "$RELEASE_ROOT" "$PUBLIC_LINK" "$DEPLOY_PRIVATE_ROOT" "$RETAIN_RELEASES" <<'REMOTE' || return 1
# wf-peer-prune
set -Eeuo pipefail
release_root="$1"; public_link="$2"; private_root="$3"; retain="$4"
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
    private="$private_root/$(basename -- "$candidate")"
    if [[ -d "$private" ]]; then
      [[ "$private" == "$private_root"/* ]]
      rm -rf -- "$private"
    fi
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

  local template_bundle
  template_bundle="$(template_bundle_for_release "$release")"
  [[ -n "$template_bundle" ]] || die "Release has no private or legacy template bundle"
  apply_template_bundle "$template_bundle" \
    || die "Applying the release template bundle failed"
  TEMPLATES_APPLIED=1
  record_state templates-synced

  purge_origin_chat_page || die "Origin page-cache purge failed"
  purge_chat_surfaces || die "Cloudflare purge failed"
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

  warn "Rollback scope is frontend release assets and bundled chat templates only; backend PHP, database schema, systemd units, and installed browser PWA state remain unchanged."

  [[ -L "$PUBLIC_LINK" ]] || die "$PUBLIC_LINK is not a managed release symlink"
  [[ -L "$RELEASE_ROOT/previous" ]] || die "No previous release is recorded"
  current="$(readlink -f -- "$PUBLIC_LINK")"
  rollback_target="$(readlink -f -- "$RELEASE_ROOT/previous")"
  [[ -d "$rollback_target" ]] || die "Recorded previous release is missing"
  [[ "$rollback_target" != "$current" ]] || die "Previous release is already active"

  if [[ -n "$(inventory_for_release "$rollback_target")" ]]; then
    verify_inventory "$rollback_target" \
      || die "Rollback refused: the recorded previous release failed inventory verification"
  else
    warn "Previous release has no $INVENTORY_NAME (pre-transactional); falling back to basic artifact checks"
    verify_rollback_release "$rollback_target" || die "Rollback refused: previous release is incomplete"
  fi

  if ! peer_enabled; then
    skip_peer "peer previous-release verification"
    remote_current=""
    remote_rollback_target=""
  else
  out="$(peer_ssh bash -s -- "$PUBLIC_LINK" "$RELEASE_ROOT" "$DEPLOY_PRIVATE_ROOT" "$INVENTORY_NAME" <<'REMOTE'
# wf-peer-rollback-check
set -Eeuo pipefail
link="$1"; release_root="$2"; private_root="$3"; inv="$4"
[[ -L "$link" ]]
current="$(readlink -f -- "$link")"
[[ -L "$release_root/previous" ]]
target="$(readlink -f -- "$release_root/previous")"
[[ -d "$target" ]]
[[ "$target" != "$current" ]]
private="$private_root/$(basename -- "$target")"
if [[ -f "$private/$inv" ]]; then
  expected=0
  declare -A seen=()
  while IFS=' ' read -r hash virtual; do
    [[ "$hash" =~ ^[0-9a-f]{64}$ ]]
    [[ -z "${seen[$virtual]+present}" ]]
    seen["$virtual"]=1
    case "$virtual" in
      public/*) relative="${virtual#public/}"; file="$target/$relative" ;;
      private/*) relative="${virtual#private/}"; file="$private/$relative" ;;
      *) exit 1 ;;
    esac
    [[ -n "$relative" && "$relative" != /* && "$relative" != *'..'* ]]
    [[ -f "$file" ]]
    [[ "$(sha256sum -- "$file" | awk '{print $1}')" == "$hash" ]]
    expected=$((expected + 1))
  done <"$private/$inv"
  actual="$(find "$target" -type f ! -name "$inv" | wc -l)"
  actual=$((actual + $(find "$private" -type f ! -name "$inv" -not -name ".$inv.tmp" | wc -l)))
  [[ "$expected" == "$actual" ]]
elif [[ -f "$target/$inv" ]]; then
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
  fi

  TARGET_RELEASE="$rollback_target"
  if [[ -f "$(private_release_dir "$rollback_target")/$RELEASE_METADATA_NAME" ]]; then
    RELEASE_METADATA_FILE="$(private_release_dir "$rollback_target")/$RELEASE_METADATA_NAME"
  else
    RELEASE_METADATA_FILE=""
  fi
  PREVIOUS_TARGET="$current"
  REMOTE_PREVIOUS_TARGET="$remote_current"
  record_state rollback-started

  snapshot_active_templates || die "Cannot snapshot the live XenForo templates"
  record_state templates-snapshotted

  local_switch "$rollback_target"
  record_state local-switched

  peer_switch_with_reconcile "$remote_rollback_target"
  record_state remote-switched

  local rollback_bundle
  rollback_bundle="$(template_bundle_for_release "$rollback_target")"
  if [[ -n "$rollback_bundle" ]]; then
    apply_template_bundle "$rollback_bundle" 0 \
      || die "Applying the rollback template bundle failed"
    TEMPLATES_APPLIED=1
  else
    warn "Rollback release has no xenforo-templates bundle (pre-transactional); leaving the live templates in place"
  fi
  record_state templates-synced

  purge_origin_chat_page || die "Origin page-cache purge failed"
  purge_chat_surfaces || die "Cloudflare purge failed"
  PURGED=1
  record_state purged

  verify_live_release "$rollback_target" 0 || die "Live verification of the rollback release failed"
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
      mkdir -p -- "$DEPLOY_RECOVERY_ROOT" "$DEPLOY_PRIVATE_ROOT" \
        || die "Cannot create private release roots"
      capture_backend_hashes || die "Cannot hash the chat backend files"
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
      mkdir -p -- "$DEPLOY_RECOVERY_ROOT" "$DEPLOY_PRIVATE_ROOT" \
        || die "Cannot create private release roots"
      capture_backend_hashes || die "Cannot hash the chat backend files"
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
