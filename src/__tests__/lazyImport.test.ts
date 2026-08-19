import { describe, expect, it, vi } from 'vitest';
import {
  LAZY_IMPORT_RELOAD_COOLDOWN_MS,
  loadLazyModule,
  shouldRecoverLazyImport,
} from '../services/lazyImport';

const createRuntime = ({
  online = true,
  now = 10_000,
  stored = null as string | null,
} = {}) => {
  let value = stored;
  const reload = vi.fn();
  return {
    reload,
    runtime: {
      online,
      now: () => now,
      storage: {
        getItem: vi.fn(() => value),
        setItem: vi.fn((_key: string, next: string) => {
          value = next;
        }),
      },
      reload,
    },
    storedValue: () => value,
  };
};

describe('lazy release import recovery', () => {
  it('returns a module without touching recovery state when the import succeeds', async () => {
    const { runtime, reload } = createRuntime();
    const module = { default: 'loaded' };

    await expect(loadLazyModule(async () => module, runtime)).resolves.toBe(module);
    expect(runtime.storage.getItem).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload while offline', async () => {
    const { runtime, reload } = createRuntime({ online: false });
    const failure = new TypeError('chunk unavailable');

    await expect(loadLazyModule(() => Promise.reject(failure), runtime)).rejects.toBe(failure);
    expect(reload).not.toHaveBeenCalled();
  });

  it('claims one online recovery and keeps the lazy promise pending during reload', async () => {
    const { runtime, reload, storedValue } = createRuntime({ now: 42_000 });
    const pending = loadLazyModule(
      () => Promise.reject(new TypeError('stale release chunk')),
      runtime,
    );

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(storedValue()).toBe('42000');
    expect(await Promise.race([
      pending.then(() => 'settled', () => 'settled'),
      Promise.resolve('pending'),
    ])).toBe('pending');
  });

  it('preserves the original failure while the session cooldown is active', async () => {
    const now = 80_000;
    const { runtime, reload } = createRuntime({
      now,
      stored: String(now - LAZY_IMPORT_RELOAD_COOLDOWN_MS + 1),
    });
    const failure = new TypeError('still unavailable');

    await expect(loadLazyModule(() => Promise.reject(failure), runtime)).rejects.toBe(failure);
    expect(reload).not.toHaveBeenCalled();
  });

  it('allows a later release recovery after the bounded cooldown', () => {
    expect(shouldRecoverLazyImport(
      true,
      1_000,
      1_000 + LAZY_IMPORT_RELOAD_COOLDOWN_MS,
    )).toBe(true);
  });
});
