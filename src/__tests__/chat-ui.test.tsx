import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { createRef } from 'react';

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

import { CaptchaRequiredError, StreamCancelledError } from '../services/api';
import { ChatWindow } from '../components/ChatWindow';
import { InputArea } from '../components/InputArea';
import { Message } from '../components/Message';

const theme = createTheme();
const renderThemed = (node: React.ReactNode) => render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
const scrollIntoViewMock = vi.fn();
const elementScrollToMock = vi.fn();
const windowScrollToMock = vi.fn();
let prefersReducedMotion = false;

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
      matches: query === '(prefers-reduced-motion: reduce)' && prefersReducedMotion,
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
    value: scrollIntoViewMock,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: elementScrollToMock,
  });
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    value: windowScrollToMock,
  });
});

beforeEach(() => {
  prefersReducedMotion = false;
  window.localStorage.clear();
  scrollIntoViewMock.mockClear();
  elementScrollToMock.mockClear();
  windowScrollToMock.mockClear();
  apiMocks.sendMessage.mockReset();
  apiMocks.getUsage.mockReset().mockResolvedValue({ logged_in: true, used: 1, limit: 10 });
  apiMocks.clearConversation.mockReset().mockResolvedValue({ success: true });
  apiMocks.deleteConversation.mockReset().mockResolvedValue({ success: true });
  apiMocks.playTTS.mockReset().mockResolvedValue(undefined);
  apiMocks.stopAudio.mockReset();
  apiMocks.setMuted.mockReset();
  delete window.turnstile;
});

afterEach(() => cleanup());

