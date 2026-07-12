#!/usr/bin/env bash
# Shared sandbox library for the deploy.sh failure-injection release tests.
#
# Every test runs deploy.sh against a throwaway sandbox:
#   $SB/local  — the "local" node (RELEASE_ROOT, PUBLIC_LINK, XenForo trees)
#   $SB/peer   — the "peer" node; the fake ssh/rsync stubs rewrite any path
#                under $SB/local to $SB/peer before executing, so remote
#                effects are observable as a second filesystem tree.
#   $SB/app    — a scratch git repo containing deploy.sh + scripts/*.mjs
#   $SB/dist   — a fake (but verify-dist-compliant) build output
#   $SB/bin    — stubbed ssh/rsync/curl/php/npm, prepended to PATH
#   $SB/control— failure-injection rules, per-stub invocation logs
#
# Failure injection: append lines to $CONTROL/rules of the form
#   <cmd> \t <nth>[+] \t <mode> \t <extended-regex>
# The stub matches the pattern against its full invocation text (args plus any
# remote script read from stdin); on the nth match it applies the mode:
#   skip:<code>     do not execute, exit <code>   (255 = connection refused)
#   after:<code>    execute, then exit <code>     (255 = connection lost late)
#   corrupt:<rel>   (rsync only) copy, then corrupt <rel> under the destination
#   purge-error     (curl only) return {"success":false} from the purge API
# "nth+" applies to every matching invocation from the nth onward.

set -Eeuo pipefail

RT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RT_APP_SRC="$(cd "$RT_LIB_DIR/../.." && pwd)"

SB=""

rt_cleanup() {
  if [[ -n "$SB" && -d "$SB" ]]; then
    rm -rf -- "$SB"
  fi
}

