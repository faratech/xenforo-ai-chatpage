#!/usr/bin/env bash
# verify-dist.mjs fixture tests: the CSS scoping rule and the chunk
# import-graph rule, validated against constructed dist trees (not the real
# build, whose CSS refactor lands separately).
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
setup_sandbox

VD="$SB/app/scripts/verify-dist.mjs"

# expect_pass <label> <dist>
expect_pass() {
  local label="$1" dist="$2" out
  out="$(node "$VD" "$dist" 2>&1)" || fail_test "$label should pass, got: $out"
}

# expect_fail <label> <dist> <message substring>
expect_fail() {
  local label="$1" dist="$2" needle="$3" out rc=0
  out="$(node "$VD" "$dist" 2>&1)" || rc=$?
  [[ "$rc" -ne 0 ]] || fail_test "$label should fail"
  [[ "$out" == *"$needle"* ]] \
    || fail_test "$label error should mention [$needle]; got: $out"
}

variant() {
  local dist="$SB/variant-$1"
  rm -rf -- "$dist"
  cp -a "$DIST_DIR" "$dist"
  printf '%s' "$dist"
}

# 1. The compliant fixture passes (scoped rules, scoped @media/@supports,
#    wf-prefixed @keyframes, @charset).
expect_pass "compliant fixture" "$DIST_DIR"

# 2. Bare global selector
d="$(variant bare-body)"
printf 'body{margin:0}\n' >>"$d/static/css/main.css"
expect_fail "bare body selector" "$d" 'Unscoped CSS selector'
expect_fail "bare body selector (names offender)" "$d" '"body"'

# 3. Comma list where one selector is unscoped
d="$(variant comma-unscoped)"
printf '#react-chat-container .a,.MuiBox-root{color:red}\n' >>"$d/static/css/main.css"
expect_fail "comma-unscoped selector" "$d" '".MuiBox-root"'

# 4. :root custom-property leak
d="$(variant root-vars)"
printf ':root{--wf-x:1}\n' >>"$d/static/css/main.css"
expect_fail ":root selector" "$d" '":root"'

# 5. Universal selector inside @media
d="$(variant media-unscoped)"
printf '@media screen{.foo{color:red}}\n' >>"$d/static/css/main.css"
expect_fail "unscoped selector inside @media" "$d" '".foo"'

# 6. @font-face is forbidden entirely
d="$(variant font-face)"
printf '@font-face{font-family:X;src:url(x.woff2)}\n' >>"$d/static/css/main.css"
expect_fail "@font-face" "$d" '@font-face is forbidden'

# 7. @keyframes must be wf-prefixed
d="$(variant keyframes)"
printf '@keyframes spin{0%%{opacity:0}}\n' >>"$d/static/css/main.css"
expect_fail "non-wf @keyframes" "$d" '@keyframes name must start with "wf"'

# 8. Other at-rules (e.g. @import) are rejected
d="$(variant import)"
printf '@import "extra.css";\n' >>"$d/static/css/main.css"
expect_fail "@import statement" "$d" 'Disallowed CSS statement'

# 9. Scoped selector wrapped in @supports still passes
d="$(variant supports-ok)"
printf '@supports (display:flex){#react-chat-container .z{display:flex}}\n' >>"$d/static/css/main.css"
expect_pass "scoped @supports" "$d"

# 10. Missing chunk import target fails
d="$(variant missing-chunk)"
printf 'import"./missing-abcdef12.chunk.js";\n' >>"$d/static/js/main.js"
expect_fail "missing chunk import" "$d" 'imports a missing file'
expect_fail "missing chunk import (names specifier)" "$d" './missing-abcdef12.chunk.js'

# 11. /chatpage/-absolute import specifiers resolve against dist
d="$(variant absolute-import)"
printf 'import("/chatpage/static/js/vendor-sandbox1.chunk.js");\n' >>"$d/static/js/main.js"
expect_pass "absolute /chatpage/ import" "$d"
printf 'import("/chatpage/static/js/gone-abcdef12.chunk.js");\n' >>"$d/static/js/main.js"
expect_fail "absolute /chatpage/ import (missing)" "$d" 'imports a missing file'

echo "OK"
