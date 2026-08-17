#!/usr/bin/env bash
# Rollback: assets AND the rolled-back release's template bundle go live on
# both nodes, designer import re-runs, Cloudflare is purged, previous pointers
# flip to the rolled-back-from release on each host.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "deploy 1 failed"
r1="$(current_release)"

mutate_dist "build-2"
mutate_styles "v2"
run_deploy || fail_test "deploy 2 failed"
r2="$(current_release)"

# v2 templates are live now
grep -q 'v2' "$XENFORO_STYLES_ROOT/wf3/templates/public/react_chat_container.html" \
  || fail_test "v2 templates should be live before rollback"

imports_before="$(stub_calls php 'import-templates')"
purges_before="$(stub_calls curl 'purge_cache')"

run_deploy rollback || fail_test "rollback failed"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"

# r1's template bundle (v1) was applied on both nodes and re-imported
assert_templates_match_bundle "$(release_bundle "$r1")"
grep -q 'v1' "$XENFORO_STYLES_ROOT/wf3/templates/public/react_chat_container.html" \
  || fail_test "rollback did not restore the v1 templates"
grep -q 'v1' "$PEER_STYLES_ROOT/wf3/templates/public/react_chat_container.html" \
  || fail_test "rollback did not restore the v1 templates on the peer"
[[ "$(stub_calls php 'import-templates')" -gt "$imports_before" ]] \
  || fail_test "designer import did not run during rollback"
[[ "$(stub_calls curl 'purge_cache')" -gt "$purges_before" ]] \
  || fail_test "Cloudflare was not purged during rollback"

# Previous pointers now record the rolled-back-from release, per host
assert_link_target "$RELEASE_ROOT/previous" "$r2"
assert_link_target "$PEER_RELEASE_ROOT/previous" "$(to_peer_path "$r2")"

assert_state complete complete
assert_eq "$(state_field action)" rollback "state action"
assert_no_next_litter
echo "OK"