fail_test() {
  echo "ASSERTION FAILED: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Sandbox construction
# ---------------------------------------------------------------------------

setup_sandbox() {
  SB="$(mktemp -d "${RELEASE_TEST_TMP:-${TMPDIR:-/tmp}}/chatpage-release-test.XXXXXX")"
  trap rt_cleanup EXIT

  mkdir -p \
    "$SB/local/releases" \
    "$SB/local/public_html" \
    "$SB/local/db-templates" \
    "$SB/peer/releases" \
    "$SB/peer/public_html" \
    "$SB/bin" "$SB/control" "$SB/app/scripts" "$SB/dist" "$SB/env"

  export SANDBOX_LOCAL="$SB/local"
  export SANDBOX_PEER="$SB/peer"
  export CONTROL="$SB/control"

  export RELEASE_ROOT="$SB/local/releases"
  export PUBLIC_LINK="$SB/local/public_html/chatpage"
  export XENFORO_ROOT="$SB/local/public_html"
  export XENFORO_STYLES_ROOT="$SB/local/public_html/src/styles"
  export DIST_DIR="$SB/dist"
  export CLOUDFLARE_ENV_FILE="$SB/env/cloudflare.env"
  export PEER_HOST="root@peer.sandbox"
  export PEER_SSH_KEY="$SB/env/fake_key"
  DEPLOY_OWNER="$(id -un):$(id -gn)"
  export DEPLOY_OWNER
  export ORIGIN_IP="127.0.0.1"
  export PEER_ORIGIN_IP="10.99.99.2"
  export PUBLIC_EDGE_IP="203.0.113.10"
  export LIVE_ORIGIN="https://windowsforum.com"
  export RETAIN_RELEASES="${RETAIN_RELEASES:-5}"
  export DEPLOY_RETRY_DELAY=0
  export DEPLOY_PUBLIC_RETRY_DELAY=0
  export DEPLOY_SSH_CONNECT_TIMEOUT=2
  export PATH="$SB/bin:$PATH"

  # shellcheck disable=SC2034  # consumed by the sourcing test scripts
  PEER_RELEASE_ROOT="$SB/peer/releases"
  PEER_PUBLIC_LINK="$SB/peer/public_html/chatpage"
  PEER_STYLES_ROOT="$SB/peer/public_html/src/styles"
  STATE_FILE="$RELEASE_ROOT/.deploy-state.json"

  printf 'CLOUDFLARE_PURGE_TOKEN=sandbox-token\nCLOUDFLARE_ZONE_ID=sandbox-zone\n' \
    >"$CLOUDFLARE_ENV_FILE"
  : >"$PEER_SSH_KEY"
  : >"$CONTROL/rules"

  make_fake_styles "$XENFORO_STYLES_ROOT" "v1"
  make_fake_styles "$PEER_STYLES_ROOT" "v1"
  snapshot_fake_db_from_styles
  make_fake_dist "$DIST_DIR" "build-1"
  make_app_repo
  write_stubs
}

make_app_repo() {
  cp "$RT_APP_SRC/deploy.sh" "$SB/app/deploy.sh"
  cp "$RT_APP_SRC/scripts/verify-dist.mjs" "$SB/app/scripts/"
  cp "$RT_APP_SRC/scripts/verify-xenforo-templates.mjs" "$SB/app/scripts/"
  cp "$RT_APP_SRC/scripts/verify-xenforo-compiled-templates.mjs" "$SB/app/scripts/"
  cp "$RT_APP_SRC/scripts/snapshot-xenforo-template-db.php" "$SB/app/scripts/"
  chmod 755 "$SB/app/deploy.sh"
  git -C "$SB/app" init -q
  git -C "$SB/app" config user.email release-tests@sandbox.invalid
  git -C "$SB/app" config user.name "Release Tests"
  git -C "$SB/app" add -A
  git -C "$SB/app" commit -qm 'sandbox baseline'
}

snapshot_fake_db_from_styles() {
  local style template target
  for style in wf3 wf3_domperf; do
    target="$SANDBOX_LOCAL/db-templates/$style"
    mkdir -p "$target"
    for template in _page_node.313 _widget_ai_chat.html react_chat_container.html; do
      cp -f -- "$XENFORO_STYLES_ROOT/$style/templates/public/$template" \
        "$target/$template"
      sed -i \
        -e 's/<div id="root" class="google-anno-skip" style="min-height:100vh"><\/div>/<div id="root"><\/div>/' \
        -e 's/?v=2/?ver=legacy-db/g' \
        "$target/$template"
    done
  done
}

# make_fake_styles <styles_root> <version-tag>
make_fake_styles() {
  local root="$1" tag="$2" style template dir
  for style in wf3 wf3_domperf; do
    dir="$root/$style/templates/public"
    mkdir -p "$dir"
    for template in _page_node.313 _widget_ai_chat.html react_chat_container.html; do
      cat >"$dir/$template" <<TEMPLATE
<div id="root" class="google-anno-skip" style="min-height:100vh"></div>
<link rel="stylesheet" href="https://windowsforum.com/chatpage/static/css/main.css?v=2">
<script type="module" src="https://windowsforum.com/chatpage/static/js/main.js?v=2"></script>
<!-- $style/$template $tag -->
TEMPLATE
    done
    write_style_metadata "$root/$style/templates"
  done
}

# Rebuild _metadata.json so verify-xenforo-templates.mjs sees a clean baseline.
write_style_metadata() {
  local templates_root="$1"
  # shellcheck disable=SC2016  # the $-expressions are JavaScript, not shell
  node -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const metadata = {};
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith("_metadata.") || entry.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, rel);
        else {
          const hash = createHash("md5").update(fs.readFileSync(full)).digest("hex");
          metadata[rel] = { hash };
        }
      }
    };
    walk(root, "");
    fs.writeFileSync(path.join(root, "_metadata.json"), JSON.stringify(metadata, null, 2));
  ' "$templates_root"
}

# mutate_styles <version-tag> — change the chat templates on both nodes (as the
# lsyncd-mirrored production trees would be) without touching metadata, i.e. a
# pending, designer-import-allowed chat template edit.
mutate_styles() {
  local tag="$1" root style template
  for root in "$XENFORO_STYLES_ROOT" "$PEER_STYLES_ROOT"; do
    for style in wf3 wf3_domperf; do
      for template in _page_node.313 _widget_ai_chat.html react_chat_container.html; do
        cat >"$root/$style/templates/public/$template" <<TEMPLATE
<div id="root" class="google-anno-skip" style="min-height:100vh"></div>
<link rel="stylesheet" href="https://windowsforum.com/chatpage/static/css/main.css?v=2">
<script type="module" src="https://windowsforum.com/chatpage/static/js/main.js?v=2"></script>
<!-- $style/$template $tag -->
TEMPLATE
      done
    done
  done
}

