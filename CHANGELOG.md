# Changelog

Notable changes to the WindowsForum AI chatpage — the React app at
`/chatpage` and the XenForo host templates it deploys alongside itself
(`XF_CHAT_TEMPLATES` in `deploy.sh`).

The package carries no version number, so entries are dated. Commit hashes are
from `faratech/xenforo-ai-chatpage` unless prefixed `web:`, which are from the
`faratech/windowsforum` monorepo.

Entries record *why* a change was needed where that is not recoverable from the
diff. Several of the causes below were expensive to find and are invisible in
the markup.

## 2026-08-01 (later still) — "cite" in the middle of a sentence

**Fixed.** Answers were reaching readers with the bare word `cite` followed by a
raw URL mid-sentence. Recovered from the chat answer cache, the stored text is:

```
…around for **about 20 years**. U+E200 cite U+E202 https://windowsforum.com/… U+E201
```

Inline citations do not always arrive as markdown. They also arrive as a token
delimited by private-use-area codepoints — `U+E200 <kind> U+E202 <payload>
U+E201` — and a browser renders `U+E2xx` as nothing at all. Strip the invisible
delimiters and what survives on screen is the word `cite` and the URL.

`normalizeAssistantMarkup()` now converts these into the markdown the renderer
already understands, so a token collapses into the same numbered superscript and
Sources entry as a citation the model wrote as a link. Kinds other than `cite`
are internal markup that was never meant to be displayed and are dropped rather
than guessed at, and any delimiter that survives the rules is removed.

It runs on both render paths. The streaming path matters as much as the
committed one: the unfinished tail of an answer renders as escaped plain text,
so a token still arriving would reach the reader verbatim. Mid-stream an
unterminated token is held back until its closing delimiter lands, rather than
letting `cite` flash on screen before the URL catches up.

The delimiters are written as `\uE200`-style escapes in both the source and the
tests. Pasted literally they are indistinguishable from nothing at all — the
first cut of this fix silently lost every one of them in an editor round-trip,
and the tests still passed.

## 2026-08-01 (later) — a question that bricked the conversation

**Fixed.** "How can I secure my Windows computer?" — one of the page's own
example prompts — returned *The AI service is temporarily unavailable* and
stayed broken on every retry. The INFO tool-call audit added earlier the same
day is what made it findable:

```
14:05:09  local tool call: windows_walkthrough
14:05:09  local tool call: windows_screenshot     ← ×11 more, 15 calls in 50ms
14:05:46  w365 fizz-gate acquired source=walkthrough waited=36.8s depth=3
14:06:12  w365 fizz-gate acquired source=walkthrough waited=61.8s depth=2
```

Three separate defects, compounding:

- **`windows_walkthrough` and `windows_console_demo` cannot fit this surface.**
  They drive live Windows VM captures behind a global semaphore with 300s and
  120s upstream timeouts, against chat's 120s streaming deadline. Denied on the
  chat page. `windows_screenshot` stays — one capture, and with the fan-out gone
  the queue it waits on is short. It still costs ~10s on a turn that takes ~9s
  without it.
- **Nothing capped concurrent tool calls.** `max_tool_calls` governs built-in
  tools only, so 15 function calls went out at once, each another slot in that
  queue. `parallel_tool_calls: false` on the chat page bounds the worst case.
- **The failure was permanent, not transient.** An abandoned tool chain leaves
  the stored OpenAI conversation holding a `function_call` with no output, and
  every later message against it 400s identically.
  `conversationErrorRequiresReset()` never matched it — the message names the
  call id, never the conversation, and the function returned early unless the
  text said "conversation" or "conv_". So the conversation was kept and the
  "retry" the error invites could never clear it. Now recognised, so one failure
  drops the dead conversation and the next message starts clean.

The already-poisoned row for the affected guest was deleted by hand; the fix
only covers conversations that fail *after* it shipped.

