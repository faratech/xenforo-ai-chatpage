#!/usr/bin/env bash
# Production deploys must fail before staging when either PHP lint or the
# backend predicate regression suite fails.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

add_rule php 1 skip:1 ' -l .*/chat\.php'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should fail when backend PHP lint fails"
assert_contains "$RT_LAST_OUTPUT" "PHP lint failed" "lint gate failure"
assert_absent "$PUBLIC_LINK"
assert_state started failed

clear_rules
add_rule php 1 skip:1 'test_chat_predicates\.php'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should fail when backend predicate tests fail"
assert_contains "$RT_LAST_OUTPUT" "Backend predicate tests failed" "predicate gate failure"
assert_absent "$PUBLIC_LINK"
assert_state started failed

clear_rules
run_deploy || fail_test "deploy should pass after backend gates recover"
assert_state complete complete
echo "OK"
