import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAPI } from '../services/api';

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const lastJSONBody = (): Record<string, unknown> => {
  const fetchMock = vi.mocked(fetch);
  const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
};

beforeEach(() => {
  ChatAPI.setExpectedIdentityId('identity_test');
  ChatAPI.setCsrfToken('csrf_test');
});

afterEach(() => {
  ChatAPI.setExpectedIdentityId('');
  ChatAPI.setCsrfToken('');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('identity bootstrap security token', () => {
  it('installs the response token immediately for subsequent protected calls', async () => {
    ChatAPI.setCsrfToken('');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        user_id: 42,
        identity_id: 'identity_test',
        csrf_token: 'csrf_from_identity_response',
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        conversations: [],
        next_cursor: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const identity = await ChatAPI.getUserData();
    expect(identity.csrf_token).toBe('csrf_from_identity_response');
    await ChatAPI.listSavedConversations();
    expect(lastJSONBody()).toMatchObject({
      action: 'listSavedConversations',
      expected_identity_id: 'identity_test',
      _xfToken: 'csrf_from_identity_response',
    });
  });
});

describe('member cloud-history contract', () => {
  it('sends identity, CSRF, pagination and explicit revisions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, conversations: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        conversation: {
          id: 'conv_1', title: 'Saved', messages: [], revision: 1,
          created_at: 10, updated_at: 20,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await ChatAPI.listSavedConversations({ limit: 25, cursor: 'opaque_cursor' });
    expect(lastJSONBody()).toEqual({
      action: 'listSavedConversations',
      limit: 25,
      cursor: 'opaque_cursor',
      expected_identity_id: 'identity_test',
      _xfToken: 'csrf_test',
    });

    await ChatAPI.upsertSavedConversation({
      id: 'conv_1',
      title: 'Saved',
      messages: [],
      created_at: 10,
    }, 0);
    expect(lastJSONBody()).toMatchObject({
      action: 'upsertSavedConversation',
      expected_revision: 0,
      conversation: { id: 'conv_1', title: 'Saved' },
    });

    await ChatAPI.deleteSavedConversation('conv_1', 1);
    expect(lastJSONBody()).toMatchObject({
      action: 'deleteSavedConversation',
      client_conversation_id: 'conv_1',
      expected_revision: 1,
    });
  });

  it('fails closed before member actions when the XenForo CSRF token is absent', async () => {
    ChatAPI.setCsrfToken('');
    vi.stubGlobal('fetch', vi.fn());

    await expect(ChatAPI.listSavedConversations()).rejects.toMatchObject({
      code: 'csrf_unavailable',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('product capability contracts', () => {
  it('submits bounded feedback identifiers without changing their wire names', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      feedback: {
        id: 'feedback_1', response_id: 'resp_1', turn_id: 'turn_1',
        rating: 'down', reason: 'outdated', created_at: 100,
      },
    })));

    await ChatAPI.submitChatFeedback({
      responseId: 'resp_1',
      turnId: 'turn_1',
      conversationId: 'conv_1',
      rating: 'down',
      reason: '  outdated  ',
    });
    expect(lastJSONBody()).toEqual({
      action: 'submitChatFeedback',
      response_id: 'resp_1',
      turn_id: 'turn_1',
      client_conversation_id: 'conv_1',
      rating: 'down',
      reason: 'outdated',
      expected_identity_id: 'identity_test',
      _xfToken: 'csrf_test',
    });
  });

  it('allows guest feedback to reach the guest-capable endpoint without a shell CSRF token', async () => {
    ChatAPI.setCsrfToken('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      feedback: {
        id: 'feedback_guest', response_id: 'resp_guest', turn_id: 'turn_guest',
        rating: 'up', created_at: 100, updated_at: 100,
      },
    })));

    await ChatAPI.submitChatFeedback({
      responseId: 'resp_guest',
      turnId: 'turn_guest',
      rating: 'up',
    });
    expect(lastJSONBody()).toEqual({
      action: 'submitChatFeedback',
      response_id: 'resp_guest',
      turn_id: 'turn_guest',
      rating: 'up',
      expected_identity_id: 'identity_test',
    });
  });

  it('uploads multipart data without overriding the browser boundary header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      attachment: {
        id: 'attachment_1', name: 'report.txt', mime: 'text/plain', size: 4, expires_at: 500,
      },
    })));

    const file = new File(['test'], 'report.txt', { type: 'text/plain' });
    await ChatAPI.uploadChatAttachment(file, { conversationId: 'conv_1' });

    const init = vi.mocked(fetch).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    const body = init?.body as FormData;
    expect(headers.has('content-type')).toBe(false);
    expect(body.get('action')).toBe('uploadChatAttachment');
    expect(body.get('expected_identity_id')).toBe('identity_test');
    expect(body.get('_xfToken')).toBe('csrf_test');
    expect(body.get('client_conversation_id')).toBe('conv_1');
    expect(body.get('file')).toBeInstanceOf(File);
  });

  it('keeps public snapshot reads token-only and protects create/revoke', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        share: { id: 'share_1', title: 'Shared', messages: [], created_at: 1, expires_at: 2 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        share: { id: 'share_1', token: 'public_token', expires_at: 2 },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await ChatAPI.getConversationShare('public_token');
    expect(lastJSONBody()).toEqual({ action: 'getConversationShare', token: 'public_token' });

    await ChatAPI.createConversationShare('conv_1', 3, { expiresIn: 86_400 });
    expect(lastJSONBody()).toMatchObject({
      action: 'createConversationShare',
      client_conversation_id: 'conv_1',
      expected_revision: 3,
      expires_in: 86_400,
      _xfToken: 'csrf_test',
    });

    await ChatAPI.revokeConversationShare('share_1');
    expect(lastJSONBody()).toMatchObject({ action: 'revokeConversationShare', share_id: 'share_1' });
  });

  it('uses revision-safe support-case actions and pagination', async () => {
    const supportCase = {
      id: 'case_1', title: 'Blue screen', description: 'After update', status: 'open',
      pc_profile: { os_name: 'Windows', memory_gb: 32 },
      conversation_ids: ['conv_1'], attachment_ids: ['attachment_1'],
      revision: 1, created_at: 10, updated_at: 20,
    } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, cases: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse({ success: true, case: supportCase }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await ChatAPI.listSupportCases({ limit: 10, cursor: 'next' });
    expect(lastJSONBody()).toMatchObject({ action: 'listSupportCases', limit: 10, cursor: 'next' });

    await ChatAPI.upsertSupportCase({
      title: supportCase.title,
      description: supportCase.description,
      pc_profile: supportCase.pc_profile,
      conversation_ids: [...supportCase.conversation_ids],
      attachment_ids: [...supportCase.attachment_ids],
    }, 0);
    expect(lastJSONBody()).toMatchObject({
      action: 'upsertSupportCase',
      expected_revision: 0,
      case: { title: 'Blue screen', pc_profile: { memory_gb: 32 } },
    });

    await ChatAPI.deleteSupportCase('case_1', 1);
    expect(lastJSONBody()).toMatchObject({
      action: 'deleteSupportCase', case_id: 'case_1', expected_revision: 1,
    });
  });

  it('adds attachment handles to a normal streaming send', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
          + 'data: {"type":"chat.stream.completed","response_id":"resp_1"}\n\n',
        ));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));

    await ChatAPI.sendMessage('read these', {
      attachmentIds: [' attachment_1 ', 'attachment_1', '', 'attachment_2'],
    });
    expect(lastJSONBody()).toMatchObject({
      message: 'read these',
      attachment_ids: ['attachment_1', 'attachment_2'],
    });
  });

  it('passes selected TTS voice and speed to the audio endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['audio']), {
      status: 200,
      headers: { 'content-type': 'audio/ogg' },
    })));

    await ChatAPI.requestTTS('hello', { voice: 'marin', speed: 1.2 });
    expect(lastJSONBody()).toEqual({
      text: 'hello',
      expected_identity_id: 'identity_test',
      voice: 'marin',
      speed: 1.2,
    });
  });
});
