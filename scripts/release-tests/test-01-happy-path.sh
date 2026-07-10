#!/usr/bin/env bash
# Happy path: fresh first deploy (no PUBLIC_LINK yet), then a second deploy.
# Asserts symlinks on both hosts, inventories, bundled templates, designer
# syncs on both nodes, purge, previous pointers (per host), state file, and
# absence of .next.* litter.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

# --- deploy 1 (fresh: PUBLIC_LINK absent on both hosts) ---
run_deploy || fail_test "first deploy failed"
r1="$(current_release)"
[[ -d "$r1" ]] || fail_test "release dir missing"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_state complete complete
assert_eq "$(state_field action)" deploy "state action"
assert_eq "$(state_field fresh_local)" true "fresh_local"
assert_eq "$(state_field fresh_remote)" true "fresh_remote"

# Inventories present and valid on both hosts
check_inventory "$r1" || fail_test "local inventory invalid"
check_inventory "$(to_peer_path "$r1")" || fail_test "peer inventory invalid"

# Template bundle staged into the release and applied
assert_exists "$r1/xenforo-templates/wf3/_page_node.313"
assert_exists "$r1/xenforo-templates/wf3_domperf/react_chat_container.html"
assert_templates_match_bundle "$r1/xenforo-templates"

# Designer sync ran on both nodes (2 styles x 2 nodes)
assert_eq "$(stub_calls php 'remote=0 .*sync-templates')" 2 "local designer syncs"
assert_eq "$(stub_calls php 'remote=1 .*sync-templates')" 2 "peer designer syncs"
assert_eq "$(stub_calls curl 'purge_cache')" 1 "purge calls"

# Fresh deploy records no previous pointer
assert_absent "$RELEASE_ROOT/previous"
assert_absent "$PEER_RELEASE_ROOT/previous"
assert_no_next_litter

# --- deploy 2 ---
mutate_dist "build-2"
mutate_styles "v2"
run_deploy || fail_test "second deploy failed"
r2="$(current_release)"
[[ "$r2" != "$r1" ]] || fail_test "second deploy did not produce a new release"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r2")"
assert_state complete complete

# Previous pointers are per host and point at each host's own prior release
assert_link_target "$RELEASE_ROOT/previous" "$r1"
assert_link_target "$PEER_RELEASE_ROOT/previous" "$(to_peer_path "$r1")"

# The new bundle (v2 templates) is live on both nodes
assert_templates_match_bundle "$r2/xenforo-templates"
grep -q 'v2' "$XENFORO_STYLES_ROOT/wf3/templates/public/react_chat_container.html" \
  || fail_test "live template does not carry the v2 payload"

# Live content converged to the new build on both origins
cmp -s "$r2/static/js/main.js" "$PUBLIC_LINK/static/js/main.js" \
  || fail_test "local live main.js is not the new build"
cmp -s "$r2/static/js/main.js" "$PEER_PUBLIC_LINK/static/js/main.js" \
  || fail_test "peer live main.js is not the new build"

assert_no_next_litter
echo "OK"
