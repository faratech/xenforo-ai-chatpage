#!/usr/bin/env bash
# Template designer sync fails after both switches: both links restored, the
# snapshotted templates re-applied and re-synced, Cloudflare re-purged, and
# the restored state re-verified.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
mutate_styles "v2"
add_rule php 1 skip:1 'sync-templates'

syncs_before="$(stub_calls php 'sync-templates')"
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at template sync"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"

# The snapshot (v2 sources, since staging snapshots the live tree) was restored
# and the designer sync re-ran during rollback.
snapshot="$(state_field template_snapshot)"
[[ -n "$snapshot" && -d "$snapshot" ]] || fail_test "template snapshot missing from state"
assert_templates_match_bundle "$snapshot"
syncs_after="$(stub_calls php 'sync-templates')"
[[ "$syncs_after" -gt $((syncs_before + 1)) ]] || fail_test "designer sync did not re-run during rollback"

assert_state remote-switched rolled-back
assert_contains "$RT_LAST_OUTPUT" "Re-verified the restored release" "restore re-verification"
assert_no_next_litter
echo "OK"
