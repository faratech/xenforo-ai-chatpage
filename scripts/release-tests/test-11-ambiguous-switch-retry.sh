#!/usr/bin/env bash
# SSH connection refused BEFORE the peer switch took effect (rc=255, no
# effect): the probe reports "not-switched", the switch is retried once, and
# the deploy completes.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
add_rule ssh 1 skip:255 'wf-peer-switch'

run_deploy || fail_test "deploy should retry a never-applied peer switch"
r2="$(current_release)"
[[ "$r2" != "$r1" ]] || fail_test "no new release was activated"

assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r2")"
assert_contains "$RT_LAST_OUTPUT" "the switch never happened; retrying once" "retry message"
assert_state complete complete
assert_no_next_litter
echo "OK"
