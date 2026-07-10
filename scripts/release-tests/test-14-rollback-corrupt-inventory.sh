#!/usr/bin/env bash
# Corrupt rollback artifacts: if the recorded previous release fails its
# SHA-256 inventory (locally or on the peer), rollback refuses before
# switching anything.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "deploy 1 failed"
r1="$(current_release)"
mutate_dist "build-2"
run_deploy || fail_test "deploy 2 failed"
r2="$(current_release)"

# --- corrupt the LOCAL copy of the previous release ---
cp "$r1/static/js/main.js" "$SB/main.js.orig"
printf 'TAMPERED' >>"$r1/static/js/main.js"

rc=0
run_deploy rollback || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "rollback should refuse a corrupt previous release"
assert_contains "$RT_LAST_OUTPUT" "inventory" "refusal mentions the inventory"

# Nothing switched anywhere; templates untouched
assert_link_target "$PUBLIC_LINK" "$r2"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r2")"
assert_templates_match_bundle "$r2/xenforo-templates"
assert_eq "$(state_field action)" rollback "state action"
assert_eq "$(state_field status)" failed "state status"
assert_no_next_litter

# --- corrupt only the PEER copy of the previous release ---
cp "$SB/main.js.orig" "$r1/static/js/main.js"
check_inventory "$r1" || fail_test "local un-tamper failed; test setup bug"
printf 'TAMPERED' >>"$(to_peer_path "$r1")/static/js/main.js"

rc=0
run_deploy rollback || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "rollback should refuse a corrupt PEER previous release"
assert_contains "$RT_LAST_OUTPUT" "peer previous-release verification failed" "peer refusal message"
assert_link_target "$PUBLIC_LINK" "$r2"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r2")"
assert_no_next_litter
echo "OK"
