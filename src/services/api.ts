/**
 * API Service Layer
 * Centralizes all API calls with type safety and error handling.
 */

import { ENV } from '../config/env';
import type {
  UserData,
  UsageData,
  StreamingResponse,
  Annotation,
  ChatMessageHistoryItem,
  SSEEvent,
  ErrorResponse,
} from '../types';

const apiBase = ENV.getApiBase();

interface SendMessagePayload {
  message: string;
  captcha_token?: string;
  client_conversation_id?: string;
  reset_conversation?: boolean;
  history?: ChatMessageHistoryItem[];
}

export interface APIErrorOptions {
  status?: number;
  code?: string;
  retryable?: boolean;
  partialText?: string;
  annotations?: Annotation[];
  responseId?: string;
}

interface StreamState {
  partialText?: string;
  annotations?: Annotation[];
  responseId?: string;
}

class StreamStateError extends Error {
  readonly partialText: string;
  readonly annotations: Annotation[];
  readonly responseId?: string;

  constructor(message: string, state: StreamState = {}) {
    super(message);
    this.partialText = state.partialText ?? '';
    this.annotations = [...(state.annotations ?? [])];
    this.responseId = state.responseId;
  }
}

export class APIError extends StreamStateError {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, options: APIErrorOptions = {}) {
    super(message, options);
    this.name = 'APIError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export class StreamCancelledError extends StreamStateError {
  constructor(
    message = 'Stream cancelled',
    partialText = '',
    annotations: Annotation[] = [],
    responseId?: string
  ) {
    super(message, { partialText, annotations, responseId });
    this.name = 'StreamCancelledError';
  }
}

export class IncompleteStreamError extends StreamStateError {
  constructor(
    message = 'Stream ended before completion',
    partialText = '',
    annotations: Annotation[] = [],
    responseId?: string
  ) {
    super(message, { partialText, annotations, responseId });
    this.name = 'IncompleteStreamError';
  }
}

export class StreamProtocolError extends StreamStateError {
  constructor(
    message = 'Invalid streaming response',
    partialText = '',
    annotations: Annotation[] = [],
    responseId?: string
  ) {
    super(message, { partialText, annotations, responseId });
    this.name = 'StreamProtocolError';
  }
}

export class CaptchaRequiredError extends APIError {
  constructor() {
    super('CAPTCHA verification required', {
      status: 403,
      code: 'captcha_required',
      retryable: false,
    });
    this.name = 'CaptchaRequiredError';
  }
}

/** @deprecated Use APIError. Retained for callers that still import BackendError. */
export class BackendError extends APIError {
  readonly isBackendError = true;

  constructor(message: string, options: APIErrorOptions = {}) {
    super(message, options);
    this.name = 'BackendError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function makeAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorMessage(errorData: ErrorResponse, fallback: string): string {
  const candidates = [errorData.message, errorData.error, errorData.detail];
  const message = candidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== ''
  );
  return message ?? fallback;
}

function errorCode(errorData: ErrorResponse): string | undefined {
  return typeof errorData.code === 'string' ? errorData.code : undefined;
}

async function readErrorResponse(response: Response): Promise<ErrorResponse> {
  try {
    const data: unknown = await response.json();
    return data && typeof data === 'object' ? data as ErrorResponse : {};
  } catch {
    return {};
  }
}

