#!/usr/bin/env bash
# Pruning resolves current/previous per host and prunes each host with its own
# keep-set: host-only stale releases are removed by that host's own logic.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "deploy 1 failed"
r1="$(current_release)"
mutate_dist "build-2"
run_deploy || fail_test "deploy 2 failed"
r2="$(current_release)"

# Stale releases that exist on only one host each
mkdir -p "$RELEASE_ROOT/00000000T000000Z-old-a" "$RELEASE_ROOT/00000000T000000Z-old-b"
mkdir -p "$PEER_RELEASE_ROOT/00000000T000000Z-old-c"
mkdir -p "$DEPLOY_PRIVATE_ROOT/00000000T000000Z-old-a" "$DEPLOY_PRIVATE_ROOT/00000000T000000Z-old-b"
mkdir -p "$PEER_PRIVATE_ROOT/00000000T000000Z-old-c"
touch -d '2020-01-01 00:00:00' \
  "$RELEASE_ROOT/00000000T000000Z-old-a" \
  "$RELEASE_ROOT/00000000T000000Z-old-b" \
  "$PEER_RELEASE_ROOT/00000000T000000Z-old-c"

export RETAIN_RELEASES=1
mutate_dist "build-3"
run_deploy || fail_test "deploy 3 failed"
r3="$(current_release)"

# Keep-sets: current (r3) + previous (r2) + RETAIN_RELEASES=1 extra (r1).
assert_exists "$r3"
assert_exists "$r2"
assert_exists "$r1"
assert_absent "$RELEASE_ROOT/00000000T000000Z-old-a"
assert_absent "$RELEASE_ROOT/00000000T000000Z-old-b"
assert_absent "$DEPLOY_PRIVATE_ROOT/00000000T000000Z-old-a"
assert_absent "$DEPLOY_PRIVATE_ROOT/00000000T000000Z-old-b"

assert_exists "$(to_peer_path "$r3")"
assert_exists "$(to_peer_path "$r2")"
assert_exists "$(to_peer_path "$r1")"
assert_absent "$PEER_RELEASE_ROOT/00000000T000000Z-old-c"
assert_absent "$PEER_PRIVATE_ROOT/00000000T000000Z-old-c"

# The recovery area is never pruned as a release
assert_exists "$RELEASE_ROOT/.recovery"
assert_state complete complete
assert_no_next_litter
echo "OK"
