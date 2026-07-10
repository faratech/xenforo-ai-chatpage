#!/usr/bin/env bash
# A second deploy while the lock is held must fail fast with a clear error and
# must not touch releases or the state file.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

mkdir -p "$RELEASE_ROOT"
lock_file="$RELEASE_ROOT/.deploy.lock"

# Hold the deploy lock from a background process.
(
  exec 9>"$lock_file"
  flock 9
  sleep 30
) &
holder=$!
# Wait until the holder actually owns the lock.
for _ in $(seq 1 50); do
  if ! flock -n "$lock_file" true 2>/dev/null; then break; fi
  sleep 0.1
done

rc=0
run_deploy || rc=$?
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true

[[ "$rc" -ne 0 ]] || fail_test "deploy succeeded while the lock was held"
assert_contains "$RT_LAST_OUTPUT" "Another deployment is already running" "lock error message"

# Nothing was staged, no state written, no links created
assert_absent "$STATE_FILE"
assert_absent "$PUBLIC_LINK"
assert_absent "$PEER_PUBLIC_LINK"
releases="$(find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -not -name '.*' | wc -l)"
assert_eq "$releases" 0 "release dirs created under lock contention"
assert_no_next_litter
echo "OK"