# make_fake_dist <dir> <content-tag> — a minimal dist that passes verify-dist,
# including the CSS scoping rule and the chunk import-graph rule.
make_fake_dist() {
  local dir="$1" tag="$2"
  rm -rf -- "$dir"
  mkdir -p "$dir/static/js" "$dir/static/css"

  cat >"$dir/.htaccess" <<'HTACCESS'
# sandbox htaccess (fake)
Header set Cache-Control "no-cache, must-revalidate"
HTACCESS

  printf 'FAKEWEBP-%s' "$tag" >"$dir/bot-avatar.webp"
  printf 'User-agent: *\nDisallow:\n' >"$dir/robots.txt"

  cat >"$dir/manifest.json" <<'MANIFEST'
{
  "name": "WindowsForum AI Chat",
  "start_url": "/chatpage/",
  "scope": "/chatpage/",
  "icons": [{ "src": "bot-avatar.webp", "sizes": "192x192", "type": "image/webp" }]
}
MANIFEST

  cat >"$dir/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AI Chat - WindowsForum</title>
    <script type="module" crossorigin src="/chatpage/static/js/main.js?v=2"></script>
    <link rel="modulepreload" crossorigin href="/chatpage/static/js/vendor-sandbox1.chunk.js">
    <link rel="stylesheet" crossorigin href="/chatpage/static/css/main.css?v=2">
  </head>
  <body>
    <div id="root" class="google-anno-skip" style="min-height:100vh"></div>
  </body>
</html>
HTML

  cat >"$dir/static/js/main.js" <<JS
import"./vendor-sandbox1.chunk.js";document.getElementById("root");/* ${tag} */
JS
  printf 'export const v = "%s";\n' "$tag" >"$dir/static/js/vendor-sandbox1.chunk.js"

  cat >"$dir/static/css/main.css" <<CSS
@charset "UTF-8";
#react-chat-container{display:flex}
#react-chat-container .message,#react-chat-container .sidebar{color:#111}
@media (max-width: 600px){#react-chat-container .sidebar{display:none}}
@supports (display: grid){#react-chat-container .grid{display:grid}}
@keyframes wfPulse{0%{opacity:0}100%{opacity:1}}
/* ${tag} */
CSS
}

# mutate_dist <content-tag> — change build output between deploys.
mutate_dist() {
  local tag="$1"
  printf '/* %s */\n' "$tag" >>"$DIST_DIR/static/js/main.js"
  printf 'FAKEWEBP-%s' "$tag" >"$DIST_DIR/bot-avatar.webp"
}

# make_legacy_public_dir <dir> — a plain (pre-release-engineering) deployment.
make_legacy_public_dir() {
  local dir="$1"
  mkdir -p "$dir/static/js" "$dir/static/css"
  printf '<!DOCTYPE html><div id="root"></div>\n' >"$dir/index.html"
  printf 'legacy-main-js\n' >"$dir/static/js/main.js"
  printf 'legacy-main-css\n' >"$dir/static/css/main.css"
  printf 'LEGACYWEBP' >"$dir/bot-avatar.webp"
  printf '# legacy original htaccess\n' >"$dir/.htaccess"
}

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------

write_stubs() {
  cat >"$SB/bin/.stub-lib.sh" <<'STUBLIB'
# Shared helpers for the sandbox command stubs. Requires: STUB_NAME, CONTROL.
stub_log() {
  printf '%s\n' "$*" >>"$CONTROL/log.$STUB_NAME"
}

# decide_mode <full invocation text> — prints the failure mode or nothing.
decide_mode() {
  local text="$1" mode="" lineno=0 line cmd nth m pat cfile n base
  [[ -f "$CONTROL/rules" ]] || { printf ''; return 0; }
  while IFS=$'\t' read -r cmd nth m pat; do
    lineno=$((lineno + 1))
    [[ "$cmd" == "$STUB_NAME" && -n "${pat:-}" ]] || continue
    if grep -Eq -- "$pat" <<<"$text"; then
      cfile="$CONTROL/.count.$STUB_NAME.$lineno"
      n=$(( $(cat "$cfile" 2>/dev/null || echo 0) + 1 ))
      printf '%s' "$n" >"$cfile"
      if [[ "$nth" == *'+' ]]; then
        base="${nth%+}"
        if ((n >= base)); then mode="$m"; break; fi
      elif ((n == nth)); then
        mode="$m"
        break
      fi
    fi
  done <"$CONTROL/rules"
  printf '%s' "$mode"
}

translate_path() {
  local s="$1"
  printf '%s' "${s//$SANDBOX_LOCAL/$SANDBOX_PEER}"
}
STUBLIB

  # ---- ssh ----------------------------------------------------------------
  cat >"$SB/bin/ssh" <<'SSHSTUB'
#!/usr/bin/env bash
set -u
# shellcheck disable=SC2034  # consumed by the sourced .stub-lib.sh
STUB_NAME=ssh
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/.stub-lib.sh"

host=""
declare -a cmd=()
while (($#)); do
  case "$1" in
    -i|-o|-F|-p|-l|-E|-S|-J) shift 2 ;;
    -*) shift ;;
    *) host="$1"; shift; cmd=("$@"); break ;;
  esac
done

has_stdin=0
for w in "${cmd[@]}"; do
  if [[ "$w" == "-s" ]]; then has_stdin=1; fi
done

script_file=""
text="${cmd[*]}"
if ((has_stdin)); then
  script_file="$(mktemp "$CONTROL/ssh-script.XXXXXX")"
  cat >"$script_file"
  text+=$'\n'"$(cat "$script_file")"
fi

stub_log "host=$host cmd=${cmd[*]}"
mode="$(decide_mode "$text")"
case "$mode" in
  skip:*)
    stub_log "INJECTED skip -> exit ${mode#skip:}"
    exit "${mode#skip:}"
    ;;
esac

declare -a tcmd=()
for w in "${cmd[@]}"; do
  tcmd+=("$(translate_path "$w")")
done

rc=0
if ((has_stdin)); then
  tscript="$(mktemp "$CONTROL/ssh-script-t.XXXXXX")"
  translate_path "$(cat "$script_file")" >"$tscript"
  declare -a pos=()
  seen=0
  for w in "${tcmd[@]}"; do
    # OpenSSH serializes argv into a remote shell command, so empty arguments
    # disappear unless callers replace them with an explicit sentinel.
    if ((seen)) && [[ -n "$w" ]]; then pos+=("$w"); fi
    if [[ "$w" == "--" ]]; then seen=1; fi
  done
  FAKE_REMOTE=1 bash "$tscript" "${pos[@]}"
  rc=$?
else
  FAKE_REMOTE=1 "${tcmd[@]}"
  rc=$?
fi

case "$mode" in
  after:*)
    stub_log "INJECTED after -> executed, exit ${mode#after:}"
    exit "${mode#after:}"
    ;;
