/**
 * Environment configuration
 * Centralizes all environment variable access
 */

export const ENV = {
  // Domain Configuration
  DOMAIN: import.meta.env.VITE_DOMAIN || 'https://windowsforum.com',
  TEST_DOMAIN: import.meta.env.VITE_TEST_DOMAIN || 'https://test.windowsforum.com',

  // Get the appropriate domain based on hostname
  getCurrentDomain: (): string => {
    return window.location.hostname === 'test.windowsforum.com'
      ? ENV.TEST_DOMAIN
      : ENV.DOMAIN;
  },

  // Cloudflare Turnstile
  TURNSTILE_SITE_KEY: import.meta.env.VITE_TURNSTILE_SITE_KEY || '0x4AAAAAAABiq2_hH-dGCkQi',

  // Feature flags
  ENABLE_VOICE: import.meta.env.VITE_ENABLE_VOICE !== 'false',
  ENABLE_FEEDBACK: import.meta.env.VITE_ENABLE_FEEDBACK !== 'false',
  MAX_CONVERSATIONS: Number.parseInt(import.meta.env.VITE_MAX_CONVERSATIONS || '50', 10),

  // API Endpoints
  ENDPOINTS: {
    CHAT: '/chat.php',
    TTS: '/tts.php',
    USER_DATA: '/chat.php',
    TURNSTILE_VERIFY: '/chat.php',
  },
} as const;

// Validate required environment variables
const requiredVars = ['VITE_DOMAIN'];
const missingVars = requiredVars.filter(
  varName => !import.meta.env[varName]
);

if (missingVars.length > 0) {
  if (import.meta.env.PROD) {
    throw new Error(
      `Critical configuration error: Missing required environment variables: ${missingVars.join(', ')}.`
    );
  } else {
    console.warn(
      `Missing environment variables: ${missingVars.join(', ')}. Using defaults.`
    );
  }
}
