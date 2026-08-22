#!/usr/bin/env bash
# Template designer import fails after both switches: both links restored, the
# snapshotted templates re-applied and re-imported, Cloudflare re-purged, and
# the restored state re-verified.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

run_deploy || fail_test "baseline deploy failed"
r1="$(current_release)"

mutate_dist "build-2"
mutate_styles "v2"
add_rule php 1 skip:1 'sync-xenforo-style-wide.php'

wide_syncs_before="$(stub_calls php 'sync-xenforo-style-wide.php')"
rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at template import"

assert_link_target "$PUBLIC_LINK" "$r1"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"

# The snapshot comes from the authoritative pre-import database (v1), not the
# pending v2 designer sources, and the designer import re-ran during rollback.
snapshot="$(state_field template_snapshot)"
[[ -n "$snapshot" && -d "$snapshot" ]] || fail_test "template snapshot missing from state"
grep -q 'v1' "$snapshot/wf3/react_chat_container.html" \
  || fail_test "rollback snapshot did not capture the pre-import database template"
assert_fake_db_matches_bundle "$(release_bundle "$r1")"
grep -q 'v2' "$XENFORO_STYLES_ROOT/wf3/templates/public/react_chat_container.html" \
  || fail_test "failure recovery destroyed the pending local designer source"
grep -q 'v2' "$PEER_STYLES_ROOT/wf3/templates/public/react_chat_container.html" \
  || fail_test "failure recovery destroyed the pending peer designer source"
wide_syncs_after="$(stub_calls php 'sync-xenforo-style-wide.php')"
[[ "$wide_syncs_after" -gt $((wide_syncs_before + 1)) ]] || fail_test "style-wide sync did not re-run during rollback"

assert_state remote-switched rolled-back
assert_contains "$RT_LAST_OUTPUT" "Re-verified the restored release" "restore re-verification"
assert_no_next_litter
echo "OK"
