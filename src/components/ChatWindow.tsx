import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Fade from '@mui/material/Fade';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import MenuIcon from '@mui/icons-material/Menu';

import type {
  Annotation,
  ChatMessageHistoryItem,
  ChatWindowProps,
  Conversation,
  ConversationMap,
  Message,
  UsageData,
} from '../types';
import { Message as MessageComponent } from './Message';
import { ConversationSidebar } from './ConversationSidebar';
import { InputArea } from './InputArea';
import { EXAMPLE_PROMPTS, generateConversationId } from '../utils/helpers';
import {
  APIError,
  AudioService,
  CaptchaRequiredError,
  ChatAPI,
  IncompleteStreamError,
  StreamCancelledError,
  StreamProtocolError,
} from '../services/api';
import { ENV } from '../config/env';
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';

const MAX_MESSAGE_BYTES = 500;
const LEGACY_CONVERSATIONS_KEY = 'chat_conversations';
const LEGACY_CURRENT_KEY = 'current_conversation_id';
const STORAGE_VERSION_KEY = 'chat_storage_version';

const messageId = (suffix = ''): string => {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `msg_${random}${suffix}`;
};

const createNewConversation = (id: string, welcomeMessage: string): Conversation => {
  const now = Date.now();
  return {
    id,
    title: 'New Chat',
    messages: [{
      id: messageId('_welcome'),
      role: 'ai',
      rawContent: welcomeMessage,
      timestamp: now,
      status: 'complete',
    }],
    createdAt: now,
    updatedAt: now,
  };
};

const noopEdit = (_id: string, _content: string) => {};
const noopRetry = (_id: string) => {};
const noopRegenerate = () => {};

type ConversationUpdate = Partial<Conversation> | ((conversation: Conversation) => Partial<Conversation>);

interface ActiveTurn {
  requestId: string;
  conversationId: string;
  controller: AbortController;
  userMessageId: string;
  partialText: string;
  annotations: Annotation[];
}

interface PendingCaptchaTurn {
  conversationId: string;
  content: string;
  userMessage: Message;
  resetConversation?: boolean;
  history?: ChatMessageHistoryItem[];
}

const getMessageText = (message: Message): string => message.rawContent.trim();

const serializeConversationHistory = (messages: Message[]): ChatMessageHistoryItem[] => messages
  .filter((message, index) => {
    const text = getMessageText(message);
    return Boolean(text)
      && message.status !== 'failed'
      && !(index === 0 && message.role === 'ai' && text.startsWith('Welcome to WindowsForum.com'));
  })
  .map((message) => ({
    role: message.role === 'ai' ? 'assistant' : 'user',
    content: getMessageText(message),
  }));

const pruneConversations = (conversationMap: ConversationMap, keepConversationId: string): ConversationMap => {
  const max = Number.isFinite(ENV.MAX_CONVERSATIONS) && ENV.MAX_CONVERSATIONS > 0
    ? ENV.MAX_CONVERSATIONS
    : 50;
  const entries = Object.entries(conversationMap).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const keep = new Set(entries.slice(0, max).map(([id]) => id));
  keep.add(keepConversationId);
  return entries.reduce<ConversationMap>((result, [id, conversation]) => {
    if (keep.has(id)) result[id] = conversation;
    return result;
  }, {});
};

const isMessage = (value: unknown): value is Message => {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return typeof message.id === 'string'
    && (message.role === 'user' || message.role === 'ai')
    && typeof message.rawContent === 'string'
    && typeof message.timestamp === 'number';
};

const parseConversationMap = (raw: string | null): ConversationMap => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: ConversationMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      if (!value || typeof value !== 'object') continue;
      const conversation = value as Partial<Conversation>;
      if (
        conversation.id !== id
        || typeof conversation.title !== 'string'
        || !Array.isArray(conversation.messages)
        || !conversation.messages.every(isMessage)
        || typeof conversation.createdAt !== 'number'
        || typeof conversation.updatedAt !== 'number'
      ) continue;
      result[id] = conversation as Conversation;
    }
    return result;
  } catch {
    return {};
  }
};

