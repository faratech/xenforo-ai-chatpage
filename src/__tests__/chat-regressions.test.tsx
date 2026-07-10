import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { ChatStoreV3 } from '../types';

const apiMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getUsage: vi.fn(),
  clearConversation: vi.fn(),
  deleteConversation: vi.fn(),
  playTTS: vi.fn(),
  stopAudio: vi.fn(),
  setMuted: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    ChatAPI: {
      ...actual.ChatAPI,
      sendMessage: apiMocks.sendMessage,
      getUsage: apiMocks.getUsage,
      clearConversation: apiMocks.clearConversation,
      deleteConversation: apiMocks.deleteConversation,
    },
  };
});

vi.mock('../services/speech', () => ({
  AudioService: {
    playTTS: apiMocks.playTTS,
    stop: apiMocks.stopAudio,
    setMuted: apiMocks.setMuted,
  },
}));

import {
  APIError,
  CaptchaRequiredError,
  StreamCancelledError,
} from '../services/api';
import { ChatWindow } from '../components/ChatWindow';
import { Message } from '../components/Message';

const theme = createTheme();
const renderThemed = (node: React.ReactNode) => render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);

const readStore = (userId: string): ChatStoreV3 => {
  const raw = window.localStorage.getItem(`chat_store:v3:${userId}`);
  if (!raw) throw new Error(`no v3 store for user ${userId}`);
  return JSON.parse(raw) as ChatStoreV3;
};

beforeAll(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  window.localStorage.clear();
  apiMocks.sendMessage.mockReset();
  apiMocks.getUsage.mockReset().mockResolvedValue({ logged_in: true, used: 1, limit: 10 });
  apiMocks.clearConversation.mockReset().mockResolvedValue({ success: true });
  apiMocks.deleteConversation.mockReset().mockResolvedValue({ success: true });
  apiMocks.playTTS.mockReset().mockResolvedValue(undefined);
  apiMocks.stopAudio.mockReset();
  apiMocks.setMuted.mockReset();
  delete window.turnstile;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const composer = () => screen.getByPlaceholderText(/Ask about Windows/);

/** Matches message-bubble paragraphs only; conversation titles repeat the text. */
const messageParagraphs = (text: string) =>
  screen.getAllByText(text).filter(element => element.tagName === 'P');

const sendText = (text: string) => {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
};

/** Renders a chat with one completed exchange: "First question" → "First answer". */
const bootWithExchange = async (userId = '42') => {
  apiMocks.sendMessage.mockResolvedValueOnce({ text: 'First answer', annotations: [] });
  const utils = renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId={userId} />);
  await screen.findByPlaceholderText(/Ask about Windows/);
  sendText('First question');
  await screen.findByText('First answer');
  return utils;
};

describe('account switching', () => {
  it('never shows one account\'s history to another account', async () => {
    const { unmount } = await bootWithExchange('42');
    await waitFor(() => expect(window.localStorage.getItem('chat_store:v3:42')).not.toBeNull());
    unmount();

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Other" userId="99" />);
    expect(await screen.findByText(/Welcome to WindowsForum\.com/)).toBeInTheDocument();
    expect(screen.queryByText('First question')).not.toBeInTheDocument();
    expect(screen.queryByText('First answer')).not.toBeInTheDocument();
    // User 42's history is still intact in their own store.
    expect(Object.values(readStore('42').conversations)[0].messages.some(
      message => message.rawContent === 'First question',
    )).toBe(true);
  });
});

