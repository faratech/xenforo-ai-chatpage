// Core types for the XenForo AI Chat application

export interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
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
}

export interface ChatMessagePayload {
  message: string;
  captcha_token?: string;
  action?: string;
  token?: string;
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
  onRegenerate: (messageId: string) => void;
  onCopy: () => void;
  isLastMessage: boolean;
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

export type FeedbackType = 'up' | 'down';