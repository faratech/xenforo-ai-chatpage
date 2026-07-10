#!/usr/bin/env bash
# Failure injected before any switch (peer staging verification fails):
# nothing is switched on either host, state records the failure, no litter.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
add_rule ssh 1 skip:1 'wf-peer-stage-verify'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at peer staging"

# Both hosts still serve the previous release; templates untouched
assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$r1/xenforo-templates"
assert_state staged failed
assert_no_next_litter
echo "OK"
