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
});
