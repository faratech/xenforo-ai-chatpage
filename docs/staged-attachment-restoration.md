# Restoring staged chat attachments

Status: **deferred pending a backend contract and rollout**. This is an
investigation of the current source, not a claim that staged attachments are
restored or that production has been changed.

## Current behavior

- An unsent text draft is saved with the per-principal v5 conversation store.
  Staged upload metadata is held separately in the mounted chat component, so
  it survives switching conversations in that component but not a reload or
  remount. A service-worker update is currently deferred while attachments are
  staged. See `src/services/storage.ts` (`storageKeys` and `mergeStores`) and
  `src/components/ChatWindow.tsx` (`composerAttachments` and
  `saveBeforeUpdate`).
- Uploads require a signed-in member and CSRF protection. The response includes
  an opaque ID, filename, MIME type, size, and expiry. PHP records the owner and
  optional conversation binding; the default expiration is seven days. The
  backend may extend a support-case attachment's expiry. See
  `/web/public_html/chat.php` (`CHAT_ATTACHMENT_DEFAULT_TTL`,
  `uploadChatAttachment`, and `upsertSupportCase`).
- Before a turn uses a handle, PHP checks its owner, ready state, expiry,
  conversation binding, private file path, size, hash, and MIME. Removing an
  attachment marks its metadata deleted before removing the file; support-case
  links may prevent deletion. Expired and deleted files are subject to the
  bounded retention job. See `wfChatProductLoadTurnAttachments` and
  `deleteChatAttachment` in `/web/public_html/chat.php`, and
  `scripts/prune-chat-product-data.php`.
- Sending successfully clears the staged chips in the current component; it
  does not consume the upload handle on the server. A failed or interrupted
  turn has separate recovery behavior. See `clearSentAttachments` and `runTurn`
  in `src/components/ChatWindow.tsx`.
- There is no narrow endpoint to validate a set of staged handles for a
  conversation. `exportSavedChatData` returns account-wide saved data and its
  public attachment metadata does not include conversation bindings. It is
  therefore unsuitable for routine draft restoration. See the member actions
  and export implementation in `/web/public_html/chat.php`.

## Proposed contract

1. Design a bounded, read-only member action that accepts a valid conversation
   ID and a capped list of opaque attachment IDs. Apply the existing member,
   CSRF, expected-identity, and rate-limit protections. Return metadata only for
   handles owned by that member, ready, unexpired, and bound to that conversation
   or explicitly unbound. Do not return file content, storage paths, or other
   members' metadata. Define a non-enumerating response for missing, expired,
   deleted, or out-of-scope IDs and a distinct transient service-failure result.
2. Persist only the minimal metadata needed to recover a staged draft under the
   existing principal and conversation scope; never persist raw file bytes by
   default. Choose an explicit versioned migration and merge policy that
   preserves the existing deletion tombstones and offline drafts. Handle quota
   and malformed data without dropping the conversation or silently claiming a
   file was recovered.
3. Treat restored metadata as **unverified** until the member action succeeds.
   On reload or reconnect, reconcile with the server; surface unavailable
   attachments and an option to reattach. Do not submit unverified handles.
   Keep the turn endpoint's independent validation because the file may expire
   or be deleted after a successful restoration check. A network failure must
   preserve recoverable metadata instead of treating it as a confirmed deletion.
4. Design cross-tab reconciliation before enabling persistence. A remove,
   conversation deletion, account deletion, or completed send in one tab must
   not be undone by a stale tab. In particular, server validation alone cannot
   distinguish an already-sent attachment from an unsent one: a successful send
   clears the local chip but leaves the server handle valid. Define durable
   per-attachment removal/consumption markers or a server-side draft lifecycle,
   including simultaneous sends, crashes between send and local persistence,
   retries after partial output, and old clients that know nothing about the new
   state. Do not use timestamp ordering alone as proof of cross-tab correctness.
5. Revisit the service-worker update guard only after safe restoration and
   unsent-action recovery are proven. Preserve the current identity-switch and
   conversation deletion behavior. Roll out the backend contract before the
   frontend and feature-detect it so an older backend and an older open tab
   remain safe.

## Required verification

- Backend tests: valid, unbound and bound IDs; wrong owner and conversation;
  duplicate and over-limit input; expired, deleted, missing and case-linked
  uploads; invalid identity or CSRF; rate limits; and storage failure. Confirm
  no content or private path leaks and no mutation on validation.
- Frontend storage and integration tests: successful reload, offline/reconnect,
  identity changes, multiple conversations and tabs, simultaneous remove/send,
  stale-tab writes, expiry and pruning, server errors, corrupt or full storage,
  account deletion, and legacy-client migration. Confirm rejected or unverified
  files are not silently sent and text drafts are retained.
- Browser coverage for the full attach, review, reload, revalidate, send, and
  reattach paths; run `npm run check` and the relevant PHP contract tests before
  any coordinated rollout.

The missing validation and cross-tab consumption contracts require backend and
frontend design together. A frontend-only persistence change could resurrect
an attachment that was already sent or removed, or present a stale file as
ready; it is intentionally not enabled by this investigation.