Replayed after the fix: 1 tool call instead of 15, full answer in 19s.

## 2026-08-01 — off-scope tools, and a wait that stops looking finished

### The assistant kept calling the weather tool

**Fixed.** `chat.php` sends no tool configuration, so the backend handed the chat
page the entire shared `/responses` catalog — the one Discord, Google Chat and
the moderation pipeline also read. After `build_tools()` dropped the functions
the WindowsForum MCP server duplicates, what was left included
`assistant_get_weather`, the `generateImage` function **and** the hosted
`image_generation` tool (`IMAGE_GENERATION_ENABLED_DEFAULT=1`): three
capabilities flatly outside the Windows/IT scope the page's own instructions
declare. At this surface's model tier — `gpt-5.6-luna` at `reasoning_effort:
low` — an off-scope tool sitting in the list gets picked on ordinary questions,
and each spurious call costs a whole extra round trip to OpenAI before the
member sees a word.

- `web:` `responses_router.py` gains `exclude_tools`, a per-caller deny-list
  matching a function `name`, a hosted tool `type`, or an MCP `server_label`.
  It is applied **last** in `build_tools()`, so it also covers `tools_override`
  and `extra_tools` — a surface that says it does not want a tool must not get
  it back through another door.
- `web:` `chat.php` denies all three. Denied there rather than in `get_tools()`
  so no other consumer is affected.
- `web:` executed local tool names now log at INFO. The equivalent lines were
  DEBUG while the service runs at INFO, which is why the journal held no
  evidence of the weather calls at all. This is what verifies the fix.

`$staticInstructions` also gained a line on tool scope. It is hashed into
`chatAnswerCacheKey()` and is the explicit prompt-cache prefix, so editing it
deliberately invalidates both — answers cached from weather-tainted turns are
dropped, at the cost of one cold-cache turn per member.

### The wait looked finished while it was still working

**Fixed.** Every step in the progress strip flipped to a green check on
`response.output_item.done`, and the strip only rendered before the first text
delta. So between steps — reasoning closed but the message item not yet open,
or a local tool running between the two upstream calls — the panel was a
motionless list of ticks with no spinner anywhere, which reads as
finished-but-broken. Then the whole strip vanished on the first delta, taking
the record of what was searched with it.

- A turn in flight now always has exactly one live row: when no step is active,
  a spinner plus `Preparing the answer…` closes the gap.
- Past ~8s the live row shows its own clock, so a long turn looks measured
  rather than hung. The interval exists only while a turn runs.
- Once the answer starts streaming the steps collapse to one line above it
  (`Worked for 6s · 3 steps`), expandable to the full list, and stay with the
  answer for the session. Held in memory only: `Message` is validated
  field-by-field by the storage sanitizer inside a versioned envelope, and a
  schema migration is not worth it for a display aid. The trail is lost on
  reload.

No reasoning narration was enabled — `reasoning_summary` stays unset and no
model reasoning text is shown to users. The client has parsed those events since
the progress strip landed, so turning it on later remains a one-field change in
`chat.php`.

## 2026-07-29 — the chat stops moving the page

`https://windowsforum.com/pages/ai/` behaved like a document with a chat in it
rather than an application. Two separate problems, fixed in that order.

### The chat was scrolling the forum page

**Fixed.** During a streamed answer the page lurched continuously; a Turnstile
challenge threw it around further.

- The auto-follow effect ran `window.scrollTo(0, document.documentElement.scrollHeight)`
  with `streamingState` in its dependencies. That state is a fresh object every
  animation frame, so this ran ~60×/s for the length of every answer. On the
  page node the document measured 1886px against a 900px viewport — 986px of
  chrome the chat does not own, 451px above it and 535px below — so the target
  was the bottom of the **forum footer**, not the end of the conversation. Each
  frame dragged the reader past the chat, composer un-stuck and answer
  off-screen.
