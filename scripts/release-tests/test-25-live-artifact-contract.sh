#!/usr/bin/env bash
# Forward activation must verify every current PWA/stable artifact and every
# emitted hashed JS/CSS/media artifact on both origins and the public edge.
# It must also reject missing artifacts, wrong cache policy, a missing worker
# scope header, and a divergent public lazy chunk.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

# Cloudflare can append a managed challenge bootstrap to HTML for the deploy
# probe while leaving the shipped application contract intact. This must not
# weaken byte-for-byte verification for non-HTML assets.
clear_rules
add_rule curl 1+ edge-html-challenge \
  '--resolve windowsforum\.com:443:203\.0\.113\.10 .*\/(index|offline)\.html.*--output'
run_deploy || fail_test "deploy should accept Cloudflare-injected HTML with an intact release contract"
r1="$(current_release)"

# The HTML exception remains fail-closed when a required app-shell marker is
# actually absent at the public edge.
clear_rules
add_rule curl 1+ invalid-html-contract \
  '--resolve windowsforum\.com:443:203\.0\.113\.10 .*\/index\.html.*--output'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should reject a broken public index contract"
assert_contains "$RT_LAST_OUTPUT" "did not satisfy the activated release HTML contract" "public index contract failure"
assert_link_target "$PUBLIC_LINK" "$r1"

assert_probe() {
  local relative="$1" query="$2" origin_ip="$3" head="$4"
  local expected="url=$LIVE_ORIGIN/chatpage/$relative$query resolve=windowsforum.com:443:$origin_ip head=$head"
  grep -Fq -- "$expected" "$CONTROL/log.curl" \
    || fail_test "missing live probe: $expected"
}

stable_artifacts=(
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

mapfile -d '' -t hashed_files < <(
  {
    find "$DIST_DIR/static/js" -maxdepth 1 -type f -name '*.js' ! -name main.js -print0
    find "$DIST_DIR/static/css" -maxdepth 1 -type f -name '*.css' ! -name main.css -print0
    find "$DIST_DIR/static/media" -type f -print0
  } | sort -z
)

for relative in "${stable_artifacts[@]}"; do
  for origin_ip in "$ORIGIN_IP" "$PEER_ORIGIN_IP" "$PUBLIC_EDGE_IP"; do
    assert_probe "$relative" '?v=2' "$origin_ip" 0
    assert_probe "$relative" '?v=2' "$origin_ip" 1
  done
done

for file in "${hashed_files[@]}"; do
  relative="${file#"$DIST_DIR/"}"
  for origin_ip in "$ORIGIN_IP" "$PEER_ORIGIN_IP" "$PUBLIC_EDGE_IP"; do
    assert_probe "$relative" '?v=2' "$origin_ip" 0
    assert_probe "$relative" '' "$origin_ip" 1
  done
done

# service-worker.js receives an additional unversioned HEAD probe for the
# Service-Worker-Allowed contract on every surface.
for origin_ip in "$ORIGIN_IP" "$PEER_ORIGIN_IP" "$PUBLIC_EDGE_IP"; do
  assert_probe service-worker.js '' "$origin_ip" 1
done

# A required current PWA icon cannot disappear between build and staging.
mv "$DIST_DIR/pwa-icon-512.png" "$DIST_DIR/pwa-icon-512.png.held"
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should reject a missing required PWA icon"
assert_link_target "$PUBLIC_LINK" "$r1"
mv "$DIST_DIR/pwa-icon-512.png.held" "$DIST_DIR/pwa-icon-512.png"

# Stable/PWA files must remain revalidated rather than immutable.
clear_rules
add_rule curl 1 bad-cache '--head .*manifest\.json'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should reject a wrong manifest cache policy"
assert_contains "$RT_LAST_OUTPUT" "missing the expected response header" "manifest cache failure"
assert_link_target "$PUBLIC_LINK" "$r1"

# Every hashed artifact must retain the immutable cache contract.
clear_rules
add_rule curl 1 bad-cache '--head .*theme-sandbox1\.css'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should reject a wrong hashed CSS cache policy"
assert_contains "$RT_LAST_OUTPUT" "missing the expected response header" "hashed cache failure"
assert_link_target "$PUBLIC_LINK" "$r1"

# Canonical /pages/ai/ registration must be explicitly permitted by the
# worker response on origins and at the edge.
clear_rules
add_rule curl 1 missing-sw-scope '--head .*service-worker\.js$'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should reject a missing service-worker scope header"
assert_contains "$RT_LAST_OUTPUT" "service-worker-allowed" "worker scope failure"
assert_link_target "$PUBLIC_LINK" "$r1"

# A single divergent public lazy chunk must fail the full-graph hash gate.
clear_rules
add_rule curl 1+ corrupt-body \
  '--resolve windowsforum\.com:443:203\.0\.113\.10 .*ChatWindow-sandbox1\.chunk\.js.*--output'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should reject a divergent public lazy chunk"
assert_contains "$RT_LAST_OUTPUT" "did not converge" "public lazy chunk hash failure"
assert_link_target "$PUBLIC_LINK" "$r1"

assert_no_next_litter
echo "OK"
