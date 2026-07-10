# XenForo AI Chat Page

A TypeScript React 19 chat UI embedded in windowsforum.com/chatpage.

## Quick Start

```bash
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to view it in your browser.

## Available Scripts

- `npm run dev` - Start the Vite development server at http://localhost:5173
- `npm run build` - Build for production to the `dist/` directory
- `npm run preview` - Preview the production build locally
- `npm run typecheck` - Type-check with the native TypeScript 7 compiler (root `typescript`)
- `npm run check` - Run lint, typecheck, tests, build, and release verification
- `npm run deploy` - Run all checks and atomically activate a production release
- `./deploy.sh rollback` - Restore the previously activated release

## Tech Stack

- Vite 8 + React 19 + TypeScript
- MUI 9 + Emotion
- marked + DOMPurify (markdown parsing and sanitization)
- XenForo PHP endpoints: `/chat.php` (SSE chat) & `/tts.php` (text-to-speech)

## Environment Setup

Create a `.env` file with `VITE_*` prefixed variables (Vite exposes only
variables prefixed with `VITE_` to client code). See [./CLAUDE.md](./CLAUDE.md)
for the full list and details.

`VITE_DOMAIN` and `VITE_TEST_DOMAIN` must be valid HTTP(S) URLs for production
builds. `VITE_API_BASE` is optional: leave it empty for same-origin API calls,
or set an absolute origin/root-relative base. Local Vite development proxies
`/chat.php` and `/tts.php` to `VITE_TEST_DOMAIN`.

## Release Contract

XenForo references stable `static/js/main.js?v=2` and
`static/css/main.css?v=2` entrypoints. Imported JavaScript chunks and bundled
media use content hashes. Stable files are served with `no-cache` while hashed
files are immutable.

Production releases are staged under `/web/releases/xenforo-ai-chatpage/` and
staged at the same path on the OCI peer before atomically switching both nodes'
`/web/public_html/chatpage` links. Deployment also
verifies the XenForo source-template diff is limited to the four chat consumers,
syncs them through `xf-designer:sync-templates`, purges only the Cloudflare
`windowsforum.com/chatpage` prefix, and checks hashes/headers on both origins and
through the public edge. Coordinate the backend-first rollout before running it.

## Documentation

See [./CLAUDE.md](./CLAUDE.md) for architecture, backend integration, and
development guidance.
