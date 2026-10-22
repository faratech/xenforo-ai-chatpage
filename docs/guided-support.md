# Guided Windows support

The chatpage adds optional member troubleshooting cases, reviewed Windows text
diagnostics, preserved conversation branches, and structured support checks.
Ordinary chat remains available. Existing model selection, XenForo identity,
Turnstile approval, and provider budgets remain authoritative.

## Rollout flags

All four flags default to `0`. Non-secret production settings belong in
`/web/.config`, following the host's existing configuration workflow.

| Setting | Capability |
| --- | --- |
| `CHATPAGE_GUIDED_SUPPORT_ENABLED` | Optional case intake, reviewed facts and reported check outcomes |
| `CHATPAGE_DIAGNOSTICS_ENABLED` | Local text review/redaction, LOG/XML/NFO exports and numbered submitted evidence |
| `CHATPAGE_BRANCHES_ENABLED` | Edit/regenerate into linked conversations, with selected destination-bound file copies |
| `CHATPAGE_SUPPORT_CARDS_ENABLED` | Validated proposed-check cards and retrieval/activity metadata; also requires guided support |

The PHP capability response fails closed until all companion tables exist.
The Python card flag is read at service startup; changing it requires the normal
guarded `aiapi.service` rollout. PHP reads the configured settings per request.
Disabling guided support lets existing guided conversations continue as ordinary
chat, without injecting their case or clearing its stored association.

## Backend-first installation

1. Review the frontend, `/web/public_html/chat.php`, and the FastAPI changes
   together. The runtime PHP endpoint requires both `scripts/chat-support-contract.php`
   and `scripts/chat-support-runtime.php` at the application path.
2. Inspect `php scripts/migrate-chat-support.php`. This default mode prints DDL
   without opening a database. Apply with `--apply` only during the coordinated
   backend rollout. The migration adds companion tables; it does not rewrite
   existing transcripts or cases.
3. Run the PHP predicate/product/support suites, the retention self-test, and
   the focused Python tests with production I/O poisoned. The existing retention
   job also cleans bounded orphan companion rows; review that operator script
   with the rollout because it is excluded from this frontend repository.
4. Commit the intended changes in their owning repositories and run
   `npm run check`. Deploy from the clean commit using the existing atomic
   release process. Stable entry URLs and XenForo template contracts are unchanged.
5. Validate enabled features with a member on a staging installation before
   enabling them for production members. Validate actual provider streaming,
   case revisions, private file expiry, fork/reload, cancellation and recovery.
   The browser smoke suite uses mocked API/SSE responses and cannot prove those
   production paths or model quality.

Release tooling lints and records hashes for the new runtime helpers and migration,
and requires the support contract test. A frontend rollback retains the additive
schema. Disable the relevant flags to withdraw a feature; retain saved data.

## Contracts and data boundaries

- `getChatCapabilities` advertises flags, modes and authoritative attachment
  budgets. Unsupported/older backends leave the new frontend features disabled.
- Turns optionally carry `mode`, `support_case_id`, `support_case_revision`, and
  integer `support_contract_version: 1`. The server resolves ownership, case
  revision and the bounded snapshot. New fingerprints include that snapshot,
  selected evidence and normalized recovery history; legacy ordinary clients
  retain their existing fingerprint.
- `updateSupportCaseProgress` uses the existing case revision for compare-and-swap.
  Identical replayed progress does not add another attempt or increment revision.
  Facts and outcomes describe the user's reports, not independently verified observations.
- `forkConversation` takes a source revision, fork message, operation and explicit
  file selection. Each branch is a regular saved transcript with immutable lineage.
  The server copies only authorized selected files into new handles and checks quotas.
- Additive `chat.context`, `chat.evidence`, `chat.support_card` and `chat.activity`
  events carry bounded public presentation data. `chat.stream.completed` remains
  the application terminal; provider completion alone does not finish a tool chain.
- `present_support_step` is a presentation tool. It does not execute a command,
  alter a case, post to the forum or expose raw tool arguments/results. Evidence
  IDs must exist in the trusted per-turn registry.
- Canonical response details live separately from client-submitted transcript
  JSON. Public shares omit them. Private exports include the selected branch's
  details/lineage, never automatically include siblings, and use JSON version 2
  when those fields are present.
- Local storage moves to principal-scoped v5 keys. V4 remains readable and is
  retained through quota failures; newer old-tab writing is merged using the
  existing draft/deletion clocks without erasing support metadata.

Text review accepts UTF-8 and BOM-marked UTF-16. The browser uploads an explicitly
reviewed UTF-8 derivative. Source line ranges refer to that derivative; raw originals
stay local during review. Suggestions cannot identify every secret, so the editable
preview remains the decision point. XML stays inert text. Binary dumps, EVTX,
archives, PDF processing and local llama inference are outside this release.

## Qualification

`node scripts/evaluate-support.mjs` validates the 30-case synthetic corpus offline.
Use its documented captured-response options to compare baseline/candidate
responses. Lexical fixture scores are aids for human review; they do not establish
factual correctness, successful retrieval, delivery, or an SLO.

Before member activation, record a baseline and candidate review for updates,
crashes, drivers, networking, activation and performance. Check citation support,
facts retained after recovery, repeated unsuccessful suggestions, and command
appropriateness. Monitor completion/errors, time to first text, total latency,
provider usage, tool failures and reported outcomes using the existing telemetry.

See [upstream provenance](sources/upstream-reuse.md) for pinned source references
and the distinction between adapting techniques and copying source code.
