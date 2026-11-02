# Syntax highlighting evaluation

Status: **not included**. The chat already presents fenced code with language
labels and accessible wrap, copy, and download controls. Its Markdown and
enhanced HTML are sanitized before display.

A local prototype used highlight.js 11.12 with nine explicitly registered
languages, a lazy import, completed code blocks only, a 50,000-character limit,
and a second sanitization of generated token markup. Unknown languages and
errors fell back to plain text. Tests covered preservation of code text,
malicious-looking text, and code-toolbar focus and wrap state.

The production build emitted a separate 54.47 kB / 18.88 kB gzip chunk. The
release verifier counts **all** JavaScript chunks, including lazy chunks, and
the prototype's combined build was 318,595 gzip bytes against the then-current
299,008-byte aggregate budget. An isolated clean-HEAD build with the same
dependencies measured 298,305 bytes. The highlight library alone consumed far
more than the available headroom, so the prototype and dependency were removed.
The aggregate limit was subsequently increased by 1 KiB to accommodate the
other chat improvements; that increase does not cover this prototype.
These figures are build measurements, not a claim about live traffic or latency.

Revisit highlighting if a smaller implementation can be demonstrated within
the release budget, or if the product explicitly accepts a revised budget based
on measured demand. Any future implementation should preserve the sanitization
boundary and code text exactly, avoid replacing interactive toolbar nodes or
losing focus when asynchronous work finishes, skip streaming and oversized code,
retain a plain-text fallback, and test malicious input, code copying, wrapping,
language coverage, bundle size, and browser behavior in both themes.