describe('transactional branch operations', () => {
  it('rejects an over-limit edit without destroying the branch', async () => {
    await bootWithExchange();
    fireEvent.click(screen.getByLabelText('Edit message'));
    const editor = screen.getAllByRole('textbox').find(
      element => (element as HTMLTextAreaElement).value === 'First question',
    );
    expect(editor).toBeDefined();
    fireEvent.change(editor as Element, { target: { value: 'x'.repeat(501) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Messages are limited to 500 UTF-8 bytes/)).toBeInTheDocument();
    expect(messageParagraphs('First answer')).toHaveLength(1);
    expect(messageParagraphs('First question')).toHaveLength(1);
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('restores the original branch when regeneration fails', async () => {
    await bootWithExchange();
    apiMocks.sendMessage.mockRejectedValueOnce(
      new APIError('Network request failed', { code: 'network_error', retryable: true }),
    );
    fireEvent.click(screen.getByLabelText('Regenerate response'));

    expect(await screen.findByText(/Network error\. Check your connection/)).toBeInTheDocument();
    expect(messageParagraphs('First answer')).toHaveLength(1);
    expect(messageParagraphs('First question')).toHaveLength(1);
    expect(apiMocks.sendMessage.mock.calls[1][1]).toMatchObject({ resetConversation: true });
    // The server may have consumed the failed turn: flagged for resync.
    await waitFor(() => {
      const stored = Object.values(readStore('42').conversations)
        .find(conversation => conversation.messages.some(message => message.rawContent === 'First answer'));
      expect(stored?.needsServerResync).toBe(true);
    });
  });

  it('replaces the branch when regeneration succeeds', async () => {
    await bootWithExchange();
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Second answer', annotations: [] });
    fireEvent.click(screen.getByLabelText('Regenerate response'));

    expect(await screen.findByText('Second answer')).toBeInTheDocument();
    expect(screen.queryByText('First answer')).not.toBeInTheDocument();
    expect(messageParagraphs('First question')).toHaveLength(1);
  });

  it('blocks branch operations while a security check is pending', async () => {
    await bootWithExchange();
    // Short-circuit the Turnstile loader so no module-level script load
    // leaks into later tests in this file.
    window.turnstile = { render: vi.fn().mockReturnValue('widget-9'), reset: vi.fn(), remove: vi.fn() };
    apiMocks.sendMessage.mockRejectedValueOnce(new CaptchaRequiredError());
    sendText('Second question');
    await screen.findByText('Complete the security check to send your message.');

    fireEvent.click(screen.getByLabelText('Regenerate response'));
    expect(await screen.findByText(
      'Complete the security check before sending another message.',
    )).toBeInTheDocument();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(messageParagraphs('First answer')).toHaveLength(1);
  });
});

describe('/clear', () => {
  it('resets the current conversation in place only after the server succeeds', async () => {
    await bootWithExchange();
    const conversationId = apiMocks.sendMessage.mock.calls[0][1].conversationId as string;

    sendText('/clear');
    await waitFor(() => expect(apiMocks.clearConversation).toHaveBeenCalledWith(conversationId));
    await waitFor(() => expect(screen.queryByText('First answer')).not.toBeInTheDocument());
    expect(screen.getByText(/Welcome to WindowsForum\.com/)).toBeInTheDocument();

    // Same conversation id, reset in place — not a new conversation.
    await waitFor(() => {
      const stored = readStore('42').conversations[conversationId];
      expect(stored).toBeDefined();
      expect(stored.messages).toHaveLength(1);
      expect(stored.title).toBe('New Chat');
    });
  });

  it('keeps everything when the server clear fails', async () => {
    await bootWithExchange();
    apiMocks.clearConversation.mockRejectedValueOnce(new APIError('down', { status: 503, retryable: true }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    sendText('/clear');
    expect(await screen.findByText(/could not clear this conversation/)).toBeInTheDocument();
    expect(messageParagraphs('First answer')).toHaveLength(1);
    expect(messageParagraphs('First question')).toHaveLength(1);
  });
});

describe('interrupted-turn resynchronization', () => {
  it('marks a stopped turn and resyncs the server on the next turn', async () => {
    apiMocks.sendMessage.mockImplementationOnce((_message: string, options: {
      signal: AbortSignal;
      onChunk?: (text: string, annotations: []) => void;
    }) => new Promise((_resolve, reject) => {
      options.onChunk?.('Partial answer', []);
      options.signal.addEventListener('abort', () => {
        reject(new StreamCancelledError('cancelled', 'Partial answer'));
      }, { once: true });
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await screen.findByPlaceholderText(/Ask about Windows/);
    sendText('Interrupted question');
    await screen.findByText('Partial answer');
    fireEvent.click(screen.getByLabelText('Stop generation'));
    await screen.findByText(/Generation stopped/);

    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Recovered answer', annotations: [] });
    sendText('Follow-up question');
    await screen.findByText('Recovered answer');

    const options = apiMocks.sendMessage.mock.calls[1][1];
    expect(options).toMatchObject({ resetConversation: true });
    // The stopped partial is sent as recovery context without the UI marker.
    expect(options.history).toContainEqual({ role: 'assistant', content: 'Partial answer' });
    expect(options.history).toContainEqual({ role: 'user', content: 'Interrupted question' });
  });
});

describe('cross-tab deletion propagation', () => {
  it('applies another tab\'s tombstone and abandons the deleted conversation', async () => {
    await bootWithExchange();
    const conversationId = apiMocks.sendMessage.mock.calls[0][1].conversationId as string;
    await waitFor(() => expect(readStore('42').conversations[conversationId]).toBeDefined());

    const remote: ChatStoreV3 = {
      version: 3,
      conversations: {},
      tombstones: { [conversationId]: Date.now() },
      pendingServerDeletions: {},
    };
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'chat_store:v3:42',
        newValue: JSON.stringify(remote),
      }));
    });

    await waitFor(() => expect(screen.queryByText('First answer')).not.toBeInTheDocument());
    expect(await screen.findByText(/Welcome to WindowsForum\.com/)).toBeInTheDocument();
    await waitFor(() => expect(readStore('42').conversations[conversationId]).toBeUndefined());
  });
});

describe('server deletion retries', () => {
  it('records a failed server deletion and retries it on the next mount', async () => {
    apiMocks.deleteConversation.mockRejectedValueOnce(new APIError('down', { status: 503, retryable: true }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = await bootWithExchange();
    const conversationId = apiMocks.sendMessage.mock.calls[0][1].conversationId as string;

    fireEvent.click(screen.getByLabelText('Open chat history'));
    fireEvent.click(await screen.findByLabelText('Delete conversation'));

    await waitFor(() => {
      const stored = readStore('42');
      expect(stored.pendingServerDeletions[conversationId]).toBeDefined();
      expect(stored.tombstones[conversationId]).toBeDefined();
      expect(stored.conversations[conversationId]).toBeUndefined();
    });
    unmount();

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await waitFor(() => {
      expect(apiMocks.deleteConversation).toHaveBeenCalledTimes(2);
      expect(readStore('42').pendingServerDeletions[conversationId]).toBeUndefined();
    });
  });
});

describe('Turnstile loading resilience', () => {
  it('recreates a timed-out Turnstile script on the next attempt', async () => {
    vi.useFakeTimers();
    apiMocks.sendMessage.mockRejectedValueOnce(new CaptchaRequiredError());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_1" />);
    fireEvent.change(composer(), { target: { value: 'Guest question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await act(async () => { await Promise.resolve(); });

    const firstScript = document.querySelector('script[data-wf-turnstile]');
    expect(firstScript).not.toBeNull();

    // The script never loads; after 15s it is torn down for recreation.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(document.querySelector('script[data-wf-turnstile]')).toBeNull();
    expect(screen.getByText('The security check could not load. Please retry.')).toBeInTheDocument();

    // The failed message came back; retrying injects a fresh script.
    apiMocks.sendMessage.mockRejectedValueOnce(new CaptchaRequiredError());
    fireEvent.click(screen.getByLabelText('Retry message'));
    await act(async () => { await Promise.resolve(); });

    const secondScript = document.querySelector('script[data-wf-turnstile]');
    expect(secondScript).not.toBeNull();
    expect(secondScript).not.toBe(firstScript);
  });
});

describe('citation rendering', () => {
  it('renders only validated http(s) citations as links', () => {
    renderThemed(
      <Message
        msg={{
          id: 'ai-1',
          role: 'ai',
          rawContent: 'Cited answer',
          timestamp: Date.now(),
          status: 'complete',
          annotations: [
            { type: 'url_citation', url: 'https://good.example/docs', title: 'Good source' },
            { type: 'url_citation', url: 'javascript:alert(1)', title: 'Evil source' },
            { type: 'file_citation', filename: 'guide.pdf' },
          ],
        }}
        userAvatar="/avatar.webp"
        userName="Member"
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
        isLastMessage
        isStreaming={false}
      />
    );

    const goodLink = screen.getByRole('link', { name: 'Good source' });
    expect(goodLink).toHaveAttribute('href', 'https://good.example/docs');
    expect(goodLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: 'Evil source' })).not.toBeInTheDocument();
    expect(screen.getByText(/Evil source/)).toBeInTheDocument();
    expect(screen.getByText(/guide\.pdf/)).toBeInTheDocument();
  });

  it('renders streaming content as escaped plain text without markdown parsing', () => {
    renderThemed(
      <Message
        msg={{
          id: 'stream-1',
          role: 'ai',
          rawContent: '**not bold yet** <img src=x onerror=alert(1)>',
          timestamp: Date.now(),
          status: 'sending',
        }}
        userAvatar="/avatar.webp"
        userName="Member"
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
        isLastMessage
        isStreaming
      />
    );

    expect(screen.getByText(/\*\*not bold yet\*\*/)).toBeInTheDocument();
    expect(document.querySelector('.wf-streaming-plain')).not.toBeNull();
    expect(document.querySelector('.wf-streaming-plain img')).toBeNull();
    expect(document.querySelector('.wf-streaming-plain strong')).toBeNull();
  });
});
