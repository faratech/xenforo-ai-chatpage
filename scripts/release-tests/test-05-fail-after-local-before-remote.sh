#!/usr/bin/env bash
# Failure between the local switch and the remote switch (peer prepare fails
# cleanly): the local symlink is restored, the peer is untouched, templates
# are restored, Cloudflare is re-purged, and the restored state re-verifies.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
add_rule ssh 1 skip:1 'wf-peer-prepare'

purges_before="$(stub_calls curl 'purge_cache')"
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at peer prepare"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$(release_bundle "$r1")"
assert_state local-switched rolled-back

# The failure path re-purged and re-verified the restored release
purges_after="$(stub_calls curl 'purge_cache')"
[[ "$purges_after" -gt "$purges_before" ]] || fail_test "no re-purge during rollback"
assert_contains "$RT_LAST_OUTPUT" "Re-verified the restored release" "restore re-verification"
assert_no_next_litter
echo "OK"
