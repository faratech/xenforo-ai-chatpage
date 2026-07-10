#!/usr/bin/env bash
# Fresh-link failure: the very first deploy fails after both switches. Since
# no previous target existed, the created links must be UNLINKED on both
# hosts, not left dangling.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

add_rule php 1 skip:1 'sync-templates'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "first deploy should have failed at template sync"

assert_absent "$PUBLIC_LINK"
assert_absent "$PEER_PUBLIC_LINK"
assert_contains "$RT_LAST_OUTPUT" "Unlinked freshly created" "fresh unlink message"
assert_state remote-switched rolled-back
assert_eq "$(state_field fresh_local)" true "fresh_local"
assert_eq "$(state_field fresh_remote)" true "fresh_remote"
assert_no_next_litter
echo "OK"
