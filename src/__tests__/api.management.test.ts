import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatAPI,
  type DeleteAllSavedChatDataResponse,
  type SavedChatDataExportResponse,
} from '../services/api';

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const requestAt = (index: number): RequestInit => {
  const request = vi.mocked(fetch).mock.calls[index]?.[1];
  if (!request) throw new Error(`Missing fetch request ${index}`);
  return request;
};

const jsonBodyAt = (index: number): Record<string, unknown> => (
  JSON.parse(String(requestAt(index).body)) as Record<string, unknown>
);

beforeEach(() => {
  ChatAPI.setExpectedIdentityId('identity_management');
  ChatAPI.setCsrfToken('csrf_management');
});

afterEach(() => {
  ChatAPI.setExpectedIdentityId('');
  ChatAPI.setCsrfToken('');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('attachment and share management API contracts', () => {
  it('deletes an attachment through the protected JSON wire', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      deferred_cleanup: true,
    })));

    const result = await ChatAPI.deleteChatAttachment('att_123');

    expect(result).toEqual({ success: true, deferred_cleanup: true });
    expect(jsonBodyAt(0)).toEqual({
      action: 'deleteChatAttachment',
      attachment_id: 'att_123',
      expected_identity_id: 'identity_management',
      _xfToken: 'csrf_management',
    });
    expect(requestAt(0).credentials).toBe('include');
  });

  it('maps the optional conversation filter and opaque pagination fields', async () => {
    const response = {
      success: true,
      shares: [{
        id: 'share_123',
        client_conversation_id: 'conv_123',
        source_revision: 4,
        created_at: 1_700_000_000_000,
        expires_at: 1_700_086_400_000,
        revoked_at: null,
      }],
      next_cursor: 'opaque_next',
    } as const;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));

    const result = await ChatAPI.listConversationShares({
      conversationId: 'conv_123',
      limit: 25,
      cursor: 'opaque_current',
    });

    expect(result).toEqual(response);
    expect(jsonBodyAt(0)).toEqual({
      action: 'listConversationShares',
      limit: 25,
      cursor: 'opaque_current',
      client_conversation_id: 'conv_123',
      expected_identity_id: 'identity_management',
      _xfToken: 'csrf_management',
    });
  });

  it('preserves an explicitly supplied empty filter for server-side validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      shares: [],
      next_cursor: null,
    })));

    await ChatAPI.listConversationShares({ conversationId: '' });

    expect(jsonBodyAt(0)).toMatchObject({ client_conversation_id: '' });
  });
});

describe('saved chat account-data API contracts', () => {
  it('fails closed before account-data actions when CSRF is unavailable', async () => {
    ChatAPI.setCsrfToken('');
    vi.stubGlobal('fetch', vi.fn());

    await expect(ChatAPI.deleteAllSavedChatData()).rejects.toMatchObject({
      code: 'csrf_unavailable',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the exact versioned export envelope through the protected action', async () => {
    const response = {
      success: true,
      export: {
        version: 1,
        scope: 'saved_chat_product_data',
        generated_at: 1_700_000_000_000,
        conversations: [{
          id: 'conv_123',
          title: 'Saved chat',
          messages: [],
          revision: 4,
          metadata_revision: 2,
          pinned_at: 1_700_000_000_000,
          archived_at: null,
          created_at: 1,
          updated_at: 2,
          message_count: 0,
        }],
        feedback: [{
          id: '42',
          client_conversation_id: null,
          response_id: 'resp_123',
          turn_id: 'turn_123',
          rating: 'up',
          reason: null,
          created_at: 1,
          updated_at: 2,
        }],
        attachments: [{
          id: 'att_123',
          name: 'screen.png',
          mime: 'image/png',
          size: 1234,
          kind: 'image',
          expires_at: 1_700_086_400_000,
        }],
        shares: [{
          id: 'share_123',
          client_conversation_id: 'conv_123',
          source_revision: 4,
          created_at: 1,
          expires_at: 2,
          revoked_at: 3,
        }],
        support_cases: [],
      },
    } satisfies SavedChatDataExportResponse;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));

    const result = await ChatAPI.exportSavedChatData();

    expect(result).toEqual(response);
    expect(jsonBodyAt(0)).toEqual({
      action: 'exportSavedChatData',
      expected_identity_id: 'identity_management',
      _xfToken: 'csrf_management',
    });
  });

  it('returns physical-cleanup counts from delete-all without weakening protection', async () => {
    const response = {
      success: true,
      deleted_scope: 'saved_chat_product_data',
      attachment_files_deleted: 3,
      attachment_files_deferred: 1,
      deletion_guards_retained: 4,
      deletion_guard_expires_at: 1_818_659_200_000,
      deletion_guard_max_retention_days: 365,
    } satisfies DeleteAllSavedChatDataResponse;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));

    const result = await ChatAPI.deleteAllSavedChatData();

    expect(result).toEqual(response);
    expect(jsonBodyAt(0)).toEqual({
      action: 'deleteAllSavedChatData',
      expected_identity_id: 'identity_management',
      _xfToken: 'csrf_management',
    });
  });

  it('propagates a caller AbortSignal into management requests', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(abortError);
    }));

    await expect(ChatAPI.exportSavedChatData({ signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
