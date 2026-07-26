// Core types for the XenForo AI Chat application

export interface Message {
  id: string;
  role: 'user' | 'ai';
  /** Raw Markdown/plain text. Rendered HTML is derived at the display boundary. */
  rawContent: string;
  timestamp: number;
  status?: 'complete' | 'sending' | 'stopped' | 'interrupted' | 'failed';
  annotations?: Annotation[];
}

/**
 * Discriminated citation union covering every annotation shape the
 * Responses API emits. URL citations carry a validated link; file-backed
 * citations carry file/container identifiers and a display filename.
 */
export interface UrlCitation {
  type: 'url_citation';
  url: string;
  title?: string;
}

export interface FileCitation {
  type: 'file_citation';
  filename?: string;
  fileId?: string;
}

export interface ContainerFileCitation {
  type: 'container_file_citation';
  containerId?: string;
  fileId?: string;
  filename?: string;
}

export interface FilePathCitation {
  type: 'file_path';
  fileId?: string;
  filename?: string;
}

export type Annotation =
  | UrlCitation
  | FileCitation
  | ContainerFileCitation
  | FilePathCitation;

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /**
   * Set when a turn was stopped or interrupted, so the server-side
   * conversation state may be missing the tail of the local transcript.
   * The next turn sends reset_conversation + full history to resync,
   * then clears the marker on success.
   */
  needsServerResync?: boolean;
}

export interface ConversationMap {
  [id: string]: Conversation;
}

/** Versioned per-user localStorage envelope. */
export interface ChatStoreV3 {
  version: 3;
  conversations: ConversationMap;
  /** conversationId → deletion timestamp (ms). Wins over any older conversation copy. */
  tombstones: Record<string, number>;
  /** conversationId → first-attempt timestamp (ms) for server deletions not yet confirmed. */
  pendingServerDeletions: Record<string, number>;
}

/** What the transport actually saw, so a lost answer can be diagnosed after the fact. */
export interface StreamDiagnostics {
  /** Turn id shared with the server log for this request. */
  turnId: string;
  /** Decoded characters received across all chunks. */
  bytesReceived: number;
  /** Distinct SSE event types observed, in first-seen order. */
  eventTypes: string[];
  /** Milliseconds from request start to failure. */
  elapsedMs: number;
}

export interface StreamingResponse {
  text: string;
  annotations: Annotation[];
  responseId?: string;
  diagnostics?: StreamDiagnostics;
}

export interface ChatMessageHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ErrorResponse {
  error?: string;
  captcha_required?: boolean;
  [key: string]: unknown;
}

export interface SSEAnnotation {
  type?: string;
  url?: string;
  title?: string;
  filename?: string;
  file_id?: string;
  container_id?: string;
  index?: number;
  start_index?: number;
  end_index?: number;
}

export interface SSEEvent {
  type?: string;
  delta?: string;
  text?: string;
  refusal?: string;
  annotation_index?: number;
  annotation?: SSEAnnotation;
  part?: { annotations?: SSEAnnotation[] };
  response_id?: string;
  id?: string;
  response?: { id?: string; error?: { message?: string }; incomplete_details?: { reason?: string } };
  detail?: string;
  error?: string | { message?: string };
  message?: string;
  [key: string]: unknown;
}

export interface UserData {
  avatar?: string;
  name?: string;
  user_id?: string | number;
}

export interface UsageData {
  logged_in?: boolean;
  unavailable?: boolean;
  tier?: string;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
  unlimited?: boolean;
  tokens_today?: number;
  reset_at?: string;
  premium_daily_allowance?: number;
}

export interface MessageProps {
  msg: Message;
  userAvatar: string;
  userName: string;
  onEdit: (messageId: string, newContent: string) => void;
  onRegenerate: () => void;
  onRetry: (messageId: string) => void;
  isLastMessage: boolean;
  isLastUserMessage?: boolean;
  isStreaming: boolean;
  isBusy?: boolean;
}

export interface ConversationSidebarProps {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
  currentConversationId: string;
  onSelectConversation: (convId: string) => void;
  onDeleteConversation: (convId: string) => void;
  onNewConversation: () => void;
}

export interface InputAreaProps {
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  isListening: boolean;
  isSpeechRecognitionSupported: boolean;
  isMuted: boolean;
  voiceEnabled: boolean;
  inputBytes: number;
  maxMessageBytes: number;
  onSend: () => void;
  onStop: () => void;
  onStartListening: () => void;
  onStopListening: () => void;
  onToggleMute: () => void;
  textFieldRef: React.RefObject<HTMLDivElement | null>;
}

export interface ChatWindowProps {
  userAvatar: string;
  userName: string;
  userId: string;
}