- `pageScrollBottomGap()` measured to the same wrong place, so sitting at the
  end of the conversation read as a 535px gap: auto-follow switched itself off,
  "Jump to latest" appeared unprompted, and pressing it pinned the reader in the
  footer.
- Turnstile added four layout shifts per challenge — the user's message was
  pulled from the transcript, the composer refilled, an error line appeared, and
  the iframe arrived ~65px late — three of which re-fired the scroll.

The transcript is now the app's only scroll container (`overscroll-behavior:
contain`) and **nothing in the app calls `window.scrollTo`**. Chasing the tail is
replaced by anchoring: one scroll per turn puts the question at the top of the
pane and the answer streams into stationary space held by a spacer that
collapses as it fills. Turnstile moved into a dialog with a reserved 300×65
slot. The two `position: sticky` hacks that existed only to compensate for the
page-scroll model are gone.

`eca785b`

Also fixed here: `minHeight: ['100vh', '100dvh']` was an MUI *breakpoint array*,
not a fallback pair, so phones got exactly the `100vh` that `dvh` exists to
avoid. All viewport units moved to `dvh` (`web:efc75717f`).

### `deploy.sh` had never verified a changed template

**Fixed.** The rendered-markup check passed for its whole existence only because
the asserted string never changed. `x-litespeed-purge: tag=public` does not
evict `/pages/ai/` — `pagecache.php` emits `X-LiteSpeed-Tag` only on the PREBHIT
path, so the page-node entry is stored untagged and a tag purge matches nothing.
Measured: three consecutive purges each returned `204` while `age` climbed
3066 → 3068 → 3182; only `*` produced a miss. httpjet has exactly two purge
forms (`peer_purge.rs`: `Purge::All`, `Purge::Tags`) and no URL-targeted purge.

The consequence was a stale shell served for the full `--xf-capsule-stale-secs`
window (3600s live) — the same failure class as the 2026-07-13 stale-content
incident that `scripts/cache_capsule_purge_test.sh` guards. The first deploy to
actually change the markup failed verification against a 50-minute-old page and
rolled itself back. **That was the check working.**

`a295856`

### The page still scrolled, because the forum chrome did

**Fixed.** The chat no longer moved the page, but the page was still a document:
1886px against a 900px viewport, the app starting 451px down. On a phone 508px
of the first 844px screen — 60% — was chrome before the conversation began.

`/pages/ai` is now a locked app shell: `html`/`body` pinned to the viewport, the
chrome that no longer fits hidden (ad, page title, share buttons, breadcrumbs,
footer), and the forum header kept as the way back out since the bottom
breadcrumb is gone.

`a0a83ae`, `web:5f65344ba`

#### Google Auto Ads was dismantling the layout — three ways

This is the part worth reading before touching the shell again. Each behaviour
broke a working layout and was only found after shipping a fix for the previous
one.

1. **Ablation.** Auto Ads writes `height: auto !important` as an *inline style*
   onto `.p-pageWrapper` — its term for neutralising an ancestor that would clip
   an ad, and a viewport-height box with `overflow: hidden` is exactly the shape
   it targets. An inline `!important` outranks any author stylesheet, so every
   height the shell set was correct and every one was silently overwritten.
2. **In-flow injection.** Moving the column onto `<body>` so the wrapper could
   grow survived the ablation, then lost to a 300px `.google-auto-placed` div
   injected directly into `<body>`, which became a flex sibling and took the
   same 300px back.
3. **Scroll-lock defeat.** With injected content present the page scrolled 258px
   despite `body { overflow: hidden }` — the usual overflow-propagation rule did
   not hold. `html` is now locked too.

`#root` is therefore `position: fixed`, offset by `--wf-shell-top`, and measures
nothing through document flow. Verified immune with all three applied at once:
ablation plus 848px of injected content → still unscrollable, zero header
overlap, chat 843px, composer flush.

`4bb57b9`

