import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_FIRST_BYTE_TIMEOUT_MS,
  ChatAPI,
  JSON_REQUEST_TIMEOUT_MS,
  READ_INACTIVITY_TIMEOUT_MS,
} from '../services/api';

const encoder = new TextEncoder();

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function streamResponse(body: ReadableStream<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
  } as Response;
}

/** A fetch mock that only settles when its abort signal fires. */
function hangingFetch() {
  return vi.fn().mockImplementation((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('terminal event handling', () => {
  it('resolves immediately on chat.stream.completed even when the transport stays open', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ type: 'response.output_text.delta', delta: 'Answer' })));
        controller.enqueue(encoder.encode(sse({ type: 'chat.stream.completed' })));
        // Never closed: the PHP proxy may hold the connection open.
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    await expect(ChatAPI.sendMessage('hi')).resolves.toEqual({
      text: 'Answer',
      annotations: [],
      responseId: undefined,
    });
  });

  it('assembles a terminal event fragmented across transport chunks', async () => {
    const frames = [
      sse({ type: 'response.output_text.delta', delta: 'Hi' }),
      'data: {"type":"chat.str',
      'eam.comp',
      'leted"}',
      '\n',
      '\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        // Never closed.
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    await expect(ChatAPI.sendMessage('hi')).resolves.toMatchObject({ text: 'Hi' });
  });
});

describe('request deadlines', () => {
  it('fails a chat request that produces no first byte within 130 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const promise = ChatAPI.sendMessage('hi');
    const expectation = expect(promise).rejects.toMatchObject({
      name: 'APIError',
      code: 'timeout',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(CHAT_FIRST_BYTE_TIMEOUT_MS + 1);
    await expectation;
  });

  it('fails a JSON/bootstrap request after 15 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const promise = ChatAPI.getUserData();
    const expectation = expect(promise).rejects.toMatchObject({
      name: 'APIError',
      code: 'timeout',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(JSON_REQUEST_TIMEOUT_MS + 1);
    await expectation;
  });

  it('times out a JSON request whose body stalls after headers arrive', async () => {
    vi.useFakeTimers();
    // Headers resolve immediately; the body read hangs until the deadline
    // aborts the signal. The deadline must still cover this window.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    } as unknown as Response)));

    const promise = ChatAPI.getUserData();
    const expectation = expect(promise).rejects.toMatchObject({
      name: 'APIError',
      code: 'timeout',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(JSON_REQUEST_TIMEOUT_MS + 1);
    await expectation;
  });

  it('applies the between-chunk inactivity limit only after the first byte', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ type: 'response.output_text.delta', delta: 'stall' })));
        // Stream stalls with the transport open.
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    const promise = ChatAPI.sendMessage('hi');
    const expectation = expect(promise).rejects.toMatchObject({
      name: 'IncompleteStreamError',
      partialText: 'stall',
    });
    await vi.advanceTimersByTimeAsync(READ_INACTIVITY_TIMEOUT_MS + 1);
    await expectation;
  });
});

describe('error classification', () => {
  const errorResponse = (status: number): Response => ({
    ok: false,
    status,
    statusText: `status ${status}`,
    json: async () => ({}),
  } as unknown as Response);

  it.each([
    [400, false],
    [408, true],
    [413, false],
    [425, true],
    [429, true],
    [500, true],
    [501, false],
    [503, true],
  ])('classifies HTTP %i as retryable=%s', async (status, retryable) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(status)));
    await expect(ChatAPI.sendMessage('hi')).rejects.toMatchObject({
      name: 'APIError',
      status,
      retryable,
    });
  });

  it('classifies network failures as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(ChatAPI.sendMessage('hi')).rejects.toMatchObject({
      name: 'APIError',
      code: 'network_error',
      retryable: true,
    });
  });
});

describe('citation annotations', () => {
  it('collects the discriminated union and deduplicates multipart events', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const events = [
          { type: 'response.output_text.delta', delta: 'Cited answer' },
          {
            type: 'response.output_text.annotation.added',
            annotation: { type: 'url_citation', url: 'https://example.com/a', title: 'Example A' },
          },
          {
            type: 'response.output_text.annotation.added',
            annotation: { type: 'file_citation', filename: 'guide.pdf', file_id: 'file_1' },
          },
          // Legacy event without a discriminant degrades to a file citation.
          {
            type: 'response.output_text.annotation.added',
            annotation: { filename: 'legacy.txt' },
          },
          // Unusable annotation shapes are dropped, not crashed on.
          {
            type: 'response.output_text.annotation.added',
            annotation: { type: 'url_citation', title: 'no url' },
          },
          {
            type: 'response.content_part.done',
            part: {
              annotations: [
                // Duplicate of the streamed URL citation.
                { type: 'url_citation', url: 'https://example.com/a', title: 'Example A' },
                { type: 'container_file_citation', container_id: 'cont_1', file_id: 'file_2', filename: 'run.log' },
                { type: 'file_path', file_id: 'file_3' },
              ],
            },
          },
          { type: 'chat.stream.completed' },
        ];
        for (const event of events) controller.enqueue(encoder.encode(sse(event)));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    const result = await ChatAPI.sendMessage('hi');
    expect(result.annotations).toEqual([
      { type: 'url_citation', url: 'https://example.com/a', title: 'Example A' },
      { type: 'file_citation', filename: 'guide.pdf', fileId: 'file_1' },
      { type: 'file_citation', filename: 'legacy.txt' },
      { type: 'container_file_citation', containerId: 'cont_1', fileId: 'file_2', filename: 'run.log' },
      { type: 'file_path', fileId: 'file_3' },
    ]);
  });
});
