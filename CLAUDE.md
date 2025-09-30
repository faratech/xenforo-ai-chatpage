# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build and Run
- `npm start` - Start development server at http://localhost:3000
- `npm run build` - Standard production build with hashed filenames
- `npm run build:consistent` - Production build with consistent filenames (uses `build.sh`)
- `npm test` - Run tests in interactive watch mode
- `npm run deploy` - Build and deploy to `/web/public_html/chatpage/` (production)

### Deployment
The app is deployed to `/web/public_html/chatpage/` which serves `https://windowsforum.com/chatpage`. The `build.sh` script removes hash suffixes from built files for cache consistency.

### Project Configuration
- **Framework**: Create React App with TypeScript
- **Build Output**: `build/` directory
- **Base Path**: `/chatpage` (configured in package.json homepage)
- **Environment**: Variables in `.env` must be prefixed with `REACT_APP_`

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
- **Conversations**: Stored in localStorage, managed in ChatWindow
- **Current Conversation**: Wrapped in useMemo for performance
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
- **Storage**: localStorage with key `chat_conversations`
- **ID Format**: `conv_{timestamp}_{random}` (see `generateConversationId()`)
- **Title Generation**: First 50 chars of first user message
- **Limit**: Configurable via `ENV.MAX_CONVERSATIONS` (default 50)
- **Current Conversation ID**: Tracked separately in localStorage

### Message Processing Pipeline
1. User input → sanitized via `sanitizeAndParse()`
2. Markdown parsing with `marked` library
3. Citation extraction (URL patterns converted to superscript refs)
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
REACT_APP_DOMAIN=https://windowsforum.com
REACT_APP_TEST_DOMAIN=https://test.windowsforum.com
REACT_APP_DATA_DOMAIN=https://data.windowsforum.com
REACT_APP_TURNSTILE_SITE_KEY=0x4AAAAAAABiq2_hH-dGCkQi
REACT_APP_ENABLE_VOICE=true
REACT_APP_MAX_CONVERSATIONS=50
```

Access via `ENV` object, never directly via `process.env` in components.

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
3. **Don't use `React` import in TypeScript** - CRA handles JSX transform
4. **Mark unused callback params** - Prefix with `_` to satisfy TypeScript
5. **Don't forget useMemo** - Wrap objects/arrays used in dependency arrays
6. **Environment variables** - Must start with `REACT_APP_` to be accessible

## Testing Deployment Locally

Before deploying:
1. Test build: `npm run build:consistent`
2. Verify output: Check `build/static/js/main.js` exists (no hash)
3. Test locally: `npx serve -s build -l 3000`
4. Deploy: `npm run deploy` (requires server access)

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

The `build.sh` script ensures consistent filenames for XenForo template integration:
- Removes hash suffixes from JS/CSS files
- Updates `index.html` and `asset-manifest.json` references
- Allows hardcoded paths in XenForo templates without cache busting

This is intentional for XenForo integration and should not be "fixed".