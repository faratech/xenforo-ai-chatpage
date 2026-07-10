/**
 * Environment configuration
 * Centralizes all environment variable access
 */

export const ENV = {
  // Domain Configuration
  DOMAIN: import.meta.env.VITE_DOMAIN || 'https://windowsforum.com',
  TEST_DOMAIN: import.meta.env.VITE_TEST_DOMAIN || 'https://test.windowsforum.com',
  API_BASE: (import.meta.env.VITE_API_BASE || '').replace(/\/$/, ''),

  // Origin that serves the built /chatpage assets in every environment.
  // Test-domain embeds must not request local assets that only production hosts.
  ASSET_ORIGIN: (import.meta.env.VITE_ASSET_ORIGIN || import.meta.env.VITE_DOMAIN || 'https://windowsforum.com').replace(/\/$/, ''),

  // Get the appropriate domain based on hostname
  getCurrentDomain: (): string => {
    return window.location.hostname === 'test.windowsforum.com'
      ? ENV.TEST_DOMAIN
      : ENV.DOMAIN;
  },

  // Local development uses Vite's same-origin proxy. Production/test default
  // to their detected origin unless an explicit API base is configured.
  getApiBase: (): string => {
    if (ENV.API_BASE) return ENV.API_BASE;
    if (import.meta.env.DEV && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) return '';
    return ENV.getCurrentDomain();
  },

  // Cloudflare Turnstile
  TURNSTILE_SITE_KEY: import.meta.env.VITE_TURNSTILE_SITE_KEY || '0x4AAAAAAABiq2_hH-dGCkQi',

  // Feature flags
  ENABLE_VOICE: import.meta.env.VITE_ENABLE_VOICE !== 'false',
  MAX_CONVERSATIONS: Number.parseInt(import.meta.env.VITE_MAX_CONVERSATIONS || '50', 10),

  // API Endpoints
  ENDPOINTS: {
    CHAT: '/chat.php',
    TTS: '/tts.php',
    USER_DATA: '/chat.php',
    TURNSTILE_VERIFY: '/chat.php',
  },
} as const;
