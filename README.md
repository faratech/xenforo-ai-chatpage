# XenForo AI Chat Page

A React 19 and TypeScript chat interface for XenForo-based sites. It provides
a streaming AI chat page that runs standalone at `/chatpage/` and embedded in a
XenForo page, with conversation history, attachments, sharing, feedback,
text-to-speech, and optional guided Windows troubleshooting.

This repository contains the frontend only. It does not contain a XenForo
add-on, XenForo templates, or the production `chat.php` / `tts.php` backends.
Those live on the XenForo host; this app expects them at the endpoints
described under [XenForo backend integration](#xenforo-backend-integration).
The PHP files under `scripts/` are companion contracts, runtime helpers, and a
migration for the guided-support backend — not a complete backend.

## Prerequisites

| Requirement | Evidence |
| --- | --- |
| Node.js `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | `engines` in `package.json` |
| npm (with `package-lock.json`) | `npm ci` in CI and below |
| A backend serving `chat.php` and `tts.php` | `src/config/env.ts` (`ENV.ENDPOINTS`) |
| Modern browser with `fetch`, streams, `localStorage` | `src/services/api.ts`, `src/services/storage.ts` |

For local UI work you still need a reachable backend: in development the Vite
server proxies chat requests to the test domain (see
[Quick start](#quick-start)).

## Quick start

```bash
npm ci
cp .env.example .env
# Edit .env — see Configuration below. The shipped example values target
# windowsforum.com; point them at your own XenForo host.
npm run dev
```

Then open `http://localhost:5173/chatpage/`. The `/chatpage/` suffix comes
from `base: '/chatpage/'` in `vite.config.ts`; the site root itself is not
served by this app.

Verified in this checkout: `npm ci`, `npm run build`, and
`node scripts/verify-dist.mjs` succeed, and `npm run dev` reports
`Local: http://localhost:5173/chatpage/`.

What happens in development:

- Vite serves the app with the React plugin (`vite.config.ts`).
- Requests matching `^/(chat|tts)\.php$` are proxied to `VITE_TEST_DOMAIN`
  with `changeOrigin: true` (`server.proxy` in `vite.config.ts`), so the
  browser talks same-origin and XenForo session cookies work.
- If no backend is reachable, identity bootstrap fails and the app shows its
  retry state (`src/bootstrap.ts`); there is no mock backend in this repo.

## Configuration

Copy `.env.example` to `.env`. Every variable below is read through
`src/config/env.ts` (as `ENV`) or `vite.config.ts`; do not read
`import.meta.env` elsewhere by convention. Vite only exposes `VITE_*`
variables to the browser, so never put a server secret in `.env` — the file
is git-ignored as a precaution (see `.gitignore`).

| Variable (`.env.example`) | Default / fallback in code | Used for |
| --- | --- | --- |
| `VITE_DOMAIN` | `https://windowsforum.com` (`env.ts`) | Production origin; API base fallback and asset origin fallback. Required and must be an absolute `http(s)` URL for `npm run build` (`vite.config.ts` throws otherwise). |
| `VITE_TEST_DOMAIN` | `https://test.windowsforum.com` (`env.ts`) | Test origin. Dev proxy target for `/chat.php` and `/tts.php`. Required for `npm run build`; in dev it falls back to the default above. |
| `VITE_API_BASE` | Empty = same-origin (recommended) | Optional API base prepended to `/chat.php` and `/tts.php` in `src/services/api.ts`. May be an absolute origin or a root-relative path such as `/api-proxy`. If set for a build it must be root-relative or an absolute `http(s)` URL. |
| `VITE_ASSET_ORIGIN` | `VITE_DOMAIN`, else `https://windowsforum.com` | Origin serving built `/chatpage` assets (for example the bot avatar) for deployed embeds, including test-domain embeds that do not host the release (`src/config/brand.ts`). |
| `VITE_TURNSTILE_SITE_KEY` | Hard-coded fallback key in `env.ts` | Cloudflare Turnstile site key for the CAPTCHA widget loaded from `challenges.cloudflare.com` in `src/components/ChatWindow.tsx`. Set your own site key for your domain. |
| `VITE_ENABLE_VOICE` | Enabled unless exactly `false` | Feature flag for voice / text-to-speech (`ENV.ENABLE_VOICE`). |
| `VITE_MAX_CONVERSATIONS` | `50` (parsed with `Number.parseInt`) | Maximum locally kept conversations (`ENV.MAX_CONVERSATIONS`). |

One more build-time variable is read by `vite.config.ts` only (not in
`.env.example`): `VITE_BUILD_ID` overrides the deterministic build identifier
used for telemetry (`__WF_BUILD_ID__`); when unset, the ID is hashed from the
source tree. You normally leave it unset.

Domain selection at runtime: `ENV.getCurrentDomain()` returns
`VITE_TEST_DOMAIN` only when the hostname is exactly
`test.windowsforum.com`, otherwise `VITE_DOMAIN`. `ENV.getApiBase()` returns
`VITE_API_BASE` if set, `''` (same-origin) on localhost in dev, otherwise the
current domain.

## XenForo backend integration

### How the pieces fit together

```text
Browser
  |-- standalone page  /chatpage/            (this app, dist/)
  |-- embedded page    XenForo page node     (host templates, not in this repo)
  |       #root -> #react-chat-container     (scoped CSS, src/index.tsx)
  |
  |-- POST /chat.php   (JSON actions + streaming chat turns)
  |-- POST /tts.php    (text-to-speech audio)
  v
XenForo host (external to this repo)
  chat.php / tts.php, XenForo session + CSRF, AI provider proxy
```

There are no XenForo add-on manifests, template XML, or host templates in
this tree. Integration is by contract, in three parts:

1. **Serving.** The host serves the production build (see
   [Production build and deployment](#production-build-and-deployment)) and a
   page containing `<div id="root">`. `src/bootstrap.ts` starts identity
   bootstrap, registers the PWA/service worker, then mounts the app with
   `mountApp()` from `src/index.tsx`.
2. **Host shell contract.** When embedded, the app scopes all of its CSS to
   `#react-chat-container` so XenForo styles are unaffected (enforced by
   `scripts/verify-dist.mjs`), reads the color scheme from the host's
   `data-color-scheme` attribute (`src/index.tsx`), and pins itself below the
   forum header by publishing `--wf-shell-top` from the `.p-header` bottom
   edge (`src/utils/hostShell.ts`). The canonical installed-app URL is the
   XenForo `/pages/ai/` shell (`public/manifest.json`,
   `src/services/pwa.ts`).
3. **Backend endpoints.** All data calls go through
   `src/services/api.ts` (`ChatAPI`); see the endpoint contract below.

### Authentication, identity, and CSRF

- Every request uses `credentials: 'include'`, so the XenForo session cookie
  must be sent to the API origin. Keep the app and `chat.php` same-origin, or
  set `VITE_API_BASE` to an origin that accepts those credentials.
- On load, `src/services/identityBootstrap.ts` and `ChatAPI.getUserData()`
  POST `{ "action": "getUserData" }` to `/chat.php`. The response is
  `UserData` (`src/types/index.ts`): optional `avatar`, `name`, `user_id`,
  `identity_id`, and an ephemeral `csrf_token`. The client stores the
  identity as `expected_identity_id` and sends it on later calls; a `428`
  status or an `identity_changed` / `identity_required` error code fires a
  `wf-chat-identity-changed` window event and the UI re-resolves identity.
- State-changing calls use `protectedPayload()` in `src/services/api.ts`,
  which adds `expected_identity_id` and the XenForo `_xfToken`. The token is
  resolved, in order, from a host-supplied value (`ChatAPI.setCsrfToken`),
  `window.XF.config.csrf`, an `input[name="_xfToken"]`, or a
  `meta[name="csrf-token"]`. If no token is available the call fails locally
  with code `csrf_unavailable` — the host page must expose one of those.
- Guests may be challenged with Cloudflare Turnstile: a chat error body with
  `captcha_required`, or HTTP `403` with code `captcha_required`, raises
  `CaptchaRequiredError`; the widget token is then sent as `captcha_token`
  on the chat turn, and `verifyCaptcha` (below) validates a token explicitly.

### `POST /chat.php` — JSON action API

Defined by `ENV.ENDPOINTS.CHAT` in `src/config/env.ts`. Unless noted, calls
are `POST` with `Content-Type: application/json`, a JSON body containing an
`action` field, and a 15-second deadline (`JSON_REQUEST_TIMEOUT_MS`).
Successful responses are JSON objects whose exact shapes are typed in
`src/types/index.ts`, `src/services/apiContracts.ts`, and
`src/services/supportContracts.ts`.

| Action | Purpose (client method in `src/services/api.ts`) |
| --- | --- |
| `getUserData` | Identity bootstrap; returns `UserData` including `csrf_token`. |
| `getUsage` | Returns `UsageData` (login state, tier, used/limit/remaining, reset). |
| `getChatCapabilities` | Returns capability flags, modes, and attachment limits; older backends leave new features disabled (`normalizeCapabilities`). |
| `verifyCaptcha` | Body `{ action, token, expected_identity_id }`; returns `{ success }`. |
| `clientTelemetry` | Fire-and-forget client events (also sent by `src/bootstrap.ts` on load failure). |
| `clearConversation` / `deleteConversation` | Server forgets a conversation; client requires `{ success: true }`. |
| `listSavedConversations` / `getSavedConversation` / `upsertSavedConversation` / `deleteSavedConversation` / `setSavedConversationState` | Saved-conversation CRUD with cursor paging and revision checks (`expected_revision`). |
| `submitChatFeedback` | Per-response rating with `response_id` and `turn_id`. |
| `uploadChatAttachment` | `multipart/form-data` upload (`file`, `_xfToken`); 60-second deadline. Not JSON. |
| `deleteChatAttachment` | Deletes an uploaded attachment by `attachment_id`. |
| `listConversationShares` / `createConversationShare` / `getConversationShare` / `revokeConversationShare` | Share-link lifecycle; `getConversationShare` takes only a `token`. |
| `listSupportCases` / `getSupportCase` / `upsertSupportCase` / `deleteSupportCase` / `updateSupportCaseProgress` / `forkConversation` | Guided-support cases, progress compare-and-swap, and conversation branching. See [Guided Windows support](#guided-windows-support). |
| `exportSavedChatData` / `deleteAllSavedChatData` | Account data export and deletion. |

Error responses are JSON read by `readErrorResponse()`: the client looks for
`message`, `error`, or `detail` (first non-empty wins), plus optional `code`,
`retry_after` (seconds; a `Retry-After` header is also honored), and
`captcha_required`. Statuses `408`, `425`, `429`, and `5xx` except `501` are
treated as retryable.

### Streaming chat turns

Sending a message is a separate call shape on the same endpoint: `POST
/chat.php` with a JSON body and **no** `action` field. The payload
(`SendMessagePayload` in `src/services/api.ts`) is `{ message, ... }` with
optional `expected_identity_id`, `captcha_token`,
`client_conversation_id`, `reset_conversation`, `has_local_history`,
`history` (`[{ role, content }]`), `attachment_ids`, and the guided-support
fields `mode`, `support_case_id`, `support_case_revision`,
`support_contract_version: 1`. The request carries an `X-WF-Turn-Id` header.

The backend must reply with `Content-Type: text/event-stream`. The client
parses SSE `data:` frames as JSON (`SSEEvent` in `src/types/index.ts`) and
handles, among others:

- `response.output_text.delta` / `.done`, `response.refusal.delta` / `.done`
  — streamed answer text.
- `response.output_text.annotation.added`, `response.content_part.done` —
  citations (`url_citation`, `file_citation`, `container_file_citation`,
  `file_path`).
- `response.output_item.added` / `.done`, `response.reasoning_summary_text.*`,
  and `response.*_call.*` progress events — shown as activity steps.
- `chat.context`, `chat.evidence`, `chat.support_card`, `chat.activity` —
  additive guided-support presentation data.
- `chat.stream.completed` — the application terminal event. An upstream
  `response.completed` alone does **not** end the turn, and a bare `[DONE]`
  frame is also accepted as terminal.
- `error`, `function_call_error`, `response.failed`, `response.incomplete` —
  surfaced as typed errors (`APIError`, `IncompleteStreamError`).

Timeouts: 180 s to first byte, 45 s between chunks, 2 MiB maximum stream
size (constants at the top of `src/services/api.ts`).

### `POST /tts.php` — text-to-speech

`ENV.ENDPOINTS.TTS`. `ChatAPI.requestTTS()` POSTs JSON
`{ text, expected_identity_id, voice?, speed? }` and expects an `audio/*`
response body, returned as a `Blob`; any other content type is an
`invalid_tts_content_type` error. Voices and chunking (4,800-byte,
sentence-bounded chunks, at most 3) are defined in
`src/services/speech.ts`. Voice is gated by `VITE_ENABLE_VOICE`.

### What you must implement on the XenForo side

This repo evidences the client half only. A working integration needs, on
your XenForo host:

- `chat.php` and `tts.php` reachable at the API base, accepting the actions
  and streaming format above, with XenForo session authentication and CSRF
  (`_xfToken`) validation.
- A host page that loads the built assets and provides `#root`, the CSRF
  token sources listed above, and (for the embedded layout) the `.p-header`
  element and `data-color-scheme` attribute.
- For guided support only, the companion PHP contracts and migration under
  `scripts/` applied backend-first — see the rollout guide linked below.

## Production build and deployment

```bash
npm ci
cp .env.example .env   # set production VITE_DOMAIN / VITE_TEST_DOMAIN, etc.
npm run build          # vite build -> dist/
npm run verify:dist    # node scripts/verify-dist.mjs
npm run preview        # optional: vite preview of the production build
```

Build facts from `vite.config.ts`:

- `VITE_DOMAIN` and `VITE_TEST_DOMAIN` are required for `npm run build` and
  must be absolute `http(s)` URLs; the build throws otherwise. `VITE_API_BASE`,
  if set, must be root-relative or an absolute `http(s)` URL.
- Output goes to `dist/` with `base: '/chatpage/'`, target `es2022`, no
  sourcemaps, and a single CSS bundle. The stable entrypoints are
  `static/js/main.js` and `static/css/main.css` (served with
  `?v=2` cache-busting); lazy chunks are content-hashed under `static/js/`
  and media under `static/media/`.
- `public/` is copied into `dist/`, including `.htaccess`, `manifest.json`,
  `service-worker.js`, `offline.html`, and the PWA icons.
- `npm run verify:dist` checks the release contract: required files exist,
  the web manifest installs the canonical `/pages/ai/` app, the service
  worker scope header is present, cache-control rules keep stable files
  revalidating and hashed files immutable, and every CSS selector is scoped
  to `#react-chat-container`. Run it before deploying any build.

Deployment itself is host-specific and is **not** shipped in this repo:
`npm run deploy` runs `./deploy.sh`, which is a private operator script —
it is listed in `.gitignore` and does not exist in a fresh clone.
[The guided-support guide](docs/guided-support.md) describes the expected
process: deploy from a clean commit with the existing atomic release
process, keep stable entry URLs and XenForo template contracts unchanged,
and roll back by disabling feature flags while retaining the additive
schema and saved data. Serve `dist/` under `/chatpage/` with the shipped
`.htaccess` semantics (or the equivalent on your server) so that stable
entrypoints revalidate and hashed assets are immutable.

## Commands

All commands are the `scripts` in `package.json`; there are no others.

| Command | Script | What it does |
| --- | --- | --- |
| `npm run dev` | `vite` | Development server at `http://localhost:5173/chatpage/` with the test-domain API proxy. |
| `npm run build` | `vite build` | Production build into `dist/`. |
| `npm run preview` | `vite preview` | Serve the production build locally. |
| `npm run lint` | `eslint .` | Lint with the flat config in `eslint.config.js`. |
| `npm run typecheck` | `tsc --noEmit` | Type-check without emitting. |
| `npm run test` | `vitest run` | Unit/component tests in `src/__tests__/` (Vitest + jsdom). |
| `npm run test:watch` | `vitest` | Same suite in watch mode. |
| `npm run test:browser` | `node scripts/browser-smoke.mjs` | Browser smoke test against mocked API/SSE responses. |
| `npm run test:public` | `node --test scripts/__tests__/evaluate-support.node.mjs` | Node tests for the shipped support-evaluation scripts; no private operator files required. |
| `npm run test:ops` | `node --test scripts/__tests__/*.node.mjs` | Node tests for the ops/eval scripts. |
| `npm run test:release` | `bash scripts/run-release-tests.sh` | Failure-injection harness for the (private) `deploy.sh`. |
| `npm run test:support-eval` | `node scripts/evaluate-support.mjs` | Offline validation of the 30-case synthetic support corpus; no model or network calls. |
| `npm run verify:dist` | `node scripts/verify-dist.mjs` | Verify a built `dist/` against the release contract described above. |
| `npm run check` | lint + typecheck + test + test:ops + build + verify:dist + test:release + test:browser | Full private operator gate, in that order; requires the intentionally untracked cache script and release-test suite. |
| `npm run check:ci` | lint + typecheck + test + test:public + build + verify:dist + test:browser | Public-checkout gate used by CI (`.github/workflows/ci.yml`, Node 24). |
| `npm run deploy` | `./deploy.sh` | Deploy via the private operator script; not present in a fresh clone (see above). |

## Project layout

```text
.
|-- index.html                  Standalone page shell (#root, /chatpage/ assets)
|-- vite.config.ts              Base path, dev proxy, build + release entry rules
|-- .env.example                Template for the VITE_* variables above
|-- public/                     Copied to dist/: .htaccess, manifest, service
|                               workers, offline page, icons, bot avatar
|-- src/
|   |-- bootstrap.ts            Identity bootstrap, PWA, mount + failure UI
|   |-- index.tsx               Theme (host color scheme), #react-chat-container
|   |-- App.tsx                 Identity resolution and app wiring
|   |-- config/
|   |   |-- env.ts              ENV: all VITE_* access, domains, ENDPOINTS
|   |   |-- brand.ts            Assistant name and avatar origin
|   |   `-- layout.ts           Layout constants
|   |-- services/
|   |   |-- api.ts              ChatAPI: every chat.php / tts.php call, SSE parser
|   |   |-- apiContracts.ts     Wire types for saved data, shares, attachments
|   |   |-- supportContracts.ts Capability/support-card normalization (fail-closed)
|   |   |-- identityBootstrap.ts  Early getUserData before the app graph loads
|   |   |-- speech.ts           TTS chunking, voices, preferences
|   |   |-- storage.ts          Principal-scoped local conversation storage
|   |   |-- diagnosticFiles.ts  Local review/redaction of diagnostic text files
|   |   |-- conversationExport.ts, telemetry.ts, pwa.ts,
|   |   |-- completionNotifications.ts, lazyImport.ts
|   |-- components/             ChatWindow, sidebar, dialogs, guided-support UI
|   |-- utils/                  helpers, hostShell (header offset), ids
|   |-- types/index.ts          Shared message, SSE, user, and usage types
|   `-- __tests__/              Vitest suite (mirrors the services/components)
|-- scripts/                    verify-dist, browser smoke, support eval,
|                               PHP support contracts + migration, release tests
|-- tests/fixtures/             Synthetic Windows support-eval corpus
|-- docs/
|   |-- guided-support.md       Guided-support rollout and contracts
|   `-- sources/upstream-reuse.md  Pinned upstream references and licenses
`-- CHANGELOG.md                Dated change history (the package is unversioned)
```

## Guided Windows support

Optional member troubleshooting on top of ordinary chat: support cases,
reviewed Windows text diagnostics, preserved conversation branches, and
structured support-check cards. Ordinary chat, model selection, XenForo
identity, Turnstile, and provider budgets are unaffected, and every new
backend capability defaults to disabled on both sides — the frontend leaves
the features off unless `getChatCapabilities` advertises them, and the PHP
capability response fails closed until its companion tables exist.

Rollout is backend-first and flag-driven (`CHATPAGE_GUIDED_SUPPORT_ENABLED`,
`CHATPAGE_DIAGNOSTICS_ENABLED`, `CHATPAGE_BRANCHES_ENABLED`,
`CHATPAGE_SUPPORT_CARDS_ENABLED`, all default `0` on the host). The full
procedure, data boundaries, storage migration, and qualification steps are
in [the guided-support guide](docs/guided-support.md).

## Provenance and licenses

The guided-support interaction and protocol techniques were adapted — not
copied — from pinned upstream snapshots (OpenAI ChatKit advanced samples,
OpenAI Responses starter app, Anthropic customer-support quickstart, and the
llama.cpp interface), each MIT-licensed. The full record with commit links,
copyright holders, and what was adapted is in
[the provenance record](docs/sources/upstream-reuse.md). Those upstream
licenses cover the upstream projects; they do not grant rights in this
repository (see below), and any future substantial code import must retain
the applicable copyright and permission notices as that record describes.

## License

There is no `LICENSE` file in this repository. No license is granted for
this code: reuse, copying, and redistribution are not permitted by this
repository unless you obtain permission from the copyright holder
separately. The MIT licenses listed in the provenance record apply only to
the named upstream projects.

## Stack

- Vite 8, React 19, and TypeScript (Node engines in `package.json`)
- Material UI and Emotion, with all CSS scoped to `#react-chat-container`
- Marked and DOMPurify for safe message rendering
- Vitest, Testing Library, ESLint, and Playwright Core for tests and checks


