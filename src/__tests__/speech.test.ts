import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAPI } from '../services/api';
import {
  AudioService,
  MAX_TTS_CHUNKS,
  MAX_TTS_CHUNK_BYTES,
  markdownToSpeechText,
  splitSpeechChunks,
} from '../services/speech';

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

describe('markdownToSpeechText', () => {
  it('strips markdown structure down to speakable text', () => {
    const text = markdownToSpeechText([
      '# Heading',
      '',
      'Some **bold** and _italic_ text with `inline code`.',
      '',
      '```ts',
      'const secret = "never spoken";',
      '```',
      '',
      '- First item',
      '1. Numbered item',
      '> A quote',
      '',
      '[WindowsForum](https://windowsforum.com) and ![screenshot](https://windowsforum.com/x.png)',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n'));

    expect(text).toContain('Heading');
    expect(text).toContain('Some bold and italic text with inline code.');
    expect(text).toContain('First item');
    expect(text).toContain('Numbered item');
    expect(text).toContain('A quote');
    expect(text).toContain('WindowsForum');
    expect(text).toContain('screenshot');
    expect(text).not.toContain('never spoken');
    expect(text).not.toMatch(/[#*_`>|[\]]/);
    expect(text).not.toContain('https://');
  });

  it('returns empty text for empty or code-only markdown', () => {
    expect(markdownToSpeechText('')).toBe('');
    expect(markdownToSpeechText('```\nonly code\n```')).toBe('');
  });
});

describe('splitSpeechChunks', () => {
  it('splits a 5,000-byte text at sentence boundaries under the 4,800-byte cap', () => {
    const sentence = `${'a'.repeat(97)}. `;
    const text = sentence.repeat(51); // ~5,049 bytes
    expect(utf8Length(text)).toBeGreaterThan(5_000);

    const chunks = splitSpeechChunks(text);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(utf8Length(chunk)).toBeLessThanOrEqual(MAX_TTS_CHUNK_BYTES);
      // Sentence-bounded: every chunk ends at a sentence terminator.
      expect(chunk.trimEnd()).toMatch(/\.$/);
    }
  });

  it('never splits a multibyte character across chunks', () => {
    // 4-byte emoji and 2-byte accented characters in one giant "word":
    // forces the code-point fallback path.
    const text = '😀é'.repeat(1_600); // 9,600 bytes in one token
    const chunks = splitSpeechChunks(text, 100, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8Length(chunk)).toBeLessThanOrEqual(100);
      // encodeURIComponent throws on lone surrogates, i.e. on a broken split.
      expect(() => encodeURIComponent(chunk)).not.toThrow();
    }
    expect(chunks.join('')).toBe(text.slice(0, chunks.join('').length));
  });

  it('caps the queue at three chunks and drops the remainder', () => {
    const sentence = `${'b'.repeat(4_000)}. `;
    const chunks = splitSpeechChunks(sentence.repeat(6));
    expect(chunks.length).toBe(MAX_TTS_CHUNKS);
  });

  it('returns no chunks for whitespace-only text', () => {
    expect(splitSpeechChunks('   \n  ')).toEqual([]);
  });
});

describe('AudioService queue lifecycle', () => {
  type AudioHooks = {
    instances: Array<{ finish: () => void; fail: () => void; pause: ReturnType<typeof vi.fn> }>;
    createObjectURL: ReturnType<typeof vi.fn>;
    revokeObjectURL: ReturnType<typeof vi.fn>;
  };

  let hooks: AudioHooks;
  let events: string[];

  const installAudioMocks = () => {
    const instances: AudioHooks['instances'] = [];
    class MockAudio extends EventTarget {
      pause = vi.fn();
      removeAttribute = vi.fn();
      constructor(_url: string) {
        super();
        const record = {
          finish: () => this.dispatchEvent(new Event('ended')),
          fail: () => this.dispatchEvent(new Event('error')),
          pause: this.pause,
        };
        instances.push(record);
      }
      play = vi.fn().mockImplementation(() => {
        events.push(`play:${instances.length}`);
        return Promise.resolve();
      });
    }
    vi.stubGlobal('Audio', MockAudio);
    const createObjectURL = vi.fn().mockReturnValue('blob:test-audio');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    hooks = { instances, createObjectURL, revokeObjectURL };
  };

  beforeEach(() => {
    events = [];
    installAudioMocks();
    AudioService.setMuted(false);
  });

  afterEach(() => {
    AudioService.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const longSentence = (fill: string) => `${fill.repeat(4_000)}. `;

  it('plays chunks strictly in order, one at a time', async () => {
    const requested: string[] = [];
    vi.spyOn(ChatAPI, 'requestTTS').mockImplementation(text => {
      requested.push(text.slice(0, 1));
      events.push(`request:${requested.length}`);
      return Promise.resolve(new Blob(['audio'], { type: 'audio/ogg' }));
    });

    const playback = AudioService.playTTS(`${longSentence('a')}${longSentence('b')}`);
    await vi.waitFor(() => expect(hooks.instances.length).toBe(1));
    // The second chunk must not be requested while the first is playing.
    expect(requested).toEqual(['a']);
    hooks.instances[0].finish();

    await vi.waitFor(() => expect(hooks.instances.length).toBe(2));
    expect(requested).toEqual(['a', 'b']);
    hooks.instances[1].finish();
    await playback;

    expect(events).toEqual(['request:1', 'play:1', 'request:2', 'play:2']);
  });

  it('requests at most three chunks for very long answers', async () => {
    const requestTTS = vi.spyOn(ChatAPI, 'requestTTS')
      .mockResolvedValue(new Blob(['audio'], { type: 'audio/ogg' }));

    const playback = AudioService.playTTS(
      `${longSentence('a')}${longSentence('b')}${longSentence('c')}${longSentence('d')}`
    );
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(hooks.instances.length).toBe(index + 1));
      hooks.instances[index].finish();
    }
    await playback;

    expect(requestTTS).toHaveBeenCalledTimes(3);
  });

  it('stops the whole queue on cancellation, not just the playing chunk', async () => {
    const requestTTS = vi.spyOn(ChatAPI, 'requestTTS')
      .mockResolvedValue(new Blob(['audio'], { type: 'audio/ogg' }));

    const playback = AudioService.playTTS(`${longSentence('a')}${longSentence('b')}`);
    await vi.waitFor(() => expect(hooks.instances.length).toBe(1));

    AudioService.stop();
    await playback;

    expect(hooks.instances[0].pause).toHaveBeenCalled();
    expect(hooks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(requestTTS).toHaveBeenCalledTimes(1);
  });

  it('stops the whole queue when muted mid-playback', async () => {
    const requestTTS = vi.spyOn(ChatAPI, 'requestTTS')
      .mockResolvedValue(new Blob(['audio'], { type: 'audio/ogg' }));

    const playback = AudioService.playTTS(`${longSentence('a')}${longSentence('b')}`);
    await vi.waitFor(() => expect(hooks.instances.length).toBe(1));

    AudioService.setMuted(true);
    await playback;

    expect(requestTTS).toHaveBeenCalledTimes(1);
  });

  it('aborts stale synthesis when a new playback starts', async () => {
    let firstSignal: AbortSignal | undefined;
    vi.spyOn(ChatAPI, 'requestTTS').mockImplementation((text, options) => {
      if (text.startsWith('first')) {
        firstSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return Promise.resolve(new Blob(['audio'], { type: 'audio/ogg' }));
    });

    const first = AudioService.playTTS('first request text.');
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const second = AudioService.playTTS('second request text.');
    expect(firstSignal?.aborted).toBe(true);

    await vi.waitFor(() => expect(hooks.instances.length).toBe(1));
    hooks.instances[0].finish();
    await Promise.all([first, second]);
    expect(hooks.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('cleans up and stops the queue when synthesis fails mid-queue', async () => {
    const requestTTS = vi.spyOn(ChatAPI, 'requestTTS')
      .mockImplementationOnce(() => Promise.resolve(new Blob(['audio'], { type: 'audio/ogg' })))
      .mockImplementationOnce(() => Promise.reject(new Error('synthesis failed')));

    const playback = AudioService.playTTS(
      `${longSentence('a')}${longSentence('b')}${longSentence('c')}`
    );
    await vi.waitFor(() => expect(hooks.instances.length).toBe(1));
    hooks.instances[0].finish();

    await expect(playback).rejects.toThrow('synthesis failed');
    expect(requestTTS).toHaveBeenCalledTimes(2);
    // The first chunk's object URL was released despite the later failure.
    expect(hooks.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('cleans up the object URL when playback itself fails', async () => {
    vi.spyOn(ChatAPI, 'requestTTS')
      .mockResolvedValue(new Blob(['audio'], { type: 'audio/ogg' }));

    const playback = AudioService.playTTS('short sentence.');
    await vi.waitFor(() => expect(hooks.instances.length).toBe(1));
    hooks.instances[0].fail();

    await expect(playback).rejects.toThrow('Audio playback failed');
    expect(hooks.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