> **Recommendation, not yet done:** exclude `/pages/ai` from Auto Ads in the
> AdSense console. Everything above is a workaround for a script actively
> fighting a full-viewport layout, and it will keep finding new ways in.

#### A percentage height chain that looked correct and was not

`.p-body-content` is sized by its flex parent *stretching* it, and a
stretch-derived height is not "definite" — a `height: 100%` child resolves to
`auto` against it and falls back to content height. Identical in devtools; only
the used value gives it away. Measured `.p-body-content` 843px,
`.p-body-pageContent` 553px, through a rule that was the winning declaration.

Everything below is now `flex: 1 1 auto` with `min-height: 0`, which has no
definiteness requirement. `.p-body-content` keeps its percentage — removing it
too left the chain with nothing to size against and it grew to the transcript's
full 99340px. `App.tsx`'s wrappers are named `.wf-app` / `.wf-app-view` so the
shell can size them; `.wf-app-center` is the transient loading/error state.

`c284007`

#### Header offset

The shell offset used the header's *height*. Those match only when the header is
the first thing on the page — a staff bar or notice above it (members get these,
guests do not) moves it down without resizing it, and the chat rode over the
logo by exactly that much. Reproduced with a 44px bar: header bottom 101px,
shell top 57px, 44px overlap.

Now measures `getBoundingClientRect().bottom`. Watching covers the header, its
wrapper *and its siblings*: a sibling resizing changes no observed element's
size (found by growing the test bar 44→96px and getting 52px of overlap back),
and insertion changes no size at all, only position, so a `MutationObserver`
handles that separately.

`3009376`, `50ef907`, `src/utils/hostShell.ts`

### The forum's 280px ad moved into the chat

The breadcrumb AdSense unit (`ca-pub-7455498979488414`, slot `6778196821`) sat
above the chat at 280px, 390px on phones. Inside a viewport that no longer
scrolls that comes straight out of the conversation, so it is **relocated, not
dropped**: `AdSlot` renders the same slot as the last row of the shell in a
fixed 90px band (60px on phones), and removes the forum's copy from the DOM.

Both gates mirror the host rather than restating its policy — `isGuest`
reproduces the macro's `isMemberOf([1])` (members have never seen this unit and
must not start), and the presence of the AdSense loader stands in for being
embedded at all, so the standalone route renders nothing.

An unfilled band is handed back to the conversation, and **the decision is
final**: measured on production, the band collapsed as unfilled and filled ~20s
later, resizing the transcript 90px mid-conversation — the same class of shift
this whole change exists to remove. Unfilled now unmounts the slot rather than
hiding it, which also puts it beyond the site-wide `collapse.js`; an attribute
either script can toggle is not a decision.

`940b358`, `f483855`

### Verification

Measured on production, 625 samples at 40ms: `window.scrollY` `[0]`, document
height `[900]` (equal to the viewport, so no scroll range at all), transcript
`[671]`, composer gap `[0]`, header overlap `[0]` — every one a single constant.
Earlier, through an 8288px streamed answer, 1024 samples held the same way.
Checked at 1440×900, 900×700 and 390×844, the last two covering the ≤900px
branch where `app_body.less` puts `overflow: hidden` on an ancestor of `#root`.

Chrome before the conversation on mobile: **508px → the forum header alone**
(52px in the harness at 390×844; 57–60px in production depending on the host).

### Known gaps

- **Not verified while logged in.** Two changes in this round were correct for
  guests and wrong for members. The header-overlap fix was validated by
  *simulating* member chrome (insert/grow/shrink/remove, zero overlap
  throughout), not by observing a real member session.
- **Auto Ads remain enabled** on this page; see the recommendation above.
- A local harness reproducing the host box model
  (`body { overflow-y: scroll }`, the 280px ad, the ≤900px `overflow: hidden`
  branch) passed while production failed, three deploys running — it has no
  AdSense, so it cannot reproduce any of the ablation behaviour. **For an embed,
  the host page is the only real test environment.**