/**
 * Base fetch wrapper with common configuration.
 */
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${endpoint}`, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new APIError('Network request failed', {
      code: 'network_error',
      retryable: true,
    });
  }

  if (!response.ok) {
    const errorData = await readErrorResponse(response);
    throw new APIError(
      errorMessage(errorData, `HTTP ${response.status}: ${response.statusText}`),
      {
        status: response.status,
        code: errorCode(errorData),
        retryable: isRetryableStatus(response.status),
      }
    );
  }

  return response.json();
}

/**
 * Chat API Service.
 */
export class ChatAPI {
  static async getUserData(): Promise<UserData> {
    return fetchAPI<UserData>(ENV.ENDPOINTS.USER_DATA, {
      method: 'POST',
      body: JSON.stringify({ action: 'getUserData' }),
    });
  }

  static async getUsage(): Promise<UsageData> {
    return fetchAPI<UsageData>(ENV.ENDPOINTS.USER_DATA, {
      method: 'POST',
      body: JSON.stringify({ action: 'getUsage' }),
    });
  }

  static async verifyCaptcha(token: string): Promise<{ success: boolean }> {
    return fetchAPI<{ success: boolean }>(ENV.ENDPOINTS.TURNSTILE_VERIFY, {
      method: 'POST',
      body: JSON.stringify({ action: 'verifyCaptcha', token }),
    });
  }

  static async sendMessage(
    message: string,
    options: {
      signal?: AbortSignal;
      captchaToken?: string;
      conversationId?: string;
      resetConversation?: boolean;
      history?: ChatMessageHistoryItem[];
      onChunk?: (partialText: string, annotations: Annotation[]) => void;
    } = {}
  ): Promise<StreamingResponse> {
    const {
      signal,
      captchaToken,
      conversationId,
      resetConversation,
      history,
      onChunk,
    } = options;

    const payload: SendMessagePayload = { message };
    if (captchaToken) payload.captcha_token = captchaToken;
    if (conversationId) payload.client_conversation_id = conversationId;
    if (resetConversation) payload.reset_conversation = true;
    if (history?.length) payload.history = history;

    let response: Response;
    try {
      response = await fetch(`${apiBase}${ENV.ENDPOINTS.CHAT}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new StreamCancelledError();
      }
      throw new APIError('Network request failed', {
        code: 'network_error',
        retryable: true,
      });
    }

    if (!response.ok) {
      const errorData = await readErrorResponse(response);
      if (errorData.captcha_required) throw new CaptchaRequiredError();

      throw new APIError(
        errorMessage(errorData, `Server error: ${response.status} ${response.statusText}`),
        {
          status: response.status,
          code: errorCode(errorData),
          retryable: isRetryableStatus(response.status),
        }
      );
    }

    if (!response.body) {
      throw new StreamProtocolError('ReadableStream not supported');
    }

    return this.processStreamingResponse(response.body, onChunk, signal);
  }

  private static async processStreamingResponse(
    body: ReadableStream<Uint8Array>,
    onChunk?: (partialText: string, annotations: Annotation[]) => void,
    signal?: AbortSignal
  ): Promise<StreamingResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let partialText = '';
    let annotations: Annotation[] = [];
    let responseId: string | undefined;
    let terminalReceived = false;

    const state = () => ({ partialText, annotations, responseId });
    const notifyChunk = () => onChunk?.(partialText, [...annotations]);

    const protocolError = (message: string) => new StreamProtocolError(
      message,
      partialText,
      annotations,
      responseId
    );

    const handleEvent = (rawEvent: string): void => {
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.substring(5).trimStart());

      // Comment-only SSE heartbeats and fields other than data are valid.
      if (dataLines.length === 0) return;

      const json = dataLines.join('\n').trim();
      if (!json || json === '[DONE]') return;
      if (terminalReceived) {
        throw protocolError('Received stream data after chat.stream.completed');
      }

      let parsedData: SSEEvent;
      try {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('SSE data must be a JSON object');
        }
        parsedData = parsed as SSEEvent;
      } catch (error) {
        try {
          if (localStorage.getItem('debug_sse') === 'true') {
            console.warn('[API] Malformed SSE data:', json, error);
          }
        } catch {
          // Debug logging must never change stream behavior.
        }
        throw protocolError('Malformed JSON in streaming response');
      }

      const eventResponseId = parsedData.response_id || parsedData.id || parsedData.response?.id;
      if (typeof eventResponseId === 'string' && eventResponseId.startsWith('resp_')) {
        responseId = eventResponseId;
      }

      const eventType = parsedData.type;
      const nestedError = typeof parsedData.error === 'string'
        ? parsedData.error
        : parsedData.error?.message;
      const detail = parsedData.detail || nestedError || parsedData.message;

      if (eventType === 'error' || eventType === 'function_call_error') {
        const status = typeof parsedData.status_code === 'number'
          ? parsedData.status_code
          : undefined;
        const code = typeof parsedData.code === 'string'
          ? parsedData.code
          : eventType;
        const retryable = typeof parsedData.retryable === 'boolean'
          ? parsedData.retryable
          : status === undefined || isRetryableStatus(status);

        throw new APIError(detail || 'AI service error', {
          status,
          code,
          retryable,
          ...state(),
        });
      }

      if (eventType === 'response.failed') {
        const failureDetail = parsedData.response?.error?.message || detail || eventType;
        throw new APIError(failureDetail, {
          code: 'response_failed',
          retryable: true,
          ...state(),
        });
      }

      if (eventType === 'response.incomplete') {
        const incompleteDetail = parsedData.response?.incomplete_details?.reason
          || detail
          || 'The AI response was incomplete';
        throw new IncompleteStreamError(
          incompleteDetail,
          partialText,
          annotations,
          responseId
        );
      }

      switch (eventType) {
        case 'response.output_text.delta':
          partialText += parsedData.delta || '';
          notifyChunk();
          break;

        case 'response.output_text.done':
          if (!partialText && typeof parsedData.text === 'string') partialText = parsedData.text;
          notifyChunk();
          break;

        case 'response.refusal.delta':
          partialText += parsedData.delta || '';
          notifyChunk();
          break;

        case 'response.refusal.done':
          if (!partialText && typeof parsedData.refusal === 'string') {
            partialText = parsedData.refusal;
          }
          notifyChunk();
          break;

        case 'response.output_text.annotation.added':
          if (
            parsedData.annotation?.type === 'file_citation'
            && typeof parsedData.annotation.filename === 'string'
          ) {
            annotations = [
              ...annotations,
              {
                index: parsedData.annotation_index ?? annotations.length,
                filename: parsedData.annotation.filename,
                fileId: parsedData.annotation.file_id,
              },
            ];
            notifyChunk();
          }
          break;

        case 'response.content_part.done':
          if (Array.isArray(parsedData.part?.annotations)) {
            annotations = parsedData.part.annotations.map((annotation, index) => ({
              index,
              filename: annotation.filename,
              fileId: annotation.file_id,
            }));
            notifyChunk();
          }
          break;

        // An upstream Responses API completion is not the application terminal
        // event. The PHP proxy may continue a tool chain after this event.
        case 'response.completed':
          break;

        case 'chat.stream.completed':
          terminalReceived = true;
          break;

        default:
          break;
      }
    };

    const READ_INACTIVITY_TIMEOUT_MS = 45_000;
    const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (signal?.aborted) return Promise.reject(makeAbortError());

      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', handleAbort);
          callback();
        };
        const handleAbort = () => finish(() => reject(makeAbortError()));
        const timeoutId = setTimeout(() => {
          const timeoutError = new Error('Stream timed out waiting for data');
          timeoutError.name = 'StreamTimeoutError';
          finish(() => reject(timeoutError));
        }, READ_INACTIVITY_TIMEOUT_MS);

        signal?.addEventListener('abort', handleAbort, { once: true });
        reader.read().then(
          (result) => finish(() => resolve(result)),
          (error: unknown) => finish(() => reject(error))
        );
      });
    };

    try {
      while (true) {
        const { value, done } = await readChunk();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          const separatorLength = buffer[boundary] === '\r' ? 4 : 2;
          buffer = buffer.slice(boundary + separatorLength);
          handleEvent(rawEvent);
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(buffer);

      if (signal?.aborted) {
        throw new StreamCancelledError(
          'Stream cancelled',
          partialText,
          annotations,
          responseId
        );
      }

      if (!terminalReceived) {
        throw new IncompleteStreamError(
          partialText
            ? 'Stream ended before chat.stream.completed'
            : 'No completed response received from server',
          partialText,
          annotations,
          responseId
        );
      }

      return { text: partialText, annotations: [...annotations], responseId };
    } catch (error) {
      if (
        error instanceof APIError
        || error instanceof StreamCancelledError
        || error instanceof IncompleteStreamError
        || error instanceof StreamProtocolError
      ) {
        throw error;
      }

      if (signal?.aborted || isAbortError(error)) {
        throw new StreamCancelledError(
          'Stream cancelled',
          partialText,
          annotations,
          responseId
        );
      }

      if (error instanceof Error && error.name === 'StreamTimeoutError') {
        throw new IncompleteStreamError(
          error.message,
          partialText,
          annotations,
          responseId
        );
      }

      throw new IncompleteStreamError(
        error instanceof Error ? error.message : 'Streaming response failed',
        partialText,
        annotations,
        responseId
      );
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  static async clearConversation(conversationId: string): Promise<{ success: boolean }> {
    return fetchAPI<{ success: boolean }>(ENV.ENDPOINTS.CHAT, {
      method: 'POST',
      body: JSON.stringify({ action: 'clearConversation', client_conversation_id: conversationId }),
    });
  }

  static async deleteConversation(conversationId: string): Promise<{ success: boolean }> {
    return fetchAPI<{ success: boolean }>(ENV.ENDPOINTS.CHAT, {
      method: 'POST',
      body: JSON.stringify({ action: 'deleteConversation', client_conversation_id: conversationId }),
    });
  }

  static async requestTTS(
    text: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<Blob> {
    let response: Response;
    try {
      response = await fetch(`${apiBase}${ENV.ENDPOINTS.TTS}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      throw new APIError('TTS network request failed', {
        code: 'tts_network_error',
        retryable: true,
      });
    }

    if (!response.ok) {
      throw new APIError('TTS request failed', {
        status: response.status,
        code: 'tts_request_failed',
        retryable: isRetryableStatus(response.status),
      });
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('audio/')) {
      throw new APIError('TTS service returned a non-audio response', {
        status: response.status,
        code: 'invalid_tts_content_type',
        retryable: true,
      });
    }

    return response.blob();
  }
}

/** Audio Service for TTS playback. */
export class AudioService {
  private static currentAudio: HTMLAudioElement | null = null;
  private static currentRequest: AbortController | null = null;
  private static currentCleanup: (() => void) | null = null;
  private static generation = 0;
  private static muted = false;

  static setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  static async playTTS(text: string): Promise<void> {
    this.stop();
    if (this.muted || !text.trim()) return;

    const generation = this.generation;
    const controller = new AbortController();
    this.currentRequest = controller;
    let releaseAudio: (() => void) | null = null;

    try {
      const audioBlob = await ChatAPI.requestTTS(text, { signal: controller.signal });
      if (controller.signal.aborted || this.muted || generation !== this.generation) return;

      const audioUrl = URL.createObjectURL(audioBlob);
      if (controller.signal.aborted || this.muted || generation !== this.generation) {
        URL.revokeObjectURL(audioUrl);
        return;
      }

      const audio = new Audio(audioUrl);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        URL.revokeObjectURL(audioUrl);
        if (this.currentAudio === audio) this.currentAudio = null;
        if (this.currentCleanup === cleanup) this.currentCleanup = null;
      };
      releaseAudio = cleanup;

      this.currentAudio = audio;
      this.currentCleanup = cleanup;
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });

      await audio.play();
    } catch (error) {
      releaseAudio?.();
      if (controller.signal.aborted || generation !== this.generation || isAbortError(error)) return;
      throw error;
    } finally {
      if (this.currentRequest === controller) this.currentRequest = null;
    }
  }

  static stop(): void {
    this.generation += 1;

    if (this.currentRequest) {
      this.currentRequest.abort();
      this.currentRequest = null;
    }

    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.removeAttribute('src');
      this.currentAudio = null;
    }

    const cleanup = this.currentCleanup;
    this.currentCleanup = null;
    cleanup?.();
  }
}
