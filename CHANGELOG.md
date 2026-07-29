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
