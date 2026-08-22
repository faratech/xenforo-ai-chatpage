#!/usr/bin/env bash
# Failure-injection test harness for deploy.sh.
#
#   bash scripts/run-release-tests.sh [test-name-filter ...]
#
# Runs every scripts/release-tests/test-*.sh in an isolated sandbox (temp
# dirs + stubbed ssh/rsync/curl/php/npm), prints per-test PASS/FAIL, and
# exits nonzero if any test fails. Dependency-free: bash + coreutils + node.

set -u

# The real deploy command may carry topology/path/retry overrides. Sandbox
# scenarios set their own overrides deliberately and must never inherit the
# caller's production values - a stray DEPLOY_LOCK_FILE or PEER_SSH_KEY from a
# wrapper script used to leak into every sandbox test. Mirrors the full
# ${VAR:-default} list in deploy.sh.
for _override in \
  BACKEND_PRODUCT_CONTRACT_FILE BACKEND_PRODUCT_MIGRATION_FILE \
  BACKEND_PRODUCT_PRUNER_FILE BACKEND_PRODUCT_TEST_FILE BACKEND_TEST_FILE \
  CLOUDFLARE_ENV_FILE CLOUDFLARE_PURGE_TOKEN CLOUDFLARE_ZONE_ID \
  DEPLOY_ALLOW_DIRTY DEPLOY_LOCK_FILE DEPLOY_OWNER DEPLOY_PRIVATE_ROOT \
  DEPLOY_PROBE_ATTEMPTS DEPLOY_PUBLIC_RETRY_ATTEMPTS DEPLOY_PUBLIC_RETRY_DELAY \
  DEPLOY_RECOVERY_ROOT DEPLOY_RETRY_DELAY DEPLOY_ROLLBACK_PUBLIC_RETRY_ATTEMPTS \
  DEPLOY_SINGLE_NODE DEPLOY_SSH_CONNECT_TIMEOUT DEPLOY_STATE_FILE DIST_DIR \
  LEGACY_CHAT_STYLE_ID LEGACY_REMOTE LIVE_ORIGIN ORIGIN_IP PEER_HOST \
  PEER_ORIGIN_IP PEER_SSH_KEY PUBLIC_EDGE_IP PUBLIC_LINK RELEASE_ROOT \
  REMOTE_PREVIOUS_TARGET RETAIN_RELEASES XENFORO_ROOT XENFORO_STYLES_ROOT; do
  unset "$_override"
done
unset _override

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$HERE/release-tests"

declare -a tests=()
declare -A seen_test=()
if (($# > 0)); then
  # Overlapping filters matched the same test twice, double-counting the
  # summary and rerunning scenarios needlessly.
  for filter in "$@"; do
    for t in "$TESTS_DIR"/test-*"$filter"*.sh; do
      if [[ -f "$t" && -z "${seen_test[$t]:-}" ]]; then
        seen_test[$t]=1
        tests+=("$t")
      fi
    done
  done
else
  for t in "$TESTS_DIR"/test-*.sh; do
    [[ -f "$t" ]] && tests+=("$t")
  done
fi

if ((${#tests[@]} == 0)); then
  echo "No tests found under $TESTS_DIR" >&2
  exit 2
fi

pass=0
fail=0
declare -a failed=()
start_all=$SECONDS

for t in "${tests[@]}"; do
  name="$(basename "$t" .sh)"
  log="$(mktemp)"
  start=$SECONDS
  if bash "$t" >"$log" 2>&1; then
    printf 'PASS  %-45s (%ss)\n' "$name" "$((SECONDS - start))"
    pass=$((pass + 1))
  else
    printf 'FAIL  %-45s (%ss)\n' "$name" "$((SECONDS - start))"
    fail=$((fail + 1))
    failed+=("$name")
    echo "----- output of $name -----"
    tail -n 60 "$log"
    echo "---------------------------"
  fi
  rm -f "$log"
done

echo
printf '%d passed, %d failed (%ss total)\n' "$pass" "$fail" "$((SECONDS - start_all))"
if ((fail > 0)); then
  printf 'Failed: %s\n' "${failed[*]}"
  exit 1
fi
