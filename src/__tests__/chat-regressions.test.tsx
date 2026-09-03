import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { ChatStoreV4 } from '../types';

const apiMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getUsage: vi.fn(),
  clearConversation: vi.fn(),
  deleteConversation: vi.fn(),
  playTTS: vi.fn(),
  stopAudio: vi.fn(),
  setMuted: vi.fn(),
  getTTSPreferences: vi.fn(() => ({ voice: 'alloy', speed: 1 })),
  configureTTS: vi.fn(),
  listSavedConversations: vi.fn(),
  getSavedConversation: vi.fn(),
  upsertSavedConversation: vi.fn(),
  deleteSavedConversation: vi.fn(),
  submitChatFeedback: vi.fn(),
  createConversationShare: vi.fn(),
  getConversationShare: vi.fn(),
  listConversationShares: vi.fn(),
  revokeConversationShare: vi.fn(),
  uploadChatAttachment: vi.fn(),
  deleteChatAttachment: vi.fn(),
  listSupportCases: vi.fn(),
  getSupportCase: vi.fn(),
  upsertSupportCase: vi.fn(),
  deleteSupportCase: vi.fn(),
  exportSavedChatData: vi.fn(),
  deleteAllSavedChatData: vi.fn(),
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
      listSavedConversations: apiMocks.listSavedConversations,
      getSavedConversation: apiMocks.getSavedConversation,
      upsertSavedConversation: apiMocks.upsertSavedConversation,
      deleteSavedConversation: apiMocks.deleteSavedConversation,
      submitChatFeedback: apiMocks.submitChatFeedback,
      createConversationShare: apiMocks.createConversationShare,
      getConversationShare: apiMocks.getConversationShare,
      listConversationShares: apiMocks.listConversationShares,
      revokeConversationShare: apiMocks.revokeConversationShare,
      uploadChatAttachment: apiMocks.uploadChatAttachment,
      deleteChatAttachment: apiMocks.deleteChatAttachment,
      listSupportCases: apiMocks.listSupportCases,
      getSupportCase: apiMocks.getSupportCase,
      upsertSupportCase: apiMocks.upsertSupportCase,
      deleteSupportCase: apiMocks.deleteSupportCase,
      exportSavedChatData: apiMocks.exportSavedChatData,
      deleteAllSavedChatData: apiMocks.deleteAllSavedChatData,
    },
  };
});

vi.mock('../services/speech', () => ({
  AudioService: {
    playTTS: apiMocks.playTTS,
    stop: apiMocks.stopAudio,
    setMuted: apiMocks.setMuted,
    getPreferences: apiMocks.getTTSPreferences,
    configure: apiMocks.configureTTS,
  },
  TTS_VOICES: ['alloy', 'cedar'],
  saveStoredTTSPreferences: (preferences: { voice: string; speed: number }) => preferences,
}));

import {
  APIError,
  CaptchaRequiredError,
  IncompleteStreamError,
  StreamCancelledError,
} from '../services/api';
import { ChatWindow } from '../components/ChatWindow';
import { Message } from '../components/Message';

const theme = createTheme();
const renderThemed = (node: React.ReactNode) => render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);

