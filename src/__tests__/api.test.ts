import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APIError,
  ChatAPI,
  IncompleteStreamError,
  StreamCancelledError,
  StreamProtocolError,
} from '../services/api';

const encoder = new TextEncoder();

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatAPI streaming protocol', () => {
  it('resolves only after the application terminal event', async () => {
    const onChunk = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      sse({ type: 'response.output_text.delta', delta: 'Hel' }),
      sse({ type: 'response.completed', response: { id: 'resp_123' } }),
      sse({ type: 'response.output_text.delta', delta: 'lo' }),
      sse({ type: 'chat.stream.completed', response_id: 'resp_123' }),
    ])));

    await expect(ChatAPI.sendMessage('hi', { onChunk })).resolves.toEqual({
      text: 'Hello',
      annotations: [],
      responseId: 'resp_123',
    });
    expect(onChunk).toHaveBeenLastCalledWith('Hello', []);
  });

  it('throws an incomplete error with the partial response on premature EOF', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      sse({ type: 'response.output_text.delta', delta: 'partial' }),
      sse({ type: 'response.completed', response: { id: 'resp_partial' } }),
    ])));

    const promise = ChatAPI.sendMessage('hi');
    await expect(promise).rejects.toMatchObject({
      name: 'IncompleteStreamError',
      partialText: 'partial',
      annotations: [],
      responseId: 'resp_partial',
    });
    await expect(promise).rejects.toBeInstanceOf(IncompleteStreamError);
  });

  it('throws a protocol error with partial text for malformed SSE JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      sse({ type: 'response.output_text.delta', delta: 'safe partial' }),
      'data: {not-json}\n\n',
    ])));

    const promise = ChatAPI.sendMessage('hi');
    await expect(promise).rejects.toMatchObject({
      name: 'StreamProtocolError',
      partialText: 'safe partial',
    });
    await expect(promise).rejects.toBeInstanceOf(StreamProtocolError);
  });

  it('turns a structured backend error into APIError without losing partial text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      sse({ type: 'response.output_text.delta', delta: 'started' }),
      sse({
        type: 'error',
        code: 'upstream_timeout',
        detail: 'Upstream response timed out',
        retryable: true,
        status_code: 504,
      }),
    ])));

    const promise = ChatAPI.sendMessage('hi');
    await expect(promise).rejects.toMatchObject({
      name: 'APIError',
      code: 'upstream_timeout',
      status: 504,
      retryable: true,
      partialText: 'started',
    });
    await expect(promise).rejects.toBeInstanceOf(APIError);
  });

  it('throws StreamCancelledError with streamed state when aborted', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          sse({ type: 'response.output_text.delta', delta: 'before stop' })
        ));
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
    } as Response));

    const controller = new AbortController();
    const onChunk = vi.fn();
    const promise = ChatAPI.sendMessage('hi', { signal: controller.signal, onChunk });
    await vi.waitFor(() => expect(onChunk).toHaveBeenCalledWith('before stop', []));
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      name: 'StreamCancelledError',
      partialText: 'before stop',
    });
    await expect(promise).rejects.toBeInstanceOf(StreamCancelledError);
  });
});

describe('TTS request validation', () => {
  it('rejects successful non-audio responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      blob: vi.fn().mockResolvedValue(new Blob(['not audio'])),
    } as unknown as Response));

    await expect(ChatAPI.requestTTS('hello')).rejects.toMatchObject({
      name: 'APIError',
      code: 'invalid_tts_content_type',
    });
  });
});
