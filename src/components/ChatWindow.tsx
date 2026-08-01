import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Fade from '@mui/material/Fade';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
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
import { AdSlot } from './AdSlot';
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
/** Fallback for the `scrollend` event, and the floor for how long a guard lasts. */
const SMOOTH_SCROLL_SETTLE_MS = 700;
/** How close to the end of the transcript still counts as "following the tail". */
const TAIL_FOLLOW_SLACK_PX = 80;
/**
 * How long a turn has to run before the wait starts showing its own clock. Short
 * turns stay clean; a long one has to look measured rather than hung.
 */
const ELAPSED_HINT_AFTER_MS = 8_000;
/** How often the elapsed hint re-renders while a turn is in flight. */
const ELAPSED_TICK_MS = 1_000;

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

const formatDuration = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * The steps of the turn that just landed, kept in memory so the trail does not
 * blink out at the instant the answer commits. Only ever the most recent turn:
 * this is a display aid, not transcript data, and is deliberately not persisted
 * — `Message` is validated field-by-field by the storage sanitizer inside a
 * versioned envelope, and a schema migration is not worth it here.
 */
interface CompletedTrail {
  messageId: string;
  activities: StreamActivity[];
  durationMs: number;
}

/**
 * One step row. Shared by the pre-answer panel and the expanded trail so the two
 * cannot drift apart.
 */
const ActivityRow: React.FC<{ label: string; detail?: string; done: boolean }> = ({
  label,
  detail,
  done,
}) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.4 }}>
    {done ? (
      <CheckIcon fontSize="small" sx={{ fontSize: 16, color: 'success.main', flexShrink: 0 }} />
    ) : (
      <CircularProgress size={14} sx={{ flexShrink: 0 }} />
    )}
    <Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontSize: 14, color: done ? 'text.secondary' : 'text.primary' }}>
        {label}
      </Typography>
      {detail && (
        <Typography sx={{ fontSize: 13, color: 'text.secondary', fontStyle: 'italic', mt: 0.25 }}>
          {detail}
        </Typography>
      )}
    </Box>
  </Box>
);

const ActivitySteps: React.FC<{ activities: StreamActivity[] }> = ({ activities }) => (
  <>
    {activities.map(activity => (
      <ActivityRow
        key={activity.id}
        label={activity.label}
        detail={activity.detail}
        done={activity.state === 'done'}
      />
    ))}
  </>
);

/**
 * What the assistant did, once it has started answering. Collapsed by default:
 * the steps mattered while the user was waiting on them, and are context
 * afterwards. Before this existed the whole strip vanished on the first text
 * delta, taking the record of what was searched with it.
 */
