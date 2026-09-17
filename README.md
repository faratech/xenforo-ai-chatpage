# XenForo AI Chat Page

A React 19 and TypeScript chat interface for XenForo-based sites.

## Quick start

```bash
npm ci
npm run dev
```

Create `.env` from `.env.example` and set the required `VITE_*` values. The
development server runs at `http://localhost:5173`.

## Commands

```bash
npm run dev        # Development server
npm run build      # Production build
npm run preview    # Preview the production build
npm run check      # Lint, type-check, test, and verify the build
```

## Stack

- Vite 8, React 19, and TypeScript
- Material UI and Emotion
- Marked and DOMPurify for safe message rendering
- XenForo-compatible chat and text-to-speech API endpoints

API requests are centralized in `src/services/api.ts`; environment values are
accessed through `src/config/env.ts`.
