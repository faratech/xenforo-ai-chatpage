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
  console.warn(
    `Missing environment variables: ${missingVars.join(', ')}. Using defaults.`
  );
}
