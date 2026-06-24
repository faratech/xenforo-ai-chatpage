/**
 * API Service Layer
 * Centralizes all API calls with type safety and error handling
 */

import { ENV } from '../config/env';
import type {
  UserData,
  StreamingResponse,
  Annotation,
  ChatMessageHistoryItem,
  SSEEvent,
  ErrorResponse,
} from '../types';

const domain = ENV.getCurrentDomain();

interface SendMessagePayload {
  message: string;
  captcha_token?: string;
  client_conversation_id?: string;
  reset_conversation?: boolean;
  history?: ChatMessageHistoryItem[];
}

/**
 * Base fetch wrapper with common configuration
 */
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${domain}${endpoint}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    let errorData: ErrorResponse;
    try {
      errorData = await response.json();
    } catch {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Chat API Service
 */
export class ChatAPI {
  /**
   * Fetch user data from the server
   */
  static async getUserData(): Promise<UserData> {
    return fetchAPI<UserData>(ENV.ENDPOINTS.USER_DATA, {
      method: 'POST',
      body: JSON.stringify({ action: 'getUserData' }),
    });
  }

  /**
   * Verify Turnstile CAPTCHA token
   */
  static async verifyCaptcha(token: string): Promise<{ success: boolean }> {
    return fetchAPI<{ success: boolean }>(ENV.ENDPOINTS.TURNSTILE_VERIFY, {
      method: 'POST',
      body: JSON.stringify({ action: 'verifyCaptcha', token }),
    });
  }

  /**
   * Send a chat message with streaming support
   */
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
    const { signal, captchaToken, conversationId, resetConversation, history, onChunk } = options;

    const payload: SendMessagePayload = { message };
    if (captchaToken) {
      payload.captcha_token = captchaToken;
    }
    if (conversationId) {
      payload.client_conversation_id = conversationId;
    }
    if (resetConversation) {
      payload.reset_conversation = true;
    }
    if (history?.length) {
      payload.history = history;
    }

    const response = await fetch(`${domain}${ENV.ENDPOINTS.CHAT}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      let errorData: ErrorResponse;
      try {
        errorData = await response.json();
      } catch {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      if (errorData.captcha_required) {
        throw new CaptchaRequiredError();
      }

      const serverMessage = errorData.message || errorData.error || errorData.detail;
      throw new Error(typeof serverMessage === 'string' && serverMessage
        ? serverMessage
        : `Server error: ${response.status}`);
    }

    if (!response.body) {
      throw new Error('ReadableStream not supported');
    }

    return this.processStreamingResponse(response.body, onChunk);
  }

  /**
   * Process streaming response from the server
   */
  private static async processStreamingResponse(
    body: ReadableStream<Uint8Array>,
    onChunk?: (partialText: string, annotations: Annotation[]) => void
  ): Promise<StreamingResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let buffer = '';
    let partialText = '';
    let annotations: Annotation[] = [];
    let hasReceivedData = false;
    let responseId: string | undefined;

    const handleEvent = (rawEvent: string) => {
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.substring(5).trimStart());

      if (dataLines.length === 0) return;
      const jsonStr = dataLines.join('\n').trim();
      if (!jsonStr || jsonStr === '[DONE]') return;

      let parsedData: SSEEvent;
      try {
        parsedData = JSON.parse(jsonStr) as SSEEvent;
      } catch (error) {
        if (localStorage.getItem('debug_sse') === 'true') {
          console.warn('[API] Ignoring malformed SSE data:', jsonStr, error);
        }
        return;
      }

      hasReceivedData = true;

      const eventResponseId = parsedData.response_id || parsedData.id || parsedData.response?.id;
      if (typeof eventResponseId === 'string' && eventResponseId.startsWith('resp_')) {
        responseId = eventResponseId;
      }

      const msgOf = (e: SSEEvent['error']) => (typeof e === 'string' ? e : e?.message);

      if (parsedData.type === 'error' || parsedData.type === 'function_call_error') {
        const errorDetail = parsedData.detail
          || (typeof parsedData.error === 'string' ? parsedData.error : parsedData.error?.message)
          || parsedData.message
          || 'Unknown error from backend';
        throw new BackendError(`AI service error: ${errorDetail}`);
      }

      if (parsedData.type === 'response.failed' || parsedData.type === 'response.incomplete') {
        const detail = parsedData.response?.error?.message
          || parsedData.response?.incomplete_details?.reason
          || msgOf(parsedData.error)
          || parsedData.type;
        throw new BackendError(`AI service error: ${detail}`);
      }

      switch (parsedData.type) {
        case 'response.output_text.delta':
          partialText += parsedData.delta || '';
          if (onChunk) onChunk(partialText, annotations);
          break;

        case 'response.output_text.done':
          if (!partialText && typeof parsedData.text === 'string') {
            partialText = parsedData.text;
          }
          if (onChunk) onChunk(partialText, annotations);
          break;

        case 'response.refusal.delta':
          partialText += parsedData.delta || '';
          if (onChunk) onChunk(partialText, annotations);
          break;

        case 'response.refusal.done':
          if (!partialText && typeof parsedData.refusal === 'string') {
            partialText = parsedData.refusal;
          }
          if (onChunk) onChunk(partialText, annotations);
          break;

        case 'response.output_text.annotation.added':
          if (parsedData.annotation?.type === 'file_citation' && typeof parsedData.annotation.filename === 'string') {
            annotations.push({
              index: parsedData.annotation_index ?? annotations.length,
              filename: parsedData.annotation.filename,
              fileId: parsedData.annotation.file_id
            });
          }
          break;

        case 'response.content_part.done':
          if (Array.isArray(parsedData.part?.annotations)) {
            annotations = parsedData.part.annotations.map((ann, idx) => ({
              index: idx,
              filename: ann.filename,
              fileId: ann.file_id
            }));
          }
          break;

        case 'response.completed':
          break;

        default:
          break;
      }
    };

    // Inactivity watchdog: reject if the server sends no data for this long.
    // Generous so it never cuts off a legitimately slow (e.g. reasoning) response.
    const READ_INACTIVITY_TIMEOUT_MS = 120_000;
    const readChunk = () => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Stream timed out (no data received)')),
            READ_INACTIVITY_TIMEOUT_MS
          );
        }),
      ]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    };

    try {
      while (!done) {
        const { value, done: streamDone } = await readChunk();
        done = streamDone;

        if (value) {
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.search(/\r?\n\r?\n/);
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(buffer[boundary] === '\r' ? boundary + 4 : boundary + 2);
            handleEvent(rawEvent);
            boundary = buffer.search(/\r?\n\r?\n/);
          }
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        handleEvent(buffer);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Stream aborted by user');
        // Return what we have so far
        return { text: partialText, annotations, responseId };
      }
      throw error;
    } finally {
      // Always release the stream/reader (normal end, abort, error, or timeout).
      void reader.cancel().catch(() => {});
    }

    if (!hasReceivedData && !partialText) {
      throw new Error('No data received from server');
    }

    return { text: partialText, annotations, responseId };
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

  /**
   * Request text-to-speech audio
   */
  static async requestTTS(text: string): Promise<Blob> {
    const response = await fetch(`${domain}${ENV.ENDPOINTS.TTS}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error('TTS request failed');
    }

    return response.blob();
  }
}

/**
 * Audio Service for TTS playback
 */
export class AudioService {
  private static currentAudio: HTMLAudioElement | null = null;

  /**
   * Play text-to-speech audio
   */
  static async playTTS(text: string): Promise<void> {
    try {
      // Stop any currently playing audio
      this.stop();

      const audioBlob = await ChatAPI.requestTTS(text);
      const audioUrl = URL.createObjectURL(audioBlob);

      this.currentAudio = new Audio(audioUrl);

      // Clean up URL when done
      this.currentAudio.addEventListener('ended', () => {
        URL.revokeObjectURL(audioUrl);
      });

      await this.currentAudio.play();
    } catch (error) {
      console.error('Error playing TTS:', error);
      throw error;
    }
  }

  /**
   * Stop currently playing audio
   */
  static stop(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }
}

export class CaptchaRequiredError extends Error {
  constructor() {
    super('CAPTCHA verification required');
    this.name = 'CaptchaRequiredError';
  }
}

export class BackendError extends Error {
  readonly isBackendError = true;
  constructor(message: string) {
    super(message);
    this.name = 'BackendError';
  }
}
