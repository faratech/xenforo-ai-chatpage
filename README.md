# XenForo AI Chat Page

A TypeScript React 19 chat UI embedded in windowsforum.com/chatpage.

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) to view it in your browser.

## Available Scripts

- `npm run dev` - Start the Vite development server at http://localhost:5173
- `npm run build` - Build for production to the `dist/` directory
- `npm run preview` - Preview the production build locally
- `npm run typecheck` - Type-check the project with `tsc --noEmit`
- `npm run deploy` - Build and deploy to the production chatpage

## Tech Stack

- Vite 8 + React 19 + TypeScript
- MUI 9 + Emotion
- marked + DOMPurify (markdown parsing and sanitization)
- XenForo PHP endpoints: `/chat.php` (SSE chat) & `/tts.php` (text-to-speech)

## Environment Setup

Create a `.env` file with `VITE_*` prefixed variables (Vite exposes only
variables prefixed with `VITE_` to client code). See [./CLAUDE.md](./CLAUDE.md)
for the full list and details.

## Documentation

See [./CLAUDE.md](./CLAUDE.md) for architecture, backend integration, and
development guidance.
