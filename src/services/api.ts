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
  SSEAnnotation,
  SSEEvent,
  ErrorResponse,
} from '../types';

const apiBase = ENV.getApiBase();

/** Bootstrap/JSON endpoints must answer quickly or the UI stalls. */
export const JSON_REQUEST_TIMEOUT_MS = 15_000;
/** The chat backend may queue behind tool calls before the first byte. */
export const CHAT_FIRST_BYTE_TIMEOUT_MS = 130_000;
/** Between-chunk inactivity limit once the stream has started. */
export const READ_INACTIVITY_TIMEOUT_MS = 45_000;

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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function makeAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Transient failures worth retrying: request/precondition timeouts, rate
 * limiting, and server-side errors other than 501 (unimplemented is
 * permanent by definition).
 */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status !== 501;
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
 * Converts a wire annotation to the discriminated citation union.
 * Unknown shapes with file metadata degrade to file citations; anything
 * else is dropped.
 */
function annotationFromSSE(annotation: SSEAnnotation | undefined): Annotation | null {
  if (!annotation || typeof annotation !== 'object') return null;

  switch (annotation.type) {
    case 'url_citation':
      if (typeof annotation.url !== 'string' || !annotation.url) return null;
      return {
        type: 'url_citation',
        url: annotation.url,
        ...(typeof annotation.title === 'string' && annotation.title ? { title: annotation.title } : {}),
      };
    case 'file_citation':
      if (typeof annotation.filename !== 'string' && typeof annotation.file_id !== 'string') return null;
      return {
        type: 'file_citation',
        ...(typeof annotation.filename === 'string' ? { filename: annotation.filename } : {}),
        ...(typeof annotation.file_id === 'string' ? { fileId: annotation.file_id } : {}),
      };
    case 'container_file_citation':
      if (typeof annotation.file_id !== 'string' && typeof annotation.container_id !== 'string') return null;
      return {
        type: 'container_file_citation',
        ...(typeof annotation.container_id === 'string' ? { containerId: annotation.container_id } : {}),
        ...(typeof annotation.file_id === 'string' ? { fileId: annotation.file_id } : {}),
        ...(typeof annotation.filename === 'string' ? { filename: annotation.filename } : {}),
      };
    case 'file_path':
      if (typeof annotation.file_id !== 'string') return null;
      return {
        type: 'file_path',
        fileId: annotation.file_id,
        ...(typeof annotation.filename === 'string' ? { filename: annotation.filename } : {}),
      };
    default:
      // Legacy backend events omit the discriminant on file citations.
      if (typeof annotation.filename === 'string' || typeof annotation.file_id === 'string') {
        return {
          type: 'file_citation',
          ...(typeof annotation.filename === 'string' ? { filename: annotation.filename } : {}),
          ...(typeof annotation.file_id === 'string' ? { fileId: annotation.file_id } : {}),
        };
      }
      return null;
  }
}

function annotationKey(annotation: Annotation): string {
  switch (annotation.type) {
    case 'url_citation':
      return `url:${annotation.url}`;
    case 'file_citation':
      return `file:${annotation.fileId ?? ''}:${annotation.filename ?? ''}`;
    case 'container_file_citation':
      return `container:${annotation.containerId ?? ''}:${annotation.fileId ?? ''}`;
    case 'file_path':
      return `path:${annotation.fileId ?? ''}`;
  }
}

/** Appends new annotations, deduplicating across multipart events. */
function mergeAnnotations(existing: Annotation[], incoming: Annotation[]): Annotation[] {
  const seen = new Set(existing.map(annotationKey));
  const merged = [...existing];
  for (const annotation of incoming) {
    const key = annotationKey(annotation);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(annotation);
  }
  return merged;
}

interface DeadlineHandle {
  signal: AbortSignal;
  /** True once the deadline (not a caller abort) fired. */
  timedOut: () => boolean;
  clear: () => void;
}

/**
 * Combines an optional caller signal with a hard deadline. The returned
 * signal aborts on either; `timedOut()` distinguishes the two.
 */
