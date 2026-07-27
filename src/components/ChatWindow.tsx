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
import CheckIcon from '@mui/icons-material/Check';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import MenuIcon from '@mui/icons-material/Menu';

import type {
  Annotation,
  ChatMessageHistoryItem,
  ChatWindowProps,
  Conversation,
  Message,
  StreamActivity,
  StreamingResponse,
  UsageData,
} from '../types';
import { Message as MessageComponent } from './Message';
import { ConversationSidebar } from './ConversationSidebar';
import { InputArea } from './InputArea';
import { EXAMPLE_PROMPTS, generateConversationId, generateTurnId } from '../utils/helpers';
import {
  APIError,
  CaptchaRequiredError,
  ChatAPI,
  IncompleteStreamError,
  StreamCancelledError,
  StreamProtocolError,
} from '../services/api';
import { AudioService } from '../services/speech';
import {
  enforceConversationCap,
  loadStore,
  mergeStores,
  parseStore,
  saveStore,
  storageKeys,
} from '../services/storage';
import { ENV } from '../config/env';
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';
import { CHAT_CONTENT_MAX_WIDTH } from '../config/layout';

const MAX_MESSAGE_BYTES = 500;
/** Local history items sent with every request as server recovery context. */
const HISTORY_CONTEXT_ITEMS = 20;
const HISTORY_CONTEXT_ITEM_BYTES = 4_000;
const TURNSTILE_LOAD_TIMEOUT_MS = 15_000;
const PENDING_DELETION_RETRY_MS = 60_000;
/** One retry for transient failures that consumed no output. */
const RETRY_BACKOFF_MS = 400;
const RETRY_JITTER_MS = 400;
/** How long a smooth scroll is treated as in progress (no portable `scrollend`). */
const SMOOTH_SCROLL_SETTLE_MS = 700;

/**
 * Read-aloud preference, scoped per account like every other stored key. It
 * used to be a bare `chat_mute`, so on a shared browser one account's setting
 * carried over to the next.
 */
const muteStorageKey = (userId: string): string => `chat_mute:v1:${encodeURIComponent(userId)}`;
const utf8Encoder = new TextEncoder();
const byteLength = (value: string): number => utf8Encoder.encode(value).length;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Safe to send again: the error is transient and no part of an answer was
 * delivered, so retrying cannot duplicate output or splice two answers
 * together. A cancelled turn is the user's decision and is never retried.
 */
const isSafelyRetryable = (error: unknown): boolean => {
  if (error instanceof StreamCancelledError || error instanceof CaptchaRequiredError) return false;
  if (error instanceof APIError) return error.retryable && !error.partialText;
  if (error instanceof IncompleteStreamError || error instanceof StreamProtocolError) {
    // A truncated stream already showed the user text; replaying it would
    // duplicate content. Only a turn that produced nothing may be retried.
    return !error.partialText;
  }
  return false;
};

const messageId = (suffix = ''): string => {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `msg_${random}${suffix}`;
};

const createWelcomeMessage = (welcomeMessage: string): Message => ({
  id: messageId('_welcome'),
  role: 'ai',
  rawContent: welcomeMessage,
  timestamp: Date.now(),
  status: 'complete',
});

const createNewConversation = (id: string, welcomeMessage: string): Conversation => {
  const now = Date.now();
  return {
    id,
    title: 'New Chat',
    messages: [createWelcomeMessage(welcomeMessage)],
    createdAt: now,
    updatedAt: now,
  };
};

const noopEdit = (_id: string, _content: string) => {};
const noopRetry = (_id: string) => {};
const noopRegenerate = () => {};

type ConversationUpdate = Partial<Conversation> | ((conversation: Conversation) => Partial<Conversation>);

type TurnKind = 'send' | 'edit' | 'regenerate' | 'retry';

interface TurnParams {
  conversationId: string;
  content: string;
  kind: TurnKind;
  /** Messages the new user message appends to. Defaults to the live list. */
  baseMessages?: Message[];
  /** Full original message list restored if a branch operation fails. */
  rollbackMessages?: Message[];
  rollbackTitle?: string;
  captchaToken?: string;
  /** Branch operations rewrite server history unconditionally. */
  forceReset?: boolean;
}

interface ActiveTurn {
  requestId: string;
  conversationId: string;
  controller: AbortController;
  userMessageId: string;
  partialText: string;
  annotations: Annotation[];
  /** What the assistant is doing before/while it answers, for the wait UI. */
  activities: StreamActivity[];
  /**
   * For branch operations (edit/regenerate/retry), the pre-turn messages
   * and title, so an abort before any output restores the original branch
   * instead of leaving it truncated.
   */
  rollbackMessages?: Message[];
  rollbackTitle?: string;
}

interface PendingCaptchaTurn {
  params: TurnParams;
  userMessage: Message;
}

const getMessageText = (message: Message): string => message.rawContent.trim();

/** Trailing markers appended to stopped/interrupted responses are UI, not context. */
const INTERRUPTION_MARKER = /\n\n_(?:Generation stopped|Response interrupted)\._$/;
const HISTORY_TRUNCATION_MARKER = '\n[truncated]';

const truncateHistoryContent = (content: string): string => {
  if (byteLength(content) <= HISTORY_CONTEXT_ITEM_BYTES) return content;

  const byteBudget = HISTORY_CONTEXT_ITEM_BYTES - byteLength(HISTORY_TRUNCATION_MARKER);
  let bytes = 0;
  let end = 0;
  for (const character of content) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > byteBudget) break;
    bytes += characterBytes;
    end += character.length;
  }
  return `${content.slice(0, end)}${HISTORY_TRUNCATION_MARKER}`;
};

