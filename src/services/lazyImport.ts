const LAZY_IMPORT_RELOAD_KEY = 'wf_chat_lazy_reload:v1';

/**
 * Keep a failed release asset from putting a long-lived tab into a reload loop.
 * A later deployment may legitimately need one more recovery attempt, so the
 * marker expires within the same browser session instead of lasting forever.
 */
export const LAZY_IMPORT_RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

interface LazyImportRecoveryRuntime {
  online: boolean;
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void;
}

export const shouldRecoverLazyImport = (
  online: boolean,
  lastAttemptAt: number | null,
  now: number,
): boolean => (
  online
  && (lastAttemptAt === null || now - lastAttemptAt >= LAZY_IMPORT_RELOAD_COOLDOWN_MS)
);

const browserRuntime = (): LazyImportRecoveryRuntime | null => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;

  try {
    return {
      online: navigator.onLine,
      now: Date.now,
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    };
  } catch {
    // sessionStorage can be unavailable in locked-down browsing contexts.
    return null;
  }
};

const claimRecoveryReload = (runtime: LazyImportRecoveryRuntime): boolean => {
  const now = runtime.now();

  try {
    const raw = runtime.storage.getItem(LAZY_IMPORT_RELOAD_KEY);
    const parsed = raw === null ? null : Number(raw);
    const lastAttemptAt = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    if (!shouldRecoverLazyImport(runtime.online, lastAttemptAt, now)) return false;
    runtime.storage.setItem(LAZY_IMPORT_RELOAD_KEY, String(now));
    return true;
  } catch {
    // Without a durable per-session marker, reloading could loop indefinitely.
    return false;
  }
};

/**
 * Load a React.lazy module and recover once from a stale hashed release graph.
 *
 * Atomic releases intentionally remove prior hashed chunks. If a tab that was
 * already open asks for one of those chunks, a single online reload moves it
 * onto the current graph. The promise remains pending while navigation starts
 * so React does not flash the global error boundary first.
 */
export const loadLazyModule = async <T>(
  loader: () => Promise<T>,
  runtime: LazyImportRecoveryRuntime | null = browserRuntime(),
): Promise<T> => {
  try {
    return await loader();
  } catch (error) {
    if (!runtime || !claimRecoveryReload(runtime)) throw error;

    try {
      runtime.reload();
    } catch {
      throw error;
    }

    return await new Promise<T>(() => undefined);
  }
};
