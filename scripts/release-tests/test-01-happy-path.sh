#!/usr/bin/env bash
# Happy path: fresh first deploy (no PUBLIC_LINK yet), then a second deploy.
# Asserts symlinks on both hosts, inventories, bundled templates, designer
# syncs on both nodes, purge, previous pointers (per host), state file, and
# absence of .next.* litter.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

# --- deploy 1 (fresh: PUBLIC_LINK absent on both hosts) ---
run_deploy || fail_test "first deploy failed"
r1="$(current_release)"
[[ -d "$r1" ]] || fail_test "release dir missing"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_state complete complete
assert_eq "$(state_field action)" deploy "state action"
assert_eq "$(state_field fresh_local)" true "fresh_local"
assert_eq "$(state_field fresh_remote)" true "fresh_remote"

# Inventories present and valid on both hosts
check_inventory "$r1" || fail_test "local inventory invalid"
check_inventory "$(to_peer_path "$r1")" || fail_test "peer inventory invalid"

# Template bundle and inventory are private, outside the public symlink.
b1="$(release_bundle "$r1")"
assert_absent "$r1/xenforo-templates"
assert_absent "$r1/RELEASE-INVENTORY.sha256"
assert_exists "$b1/wf3/_page_node.313"
assert_exists "$b1/wf3_domperf/react_chat_container.html"
assert_exists "$b1/wf5/_page_node.313"
metadata1="$(release_private_dir "$r1")/RELEASE-METADATA.json"
assert_exists "$metadata1"
assert_templates_match_bundle "$b1"
assert_eq "$(state_field release_metadata)" "$metadata1" "state metadata path"
assert_eq "$(json_value "$metadata1" working_tree_dirty)" false "clean release metadata"
assert_eq "$(json_object_value "$metadata1" backend_hashes chat.php)" \
  "$(sha256sum "$XENFORO_ROOT/chat.php" | awk '{print $1}')" "metadata chat.php hash"
assert_eq "$(json_object_value "$STATE_FILE" backend_hashes chat.php)" \
  "$(sha256sum "$XENFORO_ROOT/chat.php" | awk '{print $1}')" "state chat.php hash"
assert_eq "$(json_object_value "$metadata1" backend_hashes chat-product-contract.php)" \
  "$(sha256sum "$SB/app/scripts/chat-product-contract.php" | awk '{print $1}')" \
  "metadata chat product contract hash"
assert_eq "$(json_object_value "$STATE_FILE" backend_hashes chat-product-contract.php)" \
  "$(sha256sum "$SB/app/scripts/chat-product-contract.php" | awk '{print $1}')" \
  "state chat product contract hash"
assert_eq "$(json_object_value "$metadata1" backend_hashes migrate-chat-product-foundation.php)" \
  "$(sha256sum "$SB/app/scripts/migrate-chat-product-foundation.php" | awk '{print $1}')" \
  "metadata chat product migration hash"
assert_eq "$(json_object_value "$metadata1" backend_hashes prune-chat-product-data.php)" \
  "$(sha256sum "$SB/app/scripts/prune-chat-product-data.php" | awk '{print $1}')" \
  "metadata chat product pruner hash"

# Designer import ran on both nodes (2 styles x 2 nodes)
assert_eq "$(stub_calls php 'remote=0 .*import-templates')" 2 "local designer imports"
assert_eq "$(stub_calls php 'remote=1 .*import-templates')" 2 "peer designer imports"
assert_eq "$(stub_calls php 'remote=0 .*rebuild-metadata')" 2 "local metadata rebuilds"
assert_eq "$(stub_calls php 'remote=0 .*sync-xenforo-db-style.php .* 17$')" 1 "local database style syncs"
assert_eq "$(stub_calls php 'remote=1 .*wf-chat-db-style-sync')" 1 "peer database style syncs"
assert_eq "$(stub_calls php 'remote=0 .*sync-xenforo-db-style.php .* 51 bootstrap wf5')" 1 "local scoped WF5 syncs"
assert_eq "$(stub_calls php 'remote=1 .*wf-chat-wf5-sync')" 1 "peer scoped WF5 syncs"
assert_eq "$(stub_calls php 'import-templates wf5')" 0 "broad WF5 designer imports"
assert_eq "$(stub_calls php ' -l ')" 6 "backend PHP lint calls"
assert_eq "$(stub_calls php 'test_chat_predicates.php')" 1 "backend predicate test calls"
assert_eq "$(stub_calls php 'test_chat_product_contract.php')" 1 "backend product contract test calls"
cmp -s "$b1/wf3/_page_node.313" \
  "$XENFORO_ROOT/db-style-17/_page_node.313" \
  || fail_test "database-managed style 17 does not match canonical wf3 template"
cmp -s "$b1/wf3/_page_node.313" \
  "$SANDBOX_PEER/public_html/db-style-17/_page_node.313" \
  || fail_test "peer database-managed style 17 does not match canonical wf3 template"
cmp -s "$b1/wf5/_page_node.313" \
  "$XENFORO_ROOT/db-style-51/_page_node.313" \
  || fail_test "scoped WF5 style 51 does not match its source bundle"
cmp -s "$b1/wf5/_page_node.313" \
  "$SANDBOX_PEER/public_html/db-style-51/_page_node.313" \
  || fail_test "peer scoped WF5 style 51 does not match its source bundle"
assert_exists "$XENFORO_ROOT/internal_data/code_cache/templates/l1/s46/public/_page_node.313.php"
assert_exists "$XENFORO_ROOT/internal_data/code_cache/templates/l1/s51/public/_page_node.313.php"
assert_eq "$(stub_calls curl 'purge_cache')" 1 "purge calls"
assert_eq "$(stub_calls redis-cli 'remote=0 .*FLUSHDB')" 1 "local Redis DB1 flushes"
assert_eq "$(stub_calls redis-cli 'remote=1 .*FLUSHDB')" 1 "peer Redis DB1 flushes"
assert_eq "$(stub_calls curl '__hj_cache_purge')" 2 "httpjet page-cache purges"

# Fresh deploy records no previous pointer
assert_absent "$RELEASE_ROOT/previous"
assert_absent "$PEER_RELEASE_ROOT/previous"
assert_no_next_litter

# --- deploy 2 ---
mutate_dist "build-2"
mutate_styles "v2"
run_deploy || fail_test "second deploy failed"
r2="$(current_release)"
[[ "$r2" != "$r1" ]] || fail_test "second deploy did not produce a new release"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r2")"
assert_state complete complete

# Previous pointers are per host and point at each host's own prior release
assert_link_target "$RELEASE_ROOT/previous" "$r1"
assert_link_target "$PEER_RELEASE_ROOT/previous" "$(to_peer_path "$r1")"

# The new bundle (v2 templates) is live on both nodes
assert_templates_match_bundle "$(release_bundle "$r2")"
grep -q 'v2' "$XENFORO_STYLES_ROOT/wf3/templates/public/react_chat_container.html" \
  || fail_test "live template does not carry the v2 payload"

# Live content converged to the new build on both origins
cmp -s "$r2/static/js/main.js" "$PUBLIC_LINK/static/js/main.js" \
  || fail_test "local live main.js is not the new build"
cmp -s "$r2/static/js/main.js" "$PEER_PUBLIC_LINK/static/js/main.js" \
  || fail_test "peer live main.js is not the new build"

assert_no_next_litter
echo "OK"
