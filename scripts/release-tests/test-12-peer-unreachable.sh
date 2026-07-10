#!/usr/bin/env bash
# The peer becomes entirely unreachable at the switch (switch, probes, and all
# later peer SSH fail with 255): the deploy aborts, restores the local link,
# and records that the peer state is unknown for manual reconciliation.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
add_rule ssh 1+ skip:255 'wf-peer-switch'
add_rule ssh 1+ skip:255 'wf-peer-probe'
add_rule ssh 1+ skip:255 'wf-peer-restore'
add_rule ssh 1+ skip:255 'wf-peer-sync-templates'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have aborted with the peer unreachable"

# Local restored; peer never switched, so it still serves r1.
assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"

assert_contains "$RT_LAST_OUTPUT" "Peer became unreachable mid-switch" "unreachable abort message"
assert_eq "$(state_field status)" rollback-incomplete "state status"
note="$(state_field note)"
assert_contains "$note" "peer unreachable" "state note mentions the unknown peer state"
assert_no_next_litter
echo "OK"
