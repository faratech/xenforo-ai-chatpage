#!/usr/bin/env bash
# Release inventories, metadata, and XenForo template bundles live outside the
# public symlink and remain part of strict local/peer rollback verification.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "deploy 1 failed"
r1="$(current_release)"
p1="$(release_private_dir "$r1")"

assert_absent "$r1/RELEASE-INVENTORY.sha256"
assert_absent "$r1/RELEASE-METADATA.json"
assert_absent "$r1/xenforo-templates"
assert_exists "$p1/RELEASE-INVENTORY.sha256"
assert_exists "$p1/RELEASE-METADATA.json"
assert_exists "$p1/xenforo-templates/wf5/_widget_ai_chat.html"
grep -Fq 'RELEASE-INVENTORY\.sha256' "$r1/.htaccess" \
  || fail_test "public .htaccess does not deny legacy release inventories"
grep -Fq 'xenforo-templates' "$r1/.htaccess" \
  || fail_test "public .htaccess does not deny legacy template bundles"
check_inventory "$r1" || fail_test "private local inventory invalid"
check_inventory "$(to_peer_path "$r1")" || fail_test "private peer inventory invalid"

mutate_dist "build-2"
run_deploy || fail_test "deploy 2 failed"
r2="$(current_release)"

template="$p1/xenforo-templates/wf5/_page_node.313"
cp -f -- "$template" "$SB/private-template.orig"
printf 'TAMPERED' >>"$template"
rc=0
run_deploy rollback || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "rollback should reject corrupt private local data"
assert_contains "$RT_LAST_OUTPUT" "inventory" "private local corruption error"
assert_link_target "$PUBLIC_LINK" "$r2"

cp -f -- "$SB/private-template.orig" "$template"
check_inventory "$r1" || fail_test "local private data restore failed"
peer_template="$(release_bundle "$(to_peer_path "$r1")")/wf5/_page_node.313"
printf 'TAMPERED' >>"$peer_template"
rc=0
run_deploy rollback || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "rollback should reject corrupt private peer data"
assert_contains "$RT_LAST_OUTPUT" "peer previous-release verification failed" "private peer corruption error"
assert_link_target "$PUBLIC_LINK" "$r2"

printf '{"leak":true}\n' >"$DIST_DIR/RELEASE-METADATA.json"
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should reject private metadata copied into public dist"
assert_contains "$RT_LAST_OUTPUT" "private/public boundary" "public leak boundary error"
assert_link_target "$PUBLIC_LINK" "$r2"
assert_no_next_litter
echo "OK"
