/**
 * Text-to-speech pipeline.
 *
 * Markdown is converted to plain speech text, split into sentence-bounded
 * UTF-8-safe chunks (the TTS backend caps request size), and played
 * strictly in order. Mute, navigation, and cancellation stop the whole
 * queue, not just the chunk in flight.
 */

import { ChatAPI } from './api';

export const MAX_TTS_CHUNK_BYTES = 4800;
export const MAX_TTS_CHUNKS = 3;

const encoder = new TextEncoder();
const utf8Length = (value: string): number => encoder.encode(value).length;

/**
 * Converts Markdown to speakable plain text: code blocks are dropped,
 * links and images collapse to their labels, and structural syntax
 * (headings, emphasis, quotes, tables, HTML tags) is stripped.
 */
export const markdownToSpeechText = (markdown: string): string => {
  if (!markdown) return '';
  return markdown
    // Fenced code blocks are not speakable; drop them entirely.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    // Images before links: keep the alt text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^(?:\s*[-*_]){3,}\s*$/gm, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // Table pipes and header separators read as noise. The separator-row
    // rule uses a single character class with one quantifier and excludes
    // newlines: overlapping quantifiers over the space character caused
    // cubic backtracking that could freeze the main thread on a long
    // whitespace run followed by a non-matching character.
    .replace(/^\s*\|/gm, '')
    .replace(/\|\s*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^[ \t:\-,]+$/gm, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
};

/**
 * Splits an oversized sentence at word boundaries, falling back to
 * code-point boundaries (never inside a surrogate pair) for single
 * tokens longer than the byte budget.
 */
const splitOversizedSentence = (sentence: string, maxBytes: number): string[] => {
  const parts: string[] = [];
  let current = '';

  for (const token of sentence.split(/(\s+)/)) {
    if (!token) continue;
    if (utf8Length(current + token) <= maxBytes) {
      current += token;
      continue;
    }
    if (current.trim()) parts.push(current.trim());
    current = '';
    if (utf8Length(token) <= maxBytes) {
      if (token.trim()) current = token;
      continue;
    }
    // A single token beyond the budget: split per code point so a
    // multi-byte character can never straddle two chunks.
    let piece = '';
    for (const character of token) {
      if (utf8Length(piece + character) > maxBytes) {
        if (piece) parts.push(piece);
        piece = character;
      } else {
        piece += character;
      }
    }
    current = piece;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
};

/**
 * Packs sentences into at most `maxChunks` chunks of at most `maxBytes`
 * UTF-8 bytes each. Text beyond the chunk limit is dropped — TTS reads
 * the beginning of a long answer, not all of it.
 */
export const splitSpeechChunks = (
  text: string,
  maxBytes: number = MAX_TTS_CHUNK_BYTES,
  maxChunks: number = MAX_TTS_CHUNKS,
): string[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = trimmed.match(/[^.!?\n]+[.!?]*[\s]*/g) ?? [trimmed];
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  for (const sentence of sentences) {
    if (chunks.length >= maxChunks) break;
    if (utf8Length(current + sentence) <= maxBytes) {
      current += sentence;
      continue;
    }
    flush();
    if (chunks.length >= maxChunks) break;
    if (utf8Length(sentence) <= maxBytes) {
      current = sentence;
      continue;
    }
    for (const part of splitOversizedSentence(sentence, maxBytes)) {
      if (chunks.length >= maxChunks) break;
      chunks.push(part);
    }
  }
  if (chunks.length < maxChunks) flush();

  return chunks.slice(0, maxChunks);
};

/** Audio Service for ordered TTS playback. */
export class AudioService {
  private static currentAudio: HTMLAudioElement | null = null;
  private static currentRequest: AbortController | null = null;
  private static currentCleanup: (() => void) | null = null;
  private static cancelPlayback: (() => void) | null = null;
  private static generation = 0;
  private static muted = false;
  private static pagehideRegistered = false;

  static setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.stop();
  }

  private static registerPagehide(): void {
    if (this.pagehideRegistered || typeof window === 'undefined') return;
    this.pagehideRegistered = true;
    window.addEventListener('pagehide', () => this.stop());
  }

  static async playTTS(markdown: string): Promise<void> {
    this.stop();
    if (this.muted) return;
    this.registerPagehide();

    const text = markdownToSpeechText(markdown);
    const chunks = splitSpeechChunks(text);
    if (!chunks.length) return;

    const generation = this.generation;
    for (const chunk of chunks) {
      if (generation !== this.generation || this.muted) return;
      const finished = await this.playChunk(chunk, generation);
      if (!finished) return;
    }
  }

  /**
   * Fetches and plays one chunk. Resolves true when playback finished
   * naturally, false when the queue was cancelled. Throws on synthesis
   * or playback failure after cleaning up, which also stops the queue.
   */
  private static async playChunk(text: string, generation: number): Promise<boolean> {
    const controller = new AbortController();
    this.currentRequest = controller;
    let releaseAudio: (() => void) | null = null;

    try {
      const audioBlob = await ChatAPI.requestTTS(text, { signal: controller.signal });
      if (controller.signal.aborted || this.muted || generation !== this.generation) return false;

      const audioUrl = URL.createObjectURL(audioBlob);
      if (controller.signal.aborted || this.muted || generation !== this.generation) {
        URL.revokeObjectURL(audioUrl);
        return false;
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

      const finished = await new Promise<boolean>((resolve, reject) => {
        const settle = (callback: () => void) => {
          if (this.cancelPlayback === cancel) this.cancelPlayback = null;
          callback();
        };
        const cancel = () => settle(() => resolve(false));
        this.cancelPlayback = cancel;
        audio.addEventListener('ended', () => settle(() => resolve(true)), { once: true });
        audio.addEventListener('error', () => settle(() => reject(new Error('Audio playback failed'))), { once: true });
        audio.play().catch((error: unknown) => settle(() => reject(
          error instanceof Error ? error : new Error('Audio playback failed'),
        )));
      });

      cleanup();
      return finished && generation === this.generation && !this.muted;
    } catch (error) {
      releaseAudio?.();
      if (
        controller.signal.aborted
        || generation !== this.generation
        || (error instanceof Error && error.name === 'AbortError')
      ) return false;
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

    const cancel = this.cancelPlayback;
    this.cancelPlayback = null;
    cancel?.();

    const cleanup = this.currentCleanup;
    this.currentCleanup = null;
    cleanup?.();
  }
}
