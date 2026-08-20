import { ChatAPI } from './api';
import type { ClientTelemetryEvent } from './apiContracts';

export interface ClientEventDetails {
  /** Ephemeral turn/event correlation only; never pass a user or conversation id. */
  eventId?: string;
  errorCode?: string;
  durationMs?: number;
  value?: number;
  /** Low-cardinality result enum such as success, stopped, or markdown_download. */
  outcome?: string;
}

const BUILD_ID = typeof __WF_BUILD_ID__ === 'string' ? __WF_BUILD_ID__ : 'development';
const SURFACE = 'chatpage' as const;

const normalizedCode = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const code = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 64);
  return code || undefined;
};

const normalizedEventId = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const id = value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 96);
  return id || undefined;
};

const normalizedOutcome = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const outcome = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 64);
  return outcome || undefined;
};

const boundedDuration = (value: number | undefined): number | undefined => (
  value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.min(600_000, Math.max(0, Math.round(value)))
);

const boundedValue = (value: number | undefined): number | undefined => (
  value === undefined || !Number.isFinite(value)
    ? undefined
    : Number(Math.min(1_000, Math.max(0, value)).toFixed(4))
);

export const reportClientEvent = (
  event: ClientTelemetryEvent,
  details: ClientEventDetails = {},
): void => {
  if (import.meta.env.MODE === 'test') return;

  const payload = {
    event,
    release: BUILD_ID,
    surface: SURFACE,
    event_id: normalizedEventId(details.eventId),
    error_code: normalizedCode(details.errorCode),
    duration_ms: boundedDuration(details.durationMs),
    value: boundedValue(details.value),
    outcome: normalizedOutcome(details.outcome),
  };

  void ChatAPI.submitClientTelemetry(payload).catch(() => undefined);
};

export type ChatLifecycleEvent =
  | 'chat_send_started'
  | 'chat_first_token'
  | 'chat_completed'
  | 'chat_stopped'
  | 'chat_failed';

export const reportChatLifecycle = (
  event: ChatLifecycleEvent,
  details: ClientEventDetails = {},
): void => reportClientEvent(event, details);

export type SourceKind = 'url' | 'file' | 'container_file' | 'generated_file';

export const reportSourceOpened = (
  sourceKind: SourceKind,
  sourceIndex?: number,
  eventId?: string,
): void => reportClientEvent('source_opened', {
  eventId,
  outcome: sourceKind,
  value: sourceIndex,
});

export type ExportDelivery =
  | 'download'
  | 'clipboard'
  | 'web-share-file'
  | 'web-share-text'
  | 'cancelled';

export const reportConversationExport = (
  format: 'markdown' | 'json' | 'text',
  delivery: ExportDelivery,
  messageCount: number,
  eventId?: string,
): void => reportClientEvent('conversation_exported', {
  eventId,
  outcome: `${format}_${delivery}`,
  value: messageCount,
});

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
