#!/usr/bin/env bash
# A Cloudflare purge acknowledgement may precede edge convergence. Rollback
# gets a longer bounded exact-hash window, but persistent divergence must still
# leave the transaction marked rollback-incomplete.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

# Keep this scenario fast while proving rollback uses its distinct, longer
# bound: two ordinary attempts versus four restoration attempts.
export DEPLOY_PUBLIC_RETRY_ATTEMPTS=2
export DEPLOY_ROLLBACK_PUBLIC_RETRY_ATTEMPTS=4

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

origin_index='--resolve windowsforum\.com:443:127\.0\.0\.1 .*\/index\.html.*--output'
edge_main='--resolve windowsforum\.com:443:203\.0\.113\.10 .*\/static/js/main\.js.*--output'
edge_main_log='url=https://windowsforum\.com/chatpage/static/js/main\.js\?v=2 resolve=windowsforum\.com:443:203\.0\.113\.10 head=0'

# Abort forward verification before it probes public main.js. During restore,
# make the first two edge responses stale; the third exact response must turn
# the recovery state into rolled-back rather than rollback-incomplete.
mutate_dist "build-2"
clear_rules
add_rule curl 1 skip:22 "$origin_index"
add_rule curl 1 corrupt-body "$edge_main"
add_rule curl 1 corrupt-body "$edge_main"
edge_calls_before="$(stub_calls curl "$edge_main_log")"

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "the forward deployment should have failed"

edge_calls_after="$(stub_calls curl "$edge_main_log")"
assert_eq "$((edge_calls_after - edge_calls_before))" 3 "rollback edge convergence probes"
assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$(release_bundle "$r1")"
assert_state purged rolled-back
assert_contains "$RT_LAST_OUTPUT" "Re-verified the restored release" "late rollback convergence"

# The longer grace window remains fail-closed: an edge that never returns the
# restored bytes exhausts the configured bound and requires reconciliation.
mutate_dist "build-3"
clear_rules
add_rule curl 1 skip:22 "$origin_index"
add_rule curl 1+ corrupt-body "$edge_main"
edge_calls_before="$(stub_calls curl "$edge_main_log")"

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "persistent rollback edge divergence should fail"

edge_calls_after="$(stub_calls curl "$edge_main_log")"
assert_eq "$((edge_calls_after - edge_calls_before))" 4 "bounded rollback edge probes"
assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_templates_match_bundle "$(release_bundle "$r1")"
assert_state purged rollback-incomplete
assert_eq "$(state_field note)" reverify-failed "rollback failure note"
assert_contains "$RT_LAST_OUTPUT" "Public static/js/main.js did not converge" "persistent edge divergence"
assert_no_next_litter
echo "OK"
