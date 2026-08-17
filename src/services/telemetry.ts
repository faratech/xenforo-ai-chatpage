import { ENV } from '../config/env';

type ClientEvent =
  | 'app_error'
  | 'unhandled_rejection'
  | 'largest_contentful_paint'
  | 'layout_shift'
  | 'navigation';

interface ClientEventDetails {
  errorCode?: string;
  durationMs?: number;
  value?: number;
}

const BUILD_ID = typeof __WF_BUILD_ID__ === 'string' ? __WF_BUILD_ID__ : 'development';
const SURFACE = typeof __WF_SURFACE__ === 'string' ? __WF_SURFACE__ : 'chatpage';

const normalizedCode = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const code = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 64);
  return code || undefined;
};

export const reportClientEvent = (event: ClientEvent, details: ClientEventDetails = {}): void => {
  if (import.meta.env.MODE === 'test') return;

  const payload = {
    action: 'clientTelemetry',
    event,
    release: BUILD_ID,
    surface: SURFACE,
    error_code: normalizedCode(details.errorCode),
    duration_ms: details.durationMs === undefined ? undefined : Math.round(details.durationMs),
    value: details.value === undefined ? undefined : Number(details.value.toFixed(4)),
  };

  void fetch(`${ENV.getApiBase()}${ENV.ENDPOINTS.CHAT}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
};

export const installClientTelemetry = (): (() => void) => {
  if (import.meta.env.MODE === 'test') return () => undefined;

  const onError = (event: ErrorEvent) => {
    reportClientEvent('app_error', { errorCode: event.error?.name || 'window_error' });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    reportClientEvent('unhandled_rejection', {
      errorCode: reason instanceof Error ? reason.name : 'non_error_rejection',
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  const observers: PerformanceObserver[] = [];
  let onPageHide: (() => void) | null = null;
  let onVisibilityChange: (() => void) | null = null;
  let onFirstInput: (() => void) | null = null;
  if ('PerformanceObserver' in window) {
    try {
      let cls = 0;
      let latestLcp: number | undefined;
      let lcpReported = false;
      let pageVitalsReported = false;
      const layoutObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (!shift.hadRecentInput) cls += shift.value ?? 0;
        }
      });
      layoutObserver.observe({ type: 'layout-shift', buffered: true });
      observers.push(layoutObserver);

      const lcpObserver = new PerformanceObserver(list => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) latestLcp = last.startTime;
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      observers.push(lcpObserver);

      const reportFinalLcp = () => {
        if (lcpReported) return;
        lcpReported = true;
        lcpObserver.disconnect();
        if (latestLcp !== undefined) {
          reportClientEvent('largest_contentful_paint', { durationMs: latestLcp });
        }
      };
      const reportPageVitals = () => {
        reportFinalLcp();
        if (pageVitalsReported) return;
        pageVitalsReported = true;
        reportClientEvent('layout_shift', { value: cls });
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (navigation) reportClientEvent('navigation', { durationMs: navigation.domContentLoadedEventEnd });
      };
      onPageHide = reportPageVitals;
      onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') reportPageVitals();
      };
      // LCP is final at the first user input even when the page stays open.
      onFirstInput = reportFinalLcp;
      window.addEventListener('pagehide', onPageHide);
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('pointerdown', onFirstInput, { once: true, capture: true });
      window.addEventListener('keydown', onFirstInput, { once: true, capture: true });
    } catch {
      // Older engines can expose PerformanceObserver without these entry types.
    }
  }

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    if (onPageHide) window.removeEventListener('pagehide', onPageHide);
    if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange);
    if (onFirstInput) {
      window.removeEventListener('pointerdown', onFirstInput, true);
      window.removeEventListener('keydown', onFirstInput, true);
    }
    observers.forEach(observer => observer.disconnect());
  };
};
