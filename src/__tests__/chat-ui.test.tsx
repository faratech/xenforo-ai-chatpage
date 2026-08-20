import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { StrictMode, createRef } from 'react';

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

const telemetryMocks = vi.hoisted(() => ({
  reportChatLifecycle: vi.fn(),
  reportClientEvent: vi.fn(),
  reportConversationExport: vi.fn(),
  reportSourceOpened: vi.fn(),
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

vi.mock('../services/telemetry', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/telemetry')>();
  return { ...actual, ...telemetryMocks };
});

import { APIError, CaptchaRequiredError, StreamCancelledError } from '../services/api';
import { ChatWindow } from '../components/ChatWindow';
import { InputArea } from '../components/InputArea';
import { Message } from '../components/Message';

const theme = createTheme();
const renderThemed = (node: React.ReactNode) => render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
const scrollIntoViewMock = vi.fn();
const elementScrollToMock = vi.fn();
const windowScrollToMock = vi.fn();
let prefersReducedMotion = false;
const clipboardWriteMock = vi.fn();

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
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteMock },
  });
});

beforeEach(() => {
  prefersReducedMotion = false;
  window.history.replaceState(null, '', '/');
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
  apiMocks.createConversationShare.mockReset().mockResolvedValue({
    success: true,
    share: { id: 'share_1', token: 'share_token_12345678901234567890', expires_at: Date.now() + 86_400_000 },
  });
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
  Object.values(telemetryMocks).forEach(mock => mock.mockReset());
  clipboardWriteMock.mockReset().mockResolvedValue(undefined);
  delete window.turnstile;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChatWindow state ownership', () => {
  it('announces the finalized answer once and emits content-free lifecycle telemetry', async () => {
    apiMocks.sendMessage.mockImplementationOnce((_message: string, options: {
      onChunk?: (text: string, annotations: []) => void;
    }) => {
      options.onChunk?.('Final accessible answer', []);
      options.onChunk?.('Final accessible answer with detail', []);
      return Promise.resolve({ text: 'Final accessible answer with detail', annotations: [] });
    });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    fireEvent.change(await screen.findByLabelText('Type your message'), { target: { value: 'Private prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Final accessible answer with detail')).toBeInTheDocument();
    expect(screen.getByText('Assistant response: Final accessible answer with detail')).toBeInTheDocument();
    expect(telemetryMocks.reportChatLifecycle).toHaveBeenCalledWith('chat_send_started', expect.objectContaining({
      eventId: expect.any(String),
      outcome: 'send',
    }));
    expect(telemetryMocks.reportChatLifecycle).toHaveBeenCalledWith('chat_first_token', expect.objectContaining({
      eventId: expect.any(String),
      outcome: 'send',
    }));
    expect(telemetryMocks.reportChatLifecycle.mock.calls.filter(([event]) => event === 'chat_first_token')).toHaveLength(1);
    expect(telemetryMocks.reportChatLifecycle).toHaveBeenCalledWith('chat_completed', expect.objectContaining({
      eventId: expect.any(String),
      outcome: 'send',
    }));
    expect(JSON.stringify(telemetryMocks.reportChatLifecycle.mock.calls)).not.toContain('Private prompt');
  });

  it('discards legacy global history and persists under the resolved identity', async () => {
    window.localStorage.setItem('chat_conversations', JSON.stringify({ leaked: { title: 'Account A secret' } }));
    window.localStorage.setItem('current_conversation_id', 'leaked');

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByText(/Welcome to WindowsForum\.com/)).toBeInTheDocument();
    expect(screen.queryByText('Account A secret')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('chat_conversations')).toBeNull();
    expect(window.localStorage.getItem('current_conversation_id')).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem('chat_store:v4:42')).not.toBeNull());
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
    expect(telemetryMocks.reportChatLifecycle).toHaveBeenCalledWith('chat_stopped', expect.objectContaining({
      eventId: expect.any(String),
      outcome: 'user',
    }));
  });

  it('restores an unsent draft after the chat remounts', async () => {
    const first = renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    fireEvent.change(await screen.findByLabelText('Type your message'), {
      target: { value: 'Keep this unfinished question' },
    });
    await waitFor(() => {
      const raw = window.localStorage.getItem('chat_store:v4:42');
      expect(raw).toContain('Keep this unfinished question');
    });
    first.unmount();

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    expect(await screen.findByLabelText('Type your message')).toHaveValue('Keep this unfinished question');
  });

  it('uses capability-led starters and records only the selected action id', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_starters" />);

    const starter = await screen.findByRole('button', { name: /Troubleshoot a Windows problem/ });
    fireEvent.click(starter);

    expect(screen.getByLabelText('Type your message')).toHaveValue(
      'Help me troubleshoot a Windows problem. Start by asking for the most useful missing details.',
    );
    expect(telemetryMocks.reportClientEvent).toHaveBeenCalledWith('starter_selected', {
      outcome: 'troubleshoot',
    });
    expect(JSON.stringify(telemetryMocks.reportClientEvent.mock.calls)).not.toContain('most useful missing details');
  });

  it('opens an actionable sync status and recovers through Retry sync now', async () => {
    apiMocks.listSavedConversations
      .mockRejectedValueOnce(new APIError('temporary failure', { status: 503, retryable: true }))
      .mockResolvedValueOnce({ success: true, conversations: [], next_cursor: null });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    const status = await screen.findByLabelText('History status: Sync paused');
    fireEvent.click(status);
    expect(await screen.findByText('Cloud history is unavailable. Chats remain safe on this device.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry sync now' }));

    await waitFor(() => expect(apiMocks.listSavedConversations).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText('History status: Synced')).toBeInTheDocument();
    expect(telemetryMocks.reportClientEvent).toHaveBeenCalledWith('sync_failed', expect.objectContaining({
      outcome: 'local_copy_safe',
    }));
    expect(telemetryMocks.reportClientEvent).toHaveBeenCalledWith('sync_recovered', expect.objectContaining({
      outcome: 'synced',
    }));
  });

  it('offers a reload instead of a futile retry when the secure page token is stale', async () => {
    apiMocks.listSavedConversations.mockRejectedValueOnce(new APIError('csrf unavailable', {
      status: 403,
      code: 'csrf_unavailable',
      retryable: false,
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    fireEvent.click(await screen.findByLabelText('History status: Sync paused'));
    const statusDialog = screen.getByRole('dialog', { name: 'Chat history' });
    expect(within(statusDialog).getByRole('button', { name: 'Reload chat' })).toBeInTheDocument();
    expect(within(statusDialog).queryByRole('button', { name: 'Retry sync now' })).not.toBeInTheDocument();
  });

  it('opens the consolidated export dialog and reports a content-free copy outcome', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_export" />);

    fireEvent.click(await screen.findByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export conversation' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Copy plain text/ }));

    await waitFor(() => expect(telemetryMocks.reportConversationExport).toHaveBeenCalledWith(
      'text', 'clipboard', 1,
    ));
    expect(screen.getAllByText('Conversation copied as plain text.')).toHaveLength(1);
    expect(JSON.stringify(telemetryMocks.reportConversationExport.mock.calls)).not.toContain('Welcome to WindowsForum');
  });

  it('branches into a new local chat without modifying the original', async () => {
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Original answer', annotations: [] });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    fireEvent.change(await screen.findByLabelText('Type your message'), { target: { value: 'Original question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Original answer');
    await waitFor(() => expect(window.localStorage.getItem('chat_store:v4:42')).toContain('Original answer'));

    const before = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}') as {
      conversations: Record<string, { messages: unknown[] }>;
    };
    const originalId = Object.keys(before.conversations)[0];
    const originalMessages = before.conversations[originalId].messages;

    fireEvent.click(screen.getByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Branch to new chat' }));

    await waitFor(() => {
      const after = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}') as {
        conversations: Record<string, { messages: unknown[]; needsServerResync?: boolean }>;
      };
      expect(Object.keys(after.conversations)).toHaveLength(2);
      expect(after.conversations[originalId].messages).toEqual(originalMessages);
      const branchId = Object.keys(after.conversations).find(id => id !== originalId);
      expect(branchId).toBeDefined();
      expect(after.conversations[branchId ?? ''].needsServerResync).toBe(true);
      expect(window.localStorage.getItem('current_conversation_id:v4:42')).toBe(branchId);
    });
  });

  it('persists visible uploaded metadata but does not copy a bound handle into a branch', async () => {
    const uploaded = {
      id: 'att_1234567890abcdef1234567890abcdef',
      name: 'diagnostic.txt',
      mime: 'text/plain',
      size: 10,
      expires_at: Date.now() + 60_000,
    };
    apiMocks.uploadChatAttachment.mockResolvedValueOnce({ success: true, attachment: uploaded });
    apiMocks.sendMessage
      .mockResolvedValueOnce({ text: 'Attachment answer', annotations: [] })
      .mockResolvedValueOnce({ text: 'Regenerated attachment answer', annotations: [] });

    const { container } = renderThemed(
      <ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />,
    );
    await screen.findByRole('region', { name: 'File attachment drop zone' });
    const file = new File(['diagnostic'], uploaded.name, { type: uploaded.mime });
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [file] },
    });
    expect(await screen.findByText(/diagnostic\.txt · 10 B/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Type your message'), {
      target: { value: 'Read the diagnostic' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Attachment answer')).toBeInTheDocument();
    expect(apiMocks.sendMessage.mock.calls[0][1]).toMatchObject({
      attachmentIds: [uploaded.id],
    });
    await waitFor(() => expect(screen.queryByText(/diagnostic\.txt · 10 B/)).not.toBeInTheDocument());
    const sentFiles = screen.getByRole('list', { name: 'Files attached to this message' });
    expect(within(sentFiles).getByText('diagnostic.txt')).toBeVisible();
    expect(within(sentFiles).getByText('10 B')).toHaveAccessibleName('10 bytes');
    await waitFor(() => {
      const store = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}') as {
        conversations: Record<string, { messages: Array<{ role: string; rawContent: string; attachments?: unknown[] }> }>;
      };
      const userMessage = Object.values(store.conversations)
        .flatMap(conversation => conversation.messages)
        .find(message => message.role === 'user' && message.rawContent === 'Read the diagnostic');
      expect(userMessage?.attachments).toEqual([{
        id: uploaded.id,
        name: uploaded.name,
        mime: uploaded.mime,
        size: uploaded.size,
      }]);
    });

    fireEvent.click(screen.getByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Branch to new chat' }));
    await waitFor(() => {
      const store = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}') as {
        conversations: Record<string, { messages: Array<{ attachments?: unknown[] }> }>;
      };
      expect(Object.values(store.conversations)).toHaveLength(2);
      const conversations = Object.values(store.conversations);
      expect(conversations.filter(conversation => (
        conversation.messages.some(message => Array.isArray(message.attachments) && message.attachments.length === 1)
      ))).toHaveLength(1);
      const branchId = window.localStorage.getItem('current_conversation_id:v4:42');
      expect(store.conversations[branchId ?? '']?.messages.every(message => message.attachments === undefined)).toBe(true);
    });

    fireEvent.click(screen.getByLabelText('Regenerate response'));
    expect(await screen.findByText('Regenerated attachment answer')).toBeInTheDocument();
    expect(apiMocks.sendMessage.mock.calls[1][1]).toMatchObject({ attachmentIds: [], resetConversation: true });
  });

  it('retains a handle after failure and clears it after an explicit retry succeeds', async () => {
    const uploaded = {
      id: 'att_abcdefabcdefabcdefabcdefabcdefab',
      name: 'retry.txt',
      mime: 'text/plain',
      size: 5,
      expires_at: Date.now() + 60_000,
    };
    apiMocks.uploadChatAttachment.mockResolvedValueOnce({ success: true, attachment: uploaded });
    apiMocks.sendMessage
      .mockRejectedValueOnce(new APIError('Attachment send failed.', { status: 500, retryable: false }))
      .mockResolvedValueOnce({ text: 'Retry succeeded', annotations: [] });

    const { container } = renderThemed(
      <ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />,
    );
    await screen.findByRole('region', { name: 'File attachment drop zone' });
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['retry'], uploaded.name, { type: uploaded.mime })] },
    });
    expect(await screen.findByText(/retry\.txt · 5 B/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Type your message'), { target: { value: 'Retry this file' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Failed to send the message. Please retry.')).toBeInTheDocument();
    expect(telemetryMocks.reportChatLifecycle).toHaveBeenCalledWith('chat_failed', expect.objectContaining({
      eventId: expect.any(String),
      outcome: 'send',
    }));
    expect(screen.getByText(/retry\.txt · 5 B/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Retry message'));
    expect(await screen.findByText('Retry succeeded')).toBeInTheDocument();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(apiMocks.sendMessage.mock.calls[1][1]).toMatchObject({
      attachmentIds: [uploaded.id],
      resetConversation: true,
    });
    await waitFor(() => expect(screen.queryByText(/retry\.txt · 5 B/)).not.toBeInTheDocument());
  });

  it('offers prior sent attachment handles to support cases once without duplicates', async () => {
    const attachment = {
      id: 'att_99999999999999999999999999999999',
      name: 'prior-log.txt',
      mime: 'text/plain',
      size: 128,
    };
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_local: {
          id: 'conv_local', title: 'Prior upload', createdAt: 1_000, updatedAt: 2_000,
          messages: [
            { id: 'sent_user', role: 'user', rawContent: 'See my log', timestamp: 1_500, attachments: [attachment] },
            { id: 'sent_ai', role: 'ai', rawContent: 'Reviewed it', timestamp: 2_000, attachments: [attachment] },
          ],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_local');

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await screen.findByText('Reviewed it');
    fireEvent.click(screen.getByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Support cases' }));
    expect(await screen.findByText('No support cases yet')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'New support case' })[0]!);

    const linkFiles = screen.getByRole('checkbox', { name: 'Link 1 current attachment' });
    expect(linkFiles).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Link 2 current attachments' })).not.toBeInTheDocument();
  });

  it('keeps attachment handles bound to a parked CAPTCHA turn', async () => {
    let turnstileConfig: Record<string, unknown> | undefined;
    window.turnstile = {
      render: vi.fn((_selector, config) => {
        turnstileConfig = config;
        return 'widget-member';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const uploaded = {
      id: 'att_ffffffffffffffffffffffffffffffff',
      name: 'challenge.json',
      mime: 'application/json',
      size: 2,
      expires_at: Date.now() + 60_000,
    };
    apiMocks.uploadChatAttachment.mockResolvedValueOnce({ success: true, attachment: uploaded });
    apiMocks.sendMessage
      .mockRejectedValueOnce(new CaptchaRequiredError())
      .mockResolvedValueOnce({ text: 'Verified attachment reply', annotations: [] });

    const { container } = renderThemed(
      <ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />,
    );
    await screen.findByRole('region', { name: 'File attachment drop zone' });
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['{}'], uploaded.name, { type: uploaded.mime })] },
    });
    await screen.findByText(/challenge\.json · 2 B/);
    fireEvent.change(screen.getByLabelText('Type your message'), { target: { value: 'Verify this file' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(window.turnstile?.render).toHaveBeenCalledTimes(1));
    await act(async () => {
      (turnstileConfig?.callback as (token: string) => void)('member-token');
    });

    expect(await screen.findByText('Verified attachment reply')).toBeInTheDocument();
    expect(apiMocks.sendMessage.mock.calls[1][1]).toMatchObject({
      attachmentIds: [uploaded.id],
      captchaToken: 'member-token',
    });
    await waitFor(() => expect(screen.queryByText(/challenge\.json · 2 B/)).not.toBeInTheDocument());
  });

  it('server-deletes a removed composer upload before dropping its chip', async () => {
    const uploaded = {
      id: 'att_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      name: 'remove.csv',
      mime: 'text/csv',
      size: 3,
      expires_at: Date.now() + 60_000,
    };
    apiMocks.uploadChatAttachment.mockResolvedValueOnce({ success: true, attachment: uploaded });
    const { container } = renderThemed(
      <ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />,
    );
    await screen.findByRole('region', { name: 'File attachment drop zone' });
    fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['csv'], uploaded.name, { type: uploaded.mime })] },
    });
    expect(await screen.findByText(/remove\.csv · 3 B/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove remove.csv'));
    await waitFor(() => expect(apiMocks.deleteChatAttachment).toHaveBeenCalledWith(uploaded.id));
    await waitFor(() => expect(screen.queryByText(/remove\.csv · 3 B/)).not.toBeInTheDocument());
  });

  it('offers device chat settings to guests without exposing member account data', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_settings" />);
    await screen.findByText(/Welcome to WindowsForum\.com/);
    fireEvent.click(screen.getByLabelText('Chat actions'));
    const settingsItem = await screen.findByRole('menuitem', { name: 'Chat settings' });
    expect(screen.queryByRole('menuitem', { name: 'Account data' })).not.toBeInTheDocument();
    fireEvent.click(settingsItem);
    expect(await screen.findByRole('dialog', { name: /Chat settings/ })).toBeInTheDocument();
  });

  it('warns when browser history persistence becomes unavailable after startup', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    apiMocks.listSavedConversations.mockRejectedValueOnce(new APIError('temporary failure', {
      status: 503,
      retryable: true,
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    fireEvent.click(await screen.findByLabelText('History status: Sync paused'));
    expect(await screen.findByText(/Browser storage is unavailable/)).toBeInTheDocument();
    expect(telemetryMocks.reportClientEvent).toHaveBeenCalledWith('sync_failed', expect.objectContaining({
      outcome: 'memory_only',
    }));
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

describe('authenticated history, feedback, and sharing', () => {
  const savedConversation = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv_cloud',
    title: 'Cloud chat',
    revision: 3,
    created_at: 1_000,
    updated_at: 3_000,
    messages: [
      { id: 'cloud_user', role: 'user', rawContent: 'Cloud question', timestamp: 2_000, status: 'complete' },
      { id: 'cloud_ai', role: 'ai', rawContent: 'Cloud answer', timestamp: 3_000, status: 'complete' },
    ],
    ...overrides,
  });

  const mockCloudList = (conversation = savedConversation()) => {
    apiMocks.listSavedConversations.mockResolvedValue({
      success: true,
      conversations: [{
        id: conversation.id,
        title: conversation.title,
        revision: conversation.revision,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        message_count: conversation.messages.length,
      }],
      next_cursor: null,
    });
    apiMocks.getSavedConversation.mockResolvedValue({ success: true, conversation });
  };

  it('removes a previously synced local record absent from a complete cloud inventory', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_deleted_elsewhere: {
          id: 'conv_deleted_elsewhere', title: 'Deleted elsewhere', createdAt: 1_000, updatedAt: 2_000,
          cloudRevision: 4, cloudUpdatedAt: 2_000, cloudSyncedLocalUpdatedAt: 2_000,
          messages: [{ id: 'private_ai', role: 'ai', rawContent: 'Stale private answer', timestamp: 2_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_deleted_elsewhere');

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    await waitFor(() => expect(screen.queryByText('Stale private answer')).not.toBeInTheDocument());
    expect(await screen.findByText(/Welcome to WindowsForum\.com/)).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}');
      expect(stored.conversations.conv_deleted_elsewhere).toBeUndefined();
      expect(stored.tombstones.conv_deleted_elsewhere).toEqual(expect.any(Number));
    });
    expect(apiMocks.upsertSavedConversation).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv_deleted_elsewhere' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not recreate a cloud-deleted record after conflict resolution returns not found', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_cloud: {
          id: 'conv_cloud', title: 'Dirty local edit', createdAt: 1_000, updatedAt: 4_000,
          cloudRevision: 3, cloudUpdatedAt: 3_000, cloudSyncedLocalUpdatedAt: 3_000,
          messages: [{ id: 'local_user', role: 'user', rawContent: 'Do not resurrect me', timestamp: 4_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_cloud');
    const remote = savedConversation({ updated_at: 3_000 });
    mockCloudList(remote);
    apiMocks.getSavedConversation
      .mockResolvedValueOnce({ success: true, conversation: remote })
      .mockRejectedValueOnce(new APIError('gone', { status: 404, code: 'not_found' }));
    apiMocks.upsertSavedConversation.mockRejectedValueOnce(new APIError('changed', {
      status: 409,
      code: 'revision_conflict',
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    await waitFor(() => expect(screen.queryByText('Do not resurrect me')).not.toBeInTheDocument());
    expect(apiMocks.upsertSavedConversation).toHaveBeenCalledTimes(1);
    expect(apiMocks.upsertSavedConversation.mock.calls[0]?.[1]).toBe(3);
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}');
      expect(stored.conversations.conv_cloud).toBeUndefined();
      expect(stored.tombstones.conv_cloud).toEqual(expect.any(Number));
    });
  });

  it('honors the server deletion guard without retrying a stale local upsert', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_stale_device: {
          id: 'conv_stale_device', title: 'Stale device copy', createdAt: 1_000, updatedAt: 4_000,
          messages: [{ id: 'stale_user', role: 'user', rawContent: 'Old offline copy', timestamp: 4_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_stale_device');
    apiMocks.upsertSavedConversation.mockRejectedValueOnce(new APIError('deleted', {
      status: 409,
      code: 'conversation_deleted',
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    await waitFor(() => expect(screen.queryByText('Old offline copy')).not.toBeInTheDocument());
    expect(apiMocks.upsertSavedConversation).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}');
      expect(stored.conversations.conv_stale_device).toBeUndefined();
      expect(stored.tombstones.conv_stale_device).toEqual(expect.any(Number));
    });
  });

  it('loads a requested cloud chat and lets the newest timestamp win', async () => {
    window.history.replaceState(null, '', '/?conversation=conv_cloud');
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_cloud: {
          id: 'conv_cloud', title: 'Older local chat', createdAt: 1_000, updatedAt: 2_000,
          messages: [{ id: 'local_ai', role: 'ai', rawContent: 'Older local answer', timestamp: 2_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_cloud');
    mockCloudList();

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByText('Cloud answer')).toBeInTheDocument();
    expect(screen.queryByText('Older local answer')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('History status: Synced')).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get('conversation')).toBe('conv_cloud');
  });

  it('does not replace a fallback chat when the user types during initial cloud hydration', async () => {
    const remote = savedConversation();
    apiMocks.listSavedConversations.mockResolvedValue({
      success: true,
      conversations: [{
        id: remote.id,
        title: remote.title,
        revision: remote.revision,
        created_at: remote.created_at,
        updated_at: remote.updated_at,
        message_count: remote.messages.length,
      }],
      next_cursor: null,
    });
    let resolveDetail: ((value: { success: true; conversation: typeof remote }) => void) | undefined;
    apiMocks.getSavedConversation.mockImplementationOnce(() => new Promise(resolve => {
      resolveDetail = resolve;
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await waitFor(() => expect(apiMocks.getSavedConversation).toHaveBeenCalledWith(
      'conv_cloud',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    fireEvent.change(screen.getByLabelText('Type your message'), {
      target: { value: 'Do not discard this draft' },
    });

    await act(async () => { resolveDetail?.({ success: true, conversation: remote }); });

    expect(await screen.findByLabelText('History status: Synced')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Do not discard this draft')).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get('conversation')).not.toBe('conv_cloud');
  });

  it('revalidates cloud history without replacing the chat selected after bootstrap', async () => {
    window.history.replaceState(null, '', '/?conversation=conv_cloud');
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_cloud: {
          id: 'conv_cloud', title: 'Older local chat', createdAt: 1_000, updatedAt: 2_000,
          messages: [{ id: 'local_ai', role: 'ai', rawContent: 'Older local answer', timestamp: 2_000 }],
        },
        conv_scratch: {
          id: 'conv_scratch', title: 'Local scratch', createdAt: 1_500, updatedAt: 2_500,
          messages: [{ id: 'scratch_ai', role: 'ai', rawContent: 'Local notes', timestamp: 2_500 }],
          draft: 'keep this draft',
          draftUpdatedAt: 2_600,
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_cloud');
    mockCloudList();

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByText('Cloud answer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Local scratch Draft saved$/ }));
    expect(await screen.findByDisplayValue('keep this draft')).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get('conversation')).toBe('conv_scratch');

    fireEvent.click(screen.getByLabelText('History status: Synced'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry sync now' }));

    await waitFor(() => expect(apiMocks.listSavedConversations).toHaveBeenCalledTimes(2));
    expect(screen.getByDisplayValue('keep this draft')).toBeInTheDocument();
    expect(screen.getByText('Local notes')).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get('conversation')).toBe('conv_scratch');
  });

  it('retries a dirty cloud write before reporting sync recovery', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_cloud: {
          id: 'conv_cloud', title: 'Dirty local edit', createdAt: 1_000, updatedAt: 4_000,
          cloudRevision: 3, cloudUpdatedAt: 3_000, cloudSyncedLocalUpdatedAt: 3_000,
          messages: [{ id: 'local_user', role: 'user', rawContent: 'Unsaved edit', timestamp: 4_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_cloud');
    window.localStorage.setItem('chat_cloud_bootstrap:v1:42', 'complete');
    mockCloudList(savedConversation({ updated_at: 3_000 }));
    apiMocks.upsertSavedConversation.mockRejectedValueOnce(new APIError('temporary', {
      status: 503,
      code: 'temporarily_unavailable',
      retryable: true,
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByLabelText('History status: Sync paused')).toBeInTheDocument();
    expect(apiMocks.upsertSavedConversation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('History status: Sync paused'));
    const statusDialog = screen.getByRole('dialog', { name: 'Chat history' });
    fireEvent.click(within(statusDialog).getByRole('button', { name: 'Retry sync now' }));

    await waitFor(() => expect(apiMocks.upsertSavedConversation).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText('History status: Synced')).toBeInTheDocument();
    expect(telemetryMocks.reportClientEvent).toHaveBeenCalledWith('sync_recovered', expect.objectContaining({
      outcome: 'synced',
    }));
  });

  it('skips unchanged cloud detail reads during manual revalidation', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_cloud: {
          id: 'conv_cloud', title: 'Cloud chat', createdAt: 1_000, updatedAt: 3_000,
          cloudRevision: 3, cloudUpdatedAt: 3_000, cloudSyncedLocalUpdatedAt: 3_000,
          messages: [{ id: 'cloud_ai', role: 'ai', rawContent: 'Cloud answer', timestamp: 3_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_cloud');
    mockCloudList();

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByLabelText('History status: Synced')).toBeInTheDocument();
    expect(apiMocks.getSavedConversation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('History status: Synced'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Chat history' })).getByRole('button', { name: 'Retry sync now' }));

    await waitFor(() => expect(apiMocks.listSavedConversations).toHaveBeenCalledTimes(2));
    expect(apiMocks.getSavedConversation).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText('History status: Synced')).toBeInTheDocument();
  });

  it('hydrates cloud details with bounded concurrency', async () => {
    const remotes = Array.from({ length: 12 }, (_, index) => savedConversation({
      id: `conv_cloud_${index}`,
      title: `Cloud chat ${index}`,
      revision: index + 1,
      created_at: 1_000 + index,
      updated_at: 3_000 + index,
      messages: [{
        id: `cloud_ai_${index}`,
        role: 'ai',
        rawContent: `Cloud answer ${index}`,
        timestamp: 3_000 + index,
        status: 'complete',
      }],
    }));
    apiMocks.listSavedConversations.mockResolvedValue({
      success: true,
      conversations: remotes.map(remote => ({
        id: remote.id,
        title: remote.title,
        revision: remote.revision,
        created_at: remote.created_at,
        updated_at: remote.updated_at,
        message_count: remote.messages.length,
      })),
      next_cursor: null,
    });
    let activeReads = 0;
    let maximumActiveReads = 0;
    apiMocks.getSavedConversation.mockImplementation(async (id: string) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise(resolve => setTimeout(resolve, 5));
      activeReads -= 1;
      return { success: true, conversation: remotes.find(remote => remote.id === id) };
    });

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByText('Cloud answer 11')).toBeInTheDocument();
    expect(apiMocks.getSavedConversation).toHaveBeenCalledTimes(12);
    expect(maximumActiveReads).toBeGreaterThan(1);
    expect(maximumActiveReads).toBeLessThanOrEqual(5);
  });

  it('keeps available cloud chats visible and reports a partial hydration failure', async () => {
    const available = savedConversation();
    const recovered = savedConversation({
      id: 'conv_unavailable',
      title: 'Recovered newer chat',
      revision: 1,
      created_at: 2_000,
      updated_at: 4_500,
      messages: [{ id: 'recovered_ai', role: 'ai', rawContent: 'Recovered answer', timestamp: 4_500 }],
    });
    apiMocks.listSavedConversations.mockResolvedValue({
      success: true,
      conversations: [
        {
          id: available.id,
          title: available.title,
          revision: available.revision,
          created_at: available.created_at,
          updated_at: available.updated_at,
          message_count: available.messages.length,
        },
        {
          id: 'conv_unavailable',
          title: 'Temporarily unavailable',
          revision: 1,
          created_at: 2_000,
          updated_at: 2_500,
          message_count: 2,
        },
      ],
      next_cursor: null,
    });
    apiMocks.getSavedConversation
      .mockResolvedValueOnce({ success: true, conversation: available })
      .mockRejectedValueOnce(new APIError('temporary failure', { status: 503, retryable: true }))
      .mockResolvedValueOnce({ success: true, conversation: recovered });

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByText('Cloud answer')).toBeInTheDocument();
    expect(await screen.findByLabelText('History status: Sync paused')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type your message'), { target: { value: 'Keep working in this chat' } });
    fireEvent.click(screen.getByLabelText('History status: Sync paused'));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Chat history' })).getByRole('button', { name: 'Retry sync now' }));

    expect(await screen.findByLabelText('History status: Synced')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep working in this chat')).toBeInTheDocument();
    expect(screen.getByText('Cloud answer')).toBeInTheDocument();
    expect(screen.queryByText('Recovered answer')).not.toBeInTheDocument();
  });

  it('uploads existing local history once and records the returned revision', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_local: {
          id: 'conv_local', title: 'Local history', createdAt: 1_000, updatedAt: 4_000,
          messages: [{ id: 'local_user', role: 'user', rawContent: 'Local question', timestamp: 4_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_local');

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    await waitFor(() => expect(apiMocks.upsertSavedConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv_local', title: 'Local history' }),
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}');
      expect(stored.conversations.conv_local.cloudRevision).toBe(1);
      expect(window.localStorage.getItem('chat_cloud_bootstrap:v1:42')).toBe('complete');
    });
  });

  it('recovers a revision conflict by accepting a concurrently newer cloud copy', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_cloud: {
          id: 'conv_cloud', title: 'Newer local', createdAt: 1_000, updatedAt: 4_000,
          messages: [{ id: 'local_user', role: 'user', rawContent: 'Local edit', timestamp: 4_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_cloud');
    const olderRemote = savedConversation({ updated_at: 3_000 });
    const concurrentRemote = savedConversation({
      revision: 4,
      updated_at: 5_000,
      messages: [{ id: 'remote_user', role: 'user', rawContent: 'Concurrent cloud edit', timestamp: 5_000 }],
    });
    mockCloudList(olderRemote);
    apiMocks.getSavedConversation
      .mockResolvedValueOnce({ success: true, conversation: olderRemote })
      .mockResolvedValueOnce({ success: true, conversation: concurrentRemote });
    apiMocks.upsertSavedConversation.mockRejectedValueOnce(new APIError('changed', {
      status: 409,
      code: 'revision_conflict',
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    expect(await screen.findByText('Concurrent cloud edit')).toBeInTheDocument();
    expect(screen.queryByText('Local edit')).not.toBeInTheDocument();
  });

  it('debounces a renamed cloud chat into a revision-safe save', async () => {
    mockCloudList();
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await screen.findByText('Cloud answer');

    fireEvent.click(screen.getByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Chat name'), { target: { value: 'Renamed cloud chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMocks.upsertSavedConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv_cloud', title: 'Renamed cloud chat' }),
      3,
      expect.any(Object),
    ), { timeout: 3_000 });
  });

  it('submits response feedback with its response and turn identifiers', async () => {
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Answer with ids', annotations: [], responseId: 'resp_1' });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    fireEvent.change(await screen.findByLabelText('Type your message'), { target: { value: 'Question with feedback' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Answer with ids');

    fireEvent.click(screen.getByLabelText('Mark response as not helpful'));
    fireEvent.change(await screen.findByLabelText('Reason (optional)'), { target: { value: 'Missed the key step' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

    await waitFor(() => expect(apiMocks.submitChatFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        responseId: 'resp_1',
        turnId: expect.any(String),
        rating: 'down',
        reason: 'Missed the key step',
      }),
    ));
    expect(telemetryMocks.reportClientEvent).toHaveBeenCalledWith('message_feedback', {
      eventId: expect.any(String),
      outcome: 'down',
    });
  });

  it('creates and one-time discloses a canonical public link only for a synced member chat', async () => {
    mockCloudList();
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await screen.findByLabelText('History status: Synced');

    fireEvent.click(screen.getByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share links' }));
    expect(await screen.findByText('No share links yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith(
      'https://windowsforum.com/pages/ai/?share=share_token_12345678901234567890'
    ));
    expect(await screen.findByText(/This URL is disclosed only now/)).toBeInTheDocument();
    expect(apiMocks.createConversationShare).toHaveBeenCalledWith(
      'conv_cloud',
      3,
      expect.objectContaining({ expiresIn: 604_800, signal: expect.any(AbortSignal) }),
    );
  });

  it('clears the local member store only after delete-all succeeds and leaves provider cleanup separate', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_old: {
          id: 'conv_old',
          title: 'Old local chat',
          createdAt: 1_000,
          updatedAt: 2_000,
          messages: [
            { id: 'old_user', role: 'user', rawContent: 'Delete this local history', timestamp: 1_500 },
            { id: 'old_ai', role: 'ai', rawContent: 'Old private answer', timestamp: 2_000 },
          ],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_old');
    apiMocks.deleteAllSavedChatData.mockResolvedValue({
      success: true,
      deleted_scope: 'saved_chat_product_data',
      attachment_files_deleted: 1,
      attachment_files_deferred: 0,
      deletion_guards_retained: 1,
      deletion_guard_expires_at: 1_818_659_200_000,
      deletion_guard_max_retention_days: 365,
    });

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    expect(await screen.findByText('Old private answer')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Account data' }));
    const accountDialog = await screen.findByRole('dialog', { name: /Your AI chat data/ });
    expect(within(accountDialog).getByText(/separate 30-day cleanup process/)).toBeInTheDocument();
    fireEvent.click(within(accountDialog).getByRole('button', { name: 'Delete all data' }));

    const confirmation = screen.getByRole('dialog', { name: 'Permanently delete saved chat data?' });
    fireEvent.change(within(confirmation).getByLabelText('Confirmation phrase'), {
      target: { value: 'DELETE SAVED CHAT DATA' },
    });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete saved data' }));

    await waitFor(() => expect(apiMocks.deleteAllSavedChatData).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/deleted from the server and this browser/)).toBeInTheDocument();
    await waitFor(() => {
      const store = JSON.parse(window.localStorage.getItem('chat_store:v4:42') ?? '{}') as {
        conversations: Record<string, unknown>;
        tombstones: Record<string, number>;
        pendingServerDeletions: Record<string, number>;
      };
      expect(store.conversations.conv_old).toBeUndefined();
      expect(Object.keys(store.conversations)).toHaveLength(1);
      expect(store.tombstones.conv_old).toEqual(expect.any(Number));
      expect(store.pendingServerDeletions).toEqual({});
      expect(window.localStorage.getItem('current_conversation_id:v4:42')).not.toBe('conv_old');
      expect(window.localStorage.getItem('chat_cloud_bootstrap:v1:42')).toBeNull();
    });
    expect(apiMocks.deleteConversation).not.toHaveBeenCalled();
    expect(screen.queryByText('Old private answer')).not.toBeInTheDocument();
  });

  it('aborts cloud persistence before starting delete-all and resumes after the reset', async () => {
    window.localStorage.setItem('chat_store:v4:42', JSON.stringify({
      version: 4,
      conversations: {
        conv_old: {
          id: 'conv_old', title: 'Pending cloud write', createdAt: 1_000, updatedAt: 2_000,
          messages: [{ id: 'old_user', role: 'user', rawContent: 'Pending private question', timestamp: 2_000 }],
        },
      },
      tombstones: {},
      pendingServerDeletions: {},
    }));
    window.localStorage.setItem('current_conversation_id:v4:42', 'conv_old');
    let syncSignal: AbortSignal | undefined;
    apiMocks.upsertSavedConversation.mockImplementation((_conversation, _revision, options: { signal: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        syncSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })
    ));
    apiMocks.deleteAllSavedChatData.mockImplementation(() => {
      expect(syncSignal?.aborted).toBe(true);
      return Promise.resolve({
        success: true,
        deleted_scope: 'saved_chat_product_data',
        attachment_files_deleted: 0,
        attachment_files_deferred: 0,
        deletion_guards_retained: 1,
        deletion_guard_expires_at: 1_818_659_200_000,
        deletion_guard_max_retention_days: 365,
      });
    });

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await waitFor(() => expect(apiMocks.upsertSavedConversation).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('Chat actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Account data' }));
    const accountDialog = await screen.findByRole('dialog', { name: /Your AI chat data/ });
    fireEvent.click(within(accountDialog).getByRole('button', { name: 'Delete all data' }));
    const confirmation = screen.getByRole('dialog', { name: 'Permanently delete saved chat data?' });
    fireEvent.change(within(confirmation).getByLabelText('Confirmation phrase'), {
      target: { value: 'DELETE SAVED CHAT DATA' },
    });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete saved data' }));

    await waitFor(() => expect(apiMocks.deleteAllSavedChatData).toHaveBeenCalledTimes(1));
    expect(syncSignal?.aborted).toBe(true);
    expect(await screen.findByText(/deleted from the server and this browser/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Pending private question')).not.toBeInTheDocument());
  });

  it('renders a public share as a read-only snapshot without local history or a composer', async () => {
    window.history.replaceState(null, '', '/pages/ai/?share=share_token_12345678901234567890');
    apiMocks.getConversationShare.mockResolvedValue({
      success: true,
      share: {
        id: 'share_1', title: 'Shared repair', created_at: 1_000, expires_at: Date.now() + 86_400_000,
        messages: [{ role: 'assistant', content: 'Shared answer', createdAt: 1_000 }],
      },
    });

    const view = renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_public" />);

    expect(await screen.findByText('Shared answer')).toBeInTheDocument();
    expect(screen.getByText(/Read-only snapshot/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Type your message')).not.toBeInTheDocument();
    expect(apiMocks.listSavedConversations).not.toHaveBeenCalled();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex,nofollow,noarchive',
    );

    view.unmount();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('restores an existing robots directive after leaving a public share', () => {
    window.history.replaceState(null, '', '/pages/ai/?share=share_token_12345678901234567890');
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'index,follow';
    document.head.appendChild(robots);
    apiMocks.getConversationShare.mockReturnValue(new Promise(() => {}));

    const view = renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_public" />);
    expect(robots).toHaveAttribute('content', 'noindex,nofollow,noarchive');

    view.unmount();
    expect(robots).toHaveAttribute('content', 'index,follow');
    robots.remove();
  });

  it('deletes the synced cloud record after local confirmation', async () => {
    mockCloudList();
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await screen.findByText('Cloud answer');

    fireEvent.click((await screen.findAllByLabelText('Actions for Cloud chat'))[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(apiMocks.deleteSavedConversation).toHaveBeenCalledWith(
      'conv_cloud',
      3,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
  });
});

describe('message scrolling', () => {
  /**
   * The transcript is the app's one scroll container, and the window is never
   * scrolled. On the XenForo page node the document is ~770px taller than the
   * chat — an AdSense reservation and the page title above it, share buttons,
   * a breadcrumb and the forum footer below — so scrolling the window to
   * `document.documentElement.scrollHeight` landed in the footer rather than
   * at the end of the conversation, once per streamed frame.
   */
  const ANCHOR_TOP = 640;

  /** Everything reports a viewport top of 0 except the current turn's anchor. */
  const stubBoundingRects = () => {
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Element) {
        const top = this.hasAttribute?.('data-wf-turn-anchor') ? ANCHOR_TOP : 0;
        return { top, y: top, bottom: top, left: 0, right: 0, x: 0, width: 0, height: 0, toJSON: () => ({}) };
      },
    });
  };

  const setPaneGeometry = (
    element: HTMLElement,
    { scrollHeight = 1_200, clientHeight = 200, scrollTop = 0 } = {},
  ) => {
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: scrollHeight },
      clientHeight: { configurable: true, value: clientHeight },
      scrollTop: { configurable: true, writable: true, value: scrollTop },
    });
  };

  const findPane = async () => {
    const pane = await screen.findByLabelText('Chat messages');
    setPaneGeometry(pane);
    return pane;
  };

  beforeEach(stubBoundingRects);

  it('never scrolls the window, whatever happens in a turn', async () => {
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Contained answer', annotations: [] });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const pane = await findPane();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Contained question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Contained answer')).toBeInTheDocument();
    fireEvent.scroll(pane);

    // The whole point of the change: the forum page around the embed stays
    // exactly where the reader left it.
    expect(windowScrollToMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('anchors a new turn to the question rather than to the end of the transcript', async () => {
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Anchored answer', annotations: [] });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    await findPane();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Anchored question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Chasing the end of the text instead slides every line upward under the
    // reader while the answer is being written.
    await waitFor(() => expect(elementScrollToMock)
      .toHaveBeenCalledWith({ top: ANCHOR_TOP, behavior: 'smooth' }));
  });

  it('reserves enough room below the newest question for it to reach the top', async () => {
    apiMocks.sendMessage.mockResolvedValueOnce({ text: 'Short answer', annotations: [] });
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const pane = await findPane();
    // A short exchange: only 60px of content sits below the anchor, so 140px
    // of the 200px pane has to be reserved or the anchor scroll clamps back.
    setPaneGeometry(pane, { scrollHeight: ANCHOR_TOP + 60, clientHeight: 200 });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Short question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    const spacer = document.querySelector<HTMLElement>('[data-wf-tail-spacer]');
    await waitFor(() => expect(spacer?.style.height).toBe('140px'));
  });

  it('smoothly jumps to the latest message when the user requests it', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const pane = await findPane();
    fireEvent.scroll(pane);

    fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));

    expect(elementScrollToMock).toHaveBeenCalledWith({ top: 1_200, behavior: 'smooth' });
    expect(windowScrollToMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('does not let a smooth jump cancel its own auto-follow', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const pane = await findPane();
    fireEvent.scroll(pane);

    fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

    // A smooth scroll emits intermediate events from far above the bottom.
    // Reacting to them turned auto-follow back off mid-animation, which made
    // the button reappear and flicker on every use.
    fireEvent.scroll(pane);
    fireEvent.scroll(pane);

    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('jumps immediately when reduced motion is requested', async () => {
    prefersReducedMotion = true;
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    const pane = await findPane();
    fireEvent.scroll(pane);

    fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));

    expect(pane.scrollTop).toBe(1_200);
    expect(elementScrollToMock).not.toHaveBeenCalled();
    expect(windowScrollToMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});

describe('the relocated forum ad', () => {
  /**
   * /pages/ai is a full-viewport shell that does not scroll, so the forum's
   * 280px breadcrumb unit (390px on a phone) is no longer emitted above the
   * chat — `_ads.html` skips it for `page-313` — and is rendered as the last
   * row of the shell instead. Both gates here mirror the host rather than
   * restating its policy, so this is what pins that.
   */
  const withAdSenseLoader = () => {
    const script = document.createElement('script');
    script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=x';
    document.head.appendChild(script);
    return () => script.remove();
  };

  afterEach(() => {
    document.querySelectorAll('script[src*="adsbygoogle.js"]').forEach(s => s.remove());
    delete window.adsbygoogle;
  });

  it('renders for a guest on the embed and enqueues the slot exactly once', async () => {
    const cleanup = withAdSenseLoader();
    const pushed: Record<string, unknown>[] = [];
    window.adsbygoogle = { push: (config: Record<string, unknown>) => { pushed.push(config); } } as never;

    // StrictMode double-mounts in development, and AdSense throws on a second
    // push into the same <ins>.
    renderThemed(
      <StrictMode>
        <ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_abc" />
      </StrictMode>,
    );

    const slot = await screen.findByLabelText('Advertisement');
    expect(slot).toBeInTheDocument();
    expect(slot.querySelector('ins.adsbygoogle')?.getAttribute('data-ad-slot')).toBe('6778196821');
    // `auto` would let the unit resize itself, which is the one thing this
    // position must never do.
    expect(slot.querySelector('ins.adsbygoogle')?.getAttribute('data-ad-format')).toBe('horizontal');
    expect(pushed).toHaveLength(1);
    cleanup();
  });

  it('never renders for a member, who has never seen this unit', async () => {
    const cleanup = withAdSenseLoader();
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);

    await screen.findByLabelText('Chat messages');
    expect(screen.queryByLabelText('Advertisement')).not.toBeInTheDocument();
    cleanup();
  });

  it('renders nothing off the embed, where no forum ad loader exists', async () => {
    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Guest" userId="guest_abc" />);

    await screen.findByLabelText('Chat messages');
    expect(screen.queryByLabelText('Advertisement')).not.toBeInTheDocument();
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
    expect(screen.getByText('Message is 2 bytes too long')).toBeInTheDocument();
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
    // A step is running, so it owns the only spinner.
    expect(screen.queryByText('Preparing the answer…')).not.toBeInTheDocument();
  });

  /**
   * Every step flips to a green check on `response.output_item.done`, so the
   * gaps between them — reasoning closed but the message item not yet open, or a
   * local tool running between the two upstream calls — used to leave a
   * motionless list of ticks that read as finished-but-broken.
   */
  it('keeps a live row when every step so far has finished', async () => {
    let emitActivity: ((activities: { id: string; label: string; state: 'active' | 'done' }[]) => void) | undefined;
    apiMocks.sendMessage.mockImplementation((_message: string, options: {
      onActivity?: (activities: { id: string; label: string; state: 'active' | 'done' }[]) => void;
    }) => new Promise(() => {
      emitActivity = options.onActivity;
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Why is my PC slow?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('Thinking…');

    await act(async () => {
      emitActivity?.([
        { id: 'a', label: 'Searching WindowsForum', state: 'done' },
        { id: 'b', label: 'Reading a thread', state: 'done' },
      ]);
    });

    expect(screen.getByText('Searching WindowsForum')).toBeInTheDocument();
    expect(screen.getByText('Preparing the answer…')).toBeInTheDocument();
  });

  it('collapses the finished steps above the answer once it starts streaming', async () => {
    apiMocks.sendMessage.mockImplementation((_message: string, options: {
      onActivity?: (activities: { id: string; label: string; state: 'active' | 'done' }[]) => void;
      onChunk?: (text: string, annotations: []) => void;
    }) => new Promise(() => {
      options.onActivity?.([
        { id: 'a', label: 'Searching WindowsForum', state: 'done' },
        { id: 'b', label: 'Reading a thread', state: 'done' },
      ]);
      options.onChunk?.('Your disk is nearly full', []);
    }));

    renderThemed(<ChatWindow userAvatar="/avatar.webp" userName="Member" userId="42" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Why is my PC slow?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Your disk is nearly full')).toBeInTheDocument();
    // The pre-answer panel is gone, but what it did is still on the page.
    expect(screen.queryByLabelText('Waiting for assistant response')).not.toBeInTheDocument();
    const summary = screen.getByRole('button', { name: /2 steps/ });
    expect(screen.queryByText('Reading a thread')).not.toBeInTheDocument();

    fireEvent.click(summary);
    expect(screen.getByText('Searching WindowsForum')).toBeInTheDocument();
    expect(screen.getByText('Reading a thread')).toBeInTheDocument();
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

  it('adds keyboard-operable code wrapping and per-message read-aloud controls', () => {
    const onSpeak = vi.fn().mockResolvedValue(undefined);
    renderThemed(
      <Message
        msg={{
          id: 'ai-1',
          role: 'ai',
          rawContent: '```ts\nconst answer = 42;\n```',
          timestamp: Date.now(),
          status: 'complete',
        }}
        userAvatar="/avatar.webp"
        userName="Member"
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
        isLastMessage
        isStreaming={false}
        onSpeak={onSpeak}
        onStopSpeaking={vi.fn()}
      />
    );

    const wrap = screen.getByRole('button', { name: 'Toggle code wrapping' });
    fireEvent.click(wrap);
    expect(wrap).toHaveAttribute('aria-pressed', 'true');
    expect(wrap.closest('.wf-code-block')).toHaveClass('is-wrapped');

    fireEvent.click(screen.getByLabelText('Read message aloud'));
    expect(onSpeak).toHaveBeenCalledWith('ai-1', '```ts\nconst answer = 42;\n```');
  });
});
