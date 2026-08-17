#!/usr/bin/env bash
# Cloudflare purge fails after switches and template import: full restore,
# re-purge succeeds, restored state re-verifies.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
add_rule curl 1 skip:22 'purge_cache'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at the purge"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$(release_bundle "$r1")"

# purge attempts: baseline 1 + failed forward 1 + rollback re-purge 1 = 3
assert_eq "$(stub_calls curl 'purge_cache')" 3 "purge attempts"
assert_state templates-synced rolled-back
assert_contains "$RT_LAST_OUTPUT" "Re-verified the restored release" "restore re-verification"
assert_no_next_litter
echo "OK"
