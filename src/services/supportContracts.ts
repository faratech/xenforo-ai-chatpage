/** Public support UI vocabulary. Provider payloads and executable UI never cross this boundary. */
export type ChatMode = 'chat' | 'troubleshoot';
export type SupportOutcome = 'helped' | 'no_change' | 'worse' | 'not_attempted';

export interface SupportAttempt {
  id: string;
  check: string;
  expected_result?: string;
  outcome: SupportOutcome;
  observed_result?: string;
}

export interface SupportProgress {
  confirmed_facts: string[];
  recent_changes: string;
  attempts: SupportAttempt[];
}

export interface ConversationLineage {
  parent_conversation_id: string;
  fork_message_id: string;
  family_id: string;
}

export interface ChatCapabilities {
  success: true;
  version: 1;
  modes: ChatMode[];
  features: { guided_support: boolean; diagnostics: boolean; branches: boolean; support_cards: boolean };
  limits: {
    max_attachments: number;
    max_image_bytes: number;
    max_text_file_bytes: number;
    max_total_text_bytes: number;
    max_total_image_bytes: number;
  };
}

export const DEFAULT_CHAT_CAPABILITIES: ChatCapabilities = {
  success: true,
  version: 1,
  modes: ['chat'],
  features: { guided_support: false, diagnostics: false, branches: false, support_cards: false },
  limits: {
    max_attachments: 4,
    max_image_bytes: 8 * 1024 * 1024,
    max_text_file_bytes: 1024 * 1024,
    max_total_text_bytes: 128 * 1024,
    max_total_image_bytes: 10 * 1024 * 1024,
  },
};

export interface SupportCard {
  id: string;
  check: string;
  explanation: string;
  expected_result: string;
  evidence_ids: string[];
  command?: string;
}

export interface ChatEvidence {
  id: string;
  kind: 'microsoft' | 'forum' | 'web' | 'diagnostic';
  title: string;
  url?: string;
  excerpt?: string;
  retrieved_at?: string;
  published_at?: string;
  line_start?: number;
  line_end?: number;
  attachment_id?: string;
}

export interface ChatContext {
  mode: ChatMode;
  case_id?: string;
  case_revision?: number;
  included_attachment_ids: string[];
  history_items: number;
  history_limit: number;
  history_item_bytes: number;
  recovery_used?: boolean;
  history_truncated?: boolean;
}

export interface ChatResponseDetails {
  context?: ChatContext;
  evidence?: ChatEvidence[];
  cards?: SupportCard[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length <= max ? Array.from(value).filter(character => {
    const code = character.charCodeAt(0);
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).join('') : undefined;
const id = (value: unknown): string | undefined => {
  const result = text(value, 128);
  return result && /^[A-Za-z0-9_.:-]+$/.test(result) ? result : undefined;
};
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

export const normalizeLineage = (value: unknown): ConversationLineage | undefined => {
  if (!record(value)) return undefined;
  const parent = id(value.parent_conversation_id), fork = id(value.fork_message_id), family = id(value.family_id);
  return parent && fork && family ? { parent_conversation_id: parent, fork_message_id: fork, family_id: family } : undefined;
};

export const normalizeSupportCard = (value: unknown): SupportCard | undefined => {
  if (!record(value)) return undefined;
  const cardId = id(value.id), check = text(value.check, 2000), explanation = text(value.explanation, 4000);
  const expected = text(value.expected_result, 2000);
  if (!cardId || !check?.trim() || explanation === undefined || expected === undefined) return undefined;
  const references = Array.isArray(value.evidence_ids) ? value.evidence_ids.map(id).filter((v): v is string => Boolean(v)).slice(0, 20) : [];
  const command = text(value.command, 4000);
  return { id: cardId, check, explanation, expected_result: expected, evidence_ids: references, ...(command ? { command } : {}) };
};

export const normalizeEvidence = (value: unknown): ChatEvidence[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap(item => {
    if (!record(item)) return [];
    const evidenceId = id(item.id), title = text(item.title, 500);
    if (!evidenceId || !title || !['microsoft', 'forum', 'web', 'diagnostic'].includes(String(item.kind))) return [];
    const result: ChatEvidence = { id: evidenceId, title, kind: item.kind as ChatEvidence['kind'] };
    const url = text(item.url, 2048);
    if (url) {
      try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) result.url = parsed.href; } catch { /* Unusable links stay absent. */ }
    }
    for (const key of ['excerpt', 'retrieved_at', 'published_at', 'attachment_id'] as const) {
      const clean = text(item[key], key === 'excerpt' ? 2000 : key === 'attachment_id' ? 128 : 80);
      if (clean) result[key] = clean;
    }
    if (integer(item.line_start, 1_000_000) && item.line_start > 0) result.line_start = item.line_start;
    if (integer(item.line_end, 1_000_000) && item.line_end >= (result.line_start ?? 1)) result.line_end = item.line_end;
    return [result];
  });
};

export const normalizeChatContext = (value: unknown): ChatContext | undefined => {
  if (!record(value) || !['chat', 'troubleshoot'].includes(String(value.mode))) return undefined;
  if (!integer(value.history_items, 250) || !integer(value.history_limit, 250) || !integer(value.history_item_bytes, 32768)) return undefined;
  const caseId = id(value.case_id);
  return {
    mode: value.mode as ChatMode,
    included_attachment_ids: Array.isArray(value.included_attachment_ids) ? value.included_attachment_ids.map(id).filter((v): v is string => Boolean(v)).slice(0, 8) : [],
    history_items: value.history_items, history_limit: value.history_limit, history_item_bytes: value.history_item_bytes,
    ...(caseId ? { case_id: caseId } : {}),
    ...(integer(value.case_revision) ? { case_revision: value.case_revision } : {}),
    ...(typeof value.recovery_used === 'boolean' ? { recovery_used: value.recovery_used } : {}),
    ...(typeof value.history_truncated === 'boolean' ? { history_truncated: value.history_truncated } : {}),
  };
};

export const normalizeResponseDetails = (value: unknown): ChatResponseDetails | undefined => {
  if (!record(value)) return undefined;
  const context = normalizeChatContext(value.context);
  const evidence = normalizeEvidence(value.evidence);
  const cards = Array.isArray(value.cards) ? value.cards.slice(0, 20).map(normalizeSupportCard).filter((v): v is SupportCard => Boolean(v)) : [];
  return context || evidence.length || cards.length ? {
    ...(context ? { context } : {}), ...(evidence.length ? { evidence } : {}), ...(cards.length ? { cards } : {}),
  } : undefined;
};

export const normalizeCapabilities = (value: unknown): ChatCapabilities => {
  if (!record(value) || value.version !== 1 || !record(value.features) || !record(value.limits)) return DEFAULT_CHAT_CAPABILITIES;
  const flags = value.features, limits = value.limits;
  const result: ChatCapabilities = {
    ...DEFAULT_CHAT_CAPABILITIES,
    features: {
      guided_support: flags.guided_support === true, diagnostics: flags.diagnostics === true,
      branches: flags.branches === true, support_cards: flags.support_cards === true,
    },
    limits: { ...DEFAULT_CHAT_CAPABILITIES.limits },
    modes: ['chat', ...(flags.guided_support === true ? ['troubleshoot' as const] : [])],
  };
  for (const key of Object.keys(result.limits) as Array<keyof ChatCapabilities['limits']>) {
    if (integer(limits[key], DEFAULT_CHAT_CAPABILITIES.limits[key]) && limits[key] > 0) result.limits[key] = limits[key];
  }
  return result;
};
