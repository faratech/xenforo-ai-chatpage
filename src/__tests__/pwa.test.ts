import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../public/manifest.json';
import serviceWorkerSource from '../../public/service-worker.js?raw';
import {
  PWAInstallPrompt,
  PWAUpdatePrompt,
  PWA_CANONICAL_SCOPE,
  PWA_LEGACY_SCOPE,
  PWA_LEGACY_SERVICE_WORKER_URL,
  PWA_SERVICE_WORKER_URL,
  appScopeForPath,
  ensureManifestLink,
  registerPWA,
} from '../services/pwa';

const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

afterEach(() => {
  document.querySelectorAll('link[rel="manifest"]').forEach(link => link.remove());
  window.history.replaceState({}, '', '/chatpage/');
  if (originalSecureContext) Object.defineProperty(window, 'isSecureContext', originalSecureContext);
  else Reflect.deleteProperty(window, 'isSecureContext');
  if (originalServiceWorker) Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.restoreAllMocks();
});

describe('canonical PWA installation', () => {
  it('maps canonical and legacy documents to narrow worker scopes', () => {
    expect(appScopeForPath('/pages/ai')).toBe(PWA_CANONICAL_SCOPE);
    expect(appScopeForPath('/pages/ai/')).toBe(PWA_CANONICAL_SCOPE);
    expect(appScopeForPath('/chatpage/')).toBe(PWA_LEGACY_SCOPE);
    expect(appScopeForPath('/forums/')).toBeNull();
  });

  it('installs or corrects the manifest link without duplicating it', () => {
    const existing = document.createElement('link');
    existing.rel = 'manifest';
    existing.href = '/old-manifest.json';
    document.head.append(existing);

    expect(ensureManifestLink()).toBe(existing);
    expect(existing.getAttribute('href')).toBe('/chatpage/manifest.json');
    expect(document.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
  });

  it('uses the canonical worker for /pages/ai and the narrow legacy alias for /chatpage', async () => {
    const registration = { waiting: null, installing: null, addEventListener: vi.fn() };
    const register = vi.fn().mockResolvedValue(registration);
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register },
    });

    window.history.replaceState({}, '', '/pages/ai/');
    await registerPWA();
    expect(register).toHaveBeenLastCalledWith(PWA_SERVICE_WORKER_URL, {
      scope: PWA_CANONICAL_SCOPE,
      updateViaCache: 'none',
    });

    window.history.replaceState({}, '', '/chatpage/');
    await registerPWA();
    expect(register).toHaveBeenLastCalledWith(PWA_LEGACY_SERVICE_WORKER_URL, {
      scope: PWA_LEGACY_SCOPE,
      updateViaCache: 'none',
    });
  });

  it('captures the browser prompt and returns its one-shot outcome', async () => {
    const service = new PWAInstallPrompt();
    const availability = vi.fn();
    const unsubscribe = service.subscribe(availability);
    service.start();

    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(service.available).toBe(true);

    await expect(service.prompt()).resolves.toBe('accepted');
    expect(prompt).toHaveBeenCalledOnce();
    expect(service.available).toBe(false);

    unsubscribe();
    service.stop();
  });

  it('exposes a waiting update only through an explicit activation action', () => {
    const postMessage = vi.fn();
    const service = new PWAUpdatePrompt();
    const availability = vi.fn();
    service.subscribe(availability);
    service.watch({
      waiting: { postMessage } as unknown as ServiceWorker,
      installing: null,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration);

    expect(service.available).toBe(true);
    expect(service.activate()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(service.available).toBe(false);
  });

  it('observes an installer that already exists when registration resolves', () => {
    let stateChange: (() => void) | undefined;
    const installing = {
      state: 'installing',
      postMessage: vi.fn(),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'statechange') stateChange = listener;
      }),
    };
    const registration = {
      waiting: null as typeof installing | null,
      installing,
      addEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { controller: {} },
    });
    const service = new PWAUpdatePrompt();

    service.watch(registration as unknown as ServiceWorkerRegistration);
    expect(service.available).toBe(false);

    registration.waiting = installing;
    installing.state = 'installed';
    stateChange?.();
    expect(service.available).toBe(true);
  });

  it('declares /pages/ai as the installed identity while retaining /chatpage assets', () => {
    expect(manifest).toMatchObject({
      id: '/pages/ai/',
      start_url: '/pages/ai/',
      scope: '/pages/ai/',
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512' }),
    ]));
  });

  it('bounds the public asset cache while preserving the offline shell', () => {
    const limit = serviceWorkerSource.match(/const MAX_CACHE_ENTRIES = (\d+);/);
    expect(limit).not.toBeNull();
    expect(Number(limit?.[1])).toBeGreaterThanOrEqual(20);
    expect(Number(limit?.[1])).toBeLessThanOrEqual(100);
    expect(serviceWorkerSource).toContain('const keys = await cache.keys()');
    expect(serviceWorkerSource).toContain("url.search === ''");
    expect(serviceWorkerSource).toContain('PRECACHE_URLS.includes(url.pathname)');
    expect(serviceWorkerSource).toContain('evictable.slice(0, overflow)');
    expect(serviceWorkerSource.match(/await trimCache\(cache\)/g)).toHaveLength(3);
    expect(serviceWorkerSource).toContain("event.data.type === 'SKIP_WAITING'");
  });
});
