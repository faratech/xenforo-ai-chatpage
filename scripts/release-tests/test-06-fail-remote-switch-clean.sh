#!/usr/bin/env bash
# The peer switch fails with a clean nonzero exit: local is rolled back,
# peer stays on the previous release, restored state re-verifies.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
add_rule ssh 1 skip:1 'wf-peer-switch'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at the peer switch"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$r1/xenforo-templates"
assert_state remote-prepared rolled-back
assert_contains "$RT_LAST_OUTPUT" "Peer symlink switch failed" "peer switch error"
assert_no_next_litter
echo "OK"
