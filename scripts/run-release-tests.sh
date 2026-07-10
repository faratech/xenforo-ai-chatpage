#!/usr/bin/env bash
# Failure-injection test harness for deploy.sh.
#
#   bash scripts/run-release-tests.sh [test-name-filter ...]
#
# Runs every scripts/release-tests/test-*.sh in an isolated sandbox (temp
# dirs + stubbed ssh/rsync/curl/php/npm), prints per-test PASS/FAIL, and
# exits nonzero if any test fails. Dependency-free: bash + coreutils + node.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$HERE/release-tests"

declare -a tests=()
if (($# > 0)); then
  for filter in "$@"; do
    for t in "$TESTS_DIR"/test-*"$filter"*.sh; do
      [[ -f "$t" ]] && tests+=("$t")
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
