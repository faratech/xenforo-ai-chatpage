import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError, ChatAPI, IncompleteStreamError } from '../services/api';

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const response = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  const encoder = new TextEncoder();
  chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
const body = () => {
  const calls = vi.mocked(fetch).mock.calls;
  return JSON.parse(String(calls[calls.length - 1]?.[1]?.body)) as Record<string, unknown>;
};
const card = { id: 'step_1', check: 'Check version', explanation: 'Identify the Windows build.', expected_result: 'A build number', evidence_ids: ['ev_1'] };

beforeEach(() => { ChatAPI.setExpectedIdentityId('identity_test'); ChatAPI.setCsrfToken('csrf_test'); });
afterEach(() => { ChatAPI.setExpectedIdentityId(''); ChatAPI.setCsrfToken(''); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('guided support transport', () => {
  it('includes selected case identity and revision but never browser-supplied provider opt-ins', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([sse({ type: 'chat.stream.completed' })])));
    await ChatAPI.sendMessage('Help with this PC', { mode: 'troubleshoot', supportCaseId: 'case_1', supportCaseRevision: 3 });
    expect(body()).toMatchObject({ mode: 'troubleshoot', support_case_id: 'case_1', support_case_revision: 3, expected_identity_id: 'identity_test' });
    expect(body()).not.toHaveProperty('chat_ui_support');
    expect(body()).not.toHaveProperty('chat_ui_evidence');
  });

  it('returns bounded details received after provider completion and across chunk boundaries', async () => {
    const onDetails = vi.fn(), onActivity = vi.fn();
    const frames = sse({ type: 'response.output_text.delta', delta: 'The answer' })
      + sse({ type: 'response.completed', response: { id: 'resp_1' } })
      + sse({ type: 'chat.context', context: { mode: 'troubleshoot', case_id: 'case_1', case_revision: 3, included_attachment_ids: [], history_items: 2, history_limit: 250, history_item_bytes: 32768 } })
      + sse({ type: 'chat.evidence', evidence: [{ id: 'ev_1', kind: 'microsoft', title: 'Microsoft Docs', url: 'https://learn.microsoft.com/windows' }] })
      + sse({ type: 'chat.support_card', card })
      + sse({ type: 'chat.activity', activity: { id: 'tool_1', label: 'Checking sources', state: 'failed', detail: 'private raw error' } })
      + sse({ type: 'chat.stream.completed', response_id: 'resp_1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(Array.from({ length: Math.ceil(frames.length / 13) }, (_, index) => frames.slice(index * 13, index * 13 + 13)))));
    const result = await ChatAPI.sendMessage('Help', { onDetails, onActivity });
    expect(result.text).toBe('The answer');
    expect(result.details).toMatchObject({ context: { case_id: 'case_1', case_revision: 3 }, cards: [card], evidence: [{ id: 'ev_1' }] });
    expect(onDetails).toHaveBeenCalled();
    expect(onActivity).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'tool_1', state: 'failed' })]));
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain('private raw error');
  });

  it('does not accept provider completion as terminal even when presentation details exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      sse({ type: 'response.output_text.delta', delta: 'Partial answer' }), sse({ type: 'chat.support_card', card }), sse({ type: 'response.completed', response: { id: 'resp_1' } }),
    ])));
    await expect(ChatAPI.sendMessage('Help')).rejects.toBeInstanceOf(IncompleteStreamError);
  });

  it('replays a completed recovered turn after transport loss with identical history fingerprints', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const history = [{ role: 'user' as const, content: 'The adapter fails after sleep.' }];
    const options = { conversationId: 'conv_recovery', turnId: 'turn_recovery_lost', history };
    let pullCount = 0;
    const lostAfterCompletion = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount++ === 0) controller.enqueue(new TextEncoder().encode(sse({ type: 'response.output_text.delta', delta: 'Completed answer' })));
        else controller.error(new TypeError('Transport lost after server ledger completion'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(payload);
      if (requests.length === 1) return Promise.resolve(new Response(JSON.stringify({ error: 'Restore local history.', code: 'history_required' }), { status: 409, headers: { 'content-type': 'application/json' } }));
      if (requests.length === 2) return Promise.resolve(lostAfterCompletion);
      // Emulate PHP's completed ledger: a different history cannot replay.
      if (JSON.stringify(payload.history) !== JSON.stringify(requests[1]!.history)) return Promise.resolve(new Response(JSON.stringify({ error: 'Turn request changed', code: 'turn_conflict' }), { status: 409, headers: { 'content-type': 'application/json' } }));
      return Promise.resolve(response([sse({ type: 'response.output_text.delta', delta: 'Completed answer' }), sse({ type: 'chat.stream.completed', replayed: true })]));
    }));

    await expect(ChatAPI.sendMessage('What next?', options)).rejects.toThrow();
    await expect(ChatAPI.sendMessage('What next?', options)).resolves.toMatchObject({ text: 'Completed answer' });
    expect(requests).toHaveLength(3);
    expect(requests[0]).not.toHaveProperty('history');
    expect(requests[1]!.history).toEqual(history);
    expect(requests[2]!.history).toEqual(history);
    expect(vi.mocked(fetch).mock.calls.map(call => new Headers(call[1]?.headers).get('X-WF-Turn-Id'))).toEqual(Array(3).fill(options.turnId));
  });

  it('deduplicates repeated presentation events and filters malicious URLs/actions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      sse({ type: 'chat.support_card', card }), sse({ type: 'chat.support_card', card: { ...card, execute: 'private action' } }),
      sse({ type: 'chat.evidence', evidence: [{ id: 'ev_1', title: 'Unsafe', kind: 'web', url: 'javascript:alert(1)', raw: 'private raw payload' }] }),
      sse({ type: 'chat.evidence', evidence: [{ id: 'ev_1', title: 'Unsafe', kind: 'web', url: 'javascript:alert(1)' }] }),
      sse({ type: 'chat.stream.completed' }),
    ])));
    const result = await ChatAPI.sendMessage('Help');
    expect(result.details?.cards).toEqual([card]);
    expect(result.details?.evidence).toEqual([{ id: 'ev_1', title: 'Unsafe', kind: 'web' }]);
    expect(JSON.stringify(result.details)).not.toContain('private');
  });

  it('uses explicit compare-and-swap revisions for progress and preserves conflict errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Revision conflict', code: 'revision_conflict' }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const progress = { confirmed_facts: ['Windows 11'], recent_changes: 'Updated driver', attempts: [{ id: 'step_1', check: 'Restart adapter', outcome: 'no_change' as const }] };
    const pending = ChatAPI.updateSupportCaseProgress('case_1', 3, progress);
    await expect(pending).rejects.toBeInstanceOf(APIError);
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
    expect(body()).toMatchObject({ action: 'updateSupportCaseProgress', case_id: 'case_1', expected_revision: 3, progress, _xfToken: 'csrf_test' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a fork operation tied to its source revision and explicit attachment selection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, conversation: { id: 'conv_fork', revision: 1 } }), { headers: { 'content-type': 'application/json' } })));
    await ChatAPI.forkConversation({ sourceConversationId: 'conv_source', expectedRevision: 7, forkMessageId: 'user_1', kind: 'regenerate', attachmentIds: ['att_1'] });
    expect(body()).toMatchObject({ action: 'forkConversation', source_conversation_id: 'conv_source', expected_revision: 7, fork_message_id: 'user_1', kind: 'regenerate', attachment_ids: ['att_1'], _xfToken: 'csrf_test' });
  });
});