const ActivityTrail: React.FC<{ activities: StreamActivity[]; durationMs: number }> = ({
  activities,
  durationMs,
}) => {
  const [expanded, setExpanded] = useState(false);
  if (!activities.length) return null;

  return (
    <Box sx={{ px: 3, pt: 1 }}>
      <Box sx={{ width: '100%', maxWidth: CHAT_CONTENT_MAX_WIDTH, mx: 'auto' }}>
        <Box
          component="button"
          type="button"
          onClick={() => setExpanded(open => !open)}
          aria-expanded={expanded}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            p: 0,
            border: 0,
            bgcolor: 'transparent',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 13,
            color: 'text.secondary',
            '&:hover, &:focus-visible': { color: 'text.primary' },
          }}
        >
          <ExpandMoreIcon
            sx={{
              fontSize: 16,
              transition: 'transform 0.12s',
              transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            }}
          />
          {`Worked for ${formatDuration(durationMs)} · ${activities.length} ${activities.length === 1 ? 'step' : 'steps'}`}
        </Box>
        {expanded && (
          <Box sx={{ pl: 2.5, pt: 0.5 }}>
            <ActivitySteps activities={activities} />
          </Box>
        )}
      </Box>
    </Box>
  );
};

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
  /** Drives the elapsed-time hint, and the duration shown on the finished trail. */
  startedAt: number;
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
  // Re-rendered once a second while a turn is in flight, so a long wait visibly
  // counts up instead of sitting on a motionless spinner.
  const [turnElapsedMs, setTurnElapsedMs] = useState(0);
  const [completedTrail, setCompletedTrail] = useState<CompletedTrail | null>(null);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showExamples, setShowExamples] = useState(true);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const turnAnchorRef = useRef<HTMLDivElement>(null);
  const tailSpacerRef = useRef<HTMLDivElement>(null);
  /** The user message the transcript is already anchored to; one anchor per turn. */
  const lastAnchoredMessageIdRef = useRef<string | null>(null);
  const anchoredConversationRef = useRef<string | null>(null);
  const turnWasLoadingRef = useRef(false);
  const skipNextAutoFollowRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const spacerFrameRef = useRef<number | null>(null);
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

  // The interval exists only while a turn is running, so an idle page never
  // re-renders on a timer.
  useEffect(() => {
    if (!isLoading) return;
    const tick = () => {
      const startedAt = activeTurnRef.current?.startedAt;
      setTurnElapsedMs(startedAt ? Date.now() - startedAt : 0);
    };
    tick();
    const timer = window.setInterval(tick, ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isLoading]);

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
    setTurnElapsedMs(0);
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
      let current: UsageData | null;
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
      startedAt: Date.now(),
      rollbackMessages: params.rollbackMessages,
      rollbackTitle: params.rollbackTitle,
    };
    activeTurnRef.current = turn;
    setActiveRequestId(requestId);
    // The previous turn's trail belongs to the previous answer.
    setCompletedTrail(null);
    setTurnElapsedMs(0);

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
      const answerId = messageId('_ai');
      updateConversationById(conversationId, conversation => ({
        messages: [...conversation.messages, {
          id: answerId,
          role: 'ai' as const,
          rawContent: result.text,
          timestamp: Date.now(),
          status: 'complete' as const,
          annotations: result.annotations,
        }],
        needsServerResync: false,
      }));
      // Hand the steps to the answer before clearActiveTurn drops them, so the
      // trail does not blink out at the moment the answer lands.
      const steps = activeTurnRef.current?.activities ?? [];
      setCompletedTrail(steps.length
        ? { messageId: answerId, activities: steps, durationMs: Date.now() - turn.startedAt }
        : null);
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

  const lastUserMessageId = useMemo(() => {
    for (let index = currentConversation.messages.length - 1; index >= 0; index -= 1) {
      if (currentConversation.messages[index].role === 'user') return currentConversation.messages[index].id;
    }
    return undefined;
  }, [currentConversation.messages]);

  // ===== Scrolling =====
  // All of it belongs to the transcript, and nothing below ever moves the
  // window. On the XenForo page node the document is roughly 770px taller than
  // the chat — a 280px AdSense reservation and the page title above it, share
  // buttons, a breadcrumb and the forum footer below — so the old
  // `window.scrollTo(0, document.documentElement.scrollHeight)` did not scroll
  // to the end of the conversation at all. It scrolled into the footer, once
  // per streamed frame, carrying the reader away from the answer being written.

  /** Following the tail is purely a question of how near the end we are. */
  const syncAutoFollow = useCallback((element: HTMLElement) => {
    setAutoFollow(element.scrollHeight - element.scrollTop - element.clientHeight < TAIL_FOLLOW_SLACK_PX);
  }, []);

  const handleScroll = useCallback(() => {
    const element = messagesContainerRef.current;
    if (!element) return;
    // A smooth programmatic scroll emits scroll events from far above the
    // bottom. Reading those as "the user scrolled away" turned auto-follow
    // back off mid-animation, which made the jump-to-latest button reappear
    // and flicker on every use.
    if (programmaticScrollRef.current) return;
    syncAutoFollow(element);
  }, [syncAutoFollow]);

  /** Ends the programmatic-scroll guard, preferring `scrollend` to the timer. */
  const armProgrammaticScrollGuard = useCallback((element: HTMLElement) => {
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }
    const release = () => {
      programmaticScrollRef.current = false;
      if (programmaticScrollTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
      }
      element.removeEventListener('scrollend', release);
    };
    if ('onscrollend' in window) {
      element.addEventListener('scrollend', release, { once: true });
    }
    // Kept as the fallback even when `scrollend` is available: a smooth scroll
    // that lands on the position it started from never fires the event at all.
    programmaticScrollTimerRef.current = window.setTimeout(release, SMOOTH_SCROLL_SETTLE_MS);
  }, []);

  const scrollToLatest = useCallback(() => {
    setAutoFollow(true);
    const element = messagesContainerRef.current;
    if (!element) return;
    if (reduceMotion) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    skipNextAutoFollowRef.current = true;
    armProgrammaticScrollGuard(element);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [armProgrammaticScrollGuard, reduceMotion]);

  /**
   * Reserves enough room after the newest question that it can actually reach
   * the top of the pane. Without it a short exchange has nothing to scroll
   * into and the anchor below silently clamps to the bottom.
   *
   * It shrinks to nothing on its own once the answer outgrows a screenful, so
   * a long response leaves no trailing gap. Written straight to `style` rather
   * than through state: this is measured against a DOM the stream is mutating
   * ~60 times a second, and a re-render per frame is exactly what commit
   * 25a2280 removed.
   */
  const measureTailSpacer = useCallback(() => {
    const pane = messagesContainerRef.current;
    const spacer = tailSpacerRef.current;
    if (!pane || !spacer) return;
    const anchor = turnAnchorRef.current;
    if (!anchor) {
      spacer.style.height = '0px';
      return;
    }
    const current = spacer.offsetHeight;
    const contentHeight = pane.scrollHeight - current;
    const anchorTop = pane.scrollTop + (anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top);
    const belowAnchor = contentHeight - anchorTop;
    const next = Math.max(0, Math.round(pane.clientHeight - belowAnchor));
    if (next !== current) spacer.style.height = `${next}px`;
  }, []);

  const scheduleTailSpacerMeasure = useCallback(() => {
    if (spacerFrameRef.current !== null) return;
    spacerFrameRef.current = requestAnimationFrame(() => {
      spacerFrameRef.current = null;
      measureTailSpacer();
    });
  }, [measureTailSpacer]);

  // Driven by ResizeObserver rather than by an effect keyed on streamingState:
  // that state is a fresh object every animation frame, so an effect would run
  // ~60 times a second and force a layout read each time.
  useEffect(() => {
    const pane = messagesContainerRef.current;
    const content = transcriptContentRef.current;
    if (!pane || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(scheduleTailSpacerMeasure);
    observer.observe(pane);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (spacerFrameRef.current !== null) {
        cancelAnimationFrame(spacerFrameRef.current);
        spacerFrameRef.current = null;
      }
    };
  }, [scheduleTailSpacerMeasure]);

  /**
   * One scroll per turn: the question the user just asked moves to the top of
   * the pane and the answer is written into the stationary space below it.
   * Chasing the end of the text instead — which is what this replaces — slides
   * every line upward under the reader while they are trying to read it.
   *
   * Opening the app or switching conversations is handled here too, and first,
   * so that loading a finished exchange lands at its end rather than anchoring
   * a question that was answered days ago.
   */
  useLayoutEffect(() => {
    const pane = messagesContainerRef.current;
    if (!pane) return;

    if (anchoredConversationRef.current !== currentConversationId) {
      anchoredConversationRef.current = currentConversationId;
      lastAnchoredMessageIdRef.current = lastUserMessageId ?? null;
      if (tailSpacerRef.current) tailSpacerRef.current.style.height = '0px';
      pane.scrollTop = pane.scrollHeight;
      setAutoFollow(true);
      return;
    }

    if (!lastUserMessageId || showCaptcha) return;
    if (lastAnchoredMessageIdRef.current === lastUserMessageId) return;
    lastAnchoredMessageIdRef.current = lastUserMessageId;
    const anchor = turnAnchorRef.current;
    if (!anchor) return;
    // The spacer has to be in place before the scroll, or there is nothing to
    // scroll into and the browser clamps the target back to the bottom.
    measureTailSpacer();
    const top = pane.scrollTop + (anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top);
    // Tail-follow has to stand down for the anchor to survive: it re-runs on
    // every streamed frame, so leaving it on pinned the pane to the end of the
    // text and the question never reached the top at all. It cannot be decided
    // from geometry here either — mid-turn, "the answer fits on screen" and
    // "the answer has not arrived yet" measure identically. "Jump to latest"
    // is how the reader opts back into following.
    setAutoFollow(false);
    if (reduceMotion) {
      pane.scrollTop = top;
      return;
    }
    armProgrammaticScrollGuard(pane);
    pane.scrollTo({ top, behavior: 'smooth' });
  }, [
    armProgrammaticScrollGuard,
    currentConversationId,
    lastUserMessageId,
    measureTailSpacer,
    reduceMotion,
    showCaptcha,
  ]);

  /**
   * Once a turn ends the ambiguity is gone, so the offer to follow can be
   * settled honestly: an answer that fit on screen leaves nothing below the
   * fold and should not keep showing "Jump to latest".
   */
  useEffect(() => {
    if (isLoading) {
      turnWasLoadingRef.current = true;
      return;
    }
    if (!turnWasLoadingRef.current) return;
    turnWasLoadingRef.current = false;
    const frame = requestAnimationFrame(() => {
      const pane = messagesContainerRef.current;
      if (!pane) return;
      measureTailSpacer();
      syncAutoFollow(pane);
    });
    return () => cancelAnimationFrame(frame);
  }, [isLoading, measureTailSpacer, syncAutoFollow]);

  /**
   * Tail-follow, opt-in. After a turn is anchored the reader sits at the top
   * of their own question rather than at the bottom, so this does not fire
   * until they scroll down or press "Jump to latest" — at which point an
   * answer still being written keeps up.
   */
  useEffect(() => {
    if (!autoFollow) return;
    if (skipNextAutoFollowRef.current) {
      skipNextAutoFollowRef.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const element = messagesContainerRef.current;
      if (element) element.scrollTop = element.scrollHeight;
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
  const visibleStreamingMessage = streamingState?.conversationId === currentConversationId
    ? streamingState.message
    : null;
  const hasActiveStep = activities.some(activity => activity.state === 'active');
  const showElapsed = turnElapsedMs >= ELAPSED_HINT_AFTER_MS;

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
      // Height and overflow live in App.css: MUI reads an sx array as
      // breakpoints rather than as a fallback pair, so `100vh`/`100dvh` cannot
      // be expressed here. See the `.wf-chat-window` block there.
      sx={{ display: 'flex', backgroundColor: containerBg }}
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
        {/* Just the first row of a fixed-height column — no stickiness needed.
            It was sticky only while the document was the scroller. */}
        <Box sx={{ borderBottom: `1px solid ${borderColor}`, px: { xs: 1, sm: 2 }, py: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, backgroundColor: 'background.paper', flexShrink: 0 }}>
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
          onScroll={handleScroll}
          // The app's only scroll container. `overscroll-behavior: contain`
          // and `scrollbar-gutter` are in App.css alongside the pane sizing.
          sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
        >
          <Box ref={transcriptContentRef}>
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
                  <React.Fragment key={message.id}>
                    {/* Where a new turn is scrolled to. Zero-height, so it costs
                        the transcript nothing when no turn is in flight. */}
                    {isLastUser && <Box ref={turnAnchorRef} aria-hidden data-wf-turn-anchor sx={{ height: 0 }} />}
                    {completedTrail?.messageId === message.id && (
                      <ActivityTrail
                        activities={completedTrail.activities}
                        durationMs={completedTrail.durationMs}
                      />
                    )}
                    <MessageComponent
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
                  </React.Fragment>
                );
              })}
            </Box>

            {visibleStreamingMessage && (
              <Box aria-live="off">
                <ActivityTrail activities={activities} durationMs={turnElapsedMs} />
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
                  <ActivitySteps activities={activities} />
                  {/* Every step flips to a green check the moment it finishes, so
                      between steps the panel would be a motionless list of ticks:
                      after reasoning closes and before the message item opens, and
                      while a tool runs between the two upstream calls. A turn in
                      flight always has exactly one live row. */}
                  {!hasActiveStep ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.4 }}>
                      <CircularProgress size={activities.length ? 14 : 16} sx={{ flexShrink: 0 }} />
                      <Typography sx={{ fontSize: 14, color: 'text.secondary' }}>
                        {activities.length ? 'Preparing the answer…' : 'Thinking…'}
                      </Typography>
                      {showElapsed && (
                        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                          {`· ${formatDuration(turnElapsedMs)}`}
                        </Typography>
                      )}
                    </Box>
                  ) : showElapsed && (
                    <Typography sx={{ fontSize: 13, color: 'text.secondary', pl: 3.5, pt: 0.25 }}>
                      {formatDuration(turnElapsedMs)}
                    </Typography>
                  )}
                </Box>
              </Box>
            )}

            {errorMessage && (
              <Box role="status" sx={{ px: 3, py: 1.5, textAlign: 'center' }}>
                <Typography color="error">{errorMessage}</Typography>
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
          </Box>

          {/* Height is set imperatively by measureTailSpacer. */}
          <Box ref={tailSpacerRef} aria-hidden data-wf-tail-spacer sx={{ flexShrink: 0 }} />

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

        {/* The forum's breadcrumb ad, relocated here from above the chat so it
            cannot take 280px (390px on a phone) out of a viewport that no
            longer scrolls. Renders nothing for members or off the embed. */}
        <AdSlot isGuest={isGuest} />
      </Box>

      {/* A fixed overlay cannot move document flow. Inline in the transcript
          this widget shifted the layout four times per challenge — the user's
          message was pulled out of the transcript, the composer refilled, an
          error line appeared, and then the iframe arrived asynchronously and
          grew ~65px — and every one of those shifts moved the reader.
          `keepMounted` so #turnstile-container exists for api.render(). */}
      <Dialog
        open={showCaptcha}
        onClose={() => cancelPendingCaptcha(true)}
        keepMounted
        aria-labelledby="wf-captcha-title"
        // Portalled inside the scoped wrapper, like the history drawer, so no
        // chat DOM or styling reaches the surrounding XenForo page.
        container={() => document.getElementById('wf-chat-window')}
      >
        <DialogTitle id="wf-captcha-title" sx={{ fontSize: 16 }}>Quick security check</DialogTitle>
        <DialogContent sx={{ display: 'flex', justifyContent: 'center', pb: 3 }}>
          <div id="turnstile-container" aria-label="Security check" />
        </DialogContent>
      </Dialog>
    </Box>
  );
};