describe('ChatWindow state ownership', () => {
  it('discards legacy global history and persists under the resolved identity', async () => {
    window.localStorage.setItem('chat_conversations', JSON.stringify({ leaked: { title: 'Account A secret' } }));
    window.localStorage.setItem('current_conversation_id', 'leaked');

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByText(/Welcome to WindowsForum\.com/)).toBeInTheDocument();
    expect(screen.queryByText('Account A secret')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('chat_conversations')).toBeNull();
    expect(window.localStorage.getItem('current_conversation_id')).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem('chat_store:v3:42')).not.toBeNull());
  });

  it('commits an aborted partial response exactly once and never speaks it', async () => {
    apiMocks.sendMessage.mockImplementation((_message: string, options: {
      signal: AbortSignal;
      onChunk?: (text: string, annotations: []) => void;
    }) => new Promise((_resolve, reject) => {
      options.onChunk?.('Partial answer', []);
      options.signal.addEventListener('abort', () => {
        reject(new StreamCancelledError('cancelled', 'Partial answer'));
      }, { once: true });
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const composer = await screen.findByRole('textbox');
    fireEvent.change(composer, { target: { value: 'How do I fix this?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Partial answer')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Stop generation'));

    await waitFor(() => expect(screen.getAllByText(/Generation stopped/)).toHaveLength(1));
    expect(screen.getAllByText(/Partial answer/)).toHaveLength(1);
    expect(apiMocks.playTTS).not.toHaveBeenCalled();
  });

  it('binds a Turnstile token to the pending turn and submits it only once', async () => {
    let turnstileConfig: Record<string, unknown> | undefined;
    window.turnstile = {
      render: vi.fn((_selector, config) => {
        turnstileConfig = config;
        return 'widget-1';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    apiMocks.sendMessage
      .mockRejectedValueOnce(new CaptchaRequiredError())
      .mockResolvedValueOnce({ text: 'Verified reply', annotations: [] });

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_abc" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Guest question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(window.turnstile?.render).toHaveBeenCalledTimes(1));
    const callback = turnstileConfig?.callback;
    expect(typeof callback).toBe('function');
    await act(async () => {
      (callback as (token: string) => void)('fresh-token');
    });

    await waitFor(() => expect(apiMocks.sendMessage).toHaveBeenCalledTimes(2));
    expect(apiMocks.sendMessage.mock.calls[1][1]).toMatchObject({
      captchaToken: 'fresh-token',
      conversationId: expect.stringMatching(/^conv_/),
    });
    expect(await screen.findByText('Verified reply')).toBeInTheDocument();
    expect(screen.getAllByText('Guest question').filter(element => element.tagName === 'P')).toHaveLength(1);
  });
});

describe('message scrolling', () => {
  const setScrollGeometry = (element: HTMLElement) => {
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
  };

  it('keeps automatic following inside the message pane', async () => {
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Contained answer', annotations: [] });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const messagePane = await screen.findByLabelText('Chat messages');
    setScrollGeometry(messagePane);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Contained question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Contained answer')).toBeInTheDocument();
    await waitFor(() => expect(messagePane.scrollTop).toBe(1_200));
    expect(elementScrollToMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(windowScrollToMock).not.toHaveBeenCalled();
  });

  it('smoothly jumps within the message pane when the user requests it', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const messagePane = await screen.findByLabelText('Chat messages');
    setScrollGeometry(messagePane);
    fireEvent.scroll(messagePane);

    fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));

    expect(elementScrollToMock).toHaveBeenCalledWith({ top: 1_200, behavior: 'smooth' });
    expect(messagePane.scrollTop).toBe(0);
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(windowScrollToMock).not.toHaveBeenCalled();
  });

  it('does not let a smooth jump cancel its own auto-follow', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const messagePane = await screen.findByLabelText('Chat messages');
    setScrollGeometry(messagePane);
    fireEvent.scroll(messagePane);

    fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

    // A smooth scroll emits intermediate events from far above the bottom.
    // Reacting to them turned auto-follow back off mid-animation, which made
    // the button reappear and flicker on every use.
    fireEvent.scroll(messagePane);
    fireEvent.scroll(messagePane);

    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('jumps immediately inside the message pane when reduced motion is requested', async () => {
    prefersReducedMotion = true;
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const messagePane = await screen.findByLabelText('Chat messages');
    setScrollGeometry(messagePane);
    fireEvent.scroll(messagePane);

    fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));

    expect(messagePane.scrollTop).toBe(1_200);
    expect(elementScrollToMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(windowScrollToMock).not.toHaveBeenCalled();
  });
});

describe('composer and message integrity', () => {
  it('does not submit Enter while an IME composition is active and enforces the byte limit', () => {
    const onSend = vi.fn();
    const commonProps = {
      setInput: vi.fn(),
      isLoading: false,
      isListening: false,
      isSpeechRecognitionSupported: false,
      isMuted: true,
      voiceEnabled: false,
      onSend,
      onStop: vi.fn(),
      onStartListening: vi.fn(),
      onStopListening: vi.fn(),
      onToggleMute: vi.fn(),
      textFieldRef: createRef<HTMLDivElement>(),
      maxMessageBytes: 500,
    };
    const { rerender } = renderThemed(<InputArea {...commonProps} input="日本語" inputBytes={9} />);
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      shiftKey: false,
      isComposing: true,
    });
    expect(onSend).not.toHaveBeenCalled();

    rerender(
      <ThemeProvider theme={theme}>
        <InputArea {...commonProps} input={'é'.repeat(251)} inputBytes={502} />
      </ThemeProvider>
    );
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByText('502 / 500 bytes')).toBeInTheDocument();
  });

  it('shows what the assistant is doing instead of a bare spinner', async () => {
    let emitActivity: ((activities: { id: string; label: string; state: 'active' | 'done' }[]) => void) | undefined;
    apiMocks.sendMessage.mockImplementation((_message: string, options: {
      onActivity?: (activities: { id: string; label: string; state: 'active' | 'done' }[]) => void;
    }) => new Promise(() => {
      // Never settles: hold the turn in its pre-answer phase.
      emitActivity = options.onActivity;
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Why is my PC slow?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Before any progress event arrives, a generic wait is all we can say.
    expect(await screen.findByText('Thinking…')).toBeInTheDocument();

    await act(async () => {
      emitActivity?.([
        { id: 'a', label: 'Searching WindowsForum', state: 'done' },
        { id: 'b', label: 'Reading a thread', state: 'active' },
      ]);
    });

    expect(screen.getByText('Searching WindowsForum')).toBeInTheDocument();
    expect(screen.getByText('Reading a thread')).toBeInTheDocument();
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
  });

  it('keeps the composer editable and focused while a response streams', () => {
    const onSend = vi.fn();
    const props = {
      setInput: vi.fn(),
      isListening: false,
      isSpeechRecognitionSupported: false,
      isMuted: true,
      voiceEnabled: false,
      onSend,
      onStop: vi.fn(),
      onStartListening: vi.fn(),
      onStopListening: vi.fn(),
      onToggleMute: vi.fn(),
      textFieldRef: createRef<HTMLDivElement>(),
      maxMessageBytes: 500,
      input: 'drafting the next question',
      inputBytes: 26,
    };
    renderThemed(<InputArea {...props} isLoading />);

    const textbox = screen.getByRole('textbox');
    // Disabling the focused textarea moves focus to <body> on every send.
    expect(textbox).not.toBeDisabled();
    textbox.focus();
    expect(document.activeElement).toBe(textbox);

    // The submit action is still gated: Enter must not send mid-stream.
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument();
  });

  it('opens the editor with the original Markdown rather than flattened rendered text', () => {
    const onEdit = vi.fn();
    renderThemed(
      <Message
        msg={{
          id: 'user-1',
          role: 'user',
          rawContent: '**bold** [example](https://example.com)',
          timestamp: Date.now(),
          status: 'complete',
        }}
        userAvatar="/avatar.webp"
        userName="Member"
        onEdit={onEdit}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
        isLastMessage={false}
        isLastUserMessage
        isStreaming={false}
      />
    );

    fireEvent.click(screen.getByLabelText('Edit message'));
    expect(screen.getByRole('textbox')).toHaveValue('**bold** [example](https://example.com)');
  });
});
