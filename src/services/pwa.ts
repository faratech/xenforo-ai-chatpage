/**
 * PWA registration for the two URLs that host this application.
 *
 * `/pages/ai/` is the canonical install identity. `/chatpage/` remains the
 * release asset host and a compatible standalone entry, but must never replace
 * the canonical XenForo URL in an installed app's manifest.
 */

export const PWA_CANONICAL_SCOPE = '/pages/ai/';
export const PWA_LEGACY_SCOPE = '/chatpage/';
export const PWA_MANIFEST_URL = '/chatpage/manifest.json';
export const PWA_SERVICE_WORKER_URL = '/chatpage/service-worker.js';
export const PWA_LEGACY_SERVICE_WORKER_URL = '/chatpage/legacy-service-worker.js';

export type AppScope = typeof PWA_CANONICAL_SCOPE | typeof PWA_LEGACY_SCOPE;

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export type InstallPromptOutcome = 'accepted' | 'dismissed' | 'unavailable';

type UpdateListener = (available: boolean) => void;

/** Tracks an installed worker that is waiting for an explicit, user-safe reload. */
export class PWAUpdatePrompt {
  private waiting: ServiceWorker | null = null;
  private listeners = new Set<UpdateListener>();
  private watchedRegistration: ServiceWorkerRegistration | null = null;
  private observedInstalling: ServiceWorker | null = null;

  private readonly refresh = (registration: ServiceWorkerRegistration): void => {
    this.waiting = registration.waiting;
    this.listeners.forEach(listener => listener(this.available));
  };

  private observeInstalling(registration: ServiceWorkerRegistration): void {
    const installing = registration.installing;
    if (!installing || installing === this.observedInstalling) return;
    this.observedInstalling = installing;
    const handleState = () => {
      // Terminal states end the watch; without removing the listener, every
      // update cycle left one behind on a worker object that outlives it.
      if (installing.state === 'installed' || installing.state === 'redundant') {
        installing.removeEventListener('statechange', handleState);
      }
      if (
        installing.state === 'installed'
        && 'serviceWorker' in navigator
        && navigator.serviceWorker.controller
      ) {
        this.refresh(registration);
      }
    };
    if (installing.state === 'redundant') return;
    if (installing.state === 'installed') handleState();
    else installing.addEventListener('statechange', handleState);
  }

  watch(registration: ServiceWorkerRegistration): void {
    if (this.watchedRegistration === registration) {
      this.refresh(registration);
      return;
    }
    this.watchedRegistration = registration;
    this.observedInstalling = null;
    this.refresh(registration);
    // register() may resolve after updatefound has already fired, so observe
    // an existing installing worker as well as future replacements.
    this.observeInstalling(registration);
    registration.addEventListener('updatefound', () => this.observeInstalling(registration));
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.available);
    return () => this.listeners.delete(listener);
  }

  get available(): boolean {
    return this.waiting !== null;
  }

  activate(): boolean {
    const worker = this.waiting;
    if (!worker || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return false;
    }
    // Keep `waiting` set until the worker actually takes control. Clearing it
    // up front meant a dropped SKIP_WAITING message (worker idling out before
    // handling it) left the UI reporting an update applied that never was,
    // with the prompt unrecoverable.
    const onControllerChange = () => {
      this.waiting = null;
      this.listeners.forEach(listener => listener(this.available));
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    worker.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }
}

export const pwaUpdatePrompt = new PWAUpdatePrompt();

const isPathWithin = (pathname: string, scope: AppScope): boolean => {
  const withoutTrailingSlash = scope.slice(0, -1);
  return pathname === withoutTrailingSlash || pathname.startsWith(scope);
};

/** Returns the narrowest worker scope suitable for the current application URL. */
export const appScopeForPath = (pathname: string): AppScope | null => {
  if (isPathWithin(pathname, PWA_CANONICAL_SCOPE)) return PWA_CANONICAL_SCOPE;
  if (isPathWithin(pathname, PWA_LEGACY_SCOPE)) return PWA_LEGACY_SCOPE;
  return null;
};

/**
 * XenForo owns the canonical document head, so the application adds the
 * manifest link when the template has not already supplied one.
 */
export const ensureManifestLink = (targetDocument: Document = document): HTMLLinkElement => {
  const existing = targetDocument.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (existing) {
    if (existing.getAttribute('href') !== PWA_MANIFEST_URL) {
      existing.setAttribute('href', PWA_MANIFEST_URL);
    }
    return existing;
  }

  const link = targetDocument.createElement('link');
  link.rel = 'manifest';
  link.href = PWA_MANIFEST_URL;
  targetDocument.head.append(link);
  return link;
};

/**
 * Registers only a narrow application scope. The worker response carries a
 * Service-Worker-Allowed header because its script lives under `/chatpage/`
 * while the canonical client lives under `/pages/ai/`.
 */
export const registerPWA = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof window === 'undefined' || !window.isSecureContext || !('serviceWorker' in navigator)) {
    return null;
  }
  const scope = appScopeForPath(window.location.pathname);
  if (!scope) return null;

  const workerUrl = scope === PWA_CANONICAL_SCOPE
    ? PWA_SERVICE_WORKER_URL
    : PWA_LEGACY_SERVICE_WORKER_URL;
  const registration = await navigator.serviceWorker.register(workerUrl, {
    scope,
    updateViaCache: 'none',
  });
  pwaUpdatePrompt.watch(registration);
  ensureManifestLink();
  return registration;
};

/**
 * Holds the browser's one-shot install prompt without installing anything on
 * its own. A component can subscribe and render an explicit, user-triggered
 * Install action.
 */
export class PWAInstallPrompt {
  private promptEvent: BeforeInstallPromptEvent | null = null;
  private listeners = new Set<(available: boolean) => void>();
  private started = false;

  private readonly onPrompt = (event: Event): void => {
    event.preventDefault();
    this.promptEvent = event as BeforeInstallPromptEvent;
    this.notify();
  };

  private readonly onInstalled = (): void => {
    this.promptEvent = null;
    this.notify();
  };

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    window.addEventListener('beforeinstallprompt', this.onPrompt);
    window.addEventListener('appinstalled', this.onInstalled);
  }

  stop(): void {
    if (!this.started || typeof window === 'undefined') return;
    window.removeEventListener('beforeinstallprompt', this.onPrompt);
    window.removeEventListener('appinstalled', this.onInstalled);
    this.promptEvent = null;
    this.started = false;
    this.notify();
  }

  subscribe(listener: (available: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.available);
    return () => this.listeners.delete(listener);
  }

  get available(): boolean {
    return this.promptEvent !== null;
  }

  async prompt(): Promise<InstallPromptOutcome> {
    const event = this.promptEvent;
    if (!event) return 'unavailable';
    this.promptEvent = null;
    this.notify();
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  }

  private notify(): void {
    const available = this.available;
    this.listeners.forEach(listener => listener(available));
  }
}

export const pwaInstallPrompt = new PWAInstallPrompt();