esac
exit "$rc"
SSHSTUB

  # ---- rsync ----------------------------------------------------------------
  cat >"$SB/bin/rsync" <<'RSYNCSTUB'
#!/usr/bin/env bash
set -u
# shellcheck disable=SC2034  # consumed by the sourced .stub-lib.sh
STUB_NAME=rsync
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/.stub-lib.sh"

text="$*"
stub_log "$text"
mode="$(decide_mode "$text")"
case "$mode" in
  skip:*)
    stub_log "INJECTED skip -> exit ${mode#skip:}"
    exit "${mode#skip:}"
    ;;
esac

declare -a paths=()
delete=0
checksum=0
while (($#)); do
  case "$1" in
    -e) shift 2 ;;
    --delete) delete=1; shift ;;
    --checksum|-c) checksum=1; shift ;;
    --*) shift ;;
    -*) shift ;;
    *) paths+=("$1"); shift ;;
  esac
done
((${#paths[@]} >= 2)) || exit 1
dst="${paths[-1]}"
unset 'paths[-1]'

if [[ "$dst" == *@*:* ]]; then
  dst="${dst#*:}"
  dst="$(translate_path "$dst")"
fi

declare -a flags=(-a)
if ((delete)); then flags+=(--delete); fi
if ((checksum)); then flags+=(--checksum); fi
/usr/bin/rsync "${flags[@]}" "${paths[@]}" "$dst"
rc=$?

case "$mode" in
  corrupt:*)
    rel="${mode#corrupt:}"
    printf 'CORRUPTED-BY-SANDBOX' >>"${dst%/}/$rel"
    stub_log "INJECTED corrupt -> ${dst%/}/$rel"
    ;;
  after:*)
    stub_log "INJECTED after -> executed, exit ${mode#after:}"
    exit "${mode#after:}"
    ;;
esac
exit "$rc"
RSYNCSTUB

  # ---- curl -----------------------------------------------------------------
  cat >"$SB/bin/curl" <<'CURLSTUB'
#!/usr/bin/env bash
set -u
# shellcheck disable=SC2034  # consumed by the sourced .stub-lib.sh
STUB_NAME=curl
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/.stub-lib.sh"

text="$*"
url=""
out=""
head=0
resolve=""
while (($#)); do
  case "$1" in
    --resolve) resolve="$2"; shift 2 ;;
    --output|-o) out="$2"; shift 2 ;;
    --head|-I) head=1; shift ;;
    --request|-X|--header|-H|--data|--data-raw|-d) shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done