const serializeConversationHistory = (messages: Message[]): ChatMessageHistoryItem[] => messages
  .map((message, index) => ({ message, index }))
  .filter(({ message, index }) => {
    const text = getMessageText(message);
    return Boolean(text)
      && message.status !== 'failed'
      && message.status !== 'sending'
      && !(index === 0 && message.role === 'ai' && text.startsWith('Welcome to WindowsForum.com'));
  })
  .map(({ message }) => {
    const content = getMessageText(message).replace(INTERRUPTION_MARKER, '').trim();
    return {
      role: message.role === 'ai' ? 'assistant' as const : 'user' as const,
      content: truncateHistoryContent(content),
    };
  })
  .filter(item => item.content !== '');

type TurnstileApi = NonNullable<Window['turnstile']>;
let turnstileLoader: Promise<TurnstileApi> | null = null;

/**
 * Loads the Turnstile script with a hard deadline. A script element that
 * failed or timed out is removed so the next attempt injects a fresh one —
 * a wedged element would otherwise never fire load again.
 */
const loadTurnstile = (): Promise<TurnstileApi> => {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoader) return turnstileLoader;

  const loader = new Promise<TurnstileApi>((resolve, reject) => {
    let settled = false;
    let script = document.querySelector<HTMLScriptElement>('script[data-wf-turnstile]');

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const failAndRecreate = (message: string) => settle(() => {
      script?.remove();
      reject(new Error(message));
    });
    const finish = () => settle(() => {
      if (window.turnstile) {
        resolve(window.turnstile);
      } else {
        script?.remove();
        reject(new Error('Turnstile loaded without exposing its API.'));
      }
    });
    const timer = setTimeout(
      () => failAndRecreate('Turnstile script timed out.'),
      TURNSTILE_LOAD_TIMEOUT_MS,
    );

    if (!script) {
      script = document.createElement('script');
      script.dataset.wfTurnstile = 'true';
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => failAndRecreate('Turnstile failed to load.'), { once: true });
  }).catch((error: unknown) => {
    turnstileLoader = null;
    throw error;
  });

  turnstileLoader = loader;
  return loader;
};