function withDeadline(timeoutMs: number, signal?: AbortSignal): DeadlineHandle {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Base fetch wrapper for JSON endpoints with a 15-second deadline.
 */
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const deadline = withDeadline(JSON_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${apiBase}${endpoint}`, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
      signal: deadline.signal,
    });
  } catch (error) {
    if (deadline.timedOut()) {
      throw new APIError('The server did not respond in time', {
        code: 'timeout',
        retryable: true,
      });
    }
    if (isAbortError(error)) throw error;
    throw new APIError('Network request failed', {
      code: 'network_error',
      retryable: true,
    });
  } finally {
    deadline.clear();
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

    // One deadline covers connection, headers, and the first body byte.
    const firstByte = withDeadline(CHAT_FIRST_BYTE_TIMEOUT_MS, signal);

    let response: Response;
    try {
      response = await fetch(`${apiBase}${ENV.ENDPOINTS.CHAT}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: firstByte.signal,
      });
    } catch (error) {
      firstByte.clear();
      if (firstByte.timedOut()) {
        throw new APIError('The AI service did not start responding in time', {
          code: 'timeout',
          retryable: true,
        });
      }
      if (signal?.aborted || isAbortError(error)) {
        throw new StreamCancelledError();
      }
      throw new APIError('Network request failed', {
        code: 'network_error',
        retryable: true,
      });
    }

    if (!response.ok) {
      firstByte.clear();
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
      firstByte.clear();
      throw new StreamProtocolError('ReadableStream not supported');
    }

    return this.processStreamingResponse(response.body, firstByte, onChunk, signal);
  }

  private static async processStreamingResponse(
    body: ReadableStream<Uint8Array>,
    firstByte: DeadlineHandle,
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
    let firstByteReceived = false;

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

        case 'response.output_text.annotation.added': {
          const annotation = annotationFromSSE(parsedData.annotation);
          if (annotation) {
            annotations = mergeAnnotations(annotations, [annotation]);
            notifyChunk();
          }
          break;
        }

        case 'response.content_part.done':
          if (Array.isArray(parsedData.part?.annotations)) {
            const incoming = parsedData.part.annotations
              .map(annotationFromSSE)
              .filter((annotation): annotation is Annotation => annotation !== null);
            if (incoming.length) {
              annotations = mergeAnnotations(annotations, incoming);
              notifyChunk();
            }
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

    const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (signal?.aborted) return Promise.reject(makeAbortError());

      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          signal?.removeEventListener('abort', handleAbort);
          callback();
        };
        const handleAbort = () => finish(() => reject(makeAbortError()));
        // Before the first byte the 130s request deadline governs; after
        // it, the between-chunk inactivity limit takes over.
        const timeoutId = firstByteReceived
          ? setTimeout(() => {
            const timeoutError = new Error('Stream timed out waiting for data');
            timeoutError.name = 'StreamTimeoutError';
            finish(() => reject(timeoutError));
          }, READ_INACTIVITY_TIMEOUT_MS)
          : undefined;

        signal?.addEventListener('abort', handleAbort, { once: true });
        reader.read().then(
          (result) => finish(() => resolve(result)),
          (error: unknown) => finish(() => reject(error))
        );
      });
    };

    try {
      while (!terminalReceived) {
        const { value, done } = await readChunk();
        if (done) break;
        if (!value) continue;
        if (!firstByteReceived) {
          firstByteReceived = true;
          firstByte.clear();
        }

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          const separatorLength = buffer[boundary] === '\r' ? 4 : 2;
          buffer = buffer.slice(boundary + separatorLength);
          handleEvent(rawEvent);
          // The terminal event resolves the turn immediately; the PHP
          // proxy may hold the transport open long after it.
          if (terminalReceived) break;
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }

      if (!terminalReceived) {
        buffer += decoder.decode();
        if (buffer.trim()) handleEvent(buffer);
      }

      if (!terminalReceived && signal?.aborted) {
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

      if (!firstByteReceived && firstByte.timedOut()) {
        throw new APIError('The AI service did not start responding in time', {
          code: 'timeout',
          retryable: true,
        });
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
      firstByte.clear();
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
