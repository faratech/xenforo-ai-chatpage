/**
 * API Service Layer
 * Centralizes all API calls with type safety and error handling
 */

import { ENV } from '../config/env';
import type { UserData, StreamingResponse, Annotation } from '../types';

const domain = ENV.getCurrentDomain();

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
    let errorData: any;
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
      onChunk?: (partialText: string, annotations: Annotation[]) => void;
    } = {}
  ): Promise<StreamingResponse> {
    const { signal, captchaToken, onChunk } = options;

    const payload: any = { message };
    if (captchaToken) {
      payload.captcha_token = captchaToken;
    }

    const response = await fetch(`${domain}${ENV.ENDPOINTS.CHAT}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      let errorData: any;
      try {
        errorData = await response.json();
      } catch (jsonError) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      if (errorData.captcha_required) {
        const error: any = new Error('CAPTCHA_REQUIRED');
        error.captchaRequired = true;
        throw error;
      }

      throw new Error(errorData.error || `Server error: ${response.status}`);
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
    let partialText = '';
    let annotations: Annotation[] = [];
    let hasReceivedData = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;

      if (value) {
        hasReceivedData = true;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.substring(6).trim();
            if (!jsonStr) continue;

            try {
              const parsedData = JSON.parse(jsonStr);

              switch (parsedData.type) {
                case 'response.output_text.delta':
                  partialText += parsedData.delta;
                  if (onChunk) onChunk(partialText, annotations);
                  break;

                case 'response.output_text.done':
                  if (onChunk) onChunk(partialText, annotations);
                  break;

                case 'response.output_text.annotation.added':
                  if (parsedData.annotation?.type === 'file_citation') {
                    annotations.push({
                      index: parsedData.annotation_index,
                      filename: parsedData.annotation.filename,
                      fileId: parsedData.annotation.file_id
                    });
                  }
                  break;

                case 'response.content_part.done':
                  if (parsedData.part?.annotations) {
                    annotations = parsedData.part.annotations.map((ann: any, idx: number) => ({
                      index: idx,
                      filename: ann.filename,
                      fileId: ann.file_id
                    }));
                  }
                  break;
              }
            } catch (error) {
              console.error('Error parsing streaming data:', error, 'Line:', line);
            }
          }
        }
      }
    }

    if (!hasReceivedData && !partialText) {
      throw new Error('No data received from server');
    }

    return { text: partialText, annotations };
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

/**
 * Error types for better error handling
 */
export class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export class CaptchaRequiredError extends APIError {
  constructor() {
    super('CAPTCHA verification required');
    this.name = 'CaptchaRequiredError';
  }
}