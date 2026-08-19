import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Avatar from '@mui/material/Avatar';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Fade from '@mui/material/Fade';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import MenuIcon from '@mui/icons-material/Menu';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PrintOutlinedIcon from '@mui/icons-material/PrintOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DataUsageOutlinedIcon from '@mui/icons-material/DataUsageOutlined';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';

import type {
  Annotation,
  ChatMessageHistoryItem,
  ChatWindowProps,
  Conversation,
  ConversationMap,
  Message,
  MessageAttachment,
  StreamActivity,
  StreamingResponse,
  UsageData,
} from '../types';
import { Message as MessageComponent } from './Message';
import { InputArea } from './InputArea';
import { EXAMPLE_PROMPTS } from '../utils/helpers';
import { generateConversationId, generateTurnId } from '../utils/ids';
import {
  APIError,
  CaptchaRequiredError,
  ChatAPI,
  IncompleteStreamError,
  StreamCancelledError,
  StreamProtocolError,
  type FeedbackRating,
  type ChatAttachment,
  type SavedConversation,
} from '../services/api';
import { AudioService, configureSpeechRecognition } from '../services/speech';
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
import {
  reportChatLifecycle,
  reportClientEvent,
  reportConversationExport,
} from '../services/telemetry';
import { loadLazyModule } from '../services/lazyImport';

// Management surfaces are not part of the core chat path. Load each only
// after its menu action so new product capabilities do not tax every session's
// initial ChatWindow chunk.
const SupportCasesDialog = React.lazy(() => loadLazyModule(async () => {
  const module = await import('./SupportCasesDialog');
  return { default: module.SupportCasesDialog };
}));
const ShareLinksDialog = React.lazy(() => loadLazyModule(async () => {
  const module = await import('./ShareLinksDialog');
  return { default: module.ShareLinksDialog };
}));
const AccountDataDialog = React.lazy(() => loadLazyModule(async () => {
  const module = await import('./AccountDataDialog');
  return { default: module.AccountDataDialog };
}));
const PreferencesDialog = React.lazy(() => loadLazyModule(async () => {
  const module = await import('./PreferencesDialog');
  return { default: module.PreferencesDialog };
}));
const AttachmentTray = React.lazy(() => loadLazyModule(async () => {
  const module = await import('./AttachmentTray');
  return { default: module.AttachmentTray };
}));
const AdSlot = React.lazy(() => loadLazyModule(async () => {
  const module = await import('./AdSlot');
  return { default: module.AdSlot };
}));
const ConversationSidebar = React.lazy(() => loadLazyModule(async () => {
  const module = await import('./ConversationSidebar');
  return { default: module.ConversationSidebar };
}));

const MAX_MESSAGE_BYTES = 4096;
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
const CLOUD_SYNC_DEBOUNCE_MS = 1_200;
const MAX_CLOUD_CONVERSATIONS = 50;
const CLOUD_FETCH_CONCURRENCY = 5;

/**
 * Read-aloud preference, scoped per account like every other stored key. It
 * used to be a bare `chat_mute`, so on a shared browser one account's setting
 * carried over to the next.
 */
const muteStorageKey = (userId: string): string => `chat_mute:v1:${encodeURIComponent(userId)}`;
const railStorageKey = (userId: string): string => `chat_rail_collapsed:v1:${encodeURIComponent(userId)}`;
const cloudBootstrapStorageKey = (userId: string): string => `chat_cloud_bootstrap:v1:${encodeURIComponent(userId)}`;
const utf8Encoder = new TextEncoder();
const byteLength = (value: string): number => utf8Encoder.encode(value).length;

const safeConversationQuery = (): string | null => {
  const value = new URL(window.location.href).searchParams.get('conversation');
  return value && /^conv_[A-Za-z0-9_-]{1,123}$/.test(value) ? value : null;
};

const safeShareQuery = (): string | null => {
  const value = new URL(window.location.href).searchParams.get('share');
  return value && /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : null;
};

const writeConversationUrl = (conversationId: string, mode: 'push' | 'replace'): void => {
  const url = new URL(window.location.href);
  url.searchParams.delete('share');
  url.searchParams.set('conversation', conversationId);
  const state = { ...(history.state && typeof history.state === 'object' ? history.state : {}), conversationId };
  if (mode === 'push') history.pushState(state, '', url);
  else history.replaceState(state, '', url);
};

const cloudSyncable = (conversation: Conversation): boolean => (
  conversation.messages.some(message => message.role === 'user')
);

const savedConversationToLocal = (
  saved: SavedConversation,
  local?: Conversation,
): Conversation => ({
  id: saved.id,
  title: saved.title,
  messages: saved.messages,
  createdAt: saved.created_at,
  updatedAt: saved.updated_at,
  ...(local?.draft !== undefined ? { draft: local.draft } : {}),
  ...(local?.draftUpdatedAt !== undefined ? { draftUpdatedAt: local.draftUpdatedAt } : {}),
  cloudRevision: saved.revision,
  cloudUpdatedAt: saved.updated_at,
  cloudSyncedLocalUpdatedAt: saved.updated_at,
  needsServerResync: true,
});

const settleInBatches = async <T,>(
  tasks: Array<() => Promise<T>>,
  batchSize = CLOUD_FETCH_CONCURRENCY,
): Promise<PromiseSettledResult<T>[]> => {
  const results: PromiseSettledResult<T>[] = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    results.push(...await Promise.allSettled(
      tasks.slice(index, index + batchSize).map(task => task())
    ));
  }
  return results;
};

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

/**
 * Rate limits and lease contention must use the server's retry window. Without
 * one, leave the turn failed for an explicit user retry rather than hammering
 * it again after the generic 400–800 ms transport backoff.
 */
const automaticRetryDelayMs = (error: unknown): number | null => {
  if (!isSafelyRetryable(error)) return null;
  if (error instanceof APIError && (error.status === 429 || error.code === 'conversation_busy')) {
    return error.retryAfterMs ?? null;
  }
  return RETRY_BACKOFF_MS + Math.random() * RETRY_JITTER_MS;
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
    draft: '',
  };
};

const assistantCompletionAnnouncement = (content: string): string => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const bounded = normalized.length > 600 ? `${normalized.slice(0, 599).trimEnd()}…` : normalized;
  return bounded ? `Assistant response: ${bounded}` : 'Assistant response complete.';
};

const telemetryErrorCode = (error: unknown): string => {
  if (error instanceof APIError) return error.code ?? (error.status ? `http_${error.status}` : 'api_error');
  if (error instanceof IncompleteStreamError) return error.code ?? 'incomplete_stream';
  if (error instanceof StreamProtocolError) return 'stream_protocol';
  if (error instanceof StreamCancelledError) return 'stream_cancelled';
  return error instanceof Error ? error.name : 'unknown_error';
};

const noopEdit = (_id: string, _content: string) => {};
const noopRetry = (_id: string) => {};
const noopRegenerate = () => {};

