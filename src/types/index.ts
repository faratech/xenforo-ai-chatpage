// Core types for the XenForo AI Chat application

export interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
  rawContent?: string;
  timestamp: number;
  annotations?: Annotation[];
}

export interface Annotation {
  index: number;
  filename?: string;
  fileId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMap {
  [id: string]: Conversation;
}

export interface StreamingResponse {
  text: string;
  annotations: Annotation[];
  responseId?: string;
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
  filename?: string;
  file_id?: string;
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
  user_id?: string;
}

export interface MessageProps {
  msg: Message;
  userAvatar: string;
  userName: string;
  onEdit: (messageId: string, newContent: string) => void;
  onRegenerate: () => void;
  isLastMessage: boolean;
  isLastUserMessage?: boolean;
  isStreaming: boolean;
  onFeedback?: (messageId: string, type: 'up' | 'down') => void;
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
  userId: string | null;
}
