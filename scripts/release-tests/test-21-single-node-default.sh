#!/usr/bin/env bash
# Current production topology: a bare deploy must take the checked single-node
# path and must not require an unavailable peer.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

unset DEPLOY_SINGLE_NODE
rc=0
output="$(bash "$SB/app/deploy.sh" 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail_test "default single-node deploy failed: $output"

local_release="$(current_release)"
[[ -d "$local_release" ]] || fail_test "local release dir missing"
assert_link_target "$PUBLIC_LINK" "$local_release"
assert_absent "$PEER_PUBLIC_LINK"
assert_eq "$(stub_calls ssh 'remote=1')" 0 "peer ssh calls"
assert_eq "$(stub_calls rsync 'remote=1')" 0 "peer rsync calls"
assert_eq "$(stub_calls php 'remote=0 .*import-templates')" 2 "local designer imports"
assert_eq "$(stub_calls curl 'purge_cache')" 1 "purge calls"
assert_no_next_litter
echo "OK"
