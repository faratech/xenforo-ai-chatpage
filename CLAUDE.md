# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build and Run
- `npm run dev` - Start Vite development server at http://localhost:5173
- `npm run build` - Production build (`vite build` → `dist/`, stable entries and hashed chunks/media)
- `npm run preview` - Preview the production build locally
- `npm run typecheck` - Type-check without emitting (`tsc --noEmit`, native TypeScript 7)
- `npm run check` - Run lint, typecheck, tests, build, and release verification
- `npm run deploy` - Build, validate, stage, and atomically activate a production release
- `./deploy.sh rollback` - Atomically restore the previous production release

### Deployment
The app is served through the `/web/public_html/chatpage` symlink at `https://windowsforum.com/chatpage`. Public assets are staged under `/web/releases/xenforo-ai-chatpage/<release-id>/`; inventories, backend hashes, and rollback template bundles are stored separately under `/web/releases/xenforo-ai-chatpage/.private/<release-id>/` so they are never reachable through the public symlink. When peer mode is deliberately enabled, both trees are staged and verified before either public symlink switches.

Production releases must come from a committed, clean worktree. `npm run deploy` refuses dirty state by default; `DEPLOY_ALLOW_DIRTY=1` is an emergency-only override and records `working_tree_dirty: true` in the private release metadata. The production gate lints the available chat backend PHP files and runs `/web/tests/test_chat_predicates.php` when present. Since 2026-08-22 no XenForo style is designer-managed (designer mode was retired across all six styles; the `src/styles/<id>/` trees remain as plain version-controlled template sources). The deploy pushes `wf3`/`wf3_domperf` into the database style-wide via `scripts/sync-xenforo-style-wide.php`; WF5/style 51 is updated through a snapshot-backed, two-template scoped sync so unrelated WF5 changes are never swept.

**Single-node mode is the safe default.** Production has been a single GCP node since 2026-07-13, so `npm run deploy` defaults `DEPLOY_SINGLE_NODE=1`. Set `DEPLOY_SINGLE_NODE=0` only after a serving peer is deliberately reintroduced and its origin probes pass. Single-node mode skips every peer staging, import, purge, prune, and probe step; all local checks, the atomic switch, rollback, the XenForo template import, the Cloudflare purge, and local-origin plus public-edge verification still run.

The deploy refuses to run when any template in `wf3`/`wf3_domperf` has drifted from `_metadata.json`, because its final step is a style-wide database sync that would sweep unrelated pending template edits into XenForo's database. Clear the drift deliberately first — `php scripts/sync-xenforo-style-wide.php /web/public_html <style-dir> <style-id>` from this repo (e.g. `wf3`/`40`) — rather than bypassing the guard.

### Project Configuration
- **Framework**: Vite 8 + React 19 + TypeScript
- **TypeScript layout**: the root `typescript@7` (native Go compiler) is the project compiler for `npm run typecheck`. `typescript-eslint` cannot load it (no JS compiler API; peer range caps at `<6.1.0`), so the `typescript-lint` devDependency (aliased `typescript@6`) is planted as the lint chain's nested `typescript` resolution by `scripts/shadow-lint-typescript.mjs` (run both as a `postinstall` hook and at the start of `npm run lint`, so an `--ignore-scripts` reinstall can't leave lint broken), and `.npmrc` sets `legacy-peer-deps` to accept the peer conflict. Remove all four (alias, script, `.npmrc` line, lint prefix) together once typescript-eslint supports TS 7.
- **Build Output**: `dist/` directory (stable `main.js`/`main.css`, content-hashed chunks/media)
- **Base Path**: `/chatpage` (configured in `vite.config.ts` `base` field)
- **Environment**: Variables in `.env` must be prefixed with `VITE_`

## Architecture Overview

### Core Application
This is a TypeScript React chat interface integrated with XenForo that provides real-time AI chat capabilities. The architecture follows a service-oriented pattern with centralized API management.

### Directory Structure
```
src/
├── components/         # React UI components
│   ├── ChatWindow.tsx        # Main chat interface (conversations, messages)
│   ├── ConversationSidebar.tsx  # History sidebar
│   ├── InputArea.tsx         # Message input controls
│   ├── Message.tsx           # Individual message display
│   └── ErrorBoundary.tsx     # Global error handling
├── services/          # API layer
│   └── api.ts               # ChatAPI, AudioService (all backend calls)
├── config/            # Configuration
│   └── env.ts               # Environment variable management
├── types/             # TypeScript definitions
│   └── index.ts             # Shared interfaces and types
└── utils/             # Helper functions
    └── helpers.ts           # Markdown parsing, sanitization, ID generation
```

### Key Design Patterns

#### 1. Service Layer Pattern
All backend communication goes through `src/services/api.ts`:
- **ChatAPI**: Handles message streaming, user data, CAPTCHA verification
- **AudioService**: Manages text-to-speech playback
- Never call fetch directly in components; always use the service layer

