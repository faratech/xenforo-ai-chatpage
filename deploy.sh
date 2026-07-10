#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 022

readonly APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

SWITCHED=0
REMOTE_SWITCHED=0
SUCCEEDED=0
MIGRATED_DIRECTORY=0
PREVIOUS_TARGET=""
REMOTE_PREVIOUS_TARGET=""
PREPARED_RELEASE=""
NEXT_LINK=""
TEMP_FILES=()

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

atomic_link() {
  local target="$1"
  local link="$2"
  local next="${link}.next.$$"

  rm -f -- "$next"
  ln -s -- "$target" "$next"
  mv -Tf -- "$next" "$link"
}

peer_ssh() {
  ssh -i "$PEER_SSH_KEY" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=no \
    "$PEER_HOST" "$@"
}

atomic_peer_link() {
  local target="$1"
  local link="$2"

  peer_ssh bash -s -- "$target" "$link" <<'REMOTE'
set -Eeuo pipefail
target="$1"
link="$2"
next="${link}.next.$$"
rm -f -- "$next"
ln -s -- "$target" "$next"
mv -Tf -- "$next" "$link"
REMOTE
}

cleanup() {
  local status=$?
  trap - EXIT

  if [[ -n "$NEXT_LINK" ]]; then
    rm -f -- "$NEXT_LINK"
  fi
  if ((${#TEMP_FILES[@]})); then
    rm -f -- "${TEMP_FILES[@]}"
  fi

  if ((SWITCHED == 1 && SUCCEEDED == 0)) && [[ -n "$PREVIOUS_TARGET" ]]; then
    log "Activation failed; restoring $PREVIOUS_TARGET"
    atomic_link "$PREVIOUS_TARGET" "$PUBLIC_LINK" || true
  elif ((MIGRATED_DIRECTORY == 1 && SWITCHED == 0 && SUCCEEDED == 0)); then
    if [[ ! -e "$PUBLIC_LINK" && ! -L "$PUBLIC_LINK" ]]; then
      mv -- "$PREVIOUS_TARGET" "$PUBLIC_LINK" || true
    fi
  fi
  if ((REMOTE_SWITCHED == 1 && SUCCEEDED == 0)) && [[ -n "$REMOTE_PREVIOUS_TARGET" ]]; then
    log "Activation failed; restoring $REMOTE_PREVIOUS_TARGET on $PEER_HOST"
    atomic_peer_link "$REMOTE_PREVIOUS_TARGET" "$PUBLIC_LINK" || true
  fi

  exit "$status"
}
trap cleanup EXIT

verify_release() {
  local release="$1"
  node "$APP_ROOT/scripts/verify-dist.mjs" "$release"
}

verify_rollback_release() {
  local release="$1"

  [[ -f "$release/index.html" ]] || fail "Rollback release is missing index.html"
  [[ -f "$release/bot-avatar.webp" ]] || fail "Rollback release is missing bot-avatar.webp"
  [[ -f "$release/static/js/main.js" ]] || fail "Rollback release is missing main.js"
  [[ -f "$release/static/css/main.css" ]] || fail "Rollback release is missing main.css"
}

verify_xenforo_templates() {
  node "$APP_ROOT/scripts/verify-xenforo-templates.mjs" "$XENFORO_STYLES_ROOT"
}

verify_peer_template_sources() {
  local style template relative local_hash remote_hash attempt matched

  for style in wf3 wf3_domperf; do
    for template in _page_node.313 _widget_ai_chat.html react_chat_container.html; do
      relative="src/styles/$style/templates/public/$template"
      local_hash="$(sha256sum "$XENFORO_ROOT/$relative" | awk '{print $1}')"
      matched=0
      for attempt in 1 2 3 4 5; do
        remote_hash="$(peer_ssh sha256sum "$XENFORO_ROOT/$relative" 2>/dev/null \
          | awk '{print $1}' || true)"
        if [[ "$remote_hash" == "$local_hash" ]]; then
          matched=1
          break
        fi
        sleep 2
      done
      ((matched == 1)) || fail "Peer template source is stale: $relative"
    done
  done

  log "Verified matching XenForo chat template sources on $PEER_HOST."
}

sync_xenforo_templates() {
  local style

  (
    cd "$XENFORO_ROOT"
    php cmd.php xf-designer:sync-templates wf3
    php cmd.php xf-designer:sync-templates wf3_domperf
  )
  for style in wf3 wf3_domperf; do
    rsync -a \
      -e "ssh -i $PEER_SSH_KEY -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no" \
      "$XENFORO_STYLES_ROOT/$style/templates/_metadata.json" \
      "$PEER_HOST:$XENFORO_STYLES_ROOT/$style/templates/_metadata.json"
  done
  peer_ssh bash -s -- "$XENFORO_ROOT" <<'REMOTE'
set -Eeuo pipefail
cd "$1"
php cmd.php xf-designer:sync-templates wf3
php cmd.php xf-designer:sync-templates wf3_domperf
REMOTE
  log "Synced changed wf3 and wf3_domperf templates through XenForo designer mode."
}

run_release_checks() {
  cd "$APP_ROOT"
  log "Running lint, typecheck, tests, build, and artifact verification..."
  npm run check
  verify_xenforo_templates
  verify_peer_template_sources
}

read_env_value() {
  local key="$1"
  local value

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

  [[ -n "$token" ]] || fail "CLOUDFLARE_PURGE_TOKEN is required for a production deployment"
  [[ -n "$zone" ]] || fail "CLOUDFLARE_ZONE_ID is required for a production deployment"

  response_file="$(mktemp)"
  TEMP_FILES+=("$response_file")
  curl --fail-with-body --silent --show-error \
    --request POST \
    "https://api.cloudflare.com/client/v4/zones/$zone/purge_cache" \
    --header "Authorization: Bearer $token" \
    --header 'Content-Type: application/json' \
    --data '{"prefixes":["windowsforum.com/chatpage"]}' \
    --output "$response_file"

  node --input-type=module - "$response_file" <<'NODE'
import { readFile } from 'node:fs/promises';

const response = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (response.success !== true) {
  throw new Error(`Cloudflare prefix purge failed: ${JSON.stringify(response.errors || response)}`);
}
NODE

  log "Purged only the windowsforum.com/chatpage Cloudflare prefix."
}

assert_header() {
  local url="$1"
  local expected="$2"
  local mode="${3:-public}"
  local headers

  if [[ "$mode" == origin ]]; then
    headers="$(curl --fail --silent --show-error --head \
      --resolve "windowsforum.com:443:$ORIGIN_IP" "$url")"
  elif [[ "$mode" == peer ]]; then
    headers="$(curl --fail --silent --show-error --head \
      --resolve "windowsforum.com:443:$PEER_ORIGIN_IP" "$url")"
  else
    headers="$(curl --fail --silent --show-error --head "$url")"
  fi

  printf '%s\n' "$headers" | tr -d '\r' | grep -Eiq "$expected" \
    || fail "$url is missing the expected Cache-Control policy: $expected"
}

assert_origin_hash() {
  local relative="$1"
  local expected_file="$2"
  local origin_ip="$3"
  local expected_hash actual_hash download

  expected_hash="$(sha256sum "$expected_file" | awk '{print $1}')"
  download="$(mktemp)"
  TEMP_FILES+=("$download")
  curl --fail --silent --show-error \
    --resolve "windowsforum.com:443:$origin_ip" \
    "$LIVE_ORIGIN/chatpage/$relative?v=2" --output "$download"
  actual_hash="$(sha256sum "$download" | awk '{print $1}')"
  [[ "$actual_hash" == "$expected_hash" ]] \
    || fail "$relative hash does not match on origin $origin_ip"
}

assert_public_hash() {
  local relative="$1"
  local expected_file="$2"
  local expected_hash actual_hash download attempt

  expected_hash="$(sha256sum "$expected_file" | awk '{print $1}')"
  download="$(mktemp)"
  TEMP_FILES+=("$download")

  for attempt in 1 2 3 4 5 6; do
    if curl --fail --silent --show-error \
      "$LIVE_ORIGIN/chatpage/$relative?v=2" --output "$download"; then
      actual_hash="$(sha256sum "$download" | awk '{print $1}')"
      if [[ "$actual_hash" == "$expected_hash" ]]; then
        return 0
      fi
    fi
    if ((attempt < 6)); then
      sleep 5
    fi
  done

  fail "Public $relative did not converge to the activated release"
}

verify_live_release() {
  local release="$1"
  local hashed_file hashed_relative

  assert_origin_hash 'static/js/main.js' "$release/static/js/main.js" "$ORIGIN_IP"
  assert_origin_hash 'static/css/main.css' "$release/static/css/main.css" "$ORIGIN_IP"
  assert_origin_hash 'bot-avatar.webp' "$release/bot-avatar.webp" "$ORIGIN_IP"
  assert_origin_hash 'static/js/main.js' "$release/static/js/main.js" "$PEER_ORIGIN_IP"
  assert_origin_hash 'static/css/main.css' "$release/static/css/main.css" "$PEER_ORIGIN_IP"
  assert_origin_hash 'bot-avatar.webp' "$release/bot-avatar.webp" "$PEER_ORIGIN_IP"
  assert_public_hash 'static/js/main.js' "$release/static/js/main.js"
  assert_public_hash 'static/css/main.css' "$release/static/css/main.css"
  assert_public_hash 'bot-avatar.webp' "$release/bot-avatar.webp"

  assert_header "$LIVE_ORIGIN/chatpage/static/js/main.js?v=2" \
    'cache-control:.*no-cache.*must-revalidate' public
  assert_header "$LIVE_ORIGIN/chatpage/static/css/main.css?v=2" \
    'cache-control:.*no-cache.*must-revalidate' origin
  assert_header "$LIVE_ORIGIN/chatpage/static/js/main.js?v=2" \
    'cache-control:.*no-cache.*must-revalidate' peer
  assert_header "$LIVE_ORIGIN/chatpage/bot-avatar.webp?v=2" \
    'cache-control:.*no-cache.*must-revalidate' origin
  assert_header "$LIVE_ORIGIN/chatpage/bot-avatar.webp?v=2" \
    'cache-control:.*no-cache.*must-revalidate' peer

  hashed_file="$(find "$release/static/js" -maxdepth 1 -type f -name '*.chunk.js' -print -quit)"
  if [[ -n "$hashed_file" && "$(basename "$hashed_file")" =~ -[A-Za-z0-9_-]{8,}\.chunk\.js$ ]]; then
    hashed_relative="${hashed_file#"$release/"}"
    assert_header "$LIVE_ORIGIN/chatpage/$hashed_relative" \
      'cache-control:.*max-age=31536000.*immutable' origin
    assert_header "$LIVE_ORIGIN/chatpage/$hashed_relative" \
      'cache-control:.*max-age=31536000.*immutable' peer
  fi

  log "Verified both origins, public hashes, and stable/immutable cache headers."
}

record_previous_releases() {
  local previous="$1"
  local remote_previous="$2"

  [[ -z "$previous" ]] || atomic_link "$previous" "$RELEASE_ROOT/previous"
  [[ -z "$remote_previous" ]] \
    || atomic_peer_link "$remote_previous" "$RELEASE_ROOT/previous"
}

prune_old_releases() {
  local current previous candidate kept=0
  local releases=()

  [[ "$RETAIN_RELEASES" =~ ^[1-9][0-9]*$ ]] \
    || fail "RETAIN_RELEASES must be a positive integer"
  current="$(readlink -f "$PUBLIC_LINK")"
  previous="${PREVIOUS_TARGET:-$(readlink -f "$RELEASE_ROOT/previous" 2>/dev/null || true)}"

  mapfile -t releases < <(
    find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
      | sort -rn | cut -d' ' -f2-
  )

  for candidate in "${releases[@]}"; do
    if [[ "$candidate" == "$current" || "$candidate" == "$previous" ]]; then
      continue
    fi
    kept=$((kept + 1))
    if ((kept > RETAIN_RELEASES)); then
      [[ "$candidate" == "$RELEASE_ROOT"/* ]] \
        || fail "Refusing to prune a release outside $RELEASE_ROOT"
      peer_ssh bash -s -- "$candidate" "$RELEASE_ROOT" <<'REMOTE'
set -Eeuo pipefail
candidate="$1"
release_root="$2"
[[ "$candidate" == "$release_root"/* ]]
rm -rf -- "$candidate"
REMOTE
      rm -rf -- "$candidate"
    fi
  done
}

stage_peer_release() {
  local release="$1"
  local local_main_hash remote_main_hash local_css_hash remote_css_hash

  peer_ssh mkdir -p -- "$release"
  rsync -a --delete \
    -e "ssh -i $PEER_SSH_KEY -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no" \
    "$release/" "$PEER_HOST:$release/"
  peer_ssh bash -s -- "$release" "$DEPLOY_OWNER" <<'REMOTE'
set -Eeuo pipefail
release="$1"
owner="$2"
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod 644 {} +
chown -R "$owner" "$release"
test -f "$release/.htaccess"
test -f "$release/index.html"
test -f "$release/static/js/main.js"
test -f "$release/static/css/main.css"
REMOTE

  local_main_hash="$(sha256sum "$release/static/js/main.js" | awk '{print $1}')"
  local_css_hash="$(sha256sum "$release/static/css/main.css" | awk '{print $1}')"
  remote_main_hash="$(peer_ssh sha256sum "$release/static/js/main.js" | awk '{print $1}')"
  remote_css_hash="$(peer_ssh sha256sum "$release/static/css/main.css" | awk '{print $1}')"
  [[ "$remote_main_hash" == "$local_main_hash" ]] \
    || fail "Peer main.js differs from the staged local release"
  [[ "$remote_css_hash" == "$local_css_hash" ]] \
    || fail "Peer main.css differs from the staged local release"

  log "Staged and verified the release on $PEER_HOST."
}

activate_peer_release() {
  local release="$1"
  local legacy="$2"

  peer_ssh bash -s -- "$release" "$PUBLIC_LINK" "$legacy" <<'REMOTE'
set -Eeuo pipefail
release="$1"
public_link="$2"
legacy="$3"
next="${public_link}.next.$$"
migrated=0
succeeded=0

cleanup() {
  status=$?
  trap - EXIT
  rm -f -- "$next"
  if ((migrated == 1 && succeeded == 0)) && [[ ! -e "$public_link" && ! -L "$public_link" ]]; then
    mv -- "$legacy" "$public_link" || true
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -L "$public_link" ]]; then
  previous="$(readlink -f "$public_link")"
  [[ -d "$previous" ]]
elif [[ -d "$public_link" ]]; then
  [[ ! -e "$legacy" ]]
  mv -- "$public_link" "$legacy"
  cp -f -- "$release/.htaccess" "$legacy/.htaccess"
  previous="$legacy"
  migrated=1
elif [[ -e "$public_link" ]]; then
  echo "$public_link exists but is neither a directory nor symlink" >&2
  exit 1
else
  previous=""
fi

ln -s -- "$release" "$next"
mv -Tf -- "$next" "$public_link"
[[ "$(readlink -f "$public_link")" == "$release" ]]
succeeded=1
printf '%s' "$previous"
REMOTE
}

prepare_release() {
  local release_id release

  run_release_checks

  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)-$$"
  release="$RELEASE_ROOT/$release_id"
  mkdir -p -- "$release"
  cp -a "$DIST_DIR"/. "$release"/
  find "$release" -type d -exec chmod 755 {} +
  find "$release" -type f -exec chmod 644 {} +
  chown -R "$DEPLOY_OWNER" "$release"
  verify_release "$release"
  stage_peer_release "$release"

  PREPARED_RELEASE="$release"
}

activate_release() {
  local release="$1"
  local legacy

  legacy="$RELEASE_ROOT/legacy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  REMOTE_PREVIOUS_TARGET="$(activate_peer_release "$release" "$legacy")"
  REMOTE_SWITCHED=1

  if [[ -L "$PUBLIC_LINK" ]]; then
    PREVIOUS_TARGET="$(readlink -f "$PUBLIC_LINK")"
    [[ -d "$PREVIOUS_TARGET" ]] || fail "Current public symlink target is missing"
  elif [[ -d "$PUBLIC_LINK" ]]; then
    [[ ! -e "$legacy" ]] || fail "Legacy release path already exists: $legacy"
    mv -- "$PUBLIC_LINK" "$legacy"
    cp -f -- "$release/.htaccess" "$legacy/.htaccess"
    PREVIOUS_TARGET="$legacy"
    MIGRATED_DIRECTORY=1
  elif [[ -e "$PUBLIC_LINK" ]]; then
    fail "$PUBLIC_LINK exists but is neither a directory nor symlink"
  fi

  NEXT_LINK="${PUBLIC_LINK}.next.$$"
  rm -f -- "$NEXT_LINK"
  ln -s -- "$release" "$NEXT_LINK"
  mv -Tf -- "$NEXT_LINK" "$PUBLIC_LINK"
  NEXT_LINK=""
  SWITCHED=1

  [[ "$(readlink -f "$PUBLIC_LINK")" == "$release" ]] \
    || fail "Public symlink did not activate the staged release"

  sync_xenforo_templates
  purge_chatpage_prefix
  verify_live_release "$release"
  prune_old_releases
  record_previous_releases "$PREVIOUS_TARGET" "$REMOTE_PREVIOUS_TARGET"
  SUCCEEDED=1
  log "Deployment complete: $release"
}

rollback_release() {
  local rollback_target current remote_rollback_target remote_current

  [[ -L "$PUBLIC_LINK" ]] || fail "$PUBLIC_LINK is not a managed release symlink"
  [[ -L "$RELEASE_ROOT/previous" ]] || fail "No previous release is recorded"
  current="$(readlink -f "$PUBLIC_LINK")"
  rollback_target="$(readlink -f "$RELEASE_ROOT/previous")"
  [[ -d "$rollback_target" ]] || fail "Recorded previous release is missing"
  [[ "$rollback_target" != "$current" ]] || fail "Previous release is already active"
  verify_rollback_release "$rollback_target"
  remote_current="$(peer_ssh readlink -f "$PUBLIC_LINK")"
  remote_rollback_target="$(peer_ssh readlink -f "$RELEASE_ROOT/previous")"
  peer_ssh test -d "$remote_rollback_target"
  [[ "$remote_rollback_target" != "$remote_current" ]] \
    || fail "Previous release is already active on $PEER_HOST"

  PREVIOUS_TARGET="$current"
  REMOTE_PREVIOUS_TARGET="$remote_current"
  atomic_peer_link "$remote_rollback_target" "$PUBLIC_LINK"
  REMOTE_SWITCHED=1
  atomic_link "$rollback_target" "$PUBLIC_LINK"
  SWITCHED=1
  purge_chatpage_prefix
  verify_live_release "$rollback_target"
  record_previous_releases "$current" "$remote_current"
  SUCCEEDED=1
  log "Rollback complete: $rollback_target"
}

main() {
  local command="${1:-deploy}"

  case "$command" in
    deploy)
      mkdir -p -- "$RELEASE_ROOT"
      prepare_release
      activate_release "$PREPARED_RELEASE"
      ;;
    rollback|--rollback)
      [[ -d "$RELEASE_ROOT" ]] || fail "No release directory exists at $RELEASE_ROOT"
      rollback_release
      ;;
    verify|--verify)
      run_release_checks
      SUCCEEDED=1
      ;;
    *)
      fail "Usage: $0 [deploy|rollback|verify]"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
