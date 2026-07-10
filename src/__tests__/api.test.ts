import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APIError,
  AudioService,
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
  AudioService.setMuted(false);
  AudioService.stop();
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

describe('TTS lifecycle', () => {
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

  it('aborts stale synthesis and revokes the current object URL on stop', async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveSecond: ((blob: Blob) => void) | undefined;
    const requestSpy = vi.spyOn(ChatAPI, 'requestTTS').mockImplementation((text, options) => {
      if (text === 'first') {
        firstSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }

      return new Promise(resolve => {
        resolveSecond = resolve;
      });
    });

    const pause = vi.fn();
    const play = vi.fn().mockResolvedValue(undefined);
    class MockAudio extends EventTarget {
      pause = pause;
      play = play;
      removeAttribute = vi.fn();
    }
    vi.stubGlobal('Audio', MockAudio);
    const createObjectURL = vi.fn().mockReturnValue('blob:test-audio');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const first = AudioService.playTTS('first');
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const second = AudioService.playTTS('second');
    expect(firstSignal?.aborted).toBe(true);

    resolveSecond?.(new Blob(['audio'], { type: 'audio/ogg' }));
    await Promise.all([first, second]);
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledOnce();

    AudioService.stop();
    expect(pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
});