#### 2. Environment Configuration
Access environment variables through `src/config/env.ts`:
```typescript
import { ENV } from '../config/env';
ENV.getCurrentDomain()  // Gets prod/test domain based on hostname
ENV.TURNSTILE_SITE_KEY  // CAPTCHA key
ENV.MAX_CONVERSATIONS   // Conversation limit
```

#### 3. State Management
- **Conversations**: Stored in localStorage, managed in ChatWindow. Live key is the per-user v4 envelope `chat_store:v4:<principal>` (see `storageKeys()` in `src/services/storage.ts`); `chat_conversations` is a legacy unscoped key that every load deletes.
- **Current Conversation**: bare map lookup (`conversations[currentConversationId] || defaultConversation`); only `defaultConversation` is memoized
- **Streaming Messages**: Separate state during active streaming
- No global state library; component state + props

### Backend Integration

#### PHP Endpoints (XenForo Backend)
- **POST /chat.php**: Main chat API with SSE streaming
- **POST /tts.php**: Text-to-speech generation
- All requests require XenForo session cookies (`credentials: 'include'`)

#### Server-Sent Events (SSE) Protocol
Messages stream as `data:` prefixed JSON lines:
```
data: {"type": "response.output_text.delta", "delta": "Hello"}
data: {"type": "response.output_text.done"}
```

Message types handled:
- `response.output_text.delta` - Incremental text chunks
- `response.output_text.done` - Stream completion
- `response.output_text.annotation.added` - File citations
- `response.content_part.done` - Annotation metadata
- `chat.stream.completed` - **The application terminal event** (chat.php synthesizes it; upstream `response.completed` is deliberately NOT terminal because the proxy may continue a tool chain). A bare `data: [DONE]` is also accepted as terminal defensively, though chat.php never sends one.

#### CAPTCHA Flow (Cloudflare Turnstile)
1. First message from guest triggers `captcha_required` error
2. Frontend displays Turnstile widget with `ENV.TURNSTILE_SITE_KEY`
3. Token sent to `ChatAPI.verifyCaptcha()`
4. Valid token stored in PHP session (2-hour expiry)
5. Subsequent messages include token until session expires

### Domain and Environment Switching
The app supports production and test environments:
- **Production**: `windowsforum.com` → `https://windowsforum.com`
- **Test**: `test.windowsforum.com` → `https://test.windowsforum.com`
- Auto-detected via `ENV.getCurrentDomain()` based on `window.location.hostname`

### Material-UI Theming
Theme syncs with XenForo's light/dark mode:
- Reads `data-color-scheme` attribute from `<html>`
- Falls back to system preference via `prefers-color-scheme`
- Theme created in `src/index.tsx` before app render

### Conversation Management
- **Storage**: per-user v4 envelope `chat_store:v4:<principal>` (conversations + tombstones + pending server deletions); legacy v2/v3 keys are migrated once and removed only after the v4 write succeeds
- **ID Format**: `conv_{timestamp}_{random}` (see `generateConversationId()`)
- **Title Generation**: First 50 chars of first user message
- **Limit**: Configurable via `ENV.MAX_CONVERSATIONS` (default 50). Cap trims tombstone locally but never queue server-side deletions; server deletion is an explicit user action
- **Current Conversation ID**: Tracked separately in localStorage (`current_conversation_id:v4:<principal>`)

### Message Processing Pipeline
1. User input → sanitized via `sanitizeAndParse()` (citation extraction is assistant-only: `{ extractCitations: false }` for user messages)
2. Markdown parsing with `marked` library
3. Citation extraction (URL patterns converted to superscript refs; answers only)
4. HTML sanitization via `DOMPurify`
5. Render with `dangerouslySetInnerHTML`

### Error Handling Strategy
- **ErrorBoundary**: Catches all React component errors
- **API Errors**: Typed errors (`APIError`, `CaptchaRequiredError`)
- **Abort Controller**: Cancels in-flight requests on user stop/navigation
- **Error UI**: User-friendly messages + dev mode stack traces

## TypeScript Considerations

### Strict Mode Enabled
- `noUnusedLocals: true` - Remove unused imports
- `noUnusedParameters: true` - Prefix with `_` if unused (e.g., `_match`)
- `noFallthroughCasesInSwitch: true` - Explicit breaks required

### Common Type Patterns
- Component props: Define interface in `src/types/index.ts`
- API responses: Type return values (e.g., `ChatAPI.getUserData(): Promise<UserData>`)
- Callbacks with unused params: Prefix with underscore `(_ann, idx) => ...`

### useMemo for Derived State
Wrap computed values that are dependency array items:
```typescript
const currentConversation = useMemo(() =>
  conversations[currentConversationId] || defaultValue,
  [conversations, currentConversationId]
);
```

## Environment Variables

Required variables (in `.env`):
```bash
VITE_DOMAIN=https://windowsforum.com
VITE_TEST_DOMAIN=https://test.windowsforum.com
VITE_API_BASE=
VITE_TURNSTILE_SITE_KEY=0x4AAAAAAABiq2_hH-dGCkQi
VITE_ENABLE_VOICE=true
VITE_MAX_CONVERSATIONS=50
```

