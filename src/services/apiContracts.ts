import type { Message } from '../types';

/** Opaque pagination cursor returned by chat.php. */
export interface CursorPageOptions {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface SavedConversationSummary {
  id: string;
  title: string;
  revision: number;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export interface SavedConversation {
  id: string;
  title: string;
  messages: Message[];
  revision: number;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export interface SavedConversationDraft {
  id: string;
  title: string;
  messages: Message[];
  created_at?: number;
}

export interface SavedConversationListResponse {
  success: true;
  conversations: SavedConversationSummary[];
  next_cursor: string | null;
}

export interface SavedConversationResponse {
  success: true;
  conversation: SavedConversation;
}

export type FeedbackRating = 'up' | 'down';

export interface ChatFeedback {
  id: string;
  response_id: string;
  turn_id: string;
  client_conversation_id?: string;
  rating: FeedbackRating;
  reason?: string;
  created_at: number;
  updated_at: number;
}

export interface ChatFeedbackResponse {
  success: true;
  feedback: ChatFeedback;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  expires_at: number;
}

export interface ChatAttachmentResponse {
  success: true;
  attachment: ChatAttachment;
}

export interface ChatAttachmentDeleteResponse {
  success: true;
  /** The handle is unreadable immediately; true means physical cleanup was queued. */
  deferred_cleanup: boolean;
}

export interface ConversationShareSummary {
  id: string;
  token: string;
  expires_at: number;
}

/** Public, display-only attachment metadata. Server attachment handles never cross this boundary. */
export interface PublicShareAttachment {
  name: string;
  mime: string;
  size: number;
}

/**
 * Public shares deliberately expose a narrower citation vocabulary than saved
 * conversations. File-backed sources are labels only; container and file ids
 * remain private implementation details.
 */
export type PublicShareAnnotation =
  | { type: 'url_citation'; url: string; title?: string }
  | { type: 'file_citation'; filename?: string };

/** Presentation DTO for an immutable public snapshot, never an internal Message. */
export interface PublicShareMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  attachments?: PublicShareAttachment[];
  annotations?: PublicShareAnnotation[];
}

export interface ConversationShare {
  id: string;
  title: string;
  messages: PublicShareMessage[];
  created_at: number;
  expires_at: number;
}

export interface ConversationShareCreateResponse {
  success: true;
  share: ConversationShareSummary;
}

export interface ConversationShareResponse {
  success: true;
  share: ConversationShare;
}

/** Owner-facing share metadata. Public bearer tokens are intentionally omitted. */
export interface ConversationShareListItem {
  id: string;
  client_conversation_id: string;
  source_revision: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface ConversationShareListOptions extends CursorPageOptions {
  /** Restrict results to one saved client conversation. */
  conversationId?: string;
}

export interface ConversationShareListResponse {
  success: true;
  shares: ConversationShareListItem[];
  next_cursor: string | null;
}

export type SupportCaseStatus = 'open' | 'resolved' | 'archived';

export interface PCProfile {
  os_name?: string;
  os_version?: string;
  edition?: string;
  build?: string;
  architecture?: string;
  device_type?: string;
  manufacturer?: string;
  model?: string;
  cpu?: string;
  memory_gb?: number;
  gpu?: string;
}

export interface SupportCase {
  id: string;
  title: string;
  description: string;
  status: SupportCaseStatus;
  pc_profile?: PCProfile;
  conversation_ids: string[];
  attachment_ids: string[];
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface SupportCaseDraft {
  id?: string;
  title: string;
  description: string;
  status?: SupportCaseStatus;
  pc_profile?: PCProfile;
  conversation_ids?: string[];
  attachment_ids?: string[];
  created_at?: number;
}

export interface SupportCaseListResponse {
  success: true;
  cases: SupportCase[];
  next_cursor: string | null;
}

export interface SupportCaseResponse {
  success: true;
  case: SupportCase;
}

export type ChatAttachmentKind = 'image' | 'text';

/** Exact attachment representation included in a server account-data export. */
export interface SavedChatDataAttachment extends ChatAttachment {
  kind: ChatAttachmentKind;
}

/** Feedback export preserves database nulls rather than omitting the fields. */
export interface SavedChatDataFeedback {
  id: string;
  client_conversation_id: string | null;
  response_id: string;
  turn_id: string;
  rating: FeedbackRating;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface SavedChatDataExport {
  version: 1;
  scope: 'saved_chat_product_data';
  generated_at: number;
  conversations: SavedConversation[];
  feedback: SavedChatDataFeedback[];
  attachments: SavedChatDataAttachment[];
  shares: ConversationShareListItem[];
  support_cases: SupportCase[];
}

export interface SavedChatDataExportResponse {
  success: true;
  export: SavedChatDataExport;
}

export interface DeleteAllSavedChatDataResponse {
  success: true;
  deleted_scope: 'saved_chat_product_data';
  attachment_files_deleted: number;
  attachment_files_deferred: number;
  /** Content-free suppression rows retained solely to reject stale-device recreation. */
  deletion_guards_retained: number;
  deletion_guard_expires_at: number;
  deletion_guard_max_retention_days: 365;
}

export type ClientTelemetryEvent =
  | 'app_error'
  | 'unhandled_rejection'
  | 'largest_contentful_paint'
  | 'layout_shift'
  | 'navigation'
  | 'surface_ready'
  | 'starter_selected'
  | 'history_search'
  | 'history_result_opened'
  | 'sync_failed'
  | 'sync_recovered'
  | 'chat_send_started'
  | 'chat_first_token'
  | 'chat_completed'
  | 'chat_stopped'
  | 'chat_failed'
  | 'message_copied'
  | 'message_feedback'
  | 'source_opened'
  | 'conversation_created'
  | 'conversation_opened'
  | 'conversation_renamed'
  | 'conversation_deleted'
  | 'conversation_exported'
  | 'attachment_uploaded'
  | 'share_created'
  | 'support_case_created'
  | 'tts_started'
  | 'tts_completed'
  | 'tts_failed';

/**
 * chat.php deliberately accepts only these non-content fields. In particular,
 * this contract has nowhere to put prompts, answers, titles, file names, URLs,
 * or conversation identifiers.
 */
export interface ClientTelemetryPayload {
  event: ClientTelemetryEvent;
  release: string;
  surface: 'chatpage';
  event_id?: string;
  error_code?: string;
  duration_ms?: number;
  value?: number;
  outcome?: string;
}
