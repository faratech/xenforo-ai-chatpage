#!/usr/bin/env bash
# A dirty worktree refuses to deploy; DEPLOY_ALLOW_DIRTY=1 overrides loudly.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

echo "# local hack" >>"$SB/app/deploy.sh"

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy succeeded from a dirty worktree"
assert_contains "$RT_LAST_OUTPUT" "Worktree is dirty" "dirty refusal message"
assert_absent "$PUBLIC_LINK"
assert_absent "$PEER_PUBLIC_LINK"
assert_state started failed

# Override works and is logged loudly
DEPLOY_ALLOW_DIRTY=1 run_deploy || fail_test "DEPLOY_ALLOW_DIRTY=1 deploy failed"
assert_contains "$RT_LAST_OUTPUT" "DEPLOY_ALLOW_DIRTY=1" "loud dirty override warning"
assert_state complete complete
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$(current_release)")"
assert_no_next_litter
echo "OK"