export const ChatWindow: React.FC<ChatWindowProps> = ({ userAvatar, userName, userId }) => {
  const theme = useTheme();
  const isGuest = userId.startsWith('guest_');
  const welcomeMessage = useMemo(() => isGuest
    ? 'Welcome to WindowsForum.com! Ask me anything about Windows or technology. For the best results, [register](/register) or [log in](/login).'
    : 'Welcome to WindowsForum.com! Ask me anything about Windows or technology.',
  [isGuest]);

  const initialChatState = useMemo(() => {
    const loaded = loadStore(userId);
    const id = loaded.currentId && loaded.store.conversations[loaded.currentId]
      ? loaded.currentId
      : generateConversationId();
    const conversations = loaded.store.conversations[id]
      ? loaded.store.conversations
      : { ...loaded.store.conversations, [id]: createNewConversation(id, welcomeMessage) };
    return {
      conversations,
      currentId: id,
      tombstones: loaded.store.tombstones,
      pendingServerDeletions: loaded.store.pendingServerDeletions,
      unavailable: loaded.unavailable,
    };
  }, [userId, welcomeMessage]);

  const [conversations, setConversations] = useState(initialChatState.conversations);
  const [currentConversationId, setCurrentConversationId] = useState(initialChatState.currentId);
  const [streamingState, setStreamingState] = useState<{ conversationId: string; message: Message } | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeechRecognitionSupported] = useState(
    () => ENV.ENABLE_VOICE && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  );
  const [speechRecognition, setSpeechRecognition] = useState<SpeechRecognition | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(muteStorageKey(userId)) ?? 'true');
      return typeof stored === 'boolean' ? stored : true;
    } catch {
      return true;
    }
  });
  // What the assistant is doing while the user waits; replaces a bare spinner.
  const [activities, setActivities] = useState<StreamActivity[]>([]);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showExamples, setShowExamples] = useState(true);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const skipNextAutoFollowRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const textFieldRef = useRef<HTMLDivElement>(null);
  const conversationsRef = useRef(conversations);
  const currentConversationIdRef = useRef(currentConversationId);
  const tombstonesRef = useRef(initialChatState.tombstones);
  const pendingDeletionsRef = useRef(initialChatState.pendingServerDeletions);
  const storageUnavailableRef = useRef(initialChatState.unavailable);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const pendingCaptchaRef = useRef<PendingCaptchaTurn | null>(null);
  const turnstileWidgetRef = useRef<string | null>(null);
  const streamingFrameRef = useRef<number | null>(null);
  const inputRef = useRef(input);
  const mutedRef = useRef(isMuted);
  const isClearingRef = useRef(false);
  // Set before applying a remote (cross-tab) change so the resulting persist
  // effect does not write it straight back — that write-back is what made two
  // tabs on different conversations ping-pong storage events forever.
  const skipNextPersistRef = useRef(false);
  const keepListeningRef = useRef(false);
  const dictationPrefixRef = useRef('');
  const runTurnRef = useRef<(params: TurnParams) => Promise<void>>(async () => {});

  const isLoading = activeRequestId !== null || isClearing;
  const inputBytes = byteLength(input);
  const containerBg = theme.palette.background.paper;
  const borderColor = theme.palette.divider;

  useEffect(() => { currentConversationIdRef.current = currentConversationId; }, [currentConversationId]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { isClearingRef.current = isClearing; }, [isClearing]);
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

  /** Persists the composed v3 store and reflects quota evictions in memory. */
  const persistStore = useCallback(() => {
    if (storageUnavailableRef.current) return;
    const result = saveStore(userId, {
      version: 3,
      conversations: conversationsRef.current,
      tombstones: tombstonesRef.current,
      pendingServerDeletions: pendingDeletionsRef.current,
    }, currentConversationIdRef.current);

    if (result.evictedIds.length) {
      queueMicrotask(() => {
        setConversations(previous => {
          const next = { ...previous };
          for (const id of result.evictedIds) delete next[id];
          return next;
        });
        setErrorMessage('Browser storage is full. The oldest conversations were removed to keep saving history.');
      });
    } else if (!result.persisted) {
      queueMicrotask(() => setErrorMessage('Browser storage is full. New chat history will not persist after reload.'));
    }
  }, [userId]);

  useEffect(() => {
    conversationsRef.current = conversations;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    persistStore();
  }, [conversations, persistStore]);
  useEffect(() => { persistStore(); }, [currentConversationId, persistStore]);

  const updateConversationById = useCallback((conversationId: string, update: ConversationUpdate) => {
    setConversations(previous => {
      const existing = previous[conversationId];
      if (!existing) return previous;
      const changes = typeof update === 'function' ? update(existing) : update;
      return enforceConversationCap({
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

  const cancelStreamingFrame = useCallback(() => {
    if (streamingFrameRef.current !== null) {
      cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
  }, []);

  const clearActiveTurn = useCallback((requestId: string) => {
    if (activeTurnRef.current?.requestId !== requestId) return false;
    activeTurnRef.current = null;
    cancelStreamingFrame();
    setActiveRequestId(null);
    setStreamingState(null);
    setActivities([]);
    return true;
  }, [cancelStreamingFrame]);

  const abortActiveTurn = useCallback((persistPartial: boolean) => {
    const turn = activeTurnRef.current;
    if (!turn) return;
    activeTurnRef.current = null;
    turn.controller.abort();
    cancelStreamingFrame();
    if (conversationsRef.current[turn.conversationId]) {
      // The server may have consumed this turn; resync it next time.
      if (persistPartial && turn.partialText.trim()) {
        updateConversationById(turn.conversationId, conversation => ({
          needsServerResync: true,
          messages: [...conversation.messages, {
            id: messageId('_stopped'),
            role: 'ai' as const,
            rawContent: `${turn.partialText.trimEnd()}\n\n_Generation stopped._`,
            timestamp: Date.now(),
            status: 'stopped' as const,
            annotations: turn.annotations,
          }],
        }));
      } else if (turn.rollbackMessages) {
        // A branch operation aborted before any output: restore the original
        // branch rather than leaving it truncated (the contract for
        // edit/regenerate/retry).
        updateConversationById(turn.conversationId, () => ({
          needsServerResync: true,
          messages: turn.rollbackMessages,
          ...(turn.rollbackTitle !== undefined ? { title: turn.rollbackTitle } : {}),
        }));
      } else {
        updateConversationById(turn.conversationId, () => ({ needsServerResync: true }));
      }
    }
    setActiveRequestId(null);
    setStreamingState(null);
    AudioService.stop();
  }, [cancelStreamingFrame, updateConversationById]);

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
    if (
      restoreFailedMessage
      && pending
      && pending.params.kind === 'send'
      && conversationsRef.current[pending.params.conversationId]
    ) {
      addMessage(pending.params.conversationId, { ...pending.userMessage, status: 'failed' });
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
    setConversations(previous => enforceConversationCap({ ...previous, [id]: conversation }, id));
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

  const retryPendingDeletions = useCallback(() => {
    for (const conversationId of Object.keys(pendingDeletionsRef.current)) {
      void ChatAPI.deleteConversation(conversationId).then(() => {
        const next = { ...pendingDeletionsRef.current };
        delete next[conversationId];
        pendingDeletionsRef.current = next;
        persistStore();
      }).catch(() => {
        // Still pending; the next retry pass picks it up.
      });
    }
  }, [persistStore]);

  useEffect(() => {
    retryPendingDeletions();
    const interval = setInterval(retryPendingDeletions, PENDING_DELETION_RETRY_MS);
    return () => clearInterval(interval);
  }, [retryPendingDeletions]);

  const handleDeleteConversation = useCallback((conversationId: string) => {
    if (activeTurnRef.current?.conversationId === conversationId) abortActiveTurn(false);
    if (pendingCaptchaRef.current?.params.conversationId === conversationId) cancelPendingCaptcha(false);

    // Tombstone first: the deletion must win across tabs even if another
    // tab writes this conversation again before seeing our update.
    tombstonesRef.current = { ...tombstonesRef.current, [conversationId]: Date.now() };
    pendingDeletionsRef.current = { ...pendingDeletionsRef.current, [conversationId]: Date.now() };
    setConversations(previous => {
      const next = { ...previous };
      delete next[conversationId];
      return next;
    });
    void ChatAPI.deleteConversation(conversationId).then(() => {
      const next = { ...pendingDeletionsRef.current };
      delete next[conversationId];
      pendingDeletionsRef.current = next;
      persistStore();
    }).catch(error => {
      console.error('Failed to delete server conversation; will retry:', error);
    });
    if (conversationId === currentConversationIdRef.current) createAndSelectConversation();
  }, [abortActiveTurn, cancelPendingCaptcha, createAndSelectConversation, persistStore]);

  // Cross-tab merge: deletions (tombstones) always win; conversations take
  // the most recently updated copy.
  useEffect(() => {
    const keys = storageKeys(userId);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== keys.store || !event.newValue) return;
      const remote = parseStore(event.newValue);
      if (!remote) return;
      const currentTombstoned = remote.tombstones[currentConversationIdRef.current] !== undefined
        || (tombstonesRef.current[currentConversationIdRef.current] !== undefined);
      // Do not persist the merge straight back to disk; the other tab is the
      // writer of record for this event.
      skipNextPersistRef.current = true;
      // Merge against the LATEST state, not the passive ref, so a just-enqueued
      // in-flight update (e.g. a completed AI reply) is not clobbered.
      setConversations(previous => {
        const merged = mergeStores({
          version: 3,
          conversations: previous,
          tombstones: tombstonesRef.current,
          pendingServerDeletions: pendingDeletionsRef.current,
        }, remote);
        tombstonesRef.current = merged.tombstones;
        pendingDeletionsRef.current = merged.pendingServerDeletions;
        return enforceConversationCap(merged.conversations, currentConversationIdRef.current);
      });
      if (currentTombstoned) {
        if (activeTurnRef.current?.conversationId === currentConversationIdRef.current) {
          abortActiveTurn(false);
        }
        createAndSelectConversation();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [abortActiveTurn, createAndSelectConversation, userId]);

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

  const getErrorText = useCallback((error: unknown): string => {
    // A turn id makes a user report traceable to the exact server request
    // instead of a wall-clock guess across four log files.
    const reference = error instanceof IncompleteStreamError && error.diagnostics
      ? ` (ref: ${error.diagnostics.turnId})`
      : '';

    if (error instanceof IncompleteStreamError) {
      if (error.code === 'completed_empty') {
        return `The assistant finished without producing an answer. Please retry.${reference}`;
      }
      return `The response was interrupted before completion. You can retry it.${reference}`;
    }
    if (error instanceof StreamProtocolError) return 'The server returned an invalid streaming response. Please retry.';
    if (error instanceof APIError) {
      if (error.status === 429 || error.status === 400 || error.status === 413) {
        // Upstream detail can be long and internal; show a readable prefix only.
        return error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message;
      }
      // Session errors are not retryable — telling the user to retry guarantees failure.
      if (error.status === 401 || error.status === 403) {
        return 'Your session expired. Reload the page, or sign in, and try again.';
      }
      if (error.code === 'timeout') return 'The AI service took too long to respond. Please retry.';
      if (error.code === 'network_error') return 'Network error. Check your connection and retry.';
      if (error.retryable) return 'The AI service is temporarily unavailable. Please retry.';
    }
    return 'Failed to send the message. Please retry.';
  }, []);

  /**
   * Answers `/usage` locally. It fetches the quota fresh rather than reading
   * the cached value behind the header badge: that value is never populated
   * for guests (the fetch is skipped for them) and may not have arrived yet
   * for anyone else, which made the command report "not available" to people
   * who had a perfectly good quota.
   *
   * Still spends no AI message — asking how much you have left should not
   * consume any of it.
   */
  const handleUsageCommand = useCallback(async (conversationId: string) => {
    setInput('');
    setErrorMessage('');
    setShowExamples(false);

    const lines: string[] = [];

    if (isGuest) {
      lines.push('You are chatting as a guest, so no per-account quota is tracked.');
      lines.push('');
      lines.push('[Register](/register) or [log in](/login) for higher limits and saved history.');
    } else {
      let current: UsageData | null = null;
      try {
        current = await ChatAPI.getUsage();
        setUsage(current);
      } catch {
        current = null;
      }

      if (!current || current.unavailable) {
        lines.push('Usage information is not available right now — the quota service did not respond.');
      } else if (!current.logged_in) {
        lines.push('You are chatting as a guest, so no per-account quota is tracked.');
      } else {
        const tier = current.tier === 'premium'
          ? 'Premium Supporter'
          : current.tier === 'unlimited' ? 'Staff' : 'Free';
        lines.push(`**Tier:** ${tier}`);
        lines.push(current.unlimited
          ? `**Messages today:** ${current.used ?? 0} (no limit)`
          : `**Messages today:** ${current.used ?? 0} of ${current.limit ?? 0}`);
        if (!current.unlimited && typeof current.remaining === 'number') {
          lines.push(`**Remaining:** ${current.remaining}`);
        }
        if (typeof current.tokens_today === 'number') {
          lines.push(`**Tokens today:** ${current.tokens_today.toLocaleString()}`);
        }
        if (current.reset_at) {
          const reset = new Date(current.reset_at);
          lines.push(`**Resets:** ${Number.isNaN(reset.getTime()) ? current.reset_at : reset.toLocaleString()}`);
        }
      }
    }

    lines.push('');
    lines.push('_Answered locally — this did not use an AI message._');

    updateConversationById(conversationId, conversation => ({
      messages: [...conversation.messages, {
        id: messageId('_usage'),
        role: 'ai' as const,
        rawContent: lines.join('\n'),
        timestamp: Date.now(),
        status: 'complete' as const,
      }],
    }));
  }, [isGuest, updateConversationById]);

  /** Transactionally resets the current conversation after the server confirms. */
  const handleClearCommand = useCallback(async (conversationId: string) => {
    setInput('');
    setIsClearing(true);
    setErrorMessage('');
    try {
      await ChatAPI.clearConversation(conversationId);
      updateConversationById(conversationId, () => ({
        title: 'New Chat',
        messages: [createWelcomeMessage(welcomeMessage)],
        needsServerResync: false,
      }));
      setShowExamples(true);
      setAutoFollow(true);
    } catch (error) {
      console.error('Failed to clear conversation:', error);
      setErrorMessage('The server could not clear this conversation, so nothing was reset. Please retry.');
    } finally {
      setIsClearing(false);
    }
  }, [updateConversationById, welcomeMessage]);

  /**
   * Runs one chat turn transactionally: nothing is mutated until validation
   * passes, and branch operations (edit/regenerate/retry) restore the
   * original messages when the turn fails without a usable result.
   */
  const runTurn = useCallback(async (params: TurnParams) => {
    const content = params.content.trim();
    if (!content || activeTurnRef.current || isClearingRef.current) return;
    if (pendingCaptchaRef.current && !params.captchaToken) {
      setErrorMessage('Complete the security check before sending another message.');
      return;
    }
    const contentBytes = byteLength(content);
    if (contentBytes > MAX_MESSAGE_BYTES) {
      setErrorMessage(`Messages are limited to ${MAX_MESSAGE_BYTES} UTF-8 bytes (${contentBytes} currently).`);
      return;
    }

    const conversationId = params.conversationId;
    const existingConversation = conversationsRef.current[conversationId]
      || createNewConversation(conversationId, welcomeMessage);
    const baseMessages = params.baseMessages ?? existingConversation.messages;
    const resetConversation = Boolean(params.forceReset || existingConversation.needsServerResync);
    // NOTE: history is uploaded on every turn but chat.php only consumes it
    // when it has no conversation record yet (chat.php:1242). Gating it on
    // `resetConversation` alone is NOT safe: when the server has silently lost
    // its record, that is exactly the turn that must re-seed, and the client
    // cannot tell. Skipping it needs a server-side `history_required` signal.
    const history = serializeConversationHistory(baseMessages).slice(-HISTORY_CONTEXT_ITEMS);

    stopListening();
    AudioService.stop();
    setErrorMessage('');
    setShowExamples(false);
    setAutoFollow(true);

    if (params.kind === 'send' && content.toLowerCase() === '/clear') {
      await handleClearCommand(conversationId);
      return;
    }

    if (params.kind === 'send' && content.toLowerCase() === '/usage') {
      await handleUsageCommand(conversationId);
      return;
    }

    const userMessage: Message = {
      id: messageId('_user'),
      role: 'user',
      rawContent: content,
      timestamp: Date.now(),
      status: 'complete',
    };
    const isFirstQuestion = !baseMessages.some(message => message.role === 'user');
    setConversations(previous => {
      const conversation = previous[conversationId] || existingConversation;
      return enforceConversationCap({
        ...previous,
        [conversationId]: {
          ...conversation,
          title: isFirstQuestion
            ? `${content.slice(0, 50)}${content.length > 50 ? '…' : ''}`
            : conversation.title,
          messages: [...baseMessages, userMessage],
          updatedAt: Date.now(),
        },
      }, conversationId);
    });
    if (params.kind === 'send') setInput('');

    const requestId = messageId('_request');
    const controller = new AbortController();
    const turn: ActiveTurn = {
      requestId,
      conversationId,
      controller,
      userMessageId: userMessage.id,
      partialText: '',
      annotations: [],
      activities: [],
      rollbackMessages: params.rollbackMessages,
      rollbackTitle: params.rollbackTitle,
    };
    activeTurnRef.current = turn;
    setActiveRequestId(requestId);

    const scheduleStreamingUpdate = () => {
      if (streamingFrameRef.current !== null) return;
      streamingFrameRef.current = requestAnimationFrame(() => {
        streamingFrameRef.current = null;
        const active = activeTurnRef.current;
        if (!active || active.requestId !== requestId) return;
        setStreamingState({
          conversationId,
          message: {
            id: `${requestId}_stream`,
            role: 'ai',
            rawContent: active.partialText,
            timestamp: Date.now(),
            status: 'sending',
            annotations: active.annotations,
          },
        });
      });
    };

    const restoreBranch = () => {
      if (!params.rollbackMessages || !conversationsRef.current[conversationId]) return;
      updateConversationById(conversationId, () => ({
        messages: params.rollbackMessages,
        ...(params.rollbackTitle !== undefined ? { title: params.rollbackTitle } : {}),
      }));
    };

    try {
      const send = (turnId: string) => ChatAPI.sendMessage(content, {
        signal: controller.signal,
        captchaToken: params.captchaToken,
        conversationId,
        resetConversation: resetConversation || undefined,
        history,
        turnId,
        onActivity: (next) => {
          const active = activeTurnRef.current;
          if (!active || active.requestId !== requestId) return;
          active.activities = next;
          setActivities(next);
        },
        onChunk: (partialText, annotations) => {
          const active = activeTurnRef.current;
          if (!active || active.requestId !== requestId) return;
          active.partialText = partialText;
          active.annotations = annotations;
          // Coalesce chunk updates to animation frames; per-chunk renders
          // jank long streams.
          scheduleStreamingUpdate();
        },
      });

      let result: StreamingResponse;
      try {
        result = await send(generateTurnId());
      } catch (error) {
        // Retry once, but only when the failure is transient AND nothing was
        // consumed: with no output delivered the server has not committed a
        // turn, so a second attempt cannot duplicate or interleave an answer.
        if (!isSafelyRetryable(error) || controller.signal.aborted) throw error;
        const active = activeTurnRef.current;
        if (!active || active.requestId !== requestId) throw error;
        await sleep(RETRY_BACKOFF_MS + Math.random() * RETRY_JITTER_MS);
        if (activeTurnRef.current?.requestId !== requestId || controller.signal.aborted) throw error;
        result = await send(generateTurnId());
      }

      if (activeTurnRef.current?.requestId !== requestId) return;
      if (!result.text.trim()) {
        // The stream completed cleanly and the backend still produced nothing.
        // Distinct from a truncated transport, and it means we very likely
        // paid for an answer the user never saw — keep the diagnostics.
        throw new IncompleteStreamError(
          'The completed stream contained no response text.',
          '',
          [],
          result.responseId,
          'completed_empty',
          result.diagnostics
        );
      }
      updateConversationById(conversationId, conversation => ({
        messages: [...conversation.messages, {
          id: messageId('_ai'),
          role: 'ai' as const,
          rawContent: result.text,
          timestamp: Date.now(),
          status: 'complete' as const,
          annotations: result.annotations,
        }],
        needsServerResync: false,
      }));
      clearActiveTurn(requestId);
      setUsageRefresh(value => value + 1);
      if (ENV.ENABLE_VOICE && !mutedRef.current) {
        void AudioService.playTTS(result.text).catch(error => console.error('TTS playback failed:', error));
      }
    } catch (error) {
      const active = activeTurnRef.current;
      if (!active || active.requestId !== requestId) return;

      if (error instanceof CaptchaRequiredError) {
        // Restore the pre-turn state entirely; the parked turn re-runs
        // with the token after verification.
        if (params.rollbackMessages) {
          restoreBranch();
        } else {
          updateConversationById(conversationId, conversation => ({
            messages: conversation.messages.filter(message => message.id !== userMessage.id),
          }));
        }
        pendingCaptchaRef.current = { params, userMessage };
        clearActiveTurn(requestId);
        if (params.kind === 'send') setInput(content);
        setShowCaptcha(true);
        setErrorMessage('Complete the security check to send your message.');
        return;
      }

      const isStreamStateError = error instanceof StreamCancelledError
        || error instanceof IncompleteStreamError
        || error instanceof StreamProtocolError
        || error instanceof APIError;
      const partialText = isStreamStateError ? error.partialText : active.partialText;
      const annotations = isStreamStateError ? error.annotations : active.annotations;

      if (error instanceof StreamCancelledError) {
        // Reached only when the abort did not come from abortActiveTurn
        // (e.g. signal aborted while this turn is still registered).
        if (partialText.trim() && conversationsRef.current[conversationId]) {
          updateConversationById(conversationId, conversation => ({
            needsServerResync: true,
            messages: [...conversation.messages, {
              id: messageId('_stopped'),
              role: 'ai' as const,
              rawContent: `${partialText.trimEnd()}\n\n_Generation stopped._`,
              timestamp: Date.now(),
              status: 'stopped' as const,
              annotations,
            }],
          }));
        }
        clearActiveTurn(requestId);
        return;
      }

      if (params.rollbackMessages) {
        // Branch operation failed: the original branch is restored intact.
        // The server may have consumed the turn, so flag a resync.
        updateConversationById(conversationId, () => ({
          messages: params.rollbackMessages,
          ...(params.rollbackTitle !== undefined ? { title: params.rollbackTitle } : {}),
          needsServerResync: true,
        }));
      } else if (partialText.trim()) {
        updateConversationById(conversationId, conversation => ({
          needsServerResync: true,
          messages: [...conversation.messages, {
            id: messageId('_interrupted'),
            role: 'ai' as const,
            rawContent: `${partialText.trimEnd()}\n\n_Response interrupted._`,
            timestamp: Date.now(),
            status: 'interrupted' as const,
            annotations,
          }],
        }));
      } else {
        updateMessage(conversationId, userMessage.id, { status: 'failed' });
      }
      clearActiveTurn(requestId);
      setErrorMessage(getErrorText(error));
      setUsageRefresh(value => value + 1);
    }
  }, [
    clearActiveTurn,
    getErrorText,
    handleClearCommand,
    handleUsageCommand,
    stopListening,
    updateConversationById,
    updateMessage,
    welcomeMessage,
  ]);

  useEffect(() => { runTurnRef.current = runTurn; }, [runTurn]);

  const handleSendMessage = useCallback(async (messageContent: string | null = null) => {
    const content = messageContent === null ? inputRef.current : messageContent;
    await runTurn({
      conversationId: currentConversationIdRef.current,
      content,
      kind: 'send',
    });
  }, [runTurn]);

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
          pendingCaptchaRef.current = null;
          cleanupTurnstileWidget();
          setShowCaptcha(false);
          setErrorMessage('');
          // A plain send may have been edited in the composer while the
          // check was showing; branch operations replay verbatim.
          const content = pending.params.kind === 'send'
            ? (inputRef.current.trim() || pending.params.content)
            : pending.params.content;
          void runTurnRef.current({ ...pending.params, content, captchaToken: token });
        },
        'expired-callback': () => {
          setErrorMessage('The security check expired. Please complete it again.');
          if (turnstileWidgetRef.current && window.turnstile) window.turnstile.reset(turnstileWidgetRef.current);
        },
        'error-callback': () => {
          setErrorMessage('The security check failed to load. Please try again.');
          if (turnstileWidgetRef.current && window.turnstile) window.turnstile.reset(turnstileWidgetRef.current);
        },
      });
    }).catch((error: unknown) => {
      console.error('Turnstile load failed:', error);
      if (!cancelled) {
        setErrorMessage('The security check could not load. Please retry.');
        cancelPendingCaptcha(true);
      }
    });
    return () => { cancelled = true; };
  }, [cancelPendingCaptcha, cleanupTurnstileWidget, showCaptcha]);

  const branchGuard = useCallback((): Conversation | null => {
    if (activeTurnRef.current || isClearingRef.current) return null;
    if (pendingCaptchaRef.current) {
      setErrorMessage('Complete the security check before sending another message.');
      return null;
    }
    return conversationsRef.current[currentConversationIdRef.current] ?? null;
  }, []);

  const handleEditMessage = useCallback((id: string, newContent: string) => {
    const conversation = branchGuard();
    if (!conversation) return;
    const index = conversation.messages.findIndex(message => message.id === id);
    if (index < 0) return;
    void runTurn({
      conversationId: conversation.id,
      content: newContent,
      kind: 'edit',
      baseMessages: conversation.messages.slice(0, index),
      rollbackMessages: conversation.messages,
      rollbackTitle: conversation.title,
      forceReset: true,
    });
  }, [branchGuard, runTurn]);

  const handleRegenerateMessage = useCallback(() => {
    const conversation = branchGuard();
    if (!conversation) return;
    const lastUserIndex = conversation.messages.map(message => message.role).lastIndexOf('user');
    if (lastUserIndex < 0) return;
    void runTurn({
      conversationId: conversation.id,
      content: conversation.messages[lastUserIndex].rawContent,
      kind: 'regenerate',
      baseMessages: conversation.messages.slice(0, lastUserIndex),
      rollbackMessages: conversation.messages,
      rollbackTitle: conversation.title,
      forceReset: true,
    });
  }, [branchGuard, runTurn]);

  const handleRetryMessage = useCallback((id: string) => {
    const conversation = branchGuard();
    if (!conversation) return;
    const index = conversation.messages.findIndex(message => message.id === id && message.role === 'user');
    if (index < 0) return;
    void runTurn({
      conversationId: conversation.id,
      content: conversation.messages[index].rawContent,
      kind: 'retry',
      baseMessages: conversation.messages.slice(0, index),
      rollbackMessages: conversation.messages,
      rollbackTitle: conversation.title,
      forceReset: true,
    });
  }, [branchGuard, runTurn]);

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
      try { localStorage.setItem(muteStorageKey(userId), JSON.stringify(next)); } catch { /* optional */ }
      AudioService.setMuted(next || !ENV.ENABLE_VOICE);
      return next;
    });
  }, [userId]);

  // Stable identities: InputArea and ConversationSidebar are memoized, and a
  // fresh arrow here would defeat that on every streaming frame.
  const handleSend = useCallback(() => { void handleSendMessage(); }, [handleSendMessage]);
  const handleStop = useCallback(() => abortActiveTurn(true), [abortActiveTurn]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  /**
   * The transcript has no scroll container of its own: it grows down the page
   * and the browser's own scrollbar moves it, so there is exactly one
   * scrollbar rather than a pane nested inside the page.
   */
  const pageScrollBottomGap = (): number => {
    const doc = document.documentElement;
    return doc.scrollHeight - (window.scrollY + window.innerHeight);
  };

  const handleScroll = useCallback(() => {
    // A smooth programmatic scroll emits scroll events from far above the
    // bottom. Reading those as "the user scrolled away" turned auto-follow
    // back off mid-animation, which made the jump-to-latest button reappear
    // and flicker on every use.
    if (programmaticScrollRef.current) return;
    setAutoFollow(pageScrollBottomGap() < 80);
  }, []);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const scrollToLatest = useCallback(() => {
    setAutoFollow(true);
    const target = document.documentElement.scrollHeight;
    if (reduceMotion) {
      window.scrollTo(0, target);
      return;
    }
    skipNextAutoFollowRef.current = true;
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    // `scrollend` is not available everywhere; fall back to a timer that
    // comfortably outlasts a smooth scroll.
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, SMOOTH_SCROLL_SETTLE_MS);
    window.scrollTo({ top: target, behavior: 'smooth' });
  }, [reduceMotion]);

  useEffect(() => {
    if (!autoFollow) return;
    if (skipNextAutoFollowRef.current) {
      skipNextAutoFollowRef.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFollow, currentConversation.messages, streamingState]);

  useEffect(() => () => {
    const active = activeTurnRef.current;
    activeTurnRef.current = null;
    active?.controller.abort();
    if (streamingFrameRef.current !== null) cancelAnimationFrame(streamingFrameRef.current);
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    if (active && conversationsRef.current[active.conversationId] && !storageUnavailableRef.current) {
      // Unmount (navigation/account switch) interrupted a turn; persist the
      // resync marker directly since no further renders will run. A branch
      // operation interrupted before output is restored to its original
      // branch so the prior answer is not lost on disk.
      const conversation = conversationsRef.current[active.conversationId];
      const restored = active.rollbackMessages && !active.partialText.trim()
        ? {
          ...conversation,
          messages: active.rollbackMessages,
          ...(active.rollbackTitle !== undefined ? { title: active.rollbackTitle } : {}),
          needsServerResync: true,
          updatedAt: Date.now(),
        }
        : { ...conversation, needsServerResync: true, updatedAt: Date.now() };
      saveStore(userId, {
        version: 3,
        conversations: {
          ...conversationsRef.current,
          [active.conversationId]: restored,
        },
        tombstones: tombstonesRef.current,
        pendingServerDeletions: pendingDeletionsRef.current,
      }, currentConversationIdRef.current);
    }
    cleanupTurnstileWidget();
    AudioService.stop();
  }, [cleanupTurnstileWidget, userId]);

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
    <Box
      id="wf-chat-window"
      className="wf-chat-window"
      sx={{
        display: 'flex',
        // Fills the viewport on a short conversation and grows past it on a
        // long one; the page scrolls rather than an inner pane. `dvh` keeps
        // mobile browser chrome from cutting off the composer.
        minHeight: ['100vh', '100dvh'],
        backgroundColor: containerBg,
      }}
    >
      <ConversationSidebar
        open={drawerOpen}
        onClose={closeDrawer}
        conversations={sortedConversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onNewConversation={handleNewConversation}
      />

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Sticky: with the page scrolling instead of an inner pane, the
            history button and title would otherwise scroll out of reach. */}
        <Box sx={{ borderBottom: `1px solid ${borderColor}`, px: { xs: 1, sm: 2 }, py: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, backgroundColor: 'background.paper', flexShrink: 0, position: 'sticky', top: 0, zIndex: 3 }}>
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
          aria-label="Chat messages"
          // No overflow of its own: the transcript grows down the page and the
          // browser's scrollbar moves it, so the page has one scrollbar
          // instead of a pane nested inside a scrolling document.
          //
          // `clip` rather than `hidden` on the x-axis: per spec, a non-visible
          // value on one axis forces the other to compute as `auto`, so
          // `overflowX: hidden` would quietly turn this back into a scroll
          // container — and re-create the second scrollbar on a long answer.
          sx={{ flex: 1, overflowX: 'clip', position: 'relative' }}
        >
          {/* KNOWN LIMITATION: because this container is the live region, its
              children being replaced on a conversation switch reads to
              assistive tech as "all of these were just added", so the whole
              transcript is announced. Fixing it properly needs a dedicated
              announcer, which duplicates every answer's text in the DOM, or
              suppression around the swap — neither is safe to ship without
              testing against a real screen reader. `aria-relevant="additions"`
              was dropped: it is already the default for role="log". */}
          <Box role="log" aria-live="polite">
            {currentConversation.messages.map((message, index) => {
              const isLast = index === currentConversation.messages.length - 1
                && Boolean(lastUserMessageId);
              const isLastUser = message.id === lastUserMessageId;
              return (
                <MessageComponent
                  key={message.id}
                  msg={message}
                  userAvatar={userAvatar}
                  userName={userName}
                  onEdit={handleEditMessage}
                  onRegenerate={handleRegenerateMessage}
                  onRetry={handleRetryMessage}
                  isLastMessage={isLast}
                  isLastUserMessage={isLastUser}
                  isStreaming={false}
                  // Only the rows that actually render busy-gated actions see
                  // this flip, so the rest keep their memo across a turn.
                  isBusy={isLoading && (isLast || isLastUser)}
                />
              );
            })}
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
            <Box
              role="status"
              aria-label="Waiting for assistant response"
              sx={{ px: 3, py: 2.5, display: 'flex', justifyContent: 'center' }}
            >
              <Box sx={{ width: '100%', maxWidth: CHAT_CONTENT_MAX_WIDTH }}>
                {activities.length === 0 ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <CircularProgress size={16} />
                    <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>Thinking…</Typography>
                  </Box>
                ) : (
                  activities.map(activity => (
                    <Box
                      key={activity.id}
                      sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.4 }}
                    >
                      {activity.state === 'done' ? (
                        <CheckIcon
                          fontSize="small"
                          sx={{ fontSize: 16, color: 'success.main', flexShrink: 0 }}
                        />
                      ) : (
                        <CircularProgress size={14} sx={{ flexShrink: 0 }} />
                      )}
                      <Box sx={{ minWidth: 0 }}>
                        <Typography
                          sx={{
                            fontSize: 14,
                            color: activity.state === 'done' ? 'text.secondary' : 'text.primary',
                          }}
                        >
                          {activity.label}
                        </Typography>
                        {activity.detail && (
                          <Typography
                            sx={{ fontSize: 13, color: 'text.secondary', fontStyle: 'italic', mt: 0.25 }}
                          >
                            {activity.detail}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  ))
                )}
              </Box>
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
              <Box sx={{ maxWidth: CHAT_CONTENT_MAX_WIDTH, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 4 }, pb: 3 }}>
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
          onSend={handleSend}
          onStop={handleStop}
          onStartListening={handleStartListening}
          onStopListening={stopListening}
          onToggleMute={toggleMute}
          textFieldRef={textFieldRef}
        />
      </Box>
    </Box>
  );
};
