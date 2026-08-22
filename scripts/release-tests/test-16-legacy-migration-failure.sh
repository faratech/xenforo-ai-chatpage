#!/usr/bin/env bash
# Legacy migration, failure path: activation fails after both hosts migrated
# their plain directory and switched. The restore must put the ORIGINAL plain
# directories back (original .htaccess included), leaving no legacy-* remains.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

make_legacy_public_dir "$PUBLIC_LINK"
make_legacy_public_dir "$PEER_PUBLIC_LINK"

add_rule php 1 skip:1 'sync-xenforo-style-wide.php'

rc=0
run_deploy || rc=$?
[[ "$rc" -ne 0 ]] || fail_test "deploy should have failed at template import"

# Both hosts are plain directories again with the original payload
assert_plain_dir "$PUBLIC_LINK"
assert_plain_dir "$PEER_PUBLIC_LINK"
for dir in "$PUBLIC_LINK" "$PEER_PUBLIC_LINK"; do
  grep -q 'legacy-main-js' "$dir/static/js/main.js" || fail_test "$dir lost the legacy payload"
  grep -q 'legacy original htaccess' "$dir/.htaccess" || fail_test "$dir .htaccess was not restored"
  assert_absent "$dir/.htaccess.pre-migrate"
  assert_absent "$dir/RELEASE-INVENTORY.sha256"
done

# No legacy-* directories remain on either host
legacy_dirs="$(find "$RELEASE_ROOT" "$PEER_RELEASE_ROOT" -maxdepth 1 -type d -name 'legacy-*' | wc -l)"
assert_eq "$legacy_dirs" 0 "leftover legacy dirs"

assert_state remote-switched rolled-back
assert_no_next_litter
echo "OK"
