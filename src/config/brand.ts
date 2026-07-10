/**
 * WindowsForum "Ask the AI" brand constants.
 * Centralizes the assistant identity + asset paths used across the UI.
 */

import { ENV } from './env';

// Local dev serves the Vite `public/` dir under the configured base
// ("/chatpage/"). Deployed embeds — including test.windowsforum.com, which
// does not host the /chatpage release — resolve the avatar from the
// configured production asset origin.
export const BOT_AVATAR = import.meta.env.DEV
  ? `${import.meta.env.BASE_URL}bot-avatar.webp`
  : `${ENV.ASSET_ORIGIN}/chatpage/bot-avatar.webp`;

export const ASSISTANT_NAME = 'WindowsForum Assistant';
export const ASSISTANT_TAGLINE = 'Windows & IT help, grounded in WindowsForum threads';
