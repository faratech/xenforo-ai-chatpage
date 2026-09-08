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

    await expect(ChatAPI.sendMessage('hi')).resolves.toMatchObject({
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

  it('treats an OpenAI-style [DONE] terminator as terminal', async () => {
    const frames = [
      sse({ type: 'response.output_text.delta', delta: 'Answer' }),
      'data: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        // Never closed: only the terminator ends this stream.
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    await expect(ChatAPI.sendMessage('hi')).resolves.toMatchObject({ text: 'Answer' });
  });

  it('classifies a transport-cut trailing frame as truncation, not a protocol error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ type: 'response.output_text.delta', delta: 'Partial' })));
        // The proxy died mid-frame; the connection then closed.
        controller.enqueue(encoder.encode('data: {"type":"chat.stre'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    await expect(ChatAPI.sendMessage('hi')).rejects.toMatchObject({
      name: 'IncompleteStreamError',
      code: 'stream_truncated',
      partialText: 'Partial',
    });
  });

  it('preserves streamed refusals as the completed assistant answer', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ type: 'response.refusal.delta', delta: 'I cannot ' })));
        controller.enqueue(encoder.encode(sse({ type: 'response.refusal.done', refusal: 'ignore duplicate done text' })));
        controller.enqueue(encoder.encode(sse({ type: 'response.refusal.delta', delta: 'help with that.' })));
        controller.enqueue(encoder.encode(sse({ type: 'chat.stream.completed' })));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(body)));

    await expect(ChatAPI.sendMessage('hi')).resolves.toMatchObject({
      text: 'I cannot help with that.',
    });
  });
});