stub_log "url=$url resolve=$resolve head=$head out=$out"
mode="$(decide_mode "$text")"
case "$mode" in
  skip:*)
    stub_log "INJECTED skip -> exit ${mode#skip:}"
    exit "${mode#skip:}"
    ;;
esac

if [[ "$url" == *api.cloudflare.com*purge_cache* ]]; then
  if [[ "$mode" == purge-error ]]; then
    body='{"success":false,"errors":[{"message":"sandbox purge failure"}]}'
    stub_log "INJECTED purge-error"
  else
    body='{"success":true,"result":{"id":"sandbox"}}'
  fi
  if [[ -n "$out" ]]; then printf '%s' "$body" >"$out"; else printf '%s' "$body"; fi
  exit 0
fi

if [[ "$url" == 'http://127.0.0.1/__hj_cache_purge' ]]; then
  exit 0
fi

path="${url#*://}"
path="/${path#*/}"
path="${path%%\?*}"

if [[ "$path" == '/pages/ai/' ]]; then
  if [[ -n "$resolve" && "$resolve" == *":${PEER_ORIGIN_IP}" ]]; then
    file="$SANDBOX_PEER/public_html/src/styles/wf3/templates/public/_page_node.313"
  else
    file="$SANDBOX_LOCAL/public_html/src/styles/wf3/templates/public/_page_node.313"
  fi
  if [[ -n "$out" ]]; then cp -f -- "$file" "$out"; else cat -- "$file"; fi
  exit 0
fi

rel="${path#/chatpage/}"

if [[ -n "$resolve" && "$resolve" == *":${PEER_ORIGIN_IP}" ]]; then
  root="$(translate_path "$PUBLIC_LINK")"
else
  root="$PUBLIC_LINK"
fi

file="$root/$rel"
if [[ ! -f "$file" ]]; then
  echo "curl stub: no such file $file" >&2
  exit 22
fi

