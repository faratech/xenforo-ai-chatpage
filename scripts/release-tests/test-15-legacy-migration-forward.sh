#!/usr/bin/env bash
# Legacy migration, forward path: PUBLIC_LINK is a plain directory on both
# hosts. Deploy migrates it to legacy-*, generates a compatible inventory in
# the legacy snapshot, switches, and records the legacy dir as previous.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

make_legacy_public_dir "$PUBLIC_LINK"
make_legacy_public_dir "$PEER_PUBLIC_LINK"

run_deploy || fail_test "legacy migration deploy failed"
r1="$(current_release)"
assert_link_target "$PEER_PUBLIC_LINK" "$(to_peer_path "$r1")"
assert_state complete complete
assert_eq "$(state_field migrated_local)" true "migrated_local"
assert_eq "$(state_field migrated_remote)" true "migrated_remote"

legacy_local="$(state_field legacy_local)"
legacy_remote="$(state_field legacy_remote)"
[[ -d "$legacy_local" ]] || fail_test "local legacy snapshot missing: $legacy_local"
[[ -d "$legacy_remote" ]] || fail_test "peer legacy snapshot missing: $legacy_remote"
[[ "$legacy_remote" == "$SANDBOX_PEER"/* ]] || fail_test "peer legacy path is not a peer path"

# Legacy snapshots preserve the old payload, get the release .htaccess, keep
# the original as .htaccess.pre-migrate, and carry a valid inventory.
for legacy in "$legacy_local" "$legacy_remote"; do
  grep -q 'legacy-main-js' "$legacy/static/js/main.js" || fail_test "$legacy lost the old payload"
  grep -q 'legacy original htaccess' "$legacy/.htaccess.pre-migrate" \
    || fail_test "$legacy did not preserve the original .htaccess"
  grep -q 'xenforo-templates' "$legacy/.htaccess" || fail_test "$legacy did not get the hardened release .htaccess"
  check_inventory "$legacy" || fail_test "$legacy inventory invalid"
done

# The legacy snapshot is the recorded previous release on each host
assert_link_target "$RELEASE_ROOT/previous" "$legacy_local"
assert_link_target "$PEER_RELEASE_ROOT/previous" "$legacy_remote"

# A manual rollback to this pre-PWA release remains supported. The strict
# forward live verifier must not require manifest/worker/offline/icon assets
# that did not exist in the legacy snapshot.
run_deploy rollback || fail_test "rollback to the pre-PWA legacy release failed"
assert_link_target "$PUBLIC_LINK" "$legacy_local"
assert_link_target "$PEER_PUBLIC_LINK" "$legacy_remote"
grep -q 'legacy-main-js' "$PUBLIC_LINK/static/js/main.js" \
  || fail_test "legacy rollback did not restore the pre-PWA payload"
assert_contains "$RT_LAST_OUTPUT" \
  "Rollback scope is frontend release assets and bundled chat templates only" \
  "rollback boundary warning"
assert_no_next_litter
echo "OK"