describe('request deadlines', () => {
  it('accepts a first byte after the old 130-second deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(sse({ type: 'response.output_text.delta', delta: 'Delayed answer' }) + sse({ type: 'chat.stream.completed' })));
          controller.close();
        }, 150_000);
      },
    }))));
    const result = ChatAPI.sendMessage('hi');
    await vi.advanceTimersByTimeAsync(150_001);
    await expect(result).resolves.toMatchObject({ text: 'Delayed answer' });
  });

  it('fails a chat request that produces no first byte within 180 seconds', async () => {
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

  it('carries a structured retry_after delay in milliseconds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '9' }),
      json: async () => ({ code: 'rate_limited', retry_after: 3 }),
    } as unknown as Response));

    await expect(ChatAPI.sendMessage('hi')).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 3_000,
    });
  });

  it('locks the client immediately for identity_required responses', async () => {
    const listener = vi.fn();
    window.addEventListener('wf-chat-identity-changed', listener, { once: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 428,
      statusText: 'Precondition Required',
      headers: new Headers(),
      json: async () => ({ code: 'identity_required' }),
    } as unknown as Response));

    await expect(ChatAPI.sendMessage('hi')).rejects.toMatchObject({
      status: 428,
      code: 'identity_required',
      retryable: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
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

describe('frame separators', () => {
  /**
   * A server that mixes CRLF and LF terminators produces a 3-byte separator.
   * Inferring the length from the first character alone consumed 4, ate the
   * next frame's leading "d", and the mangled frame was then dropped without
   * an error — losing a delta, or the terminal event with it.
   */
  it.each([
    ['LF', '\n\n', '\n\n'],
    ['CRLF', '\r\n\r\n', '\r\n\r\n'],
    ['CRLF then LF', '\r\n\n', '\n\n'],
    ['LF then CRLF', '\n\r\n', '\n\n'],
  ])('parses every frame across a %s separator', async (_label, first, second) => {
    const payload = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'A' })}${first}`
      + `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'B' })}${second}`
      + `data: ${JSON.stringify({ type: 'chat.stream.completed', response_id: 'resp_sep' })}\n\n`;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload));
          controller.close();
        },
      })
    )));

    await expect(ChatAPI.sendMessage('hi')).resolves.toMatchObject({
      text: 'AB',
      responseId: 'resp_sep',
    });
  });
});

describe('empty-answer classification', () => {
  const streamOf = (payload: string) => streamResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  }));

  it('reports a truncated stream distinctly from one that never started', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(
      sse({ type: 'response.output_text.delta', delta: 'half an answer' })
    )));

    await expect(ChatAPI.sendMessage('hi')).rejects.toMatchObject({
      name: 'IncompleteStreamError',
      code: 'stream_truncated',
      partialText: 'half an answer',
    });
  });

  it('reports a stream that delivered nothing at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(': keepalive\n\n')));

    await expect(ChatAPI.sendMessage('hi')).rejects.toMatchObject({
      name: 'IncompleteStreamError',
      code: 'stream_no_terminal',
      partialText: '',
    });
  });

  it('carries diagnostics that identify the turn and what arrived', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(
      sse({ type: 'response.output_text.delta', delta: 'x' })
    )));

    await expect(ChatAPI.sendMessage('hi', { turnId: 'turn-abc' })).rejects.toMatchObject({
      diagnostics: {
        turnId: 'turn-abc',
        eventTypes: ['response.output_text.delta'],
      },
    });
  });

  it('sends the turn id as a header so the server log can be correlated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamOf(
      sse({ type: 'chat.stream.completed' })
    ));
    vi.stubGlobal('fetch', fetchMock);

    await ChatAPI.sendMessage('hi', { turnId: 'turn-xyz' });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-WF-Turn-Id']).toBe('turn-xyz');
  });
});

describe('keepalive comments', () => {
  it('treats comment lines as no-ops that keep the stream alive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
          controller.enqueue(encoder.encode(sse({ type: 'response.output_text.delta', delta: 'ok' })));
          controller.enqueue(encoder.encode(': keepalive\n\n'));
          controller.enqueue(encoder.encode(sse({ type: 'chat.stream.completed' })));
          controller.close();
        },
      })
    )));

    await expect(ChatAPI.sendMessage('hi')).resolves.toMatchObject({ text: 'ok' });
  });
});

describe('activity progress events', () => {
  const streamOf = (payload: string) => streamResponse(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  }));

  /**
   * These events were already arriving — responses_router yields every
   * upstream event and chat.php echoes it — and were being dropped by the
   * client's `default: break;`, which is why the wait showed a bare spinner.
   */
  it('reports tool steps as they start and finish', async () => {
    const updates: string[][] = [];
    const payload = [
      sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'searchWindowsForum' } }),
      sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', name: 'searchWindowsForum' } }),
      sse({ type: 'response.output_item.added', output_index: 1, item: { id: 'fs_1', type: 'file_search_call' } }),
      sse({ type: 'response.output_text.delta', delta: 'Answer' }),
      sse({ type: 'chat.stream.completed' }),
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(payload)));

    await ChatAPI.sendMessage('hi', {
      onActivity: activities => updates.push(activities.map(a => `${a.label}:${a.state}`)),
    });

    expect(updates[0]).toEqual(['Searching WindowsForum:active']);
    expect(updates[1]).toEqual(['Searching WindowsForum:active', 'Searching WindowsForum:active']);
    expect(updates[updates.length - 1]).toEqual([
      'Searching WindowsForum:done',
      'Searching WindowsForum:done',
    ]);
  });

  it('derives steps from per-tool progress events without enumerating each one', async () => {
    const updates: string[][] = [];
    const payload = [
      sse({ type: 'response.web_search_call.in_progress', item_id: 'ws_1', output_index: 0 }),
      sse({ type: 'response.web_search_call.searching', item_id: 'ws_1', output_index: 0 }),
      sse({ type: 'response.web_search_call.completed', item_id: 'ws_1', output_index: 0 }),
      sse({ type: 'chat.stream.completed' }),
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(payload)));

    await ChatAPI.sendMessage('hi', {
      onActivity: activities => updates.push(activities.map(a => `${a.label}:${a.state}`)),
    });

    expect(updates[0]).toEqual(['Searching the web:active']);
    expect(updates[updates.length - 1]).toEqual(['Searching the web:done']);
  });

  it('ignores unknown item types rather than showing raw internals', async () => {
    const onActivity = vi.fn();
    const payload = [
      sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'x_1', type: 'some_internal_thing' } }),
      sse({ type: 'response.some_internal_thing.in_progress', item_id: 'x_1' }),
      sse({ type: 'chat.stream.completed' }),
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(payload)));

    await ChatAPI.sendMessage('hi', { onActivity });
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('does not re-notify when a repeated event changes nothing', async () => {
    const onActivity = vi.fn();
    const payload = [
      sse({ type: 'response.file_search_call.in_progress', item_id: 'fs_1' }),
      sse({ type: 'response.file_search_call.in_progress', item_id: 'fs_1' }),
      sse({ type: 'response.file_search_call.in_progress', item_id: 'fs_1' }),
      sse({ type: 'chat.stream.completed' }),
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(payload)));

    await ChatAPI.sendMessage('hi', { onActivity });
    expect(onActivity).toHaveBeenCalledTimes(2); // Start and application completion only.
  });
});

describe('reasoning summaries', () => {
  /**
   * gpt-5.6-luna reasons on every turn either way (it is in REASONING_MODELS,
   * ~245 reasoning tokens/turn on this surface). Asking for `reasoning.summary`
   * only makes it narrate what it is already doing, so the client is ready for
   * that text before the backend opts in.
   */
  it('streams reasoning summary text into the step it belongs to', async () => {
    const updates: { label: string; detail?: string }[][] = [];
    const payload = [
      sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } }),
      sse({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Checking ' }),
      sse({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'driver reports' }),
      sse({ type: 'response.reasoning_summary_text.done', item_id: 'rs_1' }),
      sse({ type: 'chat.stream.completed' }),
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(payload)); controller.close(); },
      })
    )));

    await ChatAPI.sendMessage('hi', {
      onActivity: activities => updates.push(activities.map(a => ({ label: a.label, detail: a.detail }))),
    });

    const final = updates[updates.length - 1];
    expect(final).toEqual([{ label: 'Thinking it through', detail: 'Checking driver reports' }]);
  });
});
