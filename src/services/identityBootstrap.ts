import type { UserData } from '../types';

const BOOTSTRAP_TIMEOUT_MS = 15_000;

/**
 * Starts the one blocking identity request before the hashed React application
 * graph downloads. This service intentionally has no runtime imports from the
 * application graph: bootstrap.ts passes the promise through the mount
 * boundary, so content-hashed chunks never need to import stable main.js.
 */
export const startIdentityBootstrap = (): Promise<UserData> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
  const configuredBase = import.meta.env.VITE_API_BASE?.trim() ?? '';
  const endpoint = `${configuredBase.replace(/\/$/, '')}/chat.php`;

  return fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getUserData' }),
    signal: controller.signal,
  }).then(async response => {
    if (!response.ok) {
      throw new Error(`Identity bootstrap failed with HTTP ${response.status}.`);
    }
    return await response.json() as UserData;
  }).finally(() => window.clearTimeout(timeout));
};
