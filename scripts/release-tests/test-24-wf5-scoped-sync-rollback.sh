#!/usr/bin/env bash
# A failure during the peer's scoped WF5/style-51 sync must restore the
# authoritative database/compiled templates on both nodes while preserving the
# pending designer sources for a later retry.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"
b1="$(release_bundle "$r1")"

mutate_dist "build-2"
mutate_styles "v2"
add_rule php 1 skip:1 'remote=1 .*wf-chat-wf5-sync'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should fail during the peer scoped WF5 sync"
assert_contains "$RT_LAST_OUTPUT" "Peer scoped WF5 chat template sync failed" "scoped WF5 failure"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_fake_db_matches_bundle "$b1"
cmp -s "$b1/wf5/_page_node.313" "$XENFORO_ROOT/db-style-51/_page_node.313" \
  || fail_test "local compiled style 51 was not rolled back"
cmp -s "$b1/wf5/_page_node.313" "$SANDBOX_PEER/public_html/db-style-51/_page_node.313" \
  || fail_test "peer compiled style 51 was not rolled back"
grep -q 'v2' "$XENFORO_STYLES_ROOT/wf5/templates/public/_page_node.313" \
  || fail_test "local pending WF5 source was destroyed"
grep -q 'v2' "$PEER_STYLES_ROOT/wf5/templates/public/_page_node.313" \
  || fail_test "peer pending WF5 source was destroyed"
assert_state remote-switched rolled-back
assert_no_next_litter
echo "OK"
