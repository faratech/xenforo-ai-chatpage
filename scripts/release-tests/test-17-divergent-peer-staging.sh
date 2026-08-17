#!/usr/bin/env bash
# Divergent peer inventories: the peer's staged release differs from the local
# one. Staging verification must fail BEFORE any switch happens anywhere.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
# The next release rsync silently corrupts main.js on the peer side.
add_rule rsync 1 corrupt:static/js/main.js '/releases/'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed on divergent peer inventories"
assert_contains "$RT_LAST_OUTPUT" "Peer release staging verification failed" "divergence error"

# No switch happened on either host
assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$(release_bundle "$r1")"
assert_state staged failed
assert_no_next_litter
echo "OK"
