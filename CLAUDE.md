# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build and Run
- `npm start` - Start development server at http://localhost:3000
- `npm run build` - Build for production to the `build` folder
- `npm test` - Run tests in interactive watch mode

### Project Setup
- This is a Create React App project
- Build output directory: `build/`
- Homepage is set to `/chatpage` in package.json

## Architecture Overview

### Core Application
This is a React-based chat interface for XenForo that integrates with an AI chatbot service. The application includes:

- **Frontend**: React chat UI with Material-UI components
- **Backend Integration**: PHP backend at `/chat.php` handling message processing
- **Cloudflare Turnstile**: CAPTCHA verification to prevent abuse

### Key Components

#### Frontend Structure
- **Main App**: `/src/App.js` - Core chat interface with:
  - Real-time streaming responses
  - Message history management
  - Voice input/output capabilities
  - Turnstile CAPTCHA integration
  - Material-UI theming

#### Backend Integration Points
- **Chat API**: `${domain}/chat.php` - Main chat endpoint
- **Session Management**: XenForo session validation
- **Turnstile Verification**: `/turnstile-verify.php` for CAPTCHA validation

### Important Implementation Details

#### Streaming Response Handling
The app uses Server-Sent Events (SSE) for real-time message streaming:
- Chunks are parsed from `data:` prefixed lines
- Message types: `response.output_text.delta` and `response.output_text.done`

#### CAPTCHA Flow
1. First message triggers CAPTCHA requirement
2. Frontend displays Turnstile widget
3. Token verification via backend
4. Session stores verification (2-hour expiry)

#### Domain Configuration
- Production: `https://windowsforum.com`
- Test: `https://test.windowsforum.com`
- Data/Assets: `https://data.windowsforum.com`

## Security Considerations

### API Keys (Currently Hardcoded - Should be Moved)
- Turnstile Site Key: `0x4AAAAAAABiq2_hH-dGCkQi`
- Secret key is server-side only in PHP files

### Session Security
- XenForo session validation required
- CORS properly configured for domain restrictions
- CAPTCHA verification stored in PHP sessions