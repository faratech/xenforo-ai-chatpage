#!/usr/bin/env bash
# Production deploys must fail before staging when either PHP lint or the
# backend predicate regression suite fails.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

missing_contract="$SB/missing-chat-product-contract.php"
export BACKEND_PRODUCT_CONTRACT_FILE="$missing_contract"
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should fail when a required backend helper is missing"
assert_contains "$RT_LAST_OUTPUT" "Required chat backend PHP file is missing" "missing helper gate failure"
assert_absent "$PUBLIC_LINK"
unset BACKEND_PRODUCT_CONTRACT_FILE

mv "$SANDBOX_LOCAL/tests/test_chat_product_contract.php" "$SANDBOX_LOCAL/tests/test_chat_product_contract.php.held"
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should fail when a required backend test is missing"
assert_contains "$RT_LAST_OUTPUT" "Required backend product contract test is missing" "missing test gate failure"
assert_absent "$PUBLIC_LINK"
assert_state started failed
mv "$SANDBOX_LOCAL/tests/test_chat_product_contract.php.held" "$SANDBOX_LOCAL/tests/test_chat_product_contract.php"

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
add_rule php 1 skip:1 'test_chat_product_contract\.php'
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should fail when backend product contract tests fail"
assert_contains "$RT_LAST_OUTPUT" "Backend product contract tests failed" "product contract gate failure"
assert_absent "$PUBLIC_LINK"
assert_state started failed

clear_rules
run_deploy || fail_test "deploy should pass after backend gates recover"
assert_state complete complete
echo "OK"
