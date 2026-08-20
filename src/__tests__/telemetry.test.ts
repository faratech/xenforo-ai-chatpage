import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ObserverRecord {
  type?: string;
  disconnected: boolean;
  emit: (entries: PerformanceEntry[]) => void;
}

let observerRecords: ObserverRecord[] = [];

class MockPerformanceObserver {
  private readonly callback: PerformanceObserverCallback;
  private readonly record: ObserverRecord;

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback;
    this.record = {
      disconnected: false,
      emit: entries => this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver),
    };
    observerRecords.push(this.record);
  }

  observe(options: PerformanceObserverInit): void {
    this.record.type = options.type;
  }

  disconnect(): void {
    this.record.disconnected = true;
  }
}

beforeEach(() => {
  observerRecords = [];
  vi.resetModules();
  vi.stubEnv('MODE', 'production');
  vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('client telemetry lifecycle', () => {
  it('reports the final LCP once with one stable build and surface, then cleans up listeners', async () => {
    const { installClientTelemetry } = await import('../services/telemetry');
    const cleanup = installClientTelemetry();
    const lcp = observerRecords.find(record => record.type === 'largest-contentful-paint');
    expect(lcp).toBeDefined();

    lcp?.emit([
      { startTime: 120 } as PerformanceEntry,
      { startTime: 240 } as PerformanceEntry,
    ]);
    expect(fetch).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    lcp?.emit([{ startTime: 360 } as PerformanceEntry]);
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();

    const payloads = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    const lcpPayloads = payloads.filter(payload => payload.event === 'largest_contentful_paint');
    expect(lcpPayloads).toHaveLength(1);
    expect(lcpPayloads[0]).toMatchObject({
      duration_ms: 240,
      release: 'development',
      surface: 'chatpage',
    });
    expect(lcp?.disconnected).toBe(true);

    const callsBeforeCleanup = vi.mocked(fetch).mock.calls.length;
    cleanup();
    window.dispatchEvent(new Event('error'));
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(callsBeforeCleanup);
  });

  it('emits only bounded, low-cardinality chat/source/export metadata', async () => {
    const {
      reportChatLifecycle,
      reportClientEvent,
      reportConversationExport,
      reportSourceOpened,
    } = await import('../services/telemetry');

    reportChatLifecycle('chat_failed', {
      eventId: 'turn:abc/unsafe',
      errorCode: 'UPSTREAM TIMEOUT!',
      durationMs: -50,
      outcome: 'Retry / offered',
    });
    reportSourceOpened('url', 3, 'turn:abc');
    reportConversationExport('markdown', 'web-share-file', 5_000, 'export:one');
    reportConversationExport('text', 'clipboard', 7, 'export:two');
    reportClientEvent('history_search', { outcome: 'no_results', value: 0 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));

    const payloads = vi.mocked(fetch).mock.calls.map(([, init]) => (
      JSON.parse(String(init?.body)) as Record<string, unknown>
    ));
    expect(payloads[0]).toMatchObject({
      action: 'clientTelemetry',
      event: 'chat_failed',
      event_id: 'turn:abc_unsafe',
      error_code: 'upstream_timeout_',
      duration_ms: 0,
      outcome: 'retry___offered',
    });
    expect(payloads[1]).toMatchObject({
      event: 'source_opened',
      outcome: 'url',
      value: 3,
    });
    expect(payloads[2]).toMatchObject({
      event: 'conversation_exported',
      outcome: 'markdown_web-share-file',
      value: 1_000,
    });
    expect(payloads[3]).toMatchObject({
      event: 'conversation_exported',
      outcome: 'text_clipboard',
      value: 7,
    });
    expect(payloads[4]).toMatchObject({
      event: 'history_search',
      outcome: 'no_results',
      value: 0,
    });
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty('message');
      expect(payload).not.toHaveProperty('url');
      expect(payload).not.toHaveProperty('title');
      expect(payload).not.toHaveProperty('conversation_id');
    }
  });
});