if ((head)); then
  case "$rel" in
    *.chunk.js|static/media/*) cc='public, max-age=31536000, immutable' ;;
    *) cc='no-cache, must-revalidate' ;;
  esac
  printf 'HTTP/2 200\r\ncache-control: %s\r\ncontent-type: application/octet-stream\r\n\r\n' "$cc"
else
  if [[ -n "$out" ]]; then cp -f -- "$file" "$out"; else cat -- "$file"; fi
fi
exit 0
CURLSTUB

  # ---- php ------------------------------------------------------------------
  cat >"$SB/bin/php" <<'PHPSTUB'
#!/usr/bin/env bash
set -u
# shellcheck disable=SC2034  # consumed by the sourced .stub-lib.sh
STUB_NAME=php
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/.stub-lib.sh"

text="remote=${FAKE_REMOTE:-0} cwd=$PWD $*"
stub_log "$text"
mode="$(decide_mode "$text")"
case "$mode" in
  skip:*)
    stub_log "INJECTED skip -> exit ${mode#skip:}"
    exit "${mode#skip:}"
    ;;
esac

if [[ "${1:-}" == *snapshot-xenforo-template-db.php ]]; then
  output_root="${3:-}"
  [[ -n "$output_root" ]] || exit 2
  mkdir -p "$output_root"
  cp -a "$SANDBOX_LOCAL/db-templates/." "$output_root/"
  exit 0
fi

if [[ "$*" == *"xf-designer:import-templates"* ]]; then
  designer="${@: -1}"
  case "$designer" in
    wf3) style_ids=(40 50) ;;
    wf3_domperf) style_ids=(47) ;;
    *) echo "php stub: unexpected designer mode $designer" >&2; exit 1 ;;
  esac

  templates_root="$PWD/src/styles/$designer/templates"
  node - "$templates_root" <<'NODE'
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const metadata = {};
const walk = (dir, prefix = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_metadata.') || entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, rel);
    else metadata[rel] = {
      hash: createHash('md5').update(fs.readFileSync(full)).digest('hex'),
    };
  }
};
walk(root);
fs.writeFileSync(path.join(root, '_metadata.json'), JSON.stringify(metadata, null, 2));
NODE

  for template in _page_node.313 _widget_ai_chat.html react_chat_container.html; do
    source="$templates_root/public/$template"
    hash="$(md5sum "$source" | awk '{print $1}')"
    compiled_name="${template%.html}"
    for language_id in 0 1; do
      for style_id in "${style_ids[@]}"; do
        compiled_dir="$PWD/internal_data/code_cache/templates/l$language_id/s$style_id/public"
        mkdir -p "$compiled_dir"
        {
          printf '<?php\n// FROM HASH: %s\n' "$hash"
          cat "$source"
        } >"$compiled_dir/$compiled_name.php"
      done
    done
  done

  db_templates="$SANDBOX_LOCAL/db-templates/$designer"
  mkdir -p "$db_templates"
  cp -f -- "$templates_root/public/_page_node.313" \
    "$templates_root/public/_widget_ai_chat.html" \
    "$templates_root/public/react_chat_container.html" \
    "$db_templates/"
fi
exit 0
PHPSTUB

  # ---- npm ------------------------------------------------------------------
  cat >"$SB/bin/npm" <<'NPMSTUB'
#!/usr/bin/env bash
set -u
# shellcheck disable=SC2034  # consumed by the sourced .stub-lib.sh
STUB_NAME=npm
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/.stub-lib.sh"
stub_log "$*"
mode="$(decide_mode "$*")"
case "$mode" in
  skip:*) exit "${mode#skip:}" ;;
esac
exit 0
NPMSTUB

  # ---- redis-cli -----------------------------------------------------------
  cat >"$SB/bin/redis-cli" <<'REDISSTUB'
#!/usr/bin/env bash
set -u
STUB_NAME=redis-cli
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/.stub-lib.sh"
text="remote=${FAKE_REMOTE:-0} $*"
stub_log "$text"
mode="$(decide_mode "$text")"
case "$mode" in
  skip:*) exit "${mode#skip:}" ;;
esac
printf 'OK\n'
REDISSTUB

  chmod 755 "$SB/bin/ssh" "$SB/bin/rsync" "$SB/bin/curl" "$SB/bin/php" "$SB/bin/npm" "$SB/bin/redis-cli"
}

# add_rule <cmd> <nth[.+]> <mode> <extended-regex>
add_rule() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$CONTROL/rules"
}

clear_rules() {
  : >"$CONTROL/rules"
  rm -f -- "$CONTROL"/.count.* 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Running deploy.sh
# ---------------------------------------------------------------------------

RT_LAST_OUTPUT=""

# run_deploy [command...] — returns deploy.sh's exit code; output captured in
# $RT_LAST_OUTPUT and echoed to the test log.
run_deploy() {
  local rc=0
  RT_LAST_OUTPUT="$(bash "$SB/app/deploy.sh" "$@" 2>&1)" || rc=$?
  printf -- '--- deploy.sh %s (rc=%s) ---\n%s\n---\n' "${*:-deploy}" "$rc" "$RT_LAST_OUTPUT"
  return "$rc"
}

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

assert_eq() {
  [[ "$1" == "$2" ]] || fail_test "${3:-values differ}: expected [$2], got [$1]"
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail_test "${3:-missing substring}: [$2] not found"
}

assert_link_target() {
  local link="$1" expected="$2"
  [[ -L "$link" ]] || fail_test "$link is not a symlink"
  assert_eq "$(readlink -f -- "$link")" "$(readlink -f -- "$expected")" "$link target"
}

assert_plain_dir() {
  local path="$1"
  [[ ! -L "$path" ]] || fail_test "$path is a symlink, expected a plain directory"
  [[ -d "$path" ]] || fail_test "$path is not a directory"
}

assert_absent() {
  [[ ! -e "$1" && ! -L "$1" ]] || fail_test "$1 should not exist"
}

assert_exists() {
  [[ -e "$1" ]] || fail_test "$1 should exist"
}

assert_no_next_litter() {
  local litter
  litter="$(find "$SB/local" "$SB/peer" -name '*.next.*' 2>/dev/null || true)"
  [[ -z "$litter" ]] || fail_test "leftover .next.* litter: $litter"
}

state_field() {
  node -e '
    const fs = require("node:fs");
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = state[process.argv[2]];
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$STATE_FILE" "$1"
}

assert_state() {
  local expected_phase="$1" expected_status="$2"
  [[ -f "$STATE_FILE" ]] || fail_test "state file $STATE_FILE is missing"
  assert_eq "$(state_field phase)" "$expected_phase" "state phase"
  assert_eq "$(state_field status)" "$expected_status" "state status"
}

# assert_templates_match_bundle <bundle_root> — live styles on BOTH nodes must
# equal the given bundle ($bundle_root/<style>/<template>).
assert_templates_match_bundle() {
  local bundle_root="$1" style template
  for style in wf3 wf3_domperf; do
    for template in _page_node.313 _widget_ai_chat.html react_chat_container.html; do
      cmp -s "$bundle_root/$style/$template" \
        "$XENFORO_STYLES_ROOT/$style/templates/public/$template" \
        || fail_test "local $style/$template does not match bundle $bundle_root"
      cmp -s "$bundle_root/$style/$template" \
        "$PEER_STYLES_ROOT/$style/templates/public/$template" \
        || fail_test "peer $style/$template does not match bundle $bundle_root"
    done
  done
}

assert_fake_db_matches_bundle() {
  local bundle_root="$1" style template
  for style in wf3 wf3_domperf; do
    for template in _page_node.313 _widget_ai_chat.html react_chat_container.html; do
      cmp -s "$bundle_root/$style/$template" \
        "$SANDBOX_LOCAL/db-templates/$style/$template" \
        || fail_test "database $style/$template does not match bundle $bundle_root"
    done
  done
}

current_release() {
  readlink -f -- "$PUBLIC_LINK"
}

peer_current_release() {
  readlink -f -- "$PEER_PUBLIC_LINK"
}

# to_peer_path <local path> — the peer-tree equivalent of a local-tree path.
to_peer_path() {
  printf '%s' "${1//$SANDBOX_LOCAL/$SANDBOX_PEER}"
}

stub_calls() {
  local cmd="$1" pattern="${2:-.}"
  if [[ -f "$CONTROL/log.$cmd" ]]; then
    grep -Ec -- "$pattern" "$CONTROL/log.$cmd" || true
  else
    printf '0'
  fi
}

# Verify a release inventory in-place (same semantics as deploy.sh).
check_inventory() {
  local dir="$1"
  (cd "$dir" && sha256sum --check --quiet RELEASE-INVENTORY.sha256)
}
