#!/usr/bin/env bash
# Retired style source directories must not block or receive a live deployment.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox
export WF_CHAT_TEST_STYLE_MANIFEST='{"styles":{"wf3":40},"existing":[17,40,50]}'
export DEPLOY_SINGLE_NODE=1
output="$(bash "$SB/app/deploy.sh" 2>&1)" || fail_test "live-style deploy failed: $output"
first="$(current_release)"
assert_eq "$(stub_calls php 'sync-xenforo-style-wide.php .* wf3_domperf')" 0 "retired style imports"
assert_eq "$(stub_calls php 'sync-xenforo-db-style.php .* 51 bootstrap')" 0 "retired WF5 imports"
output="$(bash "$SB/app/deploy.sh" 2>&1)" || fail_test "second deploy failed: $output"
output="$(bash "$SB/app/deploy.sh" rollback 2>&1)" || fail_test "live-style rollback failed: $output"
assert_link_target "$PUBLIC_LINK" "$first"
assert_eq "$(stub_calls php 'sync-xenforo-style-wide.php .* wf3_domperf')" 0 "retired style rollback imports"
assert_eq "$(stub_calls php 'sync-xenforo-db-style.php .* 51 bootstrap')" 0 "retired WF5 rollback imports"
echo OK
