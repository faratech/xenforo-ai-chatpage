# Logged-in chat flow audit — 2026-09-08

The member flow was traced from identity bootstrap through conversation loading,
submission, PHP forwarding, streaming, tools, interruption, persistence, and
rendering. This is a scoped reliability review, not a security certification.

## Findings fixed

1. The browser's 130-second first-byte deadline cut off requests before the
   requested 180-second backend window. It now waits 180 seconds. The separate
   45-second inactivity deadline still detects a dead stream after the first
   byte; server heartbeats keep a healthy tool wait alive. The companion change
   in `/web/public_html/chat.php` sets upstream timeout/read timeout to 180
   seconds and the Responses request timeout to 180 seconds. Its old 120000
   value used the wrong units and was clamped to the API maximum of 900 seconds.
2. `response.output_item.done` for a function call finishes argument generation,
   not execution. Function steps now stay active until application completion.
   `response.completed` remains nonterminal so tool-chain answers are retained.
3. ScreenshotAI publishes under `/images/ai/w365-tasks/`, which the renderer's
   image policy omitted. That folder is now accepted under the existing HTTPS
   WindowsForum host policy. Untrusted hosts and unrelated folders remain denied.
4. Stopping or unmounting a plain send before its first text left no stopped
   response in history. A stopped row is now retained even without partial text;
   its presentation marker is omitted from provider recovery context. Existing
   edit/regenerate branch restoration remains intact. Stopping a stream with a
   managed Windows activity also explains that the job may continue and directs
   the user to request status or cancellation before starting it again.
5. A failed plain send without text did not mark server context uncertain or
   retain the turn reference on the failed message. It now does both, matching
   the existing partial-output and branch failure recovery behavior.

## Other paths reviewed

- Identity bootstrap and revalidation: expected identity marker, account-scoped
  storage, remount on user changes, session-error locking, and transient recovery.
- Local/cloud history: drafts, revisions, conflicts, tombstones, deletions,
  pin/archive metadata, branch restoration, and history-required fallback.
- Requests: authenticated cookies, protected management payloads, attachment
  handles, quota errors, CAPTCHA fallback, and cancellation signals.
- Streaming: application terminal event, heartbeat deadlines, partial answers,
  annotations, bounded response size, and automatic retry using the same turn ID.
- Rendering and secondary flows: trusted screenshot URLs, citations, sharing,
  attachments, voice controls, PWA updates, and reload persistence.

No additional defect was established in these other paths during this pass.
An automatic retry preserves its turn ID; absence of text alone is not evidence
that no server work happened. Explicit regenerate/retry remains a new chat turn.
The Stop control closes the browser stream; it is not a desktop-job cancellation
API. Desktop completion is established by the tool result, not a progress tick.

## Validation and limits

Regression tests cover a first byte at 150 seconds, function progress ordering,
trusted task screenshot rendering, stop before text with clean recovery history,
and failed-turn resynchronization with a retained support reference. The Chromium
smoke suite includes a simulated signed-in member receiving a desktop screenshot
and retaining it after reload. All API calls in that scenario are isolated mocks;
it does not create production account data or execute a desktop job.

The release gate passed lint, TypeScript, 378 application tests, 4 operations
tests, build/import checks, 26 deployment/rollback tests, and Chromium smoke
scenarios including the screenshot/reload check.
The companion PHP source passes lint and all 72 chat predicate checks.
Production standalone-page and identity-bootstrap HTTP probes returned 200.

The connected browser failed navigation with ERR_PROXY_CONNECTION_FAILED and
had no signed-in session. Consequently a live member browser-to-PHP-to-Windows
round trip was not verified in this pass. Earlier direct desktop-worker tests
are separate evidence and must not be described as member UI coverage.

## Deployment findings

Deployment exposed two additional stale assumptions. The `wf4_container.css`
source already matched its live database row byte-for-byte but its recorded
metadata hash was old; only that hash was repaired in the parent repository.
The deploy also required retired styles 46, 47 and 51, while the live database
contains only 17, 40 and 50. Deployment now discovers active source styles and
filters compiled consumers using the live style set, preserving the required
canonical style and conflicting-marker checks. Snapshot/import/rollback all use
that selection. A release regression exercises deployment and rollback with the
retired directories still present. Template preflight runs before the expensive
release gate as well as afterward to detect drift during the checks.