const storageKeys = (userId: string) => {
  const principal = encodeURIComponent(userId);
  return {
    conversations: `chat_conversations:v2:${principal}`,
    current: `current_conversation_id:v2:${principal}`,
  };
};

const loadStoredState = (userId: string): { conversations: ConversationMap; currentId: string | null } => {
  const keys = storageKeys(userId);
  try {
    // Unscoped history cannot be assigned safely on a shared browser.
    localStorage.removeItem(LEGACY_CONVERSATIONS_KEY);
    localStorage.removeItem(LEGACY_CURRENT_KEY);
    localStorage.setItem(STORAGE_VERSION_KEY, '2');
    const conversations = parseConversationMap(localStorage.getItem(keys.conversations));
    const currentId = localStorage.getItem(keys.current);
    return { conversations, currentId };
  } catch (error) {
    console.warn('Local chat storage is unavailable; continuing without persistence.', error);
    return { conversations: {}, currentId: null };
  }
};

type TurnstileApi = NonNullable<Window['turnstile']>;
let turnstileLoader: Promise<TurnstileApi> | null = null;

const loadTurnstile = (): Promise<TurnstileApi> => {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;

  turnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
    const finish = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('Turnstile loaded without exposing its API.'));
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-wf-turnstile]');
    if (existing) {
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => reject(new Error('Turnstile failed to load.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.dataset.wfTurnstile = 'true';
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => reject(new Error('Turnstile failed to load.')), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    turnstileLoader = null;
    throw error;
  });

  return turnstileLoader;
};

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export const ChatWindow: React.FC<ChatWindowProps> = ({ userAvatar, userName, userId }) => {
  const theme = useTheme();
  const isGuest = userId.startsWith('guest_');
  const welcomeMessage = useMemo(() => isGuest
    ? 'Welcome to WindowsForum.com! Ask me anything about Windows or technology. For the best results, [register](/register) or [log in](/login).'
    : 'Welcome to WindowsForum.com! Ask me anything about Windows or technology.',
  [isGuest]);
  const keys = useMemo(() => storageKeys(userId), [userId]);
  const initialChatState = useMemo(() => {
    const stored = loadStoredState(userId);
    const id = stored.currentId && stored.conversations[stored.currentId]
      ? stored.currentId
      : generateConversationId();
    const initialConversations = stored.conversations[id]
      ? stored.conversations
      : { ...stored.conversations, [id]: createNewConversation(id, welcomeMessage) };
    return { conversations: initialConversations, currentId: id };
  }, [userId, welcomeMessage]);

  const [conversations, setConversations] = useState<ConversationMap>(initialChatState.conversations);
  const [currentConversationId, setCurrentConversationId] = useState(initialChatState.currentId);
  const [streamingState, setStreamingState] = useState<{ conversationId: string; message: Message } | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeechRecognitionSupported] = useState(
    () => ENV.ENABLE_VOICE && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  );
  const [speechRecognition, setSpeechRecognition] = useState<SpeechRecognition | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('chat_mute') ?? 'true');
      return typeof stored === 'boolean' ? stored : true;
    } catch {
      return true;
    }
  });
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showExamples, setShowExamples] = useState(true);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textFieldRef = useRef<HTMLDivElement>(null);
  const conversationsRef = useRef(conversations);
  const currentConversationIdRef = useRef(currentConversationId);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const pendingCaptchaRef = useRef<PendingCaptchaTurn | null>(null);
  const turnstileWidgetRef = useRef<string | null>(null);
  const inputRef = useRef(input);
  const mutedRef = useRef(isMuted);
  const keepListeningRef = useRef(false);
  const dictationPrefixRef = useRef('');
  const sendMessageRef = useRef<(content: string, options?: SendOptions) => Promise<void>>(async () => {});

  const isLoading = activeRequestId !== null;
  const inputBytes = byteLength(input);
  const containerBg = theme.palette.background.paper;
  const borderColor = theme.palette.divider;

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { currentConversationIdRef.current = currentConversationId; }, [currentConversationId]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => {
    mutedRef.current = isMuted;
    AudioService.setMuted(isMuted || !ENV.ENABLE_VOICE);
  }, [isMuted]);

  const defaultConversation = useMemo<Conversation>(() => ({
    id: currentConversationId,
    title: 'New Chat',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  }), [currentConversationId]);
  const currentConversation = conversations[currentConversationId] || defaultConversation;

  useEffect(() => {
    try {
      localStorage.setItem(keys.conversations, JSON.stringify(pruneConversations(conversations, currentConversationId)));
      localStorage.setItem(keys.current, currentConversationId);
    } catch (error) {
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        queueMicrotask(() => setErrorMessage('Browser storage is full. New chat history will not persist after reload.'));
      } else {
        console.warn('Failed to persist chat history:', error);
      }
    }
  }, [conversations, currentConversationId, keys]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== keys.conversations || !event.newValue) return;
      const remote = parseConversationMap(event.newValue);
      setConversations(local => {
        const merged = { ...local };
        for (const [id, conversation] of Object.entries(remote)) {
          if (!merged[id] || conversation.updatedAt > merged[id].updatedAt) merged[id] = conversation;
        }
        return pruneConversations(merged, currentConversationIdRef.current);
      });
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [keys.conversations]);

  useEffect(() => {
    if (isGuest) return;
    let cancelled = false;
    ChatAPI.getUsage()
      .then(value => { if (!cancelled) setUsage(value); })
      .catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [isGuest, usageRefresh, userId]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent) => setReduceMotion(event.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  const updateConversationById = useCallback((conversationId: string, update: ConversationUpdate) => {
    setConversations(previous => {
      const existing = previous[conversationId];
      if (!existing) return previous;
      const changes = typeof update === 'function' ? update(existing) : update;
      return pruneConversations({
        ...previous,
        [conversationId]: { ...existing, ...changes, updatedAt: Date.now() },
      }, conversationId);
    });
  }, []);

  const addMessage = useCallback((conversationId: string, message: Message) => {
    updateConversationById(conversationId, conversation => ({
      messages: [...conversation.messages, message],
    }));
  }, [updateConversationById]);

  const updateMessage = useCallback((conversationId: string, id: string, update: Partial<Message>) => {
    updateConversationById(conversationId, conversation => ({
      messages: conversation.messages.map(message => message.id === id ? { ...message, ...update } : message),
    }));
  }, [updateConversationById]);

  const clearActiveTurn = useCallback((requestId: string) => {
    if (activeTurnRef.current?.requestId !== requestId) return false;
    activeTurnRef.current = null;
    setActiveRequestId(null);
    setStreamingState(null);
    return true;
  }, []);

  const abortActiveTurn = useCallback((persistPartial: boolean) => {
    const turn = activeTurnRef.current;
    if (!turn) return;
    activeTurnRef.current = null;
    turn.controller.abort();
    if (persistPartial && turn.partialText.trim() && conversationsRef.current[turn.conversationId]) {
      addMessage(turn.conversationId, {
        id: messageId('_stopped'),
        role: 'ai',
        rawContent: `${turn.partialText.trimEnd()}\n\n_Generation stopped._`,
        timestamp: Date.now(),
        status: 'stopped',
        annotations: turn.annotations,
      });
    }
    setActiveRequestId(null);
    setStreamingState(null);
    AudioService.stop();
  }, [addMessage]);

  const cleanupTurnstileWidget = useCallback(() => {
    const widgetId = turnstileWidgetRef.current;
    if (widgetId && window.turnstile) {
      try { window.turnstile.remove(widgetId); } catch { /* already removed */ }
    }
    turnstileWidgetRef.current = null;
  }, []);

  const cancelPendingCaptcha = useCallback((restoreFailedMessage: boolean) => {
    const pending = pendingCaptchaRef.current;
    pendingCaptchaRef.current = null;
    cleanupTurnstileWidget();
    setShowCaptcha(false);
    if (restoreFailedMessage && pending && conversationsRef.current[pending.conversationId]) {
      addMessage(pending.conversationId, { ...pending.userMessage, status: 'failed' });
    }
  }, [addMessage, cleanupTurnstileWidget]);

  const stopListening = useCallback(() => {
    keepListeningRef.current = false;
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch { /* browser already stopped */ }
    }
    setIsListening(false);
  }, [speechRecognition]);

  const createAndSelectConversation = useCallback(() => {
    const id = generateConversationId();
    const conversation = createNewConversation(id, welcomeMessage);
    setConversations(previous => pruneConversations({ ...previous, [id]: conversation }, id));
    setCurrentConversationId(id);
    setInput('');
    setErrorMessage('');
    setShowExamples(true);
    setAutoFollow(true);
  }, [welcomeMessage]);

  const handleNewConversation = useCallback(() => {
    stopListening();
    abortActiveTurn(true);
    cancelPendingCaptcha(true);
    createAndSelectConversation();
  }, [abortActiveTurn, cancelPendingCaptcha, createAndSelectConversation, stopListening]);

  const handleSelectConversation = useCallback((conversationId: string) => {
    if (conversationId === currentConversationIdRef.current) {
      setDrawerOpen(false);
      return;
    }
    stopListening();
    abortActiveTurn(true);
    cancelPendingCaptcha(true);
    AudioService.stop();
    setCurrentConversationId(conversationId);
    setInput('');
    setErrorMessage('');
    setDrawerOpen(false);
    setShowExamples(false);
    setAutoFollow(true);
  }, [abortActiveTurn, cancelPendingCaptcha, stopListening]);

  const handleDeleteConversation = useCallback((conversationId: string) => {
    if (activeTurnRef.current?.conversationId === conversationId) abortActiveTurn(false);
    if (pendingCaptchaRef.current?.conversationId === conversationId) cancelPendingCaptcha(false);
    void ChatAPI.deleteConversation(conversationId).catch(error => {
      console.error('Failed to delete server conversation:', error);
    });
    setConversations(previous => {
      const next = { ...previous };
      delete next[conversationId];
      return next;
    });
    if (conversationId === currentConversationIdRef.current) createAndSelectConversation();
  }, [abortActiveTurn, cancelPendingCaptcha, createAndSelectConversation]);

  const getErrorText = useCallback((error: unknown): string => {
    if (error instanceof IncompleteStreamError) return 'The response was interrupted before completion. You can retry it.';
    if (error instanceof StreamProtocolError) return 'The server returned an invalid streaming response. Please retry.';
    if (error instanceof APIError) {
      if (error.status === 429 || error.status === 400 || error.status === 413) return error.message;
      if (error.code === 'network_error') return 'Network error. Check your connection and retry.';
      if (error.retryable) return 'The AI service is temporarily unavailable. Please retry.';
    }
    return 'Failed to send the message. Please retry.';
  }, []);

  const handleSendMessage = useCallback(async (messageContent: string | null = null, options: SendOptions = {}) => {
    const content = (messageContent === null ? inputRef.current : messageContent).trim();
    if (!content || activeTurnRef.current) return;
    if (pendingCaptchaRef.current && !options.captchaToken) {
      setErrorMessage('Complete the security check before sending another message.');
      return;
    }
    const contentBytes = byteLength(content);
    if (contentBytes > MAX_MESSAGE_BYTES) {
      setErrorMessage(`Messages are limited to ${MAX_MESSAGE_BYTES} UTF-8 bytes (${contentBytes} currently).`);
      return;
    }

    const conversationId = options.conversationId || currentConversationIdRef.current;
    const existingConversation = conversationsRef.current[conversationId]
      || createNewConversation(conversationId, welcomeMessage);

    stopListening();
    AudioService.stop();
    setErrorMessage('');
    setShowExamples(false);
    setAutoFollow(true);

    if (content.toLowerCase() === '/clear') {
      void ChatAPI.clearConversation(conversationId).catch(error => console.error('Failed to clear conversation:', error));
      createAndSelectConversation();
      return;
    }

    const userMessage: Message = {
      id: messageId('_user'),
      role: 'user',
      rawContent: content,
      timestamp: Date.now(),
      status: 'complete',
    };
    setConversations(previous => {
      const conversation = previous[conversationId] || existingConversation;
      const isFirstQuestion = conversation.messages.length === 1;
      return pruneConversations({
        ...previous,
        [conversationId]: {
          ...conversation,
          title: isFirstQuestion
            ? `${content.slice(0, 50)}${content.length > 50 ? '…' : ''}`
            : conversation.title,
          messages: [...conversation.messages, userMessage],
          updatedAt: Date.now(),
        },
      }, conversationId);
    });
    setInput('');

    const requestId = messageId('_request');
    const controller = new AbortController();
    const turn: ActiveTurn = {
      requestId,
      conversationId,
      controller,
      userMessageId: userMessage.id,
      partialText: '',
      annotations: [],
    };
    activeTurnRef.current = turn;
    setActiveRequestId(requestId);

    try {
      const result = await ChatAPI.sendMessage(content, {
        signal: controller.signal,
        captchaToken: options.captchaToken,
        conversationId,
        resetConversation: options.resetConversation,
        history: options.history,
        onChunk: (partialText, annotations) => {
          const active = activeTurnRef.current;
          if (!active || active.requestId !== requestId) return;
          active.partialText = partialText;
          active.annotations = annotations;
          setStreamingState({
            conversationId,
            message: {
              id: `${requestId}_stream`,
              role: 'ai',
              rawContent: partialText || '▍',
              timestamp: Date.now(),
              status: 'sending',
              annotations,
            },
          });
        },
      });

      if (activeTurnRef.current?.requestId !== requestId) return;
      if (!result.text.trim()) {
        throw new IncompleteStreamError('The completed stream contained no response text.');
      }
      addMessage(conversationId, {
        id: messageId('_ai'),
        role: 'ai',
        rawContent: result.text,
        timestamp: Date.now(),
        status: 'complete',
        annotations: result.annotations,
      });
      clearActiveTurn(requestId);
      setUsageRefresh(value => value + 1);
      if (ENV.ENABLE_VOICE && !mutedRef.current) {
        void AudioService.playTTS(result.text).catch(error => console.error('TTS playback failed:', error));
      }
    } catch (error) {
      const active = activeTurnRef.current;
      if (!active || active.requestId !== requestId) return;

      if (error instanceof CaptchaRequiredError) {
        updateConversationById(conversationId, conversation => ({
          messages: conversation.messages.filter(message => message.id !== userMessage.id),
        }));
        pendingCaptchaRef.current = {
          conversationId,
          content,
          userMessage,
          resetConversation: options.resetConversation,
          history: options.history,
        };
        clearActiveTurn(requestId);
        setInput(content);
        setShowCaptcha(true);
        setErrorMessage('Complete the security check to send your message.');
        return;
      }

      const partialText = error instanceof StreamCancelledError
        || error instanceof IncompleteStreamError
        || error instanceof StreamProtocolError
        || error instanceof APIError
        ? error.partialText
        : active.partialText;
      const annotations = error instanceof StreamCancelledError
        || error instanceof IncompleteStreamError
        || error instanceof StreamProtocolError
        || error instanceof APIError
        ? error.annotations
        : active.annotations;

      if (partialText.trim()) {
        addMessage(conversationId, {
          id: messageId('_interrupted'),
          role: 'ai',
          rawContent: `${partialText.trimEnd()}\n\n_Response interrupted._`,
          timestamp: Date.now(),
          status: error instanceof StreamCancelledError ? 'stopped' : 'interrupted',
          annotations,
        });
      } else if (!(error instanceof StreamCancelledError)) {
        updateMessage(conversationId, userMessage.id, { status: 'failed' });
      }
      clearActiveTurn(requestId);
      if (!(error instanceof StreamCancelledError)) {
        setErrorMessage(getErrorText(error));
        setUsageRefresh(value => value + 1);
      }
    }
  }, [
    addMessage,
    clearActiveTurn,
    createAndSelectConversation,
    getErrorText,
    stopListening,
    updateConversationById,
    updateMessage,
    welcomeMessage,
  ]);

  useEffect(() => { sendMessageRef.current = handleSendMessage; }, [handleSendMessage]);

  useEffect(() => {
    if (!showCaptcha) return;
    let cancelled = false;
    void loadTurnstile().then(api => {
      if (cancelled || !pendingCaptchaRef.current) return;
      cleanupTurnstileWidget();
      turnstileWidgetRef.current = api.render('#turnstile-container', {
        sitekey: ENV.TURNSTILE_SITE_KEY,
        callback: (token: string) => {
          const pending = pendingCaptchaRef.current;
          if (!pending) return;
          const editedContent = inputRef.current.trim();
          pendingCaptchaRef.current = null;
          cleanupTurnstileWidget();
          setShowCaptcha(false);
          setErrorMessage('');
          void sendMessageRef.current(editedContent || pending.content, {
            conversationId: pending.conversationId,
            resetConversation: pending.resetConversation,
            history: pending.history,
            captchaToken: token,
          });
        },
        'expired-callback': () => {
          setErrorMessage('The security check expired. Please complete it again.');
          if (turnstileWidgetRef.current) api.reset(turnstileWidgetRef.current);
        },
        'error-callback': () => {
          setErrorMessage('The security check failed to load. Please try again.');
          if (turnstileWidgetRef.current) api.reset(turnstileWidgetRef.current);
        },
      });
    }).catch(error => {
      console.error('Turnstile load failed:', error);
      if (!cancelled) {
        setErrorMessage('The security check could not load. Please retry.');
        cancelPendingCaptcha(true);
      }
    });
    return () => { cancelled = true; };
  }, [cancelPendingCaptcha, cleanupTurnstileWidget, showCaptcha]);

  const handleEditMessage = useCallback((id: string, newContent: string) => {
    if (activeTurnRef.current) return;
    const conversation = conversationsRef.current[currentConversationIdRef.current];
    if (!conversation) return;
    const index = conversation.messages.findIndex(message => message.id === id);
    if (index < 0) return;
    const before = conversation.messages.slice(0, index);
    updateConversationById(conversation.id, { messages: before });
    void handleSendMessage(newContent, {
      conversationId: conversation.id,
      resetConversation: true,
      history: serializeConversationHistory(before),
    });
  }, [handleSendMessage, updateConversationById]);

  const handleRegenerateMessage = useCallback(() => {
    if (activeTurnRef.current) return;
    const conversation = conversationsRef.current[currentConversationIdRef.current];
    if (!conversation) return;
    const lastUserIndex = conversation.messages.map(message => message.role).lastIndexOf('user');
    if (lastUserIndex < 0) return;
    const userMessage = conversation.messages[lastUserIndex];
    const before = conversation.messages.slice(0, lastUserIndex);
    updateConversationById(conversation.id, { messages: before });
    void handleSendMessage(userMessage.rawContent, {
      conversationId: conversation.id,
      resetConversation: true,
      history: serializeConversationHistory(before),
    });
  }, [handleSendMessage, updateConversationById]);

  const handleRetryMessage = useCallback((id: string) => {
    if (activeTurnRef.current) return;
    const conversation = conversationsRef.current[currentConversationIdRef.current];
    if (!conversation) return;
    const index = conversation.messages.findIndex(message => message.id === id && message.role === 'user');
    if (index < 0) return;
    const failedMessage = conversation.messages[index];
    const before = conversation.messages.slice(0, index);
    updateConversationById(conversation.id, { messages: before });
    void handleSendMessage(failedMessage.rawContent, {
      conversationId: conversation.id,
      resetConversation: true,
      history: serializeConversationHistory(before),
    });
  }, [handleSendMessage, updateConversationById]);

  useEffect(() => {
    if (!ENV.ENABLE_VOICE) return;
    const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Constructor) return;
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
      const prefix = dictationPrefixRef.current;
      setInput(`${prefix}${prefix && transcript ? ' ' : ''}${transcript}`);
    };
    recognition.onerror = event => {
      console.error('Speech recognition error:', event.error);
      keepListeningRef.current = false;
      setIsListening(false);
      setErrorMessage(`Voice input stopped: ${event.error}.`);
    };
    recognition.onend = () => {
      if (keepListeningRef.current && !activeTurnRef.current) {
        try { recognition.start(); return; } catch { keepListeningRef.current = false; }
      }
      setIsListening(false);
    };
    setSpeechRecognition(recognition);
    return () => {
      keepListeningRef.current = false;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try { recognition.stop(); } catch { /* already stopped */ }
    };
  }, []);

  const handleStartListening = useCallback(() => {
    if (!speechRecognition || activeTurnRef.current) return;
    dictationPrefixRef.current = inputRef.current.trim();
    keepListeningRef.current = true;
    setIsListening(true);
    try { speechRecognition.start(); } catch (error) {
      console.error('Speech recognition failed to start:', error);
      keepListeningRef.current = false;
      setIsListening(false);
    }
  }, [speechRecognition]);

  const toggleMute = useCallback(() => {
    setIsMuted(previous => {
      const next = !previous;
      try { localStorage.setItem('chat_mute', JSON.stringify(next)); } catch { /* optional */ }
      AudioService.setMuted(next || !ENV.ENABLE_VOICE);
      return next;
    });
  }, []);

  const handleScroll = useCallback(() => {
    const element = messagesContainerRef.current;
    if (!element) return;
    setAutoFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
  }, []);

  const scrollToLatest = useCallback(() => {
    setAutoFollow(true);
    messagesEndRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [reduceMotion]);

  useEffect(() => {
    if (!autoFollow) return;
    const frame = requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }));
    return () => cancelAnimationFrame(frame);
  }, [autoFollow, currentConversation.messages, streamingState]);

  useEffect(() => () => {
    const active = activeTurnRef.current;
    activeTurnRef.current = null;
    active?.controller.abort();
    cleanupTurnstileWidget();
    AudioService.stop();
  }, [cleanupTurnstileWidget]);

  const sortedConversations = useMemo(
    () => Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  );
  const lastUserMessageId = useMemo(() => {
    for (let index = currentConversation.messages.length - 1; index >= 0; index -= 1) {
      if (currentConversation.messages[index].role === 'user') return currentConversation.messages[index].id;
    }
    return undefined;
  }, [currentConversation.messages]);
  const visibleStreamingMessage = streamingState?.conversationId === currentConversationId
    ? streamingState.message
    : null;
  const usageVisible = !isGuest && !!usage?.logged_in && !usage.unavailable;
  const usageTierLabel = usage?.tier === 'premium'
    ? 'Premium Supporter'
    : usage?.tier === 'unlimited' ? 'Staff' : 'Free';
  const usageText = usage?.unlimited
    ? `${usage.used ?? 0} today`
    : `${usage?.used ?? 0} / ${usage?.limit ?? 0} today`;
  const usageTooltip = `AI messages today · ${usageTierLabel}`;

  return (
    <Box id="react-chat-container" sx={{ display: 'flex', height: '100vh', backgroundColor: containerBg }}>
      <ConversationSidebar
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        conversations={sortedConversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onNewConversation={handleNewConversation}
      />

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box sx={{ borderBottom: `1px solid ${borderColor}`, px: 2, py: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, backgroundColor: 'background.paper', flexShrink: 0 }}>
          <IconButton onClick={() => setDrawerOpen(true)} aria-label="Open chat history"><MenuIcon /></IconButton>
          <Avatar src={BOT_AVATAR} alt={ASSISTANT_NAME} sx={{ width: 36, height: 36, bgcolor: '#0a2c4d' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" sx={{ lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentConversation.title}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'success.main' }} />
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{ASSISTANT_NAME} · online</Typography>
            </Box>
          </Box>
          {usageVisible && (
            <Tooltip title={usageTooltip}>
              <Box sx={{ px: 1, py: 0.25, borderRadius: 1, border: `1px solid ${borderColor}`, display: { xs: 'none', sm: 'block' }, flexShrink: 0 }}>
                <Typography sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>{usageText}</Typography>
              </Box>
            </Tooltip>
          )}
          <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={handleNewConversation}>New chat</Button>
        </Box>

        <Box
          ref={messagesContainerRef}
          className="chat-messages-container"
          onScroll={handleScroll}
          aria-label="Chat messages"
          sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
        >
          <Box role="log" aria-live="polite" aria-relevant="additions">
            {currentConversation.messages.map((message, index) => (
              <MessageComponent
                key={message.id}
                msg={message}
                userAvatar={userAvatar}
                userName={userName}
                onEdit={handleEditMessage}
                onRegenerate={handleRegenerateMessage}
                onRetry={handleRetryMessage}
                isLastMessage={index === currentConversation.messages.length - 1 && Boolean(lastUserMessageId)}
                isLastUserMessage={message.id === lastUserMessageId}
                isStreaming={false}
                isBusy={isLoading}
              />
            ))}
          </Box>

          {visibleStreamingMessage && (
            <Box aria-live="off">
              <MessageComponent
                msg={visibleStreamingMessage}
                userAvatar={userAvatar}
                userName={userName}
                onEdit={noopEdit}
                onRegenerate={noopRegenerate}
                onRetry={noopRetry}
                isLastMessage
                isStreaming
                isBusy
              />
            </Box>
          )}

          {isLoading && !visibleStreamingMessage && (
            <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }} aria-label="Waiting for assistant response">
              <CircularProgress size={24} />
            </Box>
          )}

          {errorMessage && (
            <Box role="status" sx={{ px: 3, py: 1.5, textAlign: 'center' }}>
              <Typography color="error">{errorMessage}</Typography>
            </Box>
          )}

          {showCaptcha && (
            <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
              <div id="turnstile-container" aria-label="Security check" />
            </Box>
          )}

          {showExamples && currentConversation.messages.length === 1 && !isLoading && (
            <Fade in timeout={reduceMotion ? 0 : undefined}>
              <Box sx={{ maxWidth: '52rem', mx: 'auto', px: { xs: 2, sm: 3, md: 4 }, pb: 3 }}>
                <Typography sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'text.secondary', mb: 1.5 }}>
                  <LightbulbIcon sx={{ fontSize: 16 }} /> Try asking
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                  {EXAMPLE_PROMPTS.map(prompt => (
                    <Box
                      key={prompt}
                      component="button"
                      onClick={() => { void handleSendMessage(prompt); }}
                      sx={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', display: 'flex', alignItems: 'center', gap: 1.25, p: 1.5, border: t => `1px solid ${t.palette.divider}`, borderRadius: 2.5, bgcolor: 'background.paper', color: 'text.primary', transition: 'border-color 0.12s, box-shadow 0.12s, transform 0.12s', '&:hover, &:focus-visible': { borderColor: 'primary.main', boxShadow: 'var(--wf-shadow-block)', transform: 'translateY(-1px)' } }}
                    >
                      <Box sx={{ width: 32, height: 32, borderRadius: 2, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'rgba(15,108,189,0.1)', color: 'primary.main' }}>
                        <LightbulbIcon sx={{ fontSize: 16 }} />
                      </Box>
                      <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{prompt}</Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Fade>
          )}

          {!autoFollow && (
            <Button className="jump-to-latest" size="small" variant="contained" onClick={scrollToLatest}>
              Jump to latest
            </Button>
          )}
          <div ref={messagesEndRef} />
        </Box>

        <InputArea
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          isListening={isListening}
          isSpeechRecognitionSupported={isSpeechRecognitionSupported}
          isMuted={isMuted}
          voiceEnabled={ENV.ENABLE_VOICE}
          inputBytes={inputBytes}
          maxMessageBytes={MAX_MESSAGE_BYTES}
          onSend={() => { void handleSendMessage(); }}
          onStop={() => abortActiveTurn(true)}
          onStartListening={handleStartListening}
          onStopListening={stopListening}
          onToggleMute={toggleMute}
          textFieldRef={textFieldRef}
        />
      </Box>
    </Box>
  );
};

interface SendOptions {
  conversationId?: string;
  resetConversation?: boolean;
  history?: ChatMessageHistoryItem[];
  captchaToken?: string;
}