const readStore = (userId: string): ChatStoreV4 => {
  const raw = window.localStorage.getItem(`chat_store:v4:${userId}`);
  if (!raw) throw new Error(`no v4 store for user ${userId}`);
  return JSON.parse(raw) as ChatStoreV4;
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
  // jsdom implements neither of these on elements; the transcript is a real
  // scroll container and the app anchors each turn by calling them.
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  apiMocks.sendMessage.mockReset();
  apiMocks.getUsage.mockReset().mockResolvedValue({ logged_in: true, used: 1, limit: 10 });
  apiMocks.clearConversation.mockReset().mockResolvedValue({ success: true });
  apiMocks.deleteConversation.mockReset().mockResolvedValue({ success: true });
  apiMocks.playTTS.mockReset().mockResolvedValue(undefined);
  apiMocks.stopAudio.mockReset();
  apiMocks.setMuted.mockReset();
  apiMocks.listSavedConversations.mockReset().mockResolvedValue({ success: true, conversations: [], next_cursor: null });
  apiMocks.getSavedConversation.mockReset();
  apiMocks.upsertSavedConversation.mockReset().mockImplementation(async (conversation, revision) => ({
    success: true,
    conversation: {
      ...conversation,
      revision: revision + 1,
      created_at: conversation.created_at ?? Date.now(),
      updated_at: Date.now(),
    },
  }));
  apiMocks.deleteSavedConversation.mockReset().mockResolvedValue({ success: true });
  apiMocks.submitChatFeedback.mockReset().mockResolvedValue({ success: true, feedback: {} });
  apiMocks.createConversationShare.mockReset();
  apiMocks.getConversationShare.mockReset();
  apiMocks.listConversationShares.mockReset().mockResolvedValue({ success: true, shares: [], next_cursor: null });
  apiMocks.revokeConversationShare.mockReset().mockResolvedValue({ success: true });
  apiMocks.uploadChatAttachment.mockReset();
  apiMocks.deleteChatAttachment.mockReset().mockResolvedValue({ success: true, deferred_cleanup: false });
  apiMocks.listSupportCases.mockReset().mockResolvedValue({ success: true, cases: [], next_cursor: null });
  apiMocks.getSupportCase.mockReset();
  apiMocks.upsertSupportCase.mockReset();
  apiMocks.deleteSupportCase.mockReset();
  apiMocks.exportSavedChatData.mockReset();
  apiMocks.deleteAllSavedChatData.mockReset();
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
    await waitFor(() => expect(window.localStorage.getItem('chat_store:v4:42')).not.toBeNull());
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
    const questionArticle = screen.getByRole('article', { name: 'Member message' });
    fireEvent.click(within(questionArticle).getByRole('button', { name: 'Message actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit message' }));
    const editor = screen.getAllByRole('textbox').find(
      element => (element as HTMLTextAreaElement).value === 'First question',
    );
    expect(editor).toBeDefined();
    fireEvent.change(editor as Element, { target: { value: 'x'.repeat(4097) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Message is 1 byte too long.')).toBeInTheDocument();
    expect(messageParagraphs('First answer')).toHaveLength(1);
    expect(editor).toHaveValue('x'.repeat(4097));
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('restores the original branch when regeneration fails', async () => {
    await bootWithExchange();
    // Both attempts fail: a transient error that consumed no output is
    // retried once, so the branch may only be restored after that too.
    apiMocks.sendMessage
      .mockRejectedValueOnce(
        new APIError('Network request failed', { code: 'network_error', retryable: true }),
      )
      .mockRejectedValueOnce(
        new APIError('Network request failed', { code: 'network_error', retryable: true }),
      );
    fireEvent.click(screen.getByLabelText('Regenerate response'));

    expect(await screen.findByText(/Network error\. Check your connection/, undefined, { timeout: 3000 }))
      .toBeInTheDocument();
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

  it('answers /usage locally without spending an AI message', async () => {
    apiMocks.getUsage.mockResolvedValue({
      logged_in: true, tier: 'premium', used: 7, limit: 100, remaining: 93,
    });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await screen.findByPlaceholderText(/Ask about Windows/);
    const before = apiMocks.sendMessage.mock.calls.length;

    sendText('/usage');

    expect(await screen.findByText(/Premium Supporter/)).toBeInTheDocument();
    expect(screen.getByText(/7 of 100/)).toBeInTheDocument();
    // The whole point: asking how much quota is left must not consume any.
    expect(apiMocks.sendMessage.mock.calls.length).toBe(before);
  });

  it('fetches the quota for /usage rather than trusting the header cache', async () => {
    // The header badge's value is never populated for guests and may not have
    // arrived yet for anyone else, which made /usage report "not available" to
    // people who had a perfectly good quota.
    apiMocks.getUsage.mockRejectedValueOnce(new Error('badge fetch failed'));
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await screen.findByPlaceholderText(/Ask about Windows/);

    apiMocks.getUsage.mockResolvedValueOnce({
      logged_in: true, tier: 'unlimited', used: 7, unlimited: true, tokens_today: 246196,
    });
    sendText('/usage');

    expect(await screen.findByText(/Staff/)).toBeInTheDocument();
    expect(screen.getByText(/no limit/)).toBeInTheDocument();
    expect(screen.getByText(/246,196/)).toBeInTheDocument();
  });

  it('tells a guest there is no per-account quota instead of an error', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_abc" />);
    await screen.findByPlaceholderText(/Ask about Windows/);

    sendText('/usage');

    expect(await screen.findByText(/no per-account quota is tracked/)).toBeInTheDocument();
    expect(screen.queryByText(/not available right now/)).not.toBeInTheDocument();
  });

  it('recovers from a transient failure that delivered nothing', async () => {
    await bootWithExchange();
    const callsBefore = apiMocks.sendMessage.mock.calls.length;
    apiMocks.sendMessage.mockRejectedValueOnce(
      new APIError('Network request failed', { code: 'network_error', retryable: true }),
    );
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Recovered answer', annotations: [] });
    fireEvent.click(screen.getByLabelText('Regenerate response'));

    expect(await screen.findByText('Recovered answer', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/Network error/)).not.toBeInTheDocument();
    expect(apiMocks.sendMessage.mock.calls.length).toBe(callsBefore + 2);
  });

  it('does not retry a 429 after the generic short transport backoff', async () => {
    await bootWithExchange();
    const callsBefore = apiMocks.sendMessage.mock.calls.length;
    apiMocks.sendMessage.mockRejectedValueOnce(
      new APIError('Please wait before trying again.', { status: 429, retryable: true }),
    );
    fireEvent.click(screen.getByLabelText('Regenerate response'));

    expect(await screen.findByText('Please wait before trying again.')).toBeInTheDocument();
    expect(apiMocks.sendMessage.mock.calls.length).toBe(callsBefore + 1);
  });

  it('never retries a turn that already delivered part of an answer', async () => {
    await bootWithExchange();
    const callsBefore = apiMocks.sendMessage.mock.calls.length;
    // Replaying this would duplicate text the user has already seen.
    apiMocks.sendMessage.mockRejectedValueOnce(
      new IncompleteStreamError('truncated', 'partial text', [], undefined, 'stream_truncated'),
    );
    fireEvent.click(screen.getByLabelText('Regenerate response'));

    expect(await screen.findByText(/interrupted before completion/)).toBeInTheDocument();
    expect(apiMocks.sendMessage.mock.calls.length).toBe(callsBefore + 1);
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

  it('restores the original branch when a regeneration is stopped before any output', async () => {
    await bootWithExchange();
    // The turn hangs until aborted, producing no partial text.
    apiMocks.sendMessage.mockImplementationOnce((_message: string, options: {
      signal: AbortSignal;
    }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new StreamCancelledError('cancelled', ''));
      }, { once: true });
    }));

    fireEvent.click(screen.getByLabelText('Regenerate response'));
    fireEvent.click(await screen.findByLabelText('Stop generation'));

    // Stopping before any output must NOT leave the branch truncated: the
    // previous answer is restored, and the turn is flagged for resync.
    expect(await screen.findByText('First answer')).toBeInTheDocument();
    expect(messageParagraphs('First question')).toHaveLength(1);
    await waitFor(() => {
      const stored = Object.values(readStore('42').conversations)
        .find(conversation => conversation.messages.some(message => message.rawContent === 'First answer'));
      expect(stored?.needsServerResync).toBe(true);
    });
  });
});

describe('/clear', () => {
  it('resets the current conversation in place only after the server succeeds', async () => {
    await bootWithExchange();
    const conversationId = apiMocks.sendMessage.mock.calls[0][1].conversationId as string;

    sendText('/clear');
    expect(await screen.findByRole('dialog', { name: 'Clear messages?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
    await waitFor(() => expect(apiMocks.clearConversation).toHaveBeenCalledWith(conversationId));
    await waitFor(() => expect(screen.queryByText('First answer')).not.toBeInTheDocument());
    expect(screen.getByText(/Welcome to WindowsForum\.com/)).toBeInTheDocument();

    // Same conversation id, reset in place — not a new conversation.
    await waitFor(() => {
      const stored = readStore('42').conversations[conversationId];
      expect(stored).toBeDefined();
      expect(stored.messages).toHaveLength(1);
      expect(stored.title).toBe('First question');
    });
  });

  it('keeps everything when the server clear fails', async () => {
    await bootWithExchange();
    apiMocks.clearConversation.mockRejectedValueOnce(new APIError('down', { status: 503, retryable: true }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    sendText('/clear');
    expect(await screen.findByRole('dialog', { name: 'Clear messages?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
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

    const remote: ChatStoreV4 = {
      version: 4,
      conversations: {},
      tombstones: { [conversationId]: Date.now() },
      pendingServerDeletions: {},
      trimmed: {},
    };
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'chat_store:v4:42',
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
    expect(document.getElementById('wf-chat-window')).toContainElement(await screen.findByText('Recent chats'));
    fireEvent.click((await screen.findAllByLabelText(/Actions for /))[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

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

  const renderStreaming = (rawContent: string) => renderThemed(
    <Message
      msg={{ id: 'stream-x', role: 'ai', rawContent, timestamp: Date.now(), status: 'sending' }}
      userAvatar="/avatar.webp"
      userName="Member"
      onEdit={vi.fn()}
      onRegenerate={vi.fn()}
      onRetry={vi.fn()}
      isLastMessage
      isStreaming
    />
  );

  it('formats the completed blocks of a streaming answer', () => {
    renderStreaming('**Install updates**\n\n## Free up storage\n\npartial senten');

    // Everything before the last blank line is structurally settled.
    expect(document.querySelector('.message-content strong')?.textContent).toBe('Install updates');
    expect(document.querySelector('.message-content h2')?.textContent).toBe('Free up storage');
    // The unfinished tail is still inert text.
    expect(document.querySelector('.wf-streaming-plain')?.textContent).toContain('partial senten');
  });

  it('never renders an unterminated code fence as markup mid-stream', () => {
    renderStreaming('Run this:\n\n```bash\nsfc /scannow\n\nDISM /Online');

    // The fence is still open, so the boundary must stay before it.
    expect(document.querySelector('.message-content pre')).toBeNull();
    const tail = document.querySelector('.wf-streaming-plain')?.textContent ?? '';
    expect(tail).toContain('```bash');
    expect(tail).toContain('sfc /scannow');
  });

  it('keeps hostile markup inert in the unfinished tail', () => {
    renderStreaming('Some prose.\n\n<img src=x onerror=alert(1)> and <script>alert(1)</script>');

    expect(document.querySelector('.message-content img')).toBeNull();
    expect(document.querySelector('.message-content script')).toBeNull();
    expect(document.querySelector('.wf-streaming-plain')?.textContent).toContain('<img src=x');
  });

  it('closes a fence and formats it once the block completes', () => {
    renderStreaming('Run this:\n\n```bash\nsfc /scannow\n```\n\nNext');

    expect(document.querySelector('.message-content pre code')?.textContent).toContain('sfc /scannow');
    expect(document.querySelector('.wf-streaming-plain')?.textContent).toBe('Next');
  });
});
