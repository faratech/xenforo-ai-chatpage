/**
 * Environment configuration
 * Centralizes all environment variable access
 */

export const ENV = {
  // Domain Configuration
  DOMAIN: process.env.REACT_APP_DOMAIN || 'https://windowsforum.com',
  TEST_DOMAIN: process.env.REACT_APP_TEST_DOMAIN || 'https://test.windowsforum.com',
  DATA_DOMAIN: process.env.REACT_APP_DATA_DOMAIN || 'https://data.windowsforum.com',

  // Get the appropriate domain based on hostname
  getCurrentDomain: (): string => {
    return window.location.hostname === 'test.windowsforum.com'
      ? ENV.TEST_DOMAIN
      : ENV.DOMAIN;
  },

  // Cloudflare Turnstile
  TURNSTILE_SITE_KEY: process.env.REACT_APP_TURNSTILE_SITE_KEY || '0x4AAAAAAABiq2_hH-dGCkQi',

  // Feature Flags
  ENABLE_VOICE: process.env.REACT_APP_ENABLE_VOICE === 'true',
  ENABLE_FEEDBACK: process.env.REACT_APP_ENABLE_FEEDBACK !== 'false',
  MAX_CONVERSATIONS: parseInt(process.env.REACT_APP_MAX_CONVERSATIONS || '50', 10),

  // API Endpoints
  ENDPOINTS: {
    CHAT: '/chat.php',
    TTS: '/tts.php',
    USER_DATA: '/chat.php',
    TURNSTILE_VERIFY: '/chat.php',
  },
} as const;

// Validate required environment variables
const requiredVars = ['REACT_APP_DOMAIN'];
const missingVars = requiredVars.filter(
  varName => !process.env[varName]
);

if (missingVars.length > 0) {
  console.warn(
    `Missing environment variables: ${missingVars.join(', ')}. Using defaults.`
  );
}