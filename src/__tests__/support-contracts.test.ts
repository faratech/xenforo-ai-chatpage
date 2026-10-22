import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_CAPABILITIES, normalizeCapabilities, normalizeChatContext,
  normalizeEvidence, normalizeLineage, normalizeResponseDetails, normalizeSupportCard,
} from '../services/supportContracts';

const card = { id: 'step_1', check: 'Check version', explanation: 'Identify applicable guidance', expected_result: 'A build number', evidence_ids: ['ev_1'] };

describe('public support presentation contracts', () => {
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://user:secret@example.com/docs', 'file:///etc/passwd'])('omits unsafe evidence links: %s', url => {
    const evidence = normalizeEvidence([{ id: 'ev_1', kind: 'web', title: 'Source', url }]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).not.toHaveProperty('url');
  });

  it('copies only bounded public evidence fields and leaves unavailable metadata absent', () => {
    const evidence = normalizeEvidence([{ id: 'ev_1', kind: 'microsoft', title: 'Docs', url: 'https://learn.microsoft.com/windows', raw_result: 'private', arguments: 'private' }]);
    expect(evidence).toEqual([{ id: 'ev_1', kind: 'microsoft', title: 'Docs', url: 'https://learn.microsoft.com/windows' }]);
    expect(normalizeEvidence(Array.from({ length: 80 }, (_, index) => ({ id: `ev_${index}`, kind: 'web', title: 'Source' })))).toHaveLength(20);
  });

  it('validates diagnostic line bounds without inventing locations', () => {
    expect(normalizeEvidence([{ id: 'diag_1', kind: 'diagnostic', title: 'reviewed.log', line_start: 8, line_end: 12 }])[0]).toMatchObject({ line_start: 8, line_end: 12 });
    expect(normalizeEvidence([{ id: 'diag_1', kind: 'diagnostic', title: 'reviewed.log', line_start: -1, line_end: -5 }])[0]).not.toHaveProperty('line_start');
    expect(normalizeEvidence([{ id: 'diag_1', kind: 'diagnostic', title: 'reviewed.log', line_start: 8, line_end: 2 }])[0]).not.toHaveProperty('line_end');
  });

  it('does not carry executable actions or provider payloads into support cards', () => {
    expect(normalizeSupportCard({ ...card, command: 'Get-ComputerInfo', execute: 'dangerous', raw: 'private' })).toEqual({ ...card, command: 'Get-ComputerInfo' });
    expect(normalizeSupportCard({ ...card, id: '<script>' })).toBeUndefined();
    expect(normalizeSupportCard({ ...card, check: ' ' })).toBeUndefined();
    expect(normalizeSupportCard({ ...card, command: 'x'.repeat(4001) })).not.toHaveProperty('command');
    expect(normalizeSupportCard(null)).toBeUndefined();
  });

  it('fails closed on absent capabilities and cannot raise server limits beyond frontend rails', () => {
    expect(normalizeCapabilities(null)).toBe(DEFAULT_CHAT_CAPABILITIES);
    const result = normalizeCapabilities({ version: 1, features: { guided_support: true, support_cards: 'true' }, limits: { max_attachments: 999, max_total_text_bytes: 64 } });
    expect(result.features.guided_support).toBe(true);
    expect(result.features.support_cards).toBe(false);
    expect(result.modes).toEqual(['chat', 'troubleshoot']);
    expect(result.limits.max_attachments).toBe(4);
    expect(result.limits.max_total_text_bytes).toBe(64);
  });

  it('rejects malformed recovery context and incomplete branch lineage', () => {
    expect(normalizeChatContext({ mode: 'troubleshoot', history_items: 2, history_limit: 250, history_item_bytes: 32768, raw_prompt: 'private' })).toEqual({ mode: 'troubleshoot', history_items: 2, history_limit: 250, history_item_bytes: 32768, included_attachment_ids: [] });
    expect(normalizeChatContext({ mode: 'troubleshoot', history_items: Infinity })).toBeUndefined();
    expect(normalizeLineage({ parent_conversation_id: 'conv_1', fork_message_id: 'message_1' })).toBeUndefined();
    expect(normalizeLineage({ parent_conversation_id: 'conv_1', fork_message_id: 'message_1', family_id: 'conv_1', raw: 'private' })).toEqual({ parent_conversation_id: 'conv_1', fork_message_id: 'message_1', family_id: 'conv_1' });
    expect(normalizeResponseDetails({ raw: 'private' })).toBeUndefined();
  });
});