Access via `ENV` object, never directly via `process.env` in components.

## Troubleshooting

### Tool Registration Mismatch (CRITICAL)

**Issue**: "No tool output found for function call" errors causing empty responses.

**Root Cause**: Tools registered in `/web/fastapi_app/tool_handler.py` must have corresponding handlers in `/web/fastapi_app/responses_router.py` `run_local_function()`.

**Fix**: When adding new tools:
1. Add tool definition to `tool_handler.py` `get_tools()` function
2. Add handler to `responses_router.py` `run_local_function()`
3. Restart service: `systemctl restart aiapi.service`

**Previously Missing Tools** (fixed 2025-09-30):
- `searchThreads` - Now aliases to `searchWindowsForum`
- `search` - MCP-compliant, aliases to `searchWindowsForum`
- `fetch` - MCP-compliant, returns placeholder
- `autoModerateContent` - Returns safe placeholder (moderation should be manual)

### Debugging SSE Stream Issues

If messages are returning empty responses:

1. **Enable Debug Logging**: In browser console, run:
   ```javascript
   localStorage.setItem('debug_sse', 'true');
   ```
   Then send a message. This will log:
   - Each chunk received with size
   - All SSE event types
   - Delta text as it arrives
   - Final stream statistics

2. **Test SSE Directly**: Visit `https://windowsforum.com/test-sse.html` to test the chat.php endpoint directly without the React app. This helps isolate whether the issue is in:
   - The backend SSE stream (Python → PHP → browser)
   - The frontend React/TypeScript parsing logic

3. **Check Console for Warnings**:
   - `"Received X chunks but extracted no text"` - SSE connection works but no text deltas found
   - `"No data received from server"` - SSE connection failed entirely
   - `"Error parsing streaming data"` - Malformed JSON in SSE events

4. **Common SSE Issues**:
   - **Buffering**: PHP may buffer output - check `ob_flush()` and `flush()` calls
   - **CORS/Credentials**: Requests must include `credentials: 'include'` for session cookies
   - **Early Termination**: Component unmounting or AbortController can stop stream
   - **Event Format Mismatch**: Backend sends `response.output_text.delta` with `delta` field

5. **Disable Debug Logging**:
   ```javascript
   localStorage.removeItem('debug_sse');
   ```

## Important Implementation Notes

### Voice Features
- **Speech Recognition**: Web Speech API (Chrome/Edge only)
- **Text-to-Speech**: Server-generated via `/tts.php`
- **Mute State**: Persisted in component state (default: muted)

### Citation Handling
Two regex patterns extract citations:
1. Markdown links: `[text](url)` → superscript `[n]`
2. Bare domains: `(example.com)` → superscript `[n]`
Citations rendered in "Sources" section at message end.

### Conversation Sidebar
- Sorted by `updatedAt` (most recent first)
- Delete button appears on hover
- Selecting conversation switches `currentConversationId`
- New conversation creates fresh ID and welcome message

## Common Pitfalls to Avoid

1. **Never bypass the service layer** - All API calls must go through `ChatAPI`
2. **Don't hardcode domains** - Use `ENV.getCurrentDomain()`
3. **React imports are optional for JSX** - Vite `@vitejs/plugin-react` with `jsx: react-jsx` in `tsconfig.json` enables the automatic JSX transform; still import React (or its hooks) when you use them.
4. **Mark unused callback params** - Prefix with `_` to satisfy TypeScript
5. **Don't forget useMemo** - Wrap objects/arrays used in dependency arrays
6. **Environment variables** - Must start with `VITE_` to be accessible (e.g., `VITE_DOMAIN`)

## Testing Deployment Locally

Before deploying:
1. Commit the complete intended release and confirm `git status --short` is empty.
2. Run the full gate: `npm run check`
3. Confirm `dist/index.html` uses `main.js?v=2` and `main.css?v=2`
4. Test locally: `npm run preview`
5. Coordinate the backend-first rollout, then deploy from the clean commit: `npm run deploy`

## Integration with XenForo

The app expects:
- Valid XenForo session cookie for authenticated users
- Guest users get limited functionality + CAPTCHA requirement
- User data returned from `/chat.php?action=getUserData`:
  ```json
  {
    "avatar": "https://...",
    "name": "Username",
    "user_id": "12345"
  }
  ```

## Build Artifacts

The Vite output contract supports XenForo integration without leaving dependency chunks stale:
- Emits stable `static/js/main.js` and `static/css/main.css` entrypoints, referenced with `?v=2`
- Emits content-hashed JavaScript chunks and bundled media
- Copies `public/.htaccess`, which serves stable entries with `no-cache, must-revalidate` and hashed assets with a one-year immutable policy
- Validates every local reference in generated `dist/index.html`

This is intentional for XenForo integration and should not be "fixed". The
`?v=2` pin (`RELEASE_ASSET_VERSION` in `vite.config.ts`) is a deliberate cache
contract, not an oversight: correctness across deploys rests on the stable
entries' `no-cache` headers plus the immediate Cloudflare purge, and the pin is
never bumped as a routine release step.