const formatDuration = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * The steps of the turn that just landed, kept in memory so the trail does not
 * blink out at the instant the answer commits. Only ever the most recent turn:
 * this is a display aid in addition to the durable activity metadata attached
 * to the committed assistant message.
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
const ActivityTrail: React.FC<{ activities: StreamActivity[]; durationMs?: number }> = ({
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
          {`${durationMs ? `Worked for ${formatDuration(durationMs)}` : 'Work details'} · ${activities.length} ${activities.length === 1 ? 'step' : 'steps'}`}
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
  /** Server-issued handles and display metadata bound to this user turn. */
  attachments?: MessageAttachment[];
}

interface ActiveTurn {
  requestId: string;
  turnId: string;
  conversationId: string;
  controller: AbortController;
  userMessageId: string;
  partialText: string;
  annotations: Annotation[];
  /** What the assistant is doing before/while it answers, for the wait UI. */
  activities: StreamActivity[];
  /** Drives the elapsed-time hint, and the duration shown on the finished trail. */
  startedAt: number;
  /** Lifecycle telemetry records the first non-empty text chunk exactly once. */
  firstTokenReported: boolean;
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

const SharedChatView: React.FC<{ token: string }> = ({ token }) => {
  const theme = useTheme();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !robots;
    const previousContent = robots?.getAttribute('content') ?? null;
    if (!robots) {
      robots = document.createElement('meta');
      robots.name = 'robots';
      document.head.appendChild(robots);
    }
    robots.content = 'noindex,nofollow,noarchive';

    return () => {
      if (created) {
        robots.remove();
      } else if (previousContent === null) {
        robots.removeAttribute('content');
      } else {
        robots.content = previousContent;
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void ChatAPI.getConversationShare(token, { signal: controller.signal })
      .then(({ share }) => {
        setConversation({
          id: share.id,
          title: share.title || 'Shared AI chat',
          messages: share.messages.map((message, messageIndex) => ({
            id: `shared_message_${messageIndex}`,
            role: message.role === 'user' ? 'user' : 'ai',
            rawContent: message.content,
            timestamp: message.createdAt,
            status: 'complete',
            ...(message.annotations?.length ? {
              annotations: message.annotations.map(annotation => ({ ...annotation })),
            } : {}),
            ...(message.attachments?.length ? {
              attachments: message.attachments.map((attachment, attachmentIndex) => ({
                id: `shared_attachment_${messageIndex}_${attachmentIndex}`,
                name: attachment.name,
                mime: attachment.mime,
                size: attachment.size,
              })),
            } : {}),
          })),
          createdAt: share.created_at,
          updatedAt: share.created_at,
        });
        setExpiresAt(share.expires_at);
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === 'AbortError') return;
        setError(reason instanceof APIError && reason.code === 'not_found'
          ? 'This shared chat is unavailable or has expired.'
          : 'The shared chat could not be loaded. Check your connection and try again.');
      });
    return () => controller.abort();
  }, [token]);

  return (
    <Box
      component="main"
      id="wf-chat-window"
      className="wf-chat-window"
      sx={{ display: 'flex', flexDirection: 'column', bgcolor: theme.palette.background.paper }}
    >
      <Box className="wf-chat-header" sx={{ minHeight: 62, px: { xs: 1.5, sm: 3 }, py: 1, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Avatar src={BOT_AVATAR} alt={ASSISTANT_NAME} sx={{ width: 36, height: 36, bgcolor: '#0a2c4d' }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h1" variant="h6" noWrap>{conversation?.title ?? 'Shared AI chat'}</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            Read-only snapshot{expiresAt ? ` · expires ${new Date(expiresAt).toLocaleDateString()}` : ''}
          </Typography>
        </Box>
        <Button component="a" href="/pages/ai/" size="small" variant="outlined">Open AI chat</Button>
      </Box>
      <Box className="chat-messages-container" role="region" aria-label="Shared chat messages" sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!conversation && !error && (
          <Box role="status" sx={{ minHeight: 220, display: 'grid', placeItems: 'center' }}>
            <Box sx={{ textAlign: 'center' }}><CircularProgress size={24} /><Typography sx={{ mt: 1, color: 'text.secondary' }}>Loading shared chat…</Typography></Box>
          </Box>
        )}
        {error && (
          <Alert severity="warning" sx={{ m: 2 }} action={<Button color="inherit" size="small" onClick={() => window.location.reload()}>Retry</Button>}>
            {error}
          </Alert>
        )}
        {conversation?.messages.map(message => (
          <React.Fragment key={message.id}>
            <MessageComponent
              msg={message}
              userAvatar=""
              userName="Shared participant"
              onEdit={noopEdit}
              onRegenerate={noopRegenerate}
              onRetry={noopRetry}
              isLastMessage={false}
              isStreaming={false}
              isBusy
            />
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
};

const InteractiveChatWindow: React.FC<ChatWindowProps> = ({ userAvatar, userName, userId }) => {
  const theme = useTheme();
  const isGuest = userId.startsWith('guest_');
  const welcomeMessage = useMemo(() => isGuest
    ? 'Welcome to WindowsForum.com! Ask me anything about Windows or technology. For the best results, [register](/register) or [log in](/login).'
    : 'Welcome to WindowsForum.com! Ask me anything about Windows or technology.',
  [isGuest]);

  const initialChatState = useMemo(() => {
    const loaded = loadStore(userId);
    const requestedId = safeConversationQuery();
    const id = requestedId && loaded.store.conversations[requestedId]
      ? requestedId
      : loaded.currentId && loaded.store.conversations[loaded.currentId]
        ? loaded.currentId
      : generateConversationId();
    const conversations = loaded.store.conversations[id]
      ? loaded.store.conversations
      : { ...loaded.store.conversations, [id]: createNewConversation(id, welcomeMessage) };
    return {
      conversations,
      currentId: id,
      createdFallback: !loaded.store.conversations[id],
      tombstones: loaded.store.tombstones,
      pendingServerDeletions: loaded.store.pendingServerDeletions,
      unavailable: loaded.unavailable,
      requestedId,
    };
  }, [userId, welcomeMessage]);

  const [conversations, setConversations] = useState(initialChatState.conversations);
  const [currentConversationId, setCurrentConversationId] = useState(initialChatState.currentId);
  const [streamingState, setStreamingState] = useState<{ conversationId: string; message: Message } | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [input, setInput] = useState(
    () => initialChatState.conversations[initialChatState.currentId]?.draft ?? ''
  );
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
  const [desktopRailCollapsed, setDesktopRailCollapsed] = useState(() => {
    try { return localStorage.getItem(railStorageKey(userId)) === 'true'; } catch { return false; }
  });
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [chatMenuAnchor, setChatMenuAnchor] = useState<HTMLElement | null>(null);
  const [renameConversationId, setRenameConversationId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const [cloudReady, setCloudReady] = useState(isGuest);
  const [cloudStatus, setCloudStatus] = useState<'device' | 'loading' | 'saving' | 'synced' | 'offline' | 'error'>(
    isGuest ? 'device' : 'loading'
  );
  const [cloudError, setCloudError] = useState('');
  const [cloudSyncGeneration, setCloudSyncGeneration] = useState(0);
  const [cloudSyncPaused, setCloudSyncPaused] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<Record<string, ChatAttachment[]>>({});
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [supportCasesOpen, setSupportCasesOpen] = useState(false);
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [accountDataOpen, setAccountDataOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, FeedbackRating>>({});
  const [feedbackPending, setFeedbackPending] = useState<Record<string, boolean>>({});
  const [showExamples, setShowExamples] = useState(true);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [announcement, setAnnouncement] = useState('');
  const isStandalone = window.top === window.self;

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
  const pendingDeletionRetryAtRef = useRef<Record<string, number>>({});
  const storageUnavailableRef = useRef(initialChatState.unavailable);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const pendingCaptchaRef = useRef<PendingCaptchaTurn | null>(null);
  const turnstileWidgetRef = useRef<string | null>(null);
  const streamingFrameRef = useRef<number | null>(null);
  const inputRef = useRef(input);
  const mutedRef = useRef(isMuted);
  const isClearingRef = useRef(false);
  const isOnlineRef = useRef(isOnline);
  const requestedConversationIdRef = useRef(initialChatState.requestedId);
  const cloudBootstrapAbortRef = useRef<AbortController | null>(null);
  const cloudSyncAbortRef = useRef<AbortController | null>(null);
  const cloudSyncTimerRef = useRef<number | null>(null);
  const cloudSyncLoopRef = useRef(false);
  const cloudSyncPausedRef = useRef(false);
  const composerAttachmentsRef = useRef(composerAttachments);
  const attachmentBusyRef = useRef(attachmentBusy);
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
  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);
  useEffect(() => { composerAttachmentsRef.current = composerAttachments; }, [composerAttachments]);
  useEffect(() => { attachmentBusyRef.current = attachmentBusy; }, [attachmentBusy]);
  useEffect(() => {
    mutedRef.current = isMuted;
    AudioService.setMuted(isMuted || !ENV.ENABLE_VOICE);
  }, [isMuted]);

  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      setErrorMessage(previous => previous.startsWith('You are offline.') ? '' : previous);
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

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

  /** Persists the composed v4 store and reflects quota evictions in memory. */
  const persistStore = useCallback(() => {
    if (storageUnavailableRef.current) return;
    const result = saveStore(userId, {
      version: 4,
      conversations: conversationsRef.current,
      tombstones: tombstonesRef.current,
      pendingServerDeletions: pendingDeletionsRef.current,
    }, currentConversationIdRef.current);

    if (result.evictedIds.length) {
      const evictedAt = Date.now();
      tombstonesRef.current = { ...tombstonesRef.current };
      pendingDeletionsRef.current = { ...pendingDeletionsRef.current };
      for (const id of result.evictedIds) {
        tombstonesRef.current[id] = evictedAt;
        pendingDeletionsRef.current[id] = evictedAt;
      }
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
    persistStore();
  }, [conversations, persistStore]);
  useEffect(() => { persistStore(); }, [currentConversationId, persistStore]);

  const enforceCapAndQueueDeletion = useCallback((next: ConversationMap, keepId: string): ConversationMap => {
    const capped = enforceConversationCap(next, keepId);
    const evicted = Object.keys(next).filter(id => !capped[id]);
    if (evicted.length) {
      const evictedAt = Date.now();
      tombstonesRef.current = { ...tombstonesRef.current };
      pendingDeletionsRef.current = { ...pendingDeletionsRef.current };
      for (const id of evicted) {
        tombstonesRef.current[id] = evictedAt;
        pendingDeletionsRef.current[id] = evictedAt;
      }
      queueMicrotask(() => setErrorMessage(
        'Your oldest conversation was removed from this browser and queued for secure server cleanup.'
      ));
    }
    return capped;
  }, []);

  const updateConversationById = useCallback((conversationId: string, update: ConversationUpdate) => {
    setConversations(previous => {
      const existing = previous[conversationId];
      if (!existing) return previous;
      const changes = typeof update === 'function' ? update(existing) : update;
      return enforceCapAndQueueDeletion({
        ...previous,
        [conversationId]: { ...existing, ...changes, updatedAt: Date.now() },
      }, conversationId);
    });
  }, [enforceCapAndQueueDeletion]);

  /** Draft edits persist without changing updatedAt, so typing does not reorder history. */
  const setConversationDraft = useCallback((conversationId: string, value: string) => {
    setConversations(previous => {
      const conversation = previous[conversationId];
      if (!conversation || conversation.draft === value) return previous;
      const next = {
        ...previous,
        [conversationId]: {
          ...conversation,
          draft: value,
          draftUpdatedAt: Date.now(),
        },
      };
      conversationsRef.current = next;
      return next;
    });
  }, []);

  const setCurrentDraft = useCallback((value: string) => {
    inputRef.current = value;
    setInput(value);
    setConversationDraft(currentConversationIdRef.current, value);
  }, [setConversationDraft]);

  const setComposerAttachmentsForConversation = useCallback((
    conversationId: string,
    attachments: ChatAttachment[],
  ) => {
    setComposerAttachments(previous => {
      const next = { ...previous };
      if (attachments.length) next[conversationId] = attachments;
      else delete next[conversationId];
      composerAttachmentsRef.current = next;
      return next;
    });
  }, []);

  /** Removes only the handles sent by this turn; later additions must survive. */
  const clearSentAttachments = useCallback((conversationId: string, sent: readonly MessageAttachment[]) => {
    if (!sent.length) return;
    const sentIds = new Set(sent.map(attachment => attachment.id));
    setComposerAttachments(previous => {
      const remaining = (previous[conversationId] ?? []).filter(attachment => !sentIds.has(attachment.id));
      const next = { ...previous };
      if (remaining.length) next[conversationId] = remaining;
      else delete next[conversationId];
      composerAttachmentsRef.current = next;
      return next;
    });
  }, []);

  const deleteComposerAttachment = useCallback(async (
    conversationId: string,
    attachment: ChatAttachment,
  ) => {
    try {
      await ChatAPI.deleteChatAttachment(attachment.id);
    } catch (error) {
      // A second tab may have removed the same unlinked upload already.
      if (!(error instanceof APIError) || error.code !== 'not_found') throw error;
    }
    // A cancelled CAPTCHA or failed send may already have written the pending
    // user row. Remove the now-invalid handle so its Retry action cannot send a
    // file the server has deliberately deleted. Avoid touching updatedAt when
    // there is no failed row to repair; removing an unsent chip is not a chat
    // edit and must not trigger a cloud-history revision.
    const failedRowUsesAttachment = conversationsRef.current[conversationId]?.messages.some(message => (
      message.role === 'user'
      && message.status === 'failed'
      && message.attachments?.some(item => item.id === attachment.id)
    ));
    if (failedRowUsesAttachment) {
      updateConversationById(conversationId, conversation => ({
        messages: conversation.messages.map(message => (
          message.role === 'user' && message.status === 'failed' && message.attachments?.some(item => item.id === attachment.id)
            ? { ...message, attachments: message.attachments.filter(item => item.id !== attachment.id) }
            : message
        )),
      }));
    }
  }, [updateConversationById]);

  const recordCloudSave = useCallback((saved: SavedConversation, syncedLocalUpdatedAt: number) => {
    setConversations(previous => {
      const current = previous[saved.id];
      if (!current) return previous;
      const next = {
        ...previous,
        [saved.id]: {
          ...current,
          cloudRevision: saved.revision,
          cloudUpdatedAt: saved.updated_at,
          cloudSyncedLocalUpdatedAt: syncedLocalUpdatedAt,
        },
      };
      conversationsRef.current = next;
      return next;
    });
  }, []);

  const applyCloudWinner = useCallback((saved: SavedConversation) => {
    setConversations(previous => {
      const local = previous[saved.id];
      const winner = !local || saved.updated_at >= local.updatedAt
        ? savedConversationToLocal(saved, local)
        : {
          ...local,
          cloudRevision: saved.revision,
          cloudUpdatedAt: saved.updated_at,
        };
      const next = enforceCapAndQueueDeletion({ ...previous, [saved.id]: winner }, currentConversationIdRef.current);
      conversationsRef.current = next;
      return next;
    });
  }, [enforceCapAndQueueDeletion]);

  /**
   * A record that once had a cloud revision but is absent from a complete
   * account snapshot was deleted elsewhere. Tombstone it locally so another
   * tab cannot merge the stale copy back. Conversations that have never had a
   * cloud revision are intentionally left alone: they are genuinely local and
   * still need their first upload.
   */
  const removeRemotelyDeletedConversation = useCallback((
    conversationId: string,
    announce = true,
    authoritative = false,
  ): boolean => {
    const deleted = conversationsRef.current[conversationId];
    if (!deleted || (!authoritative && deleted.cloudRevision === undefined)) return false;

    const deletedAt = Math.max(
      Date.now(),
      (pendingDeletionsRef.current[conversationId] ?? 0) + 1,
    );
    tombstonesRef.current = { ...tombstonesRef.current, [conversationId]: deletedAt };
    const pending = { ...pendingDeletionsRef.current };
    delete pending[conversationId];
    pendingDeletionsRef.current = pending;
    delete pendingDeletionRetryAtRef.current[conversationId];

    const next: ConversationMap = { ...conversationsRef.current };
    delete next[conversationId];
    let selectedId = currentConversationIdRef.current;
    if (!next[selectedId]) {
      selectedId = Object.values(next)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? generateConversationId();
      if (!next[selectedId]) next[selectedId] = createNewConversation(selectedId, welcomeMessage);
      currentConversationIdRef.current = selectedId;
      requestedConversationIdRef.current = selectedId;
      const selectedDraft = next[selectedId]?.draft ?? '';
      inputRef.current = selectedDraft;
      setCurrentConversationId(selectedId);
      setInput(selectedDraft);
      setShowExamples((next[selectedId]?.messages.length ?? 0) <= 1);
      writeConversationUrl(selectedId, 'replace');
    }

    conversationsRef.current = next;
    setConversations(next);
    setComposerAttachments(previous => {
      if (!previous[conversationId]) return previous;
      const remaining = { ...previous };
      delete remaining[conversationId];
      composerAttachmentsRef.current = remaining;
      return remaining;
    });
    if (announce) setAnnouncement('A chat deleted from your account on another device was removed here too.');
    return true;
  }, [welcomeMessage]);

  const syncConversationToCloud = useCallback(async (
    conversationId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const snapshot = conversationsRef.current[conversationId];
    if (!snapshot || !cloudSyncable(snapshot) || isGuest) return true;
    if (cloudSyncPausedRef.current || signal.aborted) return false;
    setCloudStatus('saving');
    setCloudError('');

    const upsert = (conversation: Conversation, revision: number) => ChatAPI.upsertSavedConversation({
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages,
      created_at: conversation.createdAt,
    }, revision, { signal });

    try {
      const result = await upsert(snapshot, snapshot.cloudRevision ?? 0);
      if (cloudSyncPausedRef.current || signal.aborted) return false;
      recordCloudSave(result.conversation, snapshot.updatedAt);
      return true;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return false;
      if (error instanceof APIError && error.code === 'conversation_deleted') {
        // The server's owner-scoped deletion guard is authoritative even for a
        // stale device copy that lost its last known cloud revision metadata.
        removeRemotelyDeletedConversation(conversationId, true, true);
        return true;
      }
      if (error instanceof APIError && error.code === 'revision_conflict') {
        try {
          const { conversation: remote } = await ChatAPI.getSavedConversation(conversationId, { signal });
          if (cloudSyncPausedRef.current || signal.aborted) return false;
          const latestLocal = conversationsRef.current[conversationId];
          if (!latestLocal || remote.updated_at >= latestLocal.updatedAt) {
            applyCloudWinner(remote);
            return true;
          }
          const retried = await upsert(latestLocal, remote.revision);
          if (cloudSyncPausedRef.current || signal.aborted) return false;
          recordCloudSave(retried.conversation, latestLocal.updatedAt);
          return true;
        } catch (conflictError) {
          if (conflictError instanceof APIError && conflictError.code === 'not_found') {
            // The conflict proved a cloud record existed; a following 404 is a
            // concurrent deletion, not permission to recreate that record.
            if (removeRemotelyDeletedConversation(conversationId, true, true)) return true;
          }
        }
      }
      setCloudStatus('error');
      setCloudError('Changes are safe on this device. Cloud history will retry after the next edit or reload.');
      return false;
    }
  }, [applyCloudWinner, isGuest, recordCloudSave, removeRemotelyDeletedConversation]);

  const deleteCloudConversation = useCallback(async (conversation: Conversation) => {
    if (isGuest || !conversation.cloudRevision) return;
    const controller = cloudSyncAbortRef.current?.signal.aborted === false
      ? cloudSyncAbortRef.current
      : new AbortController();
    cloudSyncAbortRef.current = controller;
    try {
      await ChatAPI.deleteSavedConversation(conversation.id, conversation.cloudRevision, { signal: controller.signal });
    } catch (error) {
      if (error instanceof APIError && error.code === 'not_found') return;
      if (error instanceof APIError && error.code === 'revision_conflict') {
        try {
          const { conversation: remote } = await ChatAPI.getSavedConversation(conversation.id, { signal: controller.signal });
          await ChatAPI.deleteSavedConversation(conversation.id, remote.revision, { signal: controller.signal });
          return;
        } catch { /* retry from the tombstone during the next bootstrap */ }
      }
      setCloudStatus('error');
      setCloudError('The chat was removed here. Cloud deletion will retry when history reloads.');
    }
  }, [isGuest]);

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
    reportChatLifecycle('chat_stopped', {
      eventId: turn.turnId,
      durationMs: Date.now() - turn.startedAt,
      outcome: persistPartial ? 'user' : 'discarded',
    });
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
            turnId: turn.turnId,
            activities: turn.activities,
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
    setSpeakingMessageId(null);
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
    setConversations(previous => {
      const next = enforceCapAndQueueDeletion({ ...previous, [id]: conversation }, id);
      conversationsRef.current = next;
      return next;
    });
    currentConversationIdRef.current = id;
    setCurrentConversationId(id);
    inputRef.current = '';
    setInput('');
    setErrorMessage('');
    setSpeakingMessageId(null);
    setShowExamples(true);
    setAutoFollow(true);
    writeConversationUrl(id, 'push');
  }, [enforceCapAndQueueDeletion, welcomeMessage]);

  const handleNewConversation = useCallback(() => {
    stopListening();
    abortActiveTurn(true);
    cancelPendingCaptcha(true);
    createAndSelectConversation();
    reportClientEvent('conversation_created', { outcome: 'new' });
  }, [abortActiveTurn, cancelPendingCaptcha, createAndSelectConversation, stopListening]);

  const handleSelectConversation = useCallback((conversationId: string, updateUrl = true) => {
    if (conversationId === currentConversationIdRef.current) {
      setDrawerOpen(false);
      if (updateUrl) writeConversationUrl(conversationId, 'replace');
      return;
    }
    stopListening();
    abortActiveTurn(true);
    cancelPendingCaptcha(true);
    AudioService.stop();
    setSpeakingMessageId(null);
    currentConversationIdRef.current = conversationId;
    setCurrentConversationId(conversationId);
    const selected = conversationsRef.current[conversationId];
    setAnnouncement(`${selected?.title ?? 'Conversation'} selected. ${selected?.messages.length ?? 0} messages.`);
    const selectedDraft = selected?.draft ?? '';
    inputRef.current = selectedDraft;
    setInput(selectedDraft);
    setErrorMessage('');
    setDrawerOpen(false);
    setShowExamples(false);
    setAutoFollow(true);
    if (updateUrl) writeConversationUrl(conversationId, 'push');
    reportClientEvent('conversation_opened', {
      outcome: updateUrl ? 'history' : 'navigation',
      value: selected?.messages.length,
    });
  }, [abortActiveTurn, cancelPendingCaptcha, stopListening]);

  const retryPendingDeletions = useCallback(() => {
    for (const conversationId of Object.keys(pendingDeletionsRef.current)) {
      if ((pendingDeletionRetryAtRef.current[conversationId] ?? 0) > Date.now()) continue;
      void ChatAPI.deleteConversation(conversationId).then(() => {
        tombstonesRef.current = {
          ...tombstonesRef.current,
          [conversationId]: Math.max(
            Date.now(),
            (pendingDeletionsRef.current[conversationId] ?? 0) + 1,
          ),
        };
        const next = { ...pendingDeletionsRef.current };
        delete next[conversationId];
        pendingDeletionsRef.current = next;
        delete pendingDeletionRetryAtRef.current[conversationId];
        persistStore();
      }).catch((error: unknown) => {
        if (error instanceof APIError && error.retryAfterMs !== undefined) {
          pendingDeletionRetryAtRef.current[conversationId] = Date.now() + error.retryAfterMs;
        }
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
    const deletedConversation = conversationsRef.current[conversationId];
    if (deletedConversation) void deleteCloudConversation(deletedConversation);
    const pendingAttachments = composerAttachmentsRef.current[conversationId] ?? [];
    if (pendingAttachments.length) {
      setComposerAttachments(previous => {
        const next = { ...previous };
        delete next[conversationId];
        composerAttachmentsRef.current = next;
        return next;
      });
      for (const attachment of pendingAttachments) {
        void ChatAPI.deleteChatAttachment(attachment.id).catch(() => {
          // Support-linked handles remain owned by their case; every other
          // failed cleanup is still covered by server expiry/pruning.
        });
      }
    }
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
      tombstonesRef.current = {
        ...tombstonesRef.current,
        [conversationId]: Math.max(
          Date.now(),
          (pendingDeletionsRef.current[conversationId] ?? 0) + 1,
        ),
      };
      const next = { ...pendingDeletionsRef.current };
      delete next[conversationId];
      pendingDeletionsRef.current = next;
      delete pendingDeletionRetryAtRef.current[conversationId];
      persistStore();
    }).catch(error => {
      if (error instanceof APIError && error.retryAfterMs !== undefined) {
        pendingDeletionRetryAtRef.current[conversationId] = Date.now() + error.retryAfterMs;
      }
      console.error('Failed to delete server conversation; will retry:', error);
    });
    if (conversationId === currentConversationIdRef.current) createAndSelectConversation();
  }, [abortActiveTurn, cancelPendingCaptcha, createAndSelectConversation, deleteCloudConversation, persistStore]);

  const requestRenameConversation = useCallback((conversationId: string) => {
    const conversation = conversationsRef.current[conversationId];
    if (!conversation) return;
    setRenameConversationId(conversationId);
    setRenameTitle(conversation.title);
  }, []);

  const confirmRenameConversation = useCallback(() => {
    if (!renameConversationId) return;
    const title = renameTitle.trim().slice(0, 80);
    if (!title) return;
    setConversations(previous => {
      const conversation = previous[renameConversationId];
      if (!conversation || conversation.title === title) return previous;
      const next = {
        ...previous,
        [renameConversationId]: { ...conversation, title, updatedAt: Date.now() },
      };
      conversationsRef.current = next;
      return next;
    });
    setAnnouncement(`Conversation renamed to ${title}.`);
    setRenameConversationId(null);
    reportClientEvent('conversation_renamed', { outcome: 'manual' });
  }, [renameConversationId, renameTitle]);

  const requestDeleteConversation = useCallback((conversationId: string) => {
    if (conversationsRef.current[conversationId]) setDeleteConversationId(conversationId);
  }, []);

  const confirmDeleteConversation = useCallback(() => {
    if (!deleteConversationId) return;
    handleDeleteConversation(deleteConversationId);
    setDeleteConversationId(null);
    setAnnouncement('Conversation deleted.');
    reportClientEvent('conversation_deleted', { outcome: 'single' });
  }, [deleteConversationId, handleDeleteConversation]);

  const quiesceCloudSync = useCallback(() => {
    cloudSyncPausedRef.current = true;
    setCloudSyncPaused(true);
    setCloudReady(false);
    cloudBootstrapAbortRef.current?.abort();
    cloudBootstrapAbortRef.current = null;
    cloudSyncAbortRef.current?.abort();
    cloudSyncAbortRef.current = null;
    cloudSyncLoopRef.current = false;
    if (cloudSyncTimerRef.current !== null) {
      window.clearTimeout(cloudSyncTimerRef.current);
      cloudSyncTimerRef.current = null;
    }
  }, []);

  const resumeCloudSync = useCallback(() => {
    cloudSyncPausedRef.current = false;
    setCloudReady(false);
    setCloudStatus(isOnlineRef.current ? 'loading' : 'offline');
    setCloudSyncPaused(false);
  }, []);

  /**
   * The account-data dialog invokes this only after the server has atomically
   * deleted the member-owned chat product records. Replace the browser store
   * with one empty conversation and tombstone every prior id so another open
   * tab cannot merge deleted history back into this one.
   */
  const handleDeleteAllSavedDataSucceeded = useCallback(async () => {
    stopListening();
    abortActiveTurn(false);
    cancelPendingCaptcha(false);
    AudioService.stop();

    // Defense in depth: the dialog already quiesces before the server request,
    // but keep the guard asserted throughout the irreversible local reset.
    quiesceCloudSync();

    const keys = storageKeys(userId);
    let diskStore: ReturnType<typeof parseStore>;
    try {
      diskStore = parseStore(localStorage.getItem(keys.store));
    } catch {
      throw new Error('Browser storage could not be cleared.');
    }
    const deletedAt = Date.now();
    const tombstones = { ...tombstonesRef.current };
    const knownConversationIds = new Set([
      ...Object.keys(conversationsRef.current),
      ...Object.keys(diskStore?.conversations ?? {}),
      ...Object.keys(pendingDeletionsRef.current),
      ...Object.keys(diskStore?.pendingServerDeletions ?? {}),
    ]);
    for (const conversationId of knownConversationIds) {
      const pendingAt = Math.max(
        pendingDeletionsRef.current[conversationId] ?? 0,
        diskStore?.pendingServerDeletions[conversationId] ?? 0,
      );
      tombstones[conversationId] = Math.max(
        deletedAt,
        pendingAt + 1,
      );
    }

    const conversationId = generateConversationId();
    const freshConversation = createNewConversation(conversationId, welcomeMessage);
    const nextConversations: ConversationMap = { [conversationId]: freshConversation };

    tombstonesRef.current = tombstones;
    // Product deletion is confirmed. Do not turn it into hidden immediate
    // provider deletion calls: provider mappings retain their documented,
    // separate 30-day cleanup lifecycle.
    pendingDeletionsRef.current = {};
    pendingDeletionRetryAtRef.current = {};
    conversationsRef.current = nextConversations;
    currentConversationIdRef.current = conversationId;
    requestedConversationIdRef.current = conversationId;
    inputRef.current = '';
    composerAttachmentsRef.current = {};
    attachmentBusyRef.current = false;

    setConversations(nextConversations);
    setCurrentConversationId(conversationId);
    setInput('');
    setComposerAttachments({});
    setAttachmentBusy(false);
    setFeedbackByMessage({});
    setFeedbackPending({});
    setStreamingState(null);
    setActiveRequestId(null);
    setActivities([]);
    setCompletedTrail(null);
    setSpeakingMessageId(null);
    setRenameConversationId(null);
    setDeleteConversationId(null);
    setSupportCasesOpen(false);
    setShareLinksOpen(false);
    setPreferencesOpen(false);
    setDrawerOpen(false);
    setChatMenuAnchor(null);
    setErrorMessage('');
    setShowExamples(true);
    setAutoFollow(true);
    setCloudError('');
    writeConversationUrl(conversationId, 'replace');

    // Persist the tombstoned empty replacement synchronously. This both clears
    // the current browser and broadcasts the deletion to other open tabs.
    const result = saveStore(userId, {
      version: 4,
      conversations: nextConversations,
      tombstones,
      pendingServerDeletions: {},
    }, conversationId);
    try {
      localStorage.removeItem(keys.legacyStoreV3);
      localStorage.removeItem(keys.legacyCurrentV3);
      localStorage.removeItem(keys.legacyConversations);
      localStorage.removeItem(keys.legacyCurrent);
      localStorage.removeItem(cloudBootstrapStorageKey(userId));
    } catch {
      throw new Error('Browser storage could not be cleared.');
    }
    if (!result.persisted) {
      throw new Error('Browser storage could not be cleared.');
    }

    setAnnouncement('Saved AI chat data was deleted. A new empty chat is ready.');
  }, [abortActiveTurn, cancelPendingCaptcha, quiesceCloudSync, stopListening, userId, welcomeMessage]);

  /**
   * Member bootstrap: hydrate the newest cloud records, resolve each local/cloud
   * pair by its content clock, and upload pre-existing local history once.
   */
  useEffect(() => {
    if (isGuest || cloudSyncPaused) return;
    const controller = new AbortController();
    cloudBootstrapAbortRef.current?.abort();
    cloudBootstrapAbortRef.current = controller;
    let active = true;

    void (async () => {
      setCloudStatus(isOnlineRef.current ? 'loading' : 'offline');
      if (!isOnlineRef.current) {
        setCloudReady(true);
        return;
      }
      try {
        const summaries: Awaited<ReturnType<typeof ChatAPI.listSavedConversations>>['conversations'] = [];
        let cursor: string | undefined;
        do {
          const page = await ChatAPI.listSavedConversations({
            limit: Math.min(50, MAX_CLOUD_CONVERSATIONS - summaries.length),
            ...(cursor ? { cursor } : {}),
            signal: controller.signal,
          });
          summaries.push(...page.conversations);
          cursor = page.next_cursor ?? undefined;
        } while (cursor && summaries.length < MAX_CLOUD_CONVERSATIONS);

        // Only infer remote deletion from a complete inventory. A local chat
        // with no cloud revision is an unsynced device record and must survive.
        if (!cursor) {
          const serverIds = new Set(summaries.map(summary => summary.id));
          for (const local of Object.values(conversationsRef.current)) {
            if (local.cloudRevision !== undefined && !serverIds.has(local.id)) {
              removeRemotelyDeletedConversation(local.id, false);
            }
          }
        }

        const tombstoned = summaries.filter(summary => tombstonesRef.current[summary.id] !== undefined);
        const tombstoneResults = await settleInBatches(tombstoned.map(summary => async () => {
          try {
            await ChatAPI.deleteSavedConversation(summary.id, summary.revision, { signal: controller.signal });
          } catch (error) {
            if (error instanceof APIError && error.code === 'not_found') return;
            if (!(error instanceof APIError) || error.code !== 'revision_conflict') throw error;
            try {
              const latest = await ChatAPI.getSavedConversation(summary.id, { signal: controller.signal });
              await ChatAPI.deleteSavedConversation(summary.id, latest.conversation.revision, { signal: controller.signal });
            } catch (conflictError) {
              if (conflictError instanceof APIError && conflictError.code === 'not_found') return;
              throw conflictError;
            }
          }
        }));
        const tombstoneDeleteFailed = tombstoneResults.some(result => result.status === 'rejected');

        const visibleSummaries = summaries.filter(summary => tombstonesRef.current[summary.id] === undefined);
        const settled = await settleInBatches(
          visibleSummaries.map(summary => () => ChatAPI.getSavedConversation(summary.id, { signal: controller.signal }))
        );
        settled.forEach((result, index) => {
          if (
            result.status === 'rejected'
            && result.reason instanceof APIError
            && result.reason.code === 'not_found'
          ) {
            removeRemotelyDeletedConversation(visibleSummaries[index]!.id, false);
          }
        });
        const detailReadFailed = settled.some(result => result.status === 'rejected'
          && (!(result.reason instanceof APIError) || result.reason.code !== 'not_found'));
        const saved = settled.flatMap(result => result.status === 'fulfilled' ? [result.value.conversation] : []);
        const requestedId = requestedConversationIdRef.current;
        if (
          requestedId
          && tombstonesRef.current[requestedId] === undefined
          && !summaries.some(summary => summary.id === requestedId)
        ) {
          try {
            const requested = await ChatAPI.getSavedConversation(requestedId, { signal: controller.signal });
            saved.push(requested.conversation);
          } catch (error) {
            if (!(error instanceof APIError) || error.code !== 'not_found') throw error;
          }
        }
        if (!active || controller.signal.aborted) return;

        let merged = { ...conversationsRef.current };
        if (initialChatState.createdFallback && saved.length && !cloudSyncable(merged[initialChatState.currentId])) {
          delete merged[initialChatState.currentId];
        }
        for (const remote of saved) {
          const local = merged[remote.id];
          merged[remote.id] = !local || remote.updated_at >= local.updatedAt
            ? savedConversationToLocal(remote, local)
            : {
              ...local,
              cloudRevision: remote.revision,
              cloudUpdatedAt: remote.updated_at,
            };
        }

        const newestCloudId = saved
          .slice()
          .sort((left, right) => right.updated_at - left.updated_at)[0]?.id;
        const selectedId = requestedId && merged[requestedId]
          ? requestedId
          : initialChatState.createdFallback && newestCloudId
            ? newestCloudId
            : merged[currentConversationIdRef.current]
              ? currentConversationIdRef.current
              : Object.keys(merged)[0];
        if (!selectedId) throw new Error('Cloud history returned no selectable conversation');
        merged = enforceCapAndQueueDeletion(merged, selectedId);
        conversationsRef.current = merged;
        setConversations(merged);
        currentConversationIdRef.current = selectedId;
        setCurrentConversationId(selectedId);
        const selectedDraft = merged[selectedId]?.draft ?? '';
        inputRef.current = selectedDraft;
        setInput(selectedDraft);
        setShowExamples((merged[selectedId]?.messages.length ?? 0) <= 1);
        writeConversationUrl(selectedId, 'replace');

        let bootstrapSucceeded = !tombstoneDeleteFailed && !detailReadFailed;
        let alreadyUploaded = false;
        try { alreadyUploaded = localStorage.getItem(cloudBootstrapStorageKey(userId)) === 'complete'; } catch { /* optional */ }
        if (!alreadyUploaded) {
          const uploadIds = Object.values(merged)
            .filter(conversation => cloudSyncable(conversation)
              && conversation.cloudSyncedLocalUpdatedAt !== conversation.updatedAt)
            .map(conversation => conversation.id);
          for (const conversationId of uploadIds) {
            if (!await syncConversationToCloud(conversationId, controller.signal)) bootstrapSucceeded = false;
          }
          if (bootstrapSucceeded) {
            try { localStorage.setItem(cloudBootstrapStorageKey(userId), 'complete'); } catch { /* optional */ }
          }
        }
        if (!active || controller.signal.aborted) return;
        setCloudReady(true);
        setCloudStatus(bootstrapSucceeded ? 'synced' : 'error');
        if (!bootstrapSucceeded) {
          setCloudError(previous => previous || (detailReadFailed
            ? 'Some account history could not be loaded. Local chats remain available; reload to retry.'
            : 'A cloud deletion is still pending. It will retry when history reloads.'));
        }
      } catch (error) {
        if (!active || controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setCloudReady(true);
        setCloudStatus('error');
        setCloudError(error instanceof APIError && error.code === 'csrf_unavailable'
          ? 'Cloud history needs a fresh secure page token. Reload this page to resume syncing.'
          : 'Cloud history is unavailable. Chats remain safe on this device.');
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (cloudBootstrapAbortRef.current === controller) cloudBootstrapAbortRef.current = null;
    };
  }, [cloudSyncPaused, enforceCapAndQueueDeletion, initialChatState.createdFallback, initialChatState.currentId, isGuest, isOnline, removeRemotelyDeletedConversation, syncConversationToCloud, userId]);

  const cloudDirtySignature = useMemo(() => Object.values(conversations)
    .filter(conversation => !isGuest
      && cloudSyncable(conversation)
      && conversation.cloudSyncedLocalUpdatedAt !== conversation.updatedAt)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(conversation => `${conversation.id}:${conversation.updatedAt}:${conversation.cloudRevision ?? 0}`)
    .join('|'), [conversations, isGuest]);

  useEffect(() => {
    if (isGuest || cloudSyncPausedRef.current || !cloudReady || !isOnline || isLoading || !cloudDirtySignature || cloudSyncLoopRef.current) return;
    if (cloudSyncTimerRef.current !== null) window.clearTimeout(cloudSyncTimerRef.current);
    cloudSyncTimerRef.current = window.setTimeout(() => {
      cloudSyncTimerRef.current = null;
      if (cloudSyncPausedRef.current || cloudSyncLoopRef.current) return;
      cloudSyncLoopRef.current = true;
      const controller = cloudSyncAbortRef.current?.signal.aborted === false
        ? cloudSyncAbortRef.current
        : new AbortController();
      cloudSyncAbortRef.current = controller;
      const dirtyIds = Object.values(conversationsRef.current)
        .filter(conversation => cloudSyncable(conversation)
          && conversation.cloudSyncedLocalUpdatedAt !== conversation.updatedAt)
        .map(conversation => conversation.id);
      void (async () => {
        let success = true;
        for (const conversationId of dirtyIds) {
          if (!await syncConversationToCloud(conversationId, controller.signal)) success = false;
        }
        cloudSyncLoopRef.current = false;
        if (!controller.signal.aborted) {
          setCloudStatus(success ? 'synced' : 'error');
          if (success) setCloudSyncGeneration(value => value + 1);
        }
      })();
    }, CLOUD_SYNC_DEBOUNCE_MS);
    return () => {
      if (cloudSyncTimerRef.current !== null) {
        window.clearTimeout(cloudSyncTimerRef.current);
        cloudSyncTimerRef.current = null;
      }
    };
  }, [cloudDirtySignature, cloudReady, cloudSyncGeneration, cloudSyncPaused, isGuest, isLoading, isOnline, syncConversationToCloud]);

  useEffect(() => () => {
    if (cloudSyncTimerRef.current !== null) window.clearTimeout(cloudSyncTimerRef.current);
    cloudBootstrapAbortRef.current?.abort();
    cloudSyncAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (isGuest) writeConversationUrl(currentConversationIdRef.current, 'replace');
    const handlePopState = () => {
      const conversationId = safeConversationQuery();
      if (!conversationId || conversationId === currentConversationIdRef.current) return;
      if (conversationsRef.current[conversationId]) {
        handleSelectConversation(conversationId, false);
      } else {
        setErrorMessage('That chat is not available in this history.');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [handleSelectConversation, isGuest]);

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
      // Merge against the LATEST state, not the passive ref, so a just-enqueued
      // in-flight update (e.g. a completed AI reply) is not clobbered. The
      // canonical no-op write guard lets this merged state be persisted safely
      // without reviving the old cross-tab ping-pong.
      setConversations(previous => {
        const merged = mergeStores({
          version: 4,
          conversations: previous,
          tombstones: tombstonesRef.current,
          pendingServerDeletions: pendingDeletionsRef.current,
        }, remote);
        tombstonesRef.current = merged.tombstones;
        pendingDeletionsRef.current = merged.pendingServerDeletions;
        return enforceCapAndQueueDeletion(merged.conversations, currentConversationIdRef.current);
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
  }, [abortActiveTurn, createAndSelectConversation, enforceCapAndQueueDeletion, userId]);

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
      if (error.code === 'identity_required' || error.code === 'identity_changed' || error.status === 428) {
        return 'Your session is being rechecked. Retry after verification completes.';
      }
      if (error.code === 'conversation_busy') {
        const wait = error.retryAfterMs === undefined ? '' : ` Try again in ${Math.max(1, Math.ceil(error.retryAfterMs / 1_000))} seconds.`;
        return `This conversation is still finishing another operation.${wait}`;
      }
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
    inputRef.current = '';
    setInput('');
    setConversationDraft(conversationId, '');
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
  }, [isGuest, setConversationDraft, updateConversationById]);

  /** Transactionally resets the current conversation after the server confirms. */
  const handleClearCommand = useCallback(async (conversationId: string) => {
    inputRef.current = '';
    setInput('');
    setConversationDraft(conversationId, '');
    setIsClearing(true);
    setErrorMessage('');
    try {
      await ChatAPI.clearConversation(conversationId);
      updateConversationById(conversationId, () => ({
        title: 'New Chat',
        messages: [createWelcomeMessage(welcomeMessage)],
        draft: '',
        draftUpdatedAt: Date.now(),
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
  }, [setConversationDraft, updateConversationById, welcomeMessage]);

  /**
   * Runs one chat turn transactionally: nothing is mutated until validation
   * passes, and branch operations (edit/regenerate/retry) restore the
   * original messages when the turn fails without a usable result.
   */
  const runTurn = useCallback(async (params: TurnParams) => {
    const content = params.content.trim();
    if (!content || activeTurnRef.current || isClearingRef.current) return;
    if (!isOnlineRef.current) {
      setErrorMessage('You are offline. Your draft is saved and can be sent after you reconnect.');
      return;
    }
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
    const turnAttachments = params.attachments ?? [];
    const resetConversation = Boolean(params.forceReset || existingConversation.needsServerResync);
    // NOTE: history is uploaded on every turn but chat.php only consumes it
    // when it has no conversation record yet (chat.php:1242). Gating it on
    // `resetConversation` alone is NOT safe: when the server has silently lost
    // its record, that is exactly the turn that must re-seed, and the client
    // cannot tell. Skipping it needs a server-side `history_required` signal.
    const history = baseMessages.some(message => message.role === 'user')
      ? serializeConversationHistory(baseMessages).slice(-HISTORY_CONTEXT_ITEMS)
      : [];

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
      ...(turnAttachments.length ? {
        attachments: turnAttachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      } : {}),
    };
    const isFirstQuestion = !baseMessages.some(message => message.role === 'user');
    setConversations(previous => {
      const conversation = previous[conversationId] || existingConversation;
      return enforceCapAndQueueDeletion({
        ...previous,
        [conversationId]: {
          ...conversation,
          title: isFirstQuestion
            ? `${content.slice(0, 50)}${content.length > 50 ? '…' : ''}`
            : conversation.title,
          messages: [...baseMessages, userMessage],
          draft: '',
          draftUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      }, conversationId);
    });
    if (params.kind === 'send') {
      inputRef.current = '';
      setInput('');
    }

    const requestId = messageId('_request');
    const controller = new AbortController();
    const turn: ActiveTurn = {
      requestId,
      turnId: generateTurnId(),
      conversationId,
      controller,
      userMessageId: userMessage.id,
      partialText: '',
      annotations: [],
      activities: [],
      startedAt: Date.now(),
      firstTokenReported: false,
      rollbackMessages: params.rollbackMessages,
      rollbackTitle: params.rollbackTitle,
    };
    activeTurnRef.current = turn;
    reportChatLifecycle('chat_send_started', {
      eventId: turn.turnId,
      outcome: params.kind,
      value: turnAttachments.length,
    });
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
        attachmentIds: turnAttachments.map(attachment => attachment.id),
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
          if (!active.firstTokenReported && partialText.length > 0) {
            active.firstTokenReported = true;
            reportChatLifecycle('chat_first_token', {
              eventId: active.turnId,
              durationMs: Date.now() - active.startedAt,
              outcome: params.kind,
            });
          }
          active.partialText = partialText;
          active.annotations = annotations;
          // Coalesce chunk updates to animation frames; per-chunk renders
          // jank long streams.
          scheduleStreamingUpdate();
        },
      });

      let result: StreamingResponse;
      try {
        result = await send(turn.turnId);
      } catch (error) {
        // Retry once, but only when the failure is transient AND nothing was
        // consumed: with no output delivered the server has not committed a
        // turn, so a second attempt cannot duplicate or interleave an answer.
        const retryDelayMs = automaticRetryDelayMs(error);
        if (retryDelayMs === null || controller.signal.aborted) throw error;
        const active = activeTurnRef.current;
        if (!active || active.requestId !== requestId) throw error;
        await sleep(retryDelayMs);
        if (activeTurnRef.current?.requestId !== requestId || controller.signal.aborted) throw error;
        result = await send(turn.turnId);
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
      if (!turn.firstTokenReported) {
        turn.firstTokenReported = true;
        reportChatLifecycle('chat_first_token', {
          eventId: turn.turnId,
          durationMs: Date.now() - turn.startedAt,
          outcome: params.kind,
        });
      }
      const answerId = messageId('_ai');
      const steps = activeTurnRef.current?.activities ?? [];
      updateConversationById(conversationId, conversation => ({
        messages: [...conversation.messages, {
          id: answerId,
          role: 'ai' as const,
          rawContent: result.text,
          timestamp: Date.now(),
          status: 'complete' as const,
          annotations: result.annotations,
          responseId: result.responseId,
          turnId: turn.turnId,
          activities: steps,
        }],
        needsServerResync: false,
      }));
      setAnnouncement(assistantCompletionAnnouncement(result.text));
      clearSentAttachments(conversationId, turnAttachments);
      // Hand the steps to the answer before clearActiveTurn drops them, so the
      // trail does not blink out at the moment the answer lands.
      setCompletedTrail(steps.length
        ? { messageId: answerId, activities: steps, durationMs: Date.now() - turn.startedAt }
        : null);
      reportChatLifecycle('chat_completed', {
        eventId: turn.turnId,
        durationMs: Date.now() - turn.startedAt,
        outcome: params.kind,
      });
      clearActiveTurn(requestId);
      setUsageRefresh(value => value + 1);
      if (ENV.ENABLE_VOICE && !mutedRef.current) {
        setSpeakingMessageId(answerId);
        void AudioService.playTTS(result.text)
          .catch(error => console.error('TTS playback failed:', error))
          .finally(() => setSpeakingMessageId(current => current === answerId ? null : current));
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
        if (params.kind === 'send') {
          inputRef.current = content;
          setInput(content);
          setConversationDraft(conversationId, content);
        }
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
              turnId: turn.turnId,
              activities: active.activities,
            }],
          }));
        }
        reportChatLifecycle('chat_stopped', {
          eventId: turn.turnId,
          durationMs: Date.now() - turn.startedAt,
          outcome: 'transport',
        });
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
            turnId: turn.turnId,
            activities: active.activities,
          }],
        }));
      } else {
        updateMessage(conversationId, userMessage.id, { status: 'failed' });
      }
      reportChatLifecycle('chat_failed', {
        eventId: turn.turnId,
        durationMs: Date.now() - turn.startedAt,
        errorCode: telemetryErrorCode(error),
        outcome: params.kind,
      });
      clearActiveTurn(requestId);
      setErrorMessage(getErrorText(error));
      setUsageRefresh(value => value + 1);
    }
  }, [
    clearActiveTurn,
    clearSentAttachments,
    enforceCapAndQueueDeletion,
    getErrorText,
    handleClearCommand,
    handleUsageCommand,
    setConversationDraft,
    stopListening,
    updateConversationById,
    updateMessage,
    welcomeMessage,
  ]);

  useEffect(() => { runTurnRef.current = runTurn; }, [runTurn]);

  const handleSendMessage = useCallback(async (messageContent: string | null = null) => {
    if (attachmentBusyRef.current) {
      setErrorMessage('Wait for the current file upload to finish before sending.');
      return;
    }
    const content = messageContent === null ? inputRef.current : messageContent;
    const conversationId = currentConversationIdRef.current;
    await runTurn({
      conversationId,
      content,
      kind: 'send',
      attachments: (composerAttachmentsRef.current[conversationId] ?? []).map(
        ({ id, name, mime, size }) => ({ id, name, mime, size }),
      ),
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
    if (attachmentBusyRef.current) {
      setErrorMessage('Wait for the current file upload to finish before changing this branch.');
      return null;
    }
    if (pendingCaptchaRef.current) {
      setErrorMessage('Complete the security check before sending another message.');
      return null;
    }
    return conversationsRef.current[currentConversationIdRef.current] ?? null;
  }, []);

  const handleBranchConversation = useCallback(() => {
    const source = branchGuard();
    if (!source) return;
    const id = generateConversationId();
    const now = Date.now();
    const branched: Conversation = {
      ...source,
      id,
      title: `Branch of ${source.title}`.slice(0, 80),
      messages: source.messages.map(message => {
        const copy = {
          ...message,
          ...(message.annotations ? { annotations: message.annotations.map(annotation => ({ ...annotation })) } : {}),
        };
        // Attachment handles are conversation-bound server capabilities. A
        // branched transcript keeps the visible text but cannot inherit those
        // handles as if they belonged to the new conversation.
        delete copy.attachments;
        return copy;
      }),
      createdAt: now,
      updatedAt: now,
      draft: '',
      draftUpdatedAt: now,
      cloudRevision: undefined,
      cloudUpdatedAt: undefined,
      cloudSyncedLocalUpdatedAt: undefined,
      needsServerResync: true,
    };
    setConversations(previous => {
      const next = enforceCapAndQueueDeletion({ ...previous, [id]: branched }, id);
      conversationsRef.current = next;
      return next;
    });
    AudioService.stop();
    setSpeakingMessageId(null);
    currentConversationIdRef.current = id;
    setCurrentConversationId(id);
    inputRef.current = '';
    setInput('');
    setChatMenuAnchor(null);
    setErrorMessage('');
    setShowExamples(false);
    setAutoFollow(true);
    writeConversationUrl(id, 'push');
    setAnnouncement(`Created ${branched.title}. The original chat is unchanged.`);
    reportClientEvent('conversation_created', {
      outcome: 'branch',
      value: branched.messages.length,
    });
  }, [branchGuard, enforceCapAndQueueDeletion]);

  const handleEditMessage = useCallback((id: string, newContent: string) => {
    const conversation = branchGuard();
    if (!conversation) return;
    const index = conversation.messages.findIndex(message => message.id === id);
    if (index < 0) return;
    const sourceMessage = conversation.messages[index];
    void runTurn({
      conversationId: conversation.id,
      content: newContent,
      kind: 'edit',
      baseMessages: conversation.messages.slice(0, index),
      rollbackMessages: conversation.messages,
      rollbackTitle: conversation.title,
      forceReset: true,
      attachments: sourceMessage.attachments?.map(attachment => ({ ...attachment })),
    });
  }, [branchGuard, runTurn]);

  const handleRegenerateMessage = useCallback(() => {
    const conversation = branchGuard();
    if (!conversation) return;
    const lastUserIndex = conversation.messages.map(message => message.role).lastIndexOf('user');
    if (lastUserIndex < 0) return;
    const sourceMessage = conversation.messages[lastUserIndex];
    void runTurn({
      conversationId: conversation.id,
      content: sourceMessage.rawContent,
      kind: 'regenerate',
      baseMessages: conversation.messages.slice(0, lastUserIndex),
      rollbackMessages: conversation.messages,
      rollbackTitle: conversation.title,
      forceReset: true,
      attachments: sourceMessage.attachments?.map(attachment => ({ ...attachment })),
    });
  }, [branchGuard, runTurn]);

  const handleRetryMessage = useCallback((id: string) => {
    const conversation = branchGuard();
    if (!conversation) return;
    const index = conversation.messages.findIndex(message => message.id === id && message.role === 'user');
    if (index < 0) return;
    const sourceMessage = conversation.messages[index];
    void runTurn({
      conversationId: conversation.id,
      content: sourceMessage.rawContent,
      kind: 'retry',
      baseMessages: conversation.messages.slice(0, index),
      rollbackMessages: conversation.messages,
      rollbackTitle: conversation.title,
      forceReset: true,
      attachments: sourceMessage.attachments?.map(attachment => ({ ...attachment })),
    });
  }, [branchGuard, runTurn]);

  useEffect(() => {
    if (!ENV.ENABLE_VOICE) return;
    const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Constructor) return;
    const recognition = configureSpeechRecognition(new Constructor());
    recognition.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
      const prefix = dictationPrefixRef.current;
      setCurrentDraft(`${prefix}${prefix && transcript ? ' ' : ''}${transcript}`);
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
  }, [setCurrentDraft]);

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
      if (next) setSpeakingMessageId(null);
      return next;
    });
  }, [userId]);

  const handleSpeakMessage = useCallback(async (id: string, content: string) => {
    if (!ENV.ENABLE_VOICE) return;
    if (mutedRef.current) {
      mutedRef.current = false;
      setIsMuted(false);
      try { localStorage.setItem(muteStorageKey(userId), 'false'); } catch { /* optional */ }
      AudioService.setMuted(false);
    }
    setSpeakingMessageId(id);
    try {
      await AudioService.playTTS(content);
    } catch (error) {
      console.error('TTS playback failed:', error);
      setErrorMessage('This message could not be read aloud. Please try again.');
    } finally {
      setSpeakingMessageId(current => current === id ? null : current);
    }
  }, [userId]);

  const handleStopSpeaking = useCallback(() => {
    AudioService.stop();
    setSpeakingMessageId(null);
  }, []);

  const toggleDesktopRail = useCallback(() => {
    setDesktopRailCollapsed(previous => {
      const next = !previous;
      try { localStorage.setItem(railStorageKey(userId), String(next)); } catch { /* optional */ }
      return next;
    });
  }, [userId]);

  const handleExportConversation = useCallback(() => {
    const conversation = conversationsRef.current[currentConversationIdRef.current];
    if (!conversation) return;
    setChatMenuAnchor(null);
    void import('../services/conversationExport')
      .then(({ createConversationExport, downloadConversationExport }) => {
        downloadConversationExport(createConversationExport(conversation, 'markdown'));
        reportConversationExport('markdown', 'download', conversation.messages.length);
        setAnnouncement('Conversation export started.');
      })
      .catch(() => setErrorMessage('The conversation export could not be prepared. Please retry.'));
  }, []);

  const handlePrintConversation = useCallback(() => {
    setChatMenuAnchor(null);
    requestAnimationFrame(() => window.print());
  }, []);

  const handleSubmitFeedback = useCallback(async (
    messageId: string,
    rating: FeedbackRating,
    reason?: string,
  ) => {
    const conversation = conversationsRef.current[currentConversationIdRef.current];
    const message = conversation?.messages.find(candidate => candidate.id === messageId);
    if (!conversation || !message?.responseId || !message.turnId) return;
    setFeedbackPending(previous => ({ ...previous, [messageId]: true }));
    try {
      await ChatAPI.submitChatFeedback({
        responseId: message.responseId,
        turnId: message.turnId,
        conversationId: conversation.id,
        rating,
        ...(reason ? { reason } : {}),
      });
      setFeedbackByMessage(previous => ({ ...previous, [messageId]: rating }));
      setAnnouncement('Feedback saved.');
      reportClientEvent('message_feedback', {
        eventId: message.turnId,
        outcome: rating,
      });
    } catch {
      setErrorMessage('Feedback could not be saved. Check your connection and try again.');
    } finally {
      setFeedbackPending(previous => {
        const next = { ...previous };
        delete next[messageId];
        return next;
      });
    }
  }, []);

  const handleMenuUsage = useCallback(() => {
    setChatMenuAnchor(null);
    void handleUsageCommand(currentConversationIdRef.current);
  }, [handleUsageCommand]);

  const handleMenuClear = useCallback(() => {
    setChatMenuAnchor(null);
    void handleClearCommand(currentConversationIdRef.current);
  }, [handleClearCommand]);

  // Stable identities: InputArea and ConversationSidebar are memoized, and a
  // fresh arrow here would defeat that on every streaming frame.
  const handleSend = useCallback(() => { void handleSendMessage(); }, [handleSendMessage]);
  const handleStop = useCallback(() => abortActiveTurn(true), [abortActiveTurn]);
  const handleAttachmentBusyChange = useCallback((busy: boolean) => {
    attachmentBusyRef.current = busy;
    setAttachmentBusy(busy);
  }, []);
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
      element.focus({ preventScroll: true });
      return;
    }
    skipNextAutoFollowRef.current = true;
    armProgrammaticScrollGuard(element);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    window.setTimeout(() => element.focus({ preventScroll: true }), SMOOTH_SCROLL_SETTLE_MS);
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
        version: 4,
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
  const currentCloudSynced = !isGuest
    && Boolean(currentConversation.cloudRevision)
    && currentConversation.cloudSyncedLocalUpdatedAt === currentConversation.updatedAt;
  const currentComposerAttachments = composerAttachments[currentConversationId] ?? [];
  const currentSupportAttachmentIds = [...new Set([
    ...currentConversation.messages.flatMap(message => message.attachments?.map(attachment => attachment.id) ?? []),
    ...currentComposerAttachments.map(attachment => attachment.id),
  ])];
  const visibleCloudStatus = isGuest ? 'device' : !isOnline ? 'offline' : cloudStatus;
  const cloudStatusLabel = visibleCloudStatus === 'device' ? 'On this device'
    : visibleCloudStatus === 'loading' ? 'Loading history…'
      : visibleCloudStatus === 'saving' ? 'Saving…'
        : visibleCloudStatus === 'synced' ? 'Synced'
          : visibleCloudStatus === 'offline' ? 'Offline · saved here'
            : 'Sync paused';
  const cloudStatusTooltip = cloudError || (isGuest
    ? 'Guest chats stay in this browser.'
    : visibleCloudStatus === 'synced' ? 'This chat is saved to your account.'
      : 'Changes remain available on this device.');
  const deleteConversation = deleteConversationId ? conversations[deleteConversationId] : undefined;
  const retryableFailedMessage = useMemo(() => {
    for (let index = currentConversation.messages.length - 1; index >= 0; index -= 1) {
      const message = currentConversation.messages[index];
      if (message.role === 'user' && message.status === 'failed') return message;
    }
    return undefined;
  }, [currentConversation.messages]);

  return (
    <Box
      component={isStandalone ? 'main' : 'div'}
      id="wf-chat-window"
      className="wf-chat-window"
      // Height and overflow live in App.css: MUI reads an sx array as
      // breakpoints rather than as a fallback pair, so `100vh`/`100dvh` cannot
      // be expressed here. See the `.wf-chat-window` block there.
      sx={{ display: 'flex', backgroundColor: containerBg }}
    >
      <React.Suspense fallback={(
        <Box
          aria-hidden
          sx={{
            display: { xs: 'none', md: 'block' },
            width: desktopRailCollapsed ? 64 : 288,
            flexShrink: 0,
            borderRight: `1px solid ${borderColor}`,
            bgcolor: 'background.paper',
          }}
        />
      )}>
        <ConversationSidebar
          open={drawerOpen}
          onClose={closeDrawer}
          conversations={sortedConversations}
          currentConversationId={currentConversationId}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={requestDeleteConversation}
          onNewConversation={handleNewConversation}
          onRenameConversation={requestRenameConversation}
          desktopCollapsed={desktopRailCollapsed}
          onToggleDesktopCollapsed={toggleDesktopRail}
        />
      </React.Suspense>

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Just the first row of a fixed-height column — no stickiness needed.
            It was sticky only while the document was the scroller. */}
        <Box className="wf-chat-header" sx={{ borderBottom: `1px solid ${borderColor}`, px: { xs: 0.75, sm: 2 }, py: { xs: 0.75, sm: 1.25 }, minHeight: { xs: 52, sm: 62 }, display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1.5 }, backgroundColor: 'background.paper', flexShrink: 0 }}>
          <IconButton sx={{ display: { xs: 'inline-flex', md: 'none' } }} onClick={() => setDrawerOpen(true)} aria-label="Open chat history"><MenuIcon /></IconButton>
          <Avatar src={BOT_AVATAR} alt={ASSISTANT_NAME} sx={{ display: { xs: 'none', sm: 'flex' }, width: 36, height: 36, bgcolor: '#0a2c4d' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography component={isStandalone ? 'h1' : 'h2'} variant="h6" sx={{ lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentConversation.title}
            </Typography>
            <Box sx={{ display: { xs: 'none', sm: 'flex' }, alignItems: 'center', gap: 0.75 }}>
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{ASSISTANT_NAME} · Windows and IT assistant</Typography>
            </Box>
          </Box>
          {usageVisible && (
            <Tooltip title={usageTooltip}>
              <Box sx={{ px: 1, py: 0.25, borderRadius: 1, border: `1px solid ${borderColor}`, display: { xs: 'none', sm: 'block' }, flexShrink: 0 }}>
                <Typography sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>{usageText}</Typography>
              </Box>
            </Tooltip>
          )}
          <Tooltip title={cloudStatusTooltip}>
            <Box
              className="wf-sync-status"
              role="status"
              tabIndex={0}
              aria-label={`History status: ${cloudStatusLabel}`}
              sx={{ px: { xs: 0.6, sm: 1 }, py: 0.35, borderRadius: 999, border: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}
            >
              {visibleCloudStatus === 'loading' || visibleCloudStatus === 'saving'
                ? <CircularProgress size={12} />
                : visibleCloudStatus === 'offline' || visibleCloudStatus === 'error'
                  ? <CloudOffOutlinedIcon sx={{ fontSize: 15 }} />
                  : <CloudDoneOutlinedIcon sx={{ fontSize: 15 }} />}
              <Typography sx={{ display: { xs: 'none', sm: 'block' }, fontSize: 11.5, color: 'text.secondary', whiteSpace: 'nowrap' }}>{cloudStatusLabel}</Typography>
            </Box>
          </Tooltip>
          <Tooltip title="New chat">
            <IconButton sx={{ display: { xs: 'inline-flex', sm: 'none' } }} onClick={handleNewConversation} aria-label="New chat">
              <AddIcon />
            </IconButton>
          </Tooltip>
          <Button sx={{ display: { xs: 'none', sm: 'inline-flex' } }} size="small" variant="outlined" startIcon={<AddIcon />} onClick={handleNewConversation}>New chat</Button>
          <Tooltip title="Chat actions">
            <IconButton
              aria-label="Chat actions"
              aria-controls={chatMenuAnchor ? 'wf-chat-actions-menu' : undefined}
              aria-haspopup="menu"
              aria-expanded={chatMenuAnchor ? 'true' : undefined}
              onClick={(event) => setChatMenuAnchor(event.currentTarget)}
            >
              <MoreVertIcon />
            </IconButton>
          </Tooltip>
        </Box>

        <Menu
          id="wf-chat-actions-menu"
          anchorEl={chatMenuAnchor}
          open={Boolean(chatMenuAnchor)}
          onClose={() => setChatMenuAnchor(null)}
          container={() => document.getElementById('wf-chat-window')}
        >
          <MenuItem disabled={isLoading} onClick={() => {
            setChatMenuAnchor(null);
            requestRenameConversation(currentConversationIdRef.current);
          }}><EditOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Rename</MenuItem>
          <MenuItem disabled={isLoading} onClick={handleBranchConversation}>
            <AccountTreeOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Branch to new chat
          </MenuItem>
          {!isGuest && (
            <MenuItem disabled={!currentConversation.cloudRevision} onClick={() => {
              setChatMenuAnchor(null);
              setShareLinksOpen(true);
            }}>
              <LinkOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Share links
            </MenuItem>
          )}
          {!isGuest && (
            <MenuItem onClick={() => {
              setChatMenuAnchor(null);
              setSupportCasesOpen(true);
            }}>
              <SupportAgentIcon fontSize="small" sx={{ mr: 1.25 }} />Support cases
            </MenuItem>
          )}
          <Divider />
          <MenuItem onClick={handleExportConversation}>
            <DownloadOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Export Markdown
          </MenuItem>
          <MenuItem onClick={handlePrintConversation}>
            <PrintOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Print
          </MenuItem>
          <Divider />
          <MenuItem disabled={isLoading || !isOnline} onClick={handleMenuClear}>
            <RestartAltIcon fontSize="small" sx={{ mr: 1.25 }} />Clear chat
          </MenuItem>
          <MenuItem disabled={isLoading || !isOnline} onClick={handleMenuUsage}>
            <DataUsageOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Usage
          </MenuItem>
          <MenuItem onClick={() => {
            setChatMenuAnchor(null);
            setPreferencesOpen(true);
          }}>
            <SettingsOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Chat settings
          </MenuItem>
          {!isGuest && (
            <MenuItem disabled={isLoading || attachmentBusy} onClick={() => {
              setChatMenuAnchor(null);
              setAccountDataOpen(true);
            }}>
              <ManageAccountsOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />Account data
            </MenuItem>
          )}
          <MenuItem disabled={isLoading} sx={{ color: 'error.main' }} onClick={() => {
            setChatMenuAnchor(null);
            requestDeleteConversation(currentConversationIdRef.current);
          }}><DeleteOutlineIcon fontSize="small" sx={{ mr: 1.25 }} />Delete chat</MenuItem>
        </Menu>

        <Box
          ref={messagesContainerRef}
          className="chat-messages-container"
          aria-label="Chat messages"
          role="region"
          tabIndex={0}
          onScroll={handleScroll}
          // The app's only scroll container. `overscroll-behavior: contain`
          // and `scrollbar-gutter` are in App.css alongside the pane sizing.
          sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
        >
          <Box ref={transcriptContentRef}>
            <Box role="log" aria-live="off">
              {currentConversation.messages.map((message, index) => {
                const isLast = index === currentConversation.messages.length - 1
                  && Boolean(lastUserMessageId);
                const isLastUser = message.id === lastUserMessageId;
                return (
                  <React.Fragment key={message.id}>
                    {/* Where a new turn is scrolled to. Zero-height, so it costs
                        the transcript nothing when no turn is in flight. */}
                    {isLastUser && <Box ref={turnAnchorRef} aria-hidden data-wf-turn-anchor sx={{ height: 0 }} />}
                    {completedTrail?.messageId === message.id ? (
                      <ActivityTrail
                        activities={completedTrail.activities}
                        durationMs={completedTrail.durationMs}
                      />
                    ) : Boolean(message.activities?.length) && (
                      <ActivityTrail activities={message.activities ?? []} />
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
                      isSpeaking={speakingMessageId === message.id}
                      onSpeak={ENV.ENABLE_VOICE ? handleSpeakMessage : undefined}
                      onStopSpeaking={handleStopSpeaking}
                      feedback={feedbackByMessage[message.id]}
                      feedbackPending={Boolean(feedbackPending[message.id])}
                      onFeedback={handleSubmitFeedback}
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
                        onClick={() => {
                          setCurrentDraft(prompt);
                          requestAnimationFrame(() => textFieldRef.current?.querySelector('textarea')?.focus());
                        }}
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

        <Box
          role="status"
          aria-live="polite"
          sx={{ position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}
        >
          {announcement}
        </Box>

        {(!isOnline || errorMessage) && (
          <Alert
            severity={isOnline ? 'error' : 'warning'}
            variant="outlined"
            role="alert"
            sx={{ mx: { xs: 1, sm: 2 }, mt: 1, flexShrink: 0, alignItems: 'center' }}
            action={isOnline ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {retryableFailedMessage && !isLoading && (
                  <Button color="inherit" size="small" onClick={() => handleRetryMessage(retryableFailedMessage.id)}>
                    Retry
                  </Button>
                )}
                <Button color="inherit" size="small" onClick={() => setErrorMessage('')}>
                  Dismiss
                </Button>
              </Box>
            ) : undefined}
          >
            {isOnline ? errorMessage : 'You are offline. Drafts stay saved on this device; reconnect to send.'}
          </Alert>
        )}

        {!isGuest && (
          <Box
            sx={{
              px: { xs: 1, sm: 2 },
              pt: 1,
              bgcolor: 'background.paper',
              borderTop: `1px solid ${borderColor}`,
              flexShrink: 0,
            }}
          >
            <Box sx={{ maxWidth: CHAT_CONTENT_MAX_WIDTH, mx: 'auto' }}>
              <React.Suspense fallback={(
                <Typography role="status" variant="caption" color="text.secondary" sx={{ display: 'block', py: 1.5 }}>
                  Loading attachment tools…
                </Typography>
              )}>
                <AttachmentTray
                  key={currentConversationId}
                  signedIn
                  conversationId={currentConversationId}
                  attachments={currentComposerAttachments}
                  onChange={attachments => setComposerAttachmentsForConversation(currentConversationId, attachments)}
                  onBusyChange={handleAttachmentBusyChange}
                  onRemoveAttachment={attachment => deleteComposerAttachment(currentConversationId, attachment)}
                  disabled={isLoading || showCaptcha || !isOnline}
                />
              </React.Suspense>
            </Box>
          </Box>
        )}

        <InputArea
          input={input}
          setInput={setCurrentDraft}
          isLoading={isLoading}
          isListening={isListening}
          isSpeechRecognitionSupported={isSpeechRecognitionSupported}
          isMuted={isMuted}
          voiceEnabled={ENV.ENABLE_VOICE}
          isOffline={!isOnline}
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
        {isGuest && (
          <React.Suspense fallback={null}>
            <AdSlot isGuest />
          </React.Suspense>
        )}
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

      <Dialog
        open={Boolean(renameConversationId)}
        onClose={() => setRenameConversationId(null)}
        aria-labelledby="wf-rename-chat-title"
        fullWidth
        maxWidth="xs"
        container={() => document.getElementById('wf-chat-window')}
      >
        <DialogTitle id="wf-rename-chat-title">Rename chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Chat name"
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value.slice(0, 80))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && renameTitle.trim()) confirmRenameConversation();
            }}
            slotProps={{ htmlInput: { maxLength: 80 } }}
            helperText={`${renameTitle.length} / 80`}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameConversationId(null)}>Cancel</Button>
          <Button variant="contained" disabled={!renameTitle.trim()} onClick={confirmRenameConversation}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(deleteConversationId)}
        onClose={() => setDeleteConversationId(null)}
        aria-labelledby="wf-delete-chat-title"
        container={() => document.getElementById('wf-chat-window')}
      >
        <DialogTitle id="wf-delete-chat-title">Delete chat?</DialogTitle>
        <DialogContent>
          <Typography>
            “{deleteConversation?.title ?? 'This chat'}” will be removed from this device and queued for secure server deletion. This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConversationId(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={confirmDeleteConversation}>Delete</Button>
        </DialogActions>
      </Dialog>

      {!isGuest && shareLinksOpen && (
        <React.Suspense fallback={null}>
          <ShareLinksDialog
            open
            onClose={() => setShareLinksOpen(false)}
            signedIn
            conversationId={currentConversation.cloudRevision ? currentConversation.id : undefined}
            conversationTitle={currentConversation.title}
            conversationRevision={currentCloudSynced ? currentConversation.cloudRevision : undefined}
            onShareCreated={() => setAnnouncement('A new share link was created. Its token is shown only in the share-links dialog.')}
          />
        </React.Suspense>
      )}

      {!isGuest && supportCasesOpen && (
        <React.Suspense fallback={null}>
          <SupportCasesDialog
            open
            onClose={() => setSupportCasesOpen(false)}
            signedIn
            currentConversationId={currentCloudSynced ? currentConversation.id : undefined}
            attachmentIds={currentSupportAttachmentIds}
            onForumHandoffCopied={() => setAnnouncement('Support case BBCode copied. Nothing was posted automatically.')}
          />
        </React.Suspense>
      )}

      {!isGuest && accountDataOpen && (
        <React.Suspense fallback={null}>
          <AccountDataDialog
            open
            onClose={() => setAccountDataOpen(false)}
            signedIn
            onDeleteAllStarting={quiesceCloudSync}
            onDeleteAllSucceeded={handleDeleteAllSavedDataSucceeded}
            onDeleteAllFinished={resumeCloudSync}
            onExportDownloaded={() => setAnnouncement('Your saved AI chat data export was downloaded.')}
          />
        </React.Suspense>
      )}

      {preferencesOpen && (
        <React.Suspense fallback={null}>
          <PreferencesDialog
            open
            onClose={() => setPreferencesOpen(false)}
            voiceEnabled={ENV.ENABLE_VOICE}
          />
        </React.Suspense>
      )}
    </Box>
  );
};

export const ChatWindow: React.FC<ChatWindowProps> = (props) => {
  const [shareToken, setShareToken] = useState(safeShareQuery);
  useEffect(() => {
    const handlePopState = () => setShareToken(safeShareQuery());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  return shareToken ? <SharedChatView key={shareToken} token={shareToken} /> : <InteractiveChatWindow {...props} />;
};
