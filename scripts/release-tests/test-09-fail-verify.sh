#!/usr/bin/env bash
# Live verification fails after everything switched: full restore including
# templates, re-purge, and a successful re-verification of the previous state.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
# First origin fetch of main.js during forward verification fails cleanly.
add_rule curl 1 skip:22 'chatpage/static/js/main\.js'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at live verification"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$r1/xenforo-templates"
assert_state purged rolled-back
assert_contains "$RT_LAST_OUTPUT" "Re-verified the restored release" "restore re-verification"
assert_no_next_litter
echo "OK"
