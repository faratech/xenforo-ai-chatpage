/**
 * Per-user conversation persistence.
 *
 * Storage layout (v3): one JSON envelope per user containing the
 * conversation map plus timestamped deletion tombstones and the queue of
 * server-side deletions that have not been confirmed yet. Tombstones make
 * deletions win across tabs: a conversation id with a tombstone is dead
 * everywhere, regardless of which tab wrote last.
 */

import type {
  Annotation,
  ChatStoreV3,
  Conversation,
  ConversationMap,
  Message,
} from '../types';
import { ENV } from '../config/env';

const STORAGE_VERSION_KEY = 'chat_storage_version';
const UNSCOPED_LEGACY_CONVERSATIONS_KEY = 'chat_conversations';
const UNSCOPED_LEGACY_CURRENT_KEY = 'current_conversation_id';

/** Tombstones and unconfirmed deletions older than this are garbage collected. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StorageKeys {
  store: string;
  current: string;
  legacyConversations: string;
  legacyCurrent: string;
}

export const storageKeys = (userId: string): StorageKeys => {
  const principal = encodeURIComponent(userId);
  return {
    store: `chat_store:v3:${principal}`,
    current: `current_conversation_id:v3:${principal}`,
    legacyConversations: `chat_conversations:v2:${principal}`,
    legacyCurrent: `current_conversation_id:v2:${principal}`,
  };
};

export const maxConversations = (): number => {
  return Number.isFinite(ENV.MAX_CONVERSATIONS) && ENV.MAX_CONVERSATIONS > 0
    ? Math.floor(ENV.MAX_CONVERSATIONS)
    : 50;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Accepts current discriminated annotations and migrates the legacy
 * file-only shape ({ index, filename, fileId }) to a file citation.
 * Returns null for anything unusable.
 */
const normalizeAnnotation = (value: unknown): Annotation | null => {
  if (!isRecord(value)) return null;

  switch (value.type) {
    case 'url_citation':
      if (typeof value.url !== 'string') return null;
      return {
        type: 'url_citation',
        url: value.url,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
      };
    case 'file_citation':
      return {
        type: 'file_citation',
        ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
        ...(typeof value.fileId === 'string' ? { fileId: value.fileId } : {}),
      };
    case 'container_file_citation':
      return {
        type: 'container_file_citation',
        ...(typeof value.containerId === 'string' ? { containerId: value.containerId } : {}),
        ...(typeof value.fileId === 'string' ? { fileId: value.fileId } : {}),
        ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
      };
    case 'file_path':
      return {
        type: 'file_path',
        ...(typeof value.fileId === 'string' ? { fileId: value.fileId } : {}),
        ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
      };
    default:
      break;
  }

  // Legacy v2 annotation: file-only model without a discriminant.
  if (typeof value.filename === 'string' || typeof value.fileId === 'string') {
    return {
      type: 'file_citation',
      ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
      ...(typeof value.fileId === 'string' ? { fileId: value.fileId } : {}),
    };
  }
  return null;
};

const normalizeMessage = (value: unknown): Message | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || (value.role !== 'user' && value.role !== 'ai')
    || typeof value.rawContent !== 'string'
    || typeof value.timestamp !== 'number'
  ) return null;

  const message: Message = {
    id: value.id,
    role: value.role,
    rawContent: value.rawContent,
    timestamp: value.timestamp,
  };
  if (
    value.status === 'complete' || value.status === 'sending' || value.status === 'stopped'
    || value.status === 'interrupted' || value.status === 'failed'
  ) {
    message.status = value.status;
  }
  if (Array.isArray(value.annotations)) {
    const annotations = value.annotations
      .map(normalizeAnnotation)
      .filter((annotation): annotation is Annotation => annotation !== null);
    if (annotations.length) message.annotations = annotations;
  }
  return message;
};

const normalizeConversation = (id: string, value: unknown): Conversation | null => {
  if (!isRecord(value)) return null;
  if (
    value.id !== id
    || typeof value.title !== 'string'
    || !Array.isArray(value.messages)
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
  ) return null;

  const messages = value.messages
    .map(normalizeMessage)
    .filter((message): message is Message => message !== null);
  if (messages.length !== value.messages.length) return null;

  const conversation: Conversation = {
    id,
    title: value.title,
    messages,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.needsServerResync === true) conversation.needsServerResync = true;
  return conversation;
};

export const parseConversationMap = (raw: string | null): ConversationMap => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const result: ConversationMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (DANGEROUS_KEYS.has(id)) continue;
      const conversation = normalizeConversation(id, value);
      if (conversation) result[id] = conversation;
    }
    return result;
  } catch {
    return {};
  }
};

const parseTimestampMap = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [id, timestamp] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(id)) continue;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) result[id] = timestamp;
  }
  return result;
};

export const parseStore = (raw: string | null): ChatStoreV3 | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 3) return null;
    const conversations: ConversationMap = {};
    if (isRecord(parsed.conversations)) {
      for (const [id, value] of Object.entries(parsed.conversations)) {
        if (DANGEROUS_KEYS.has(id)) continue;
        const conversation = normalizeConversation(id, value);
        if (conversation) conversations[id] = conversation;
      }
    }
    return {
      version: 3,
      conversations,
      tombstones: parseTimestampMap(parsed.tombstones),
      pendingServerDeletions: parseTimestampMap(parsed.pendingServerDeletions),
    };
  } catch {
    return null;
  }
};

export const emptyStore = (): ChatStoreV3 => ({
  version: 3,
  conversations: {},
  tombstones: {},
  pendingServerDeletions: {},
});

/** Removes every conversation that has a tombstone. Tombstones always win. */
export const applyTombstones = (store: ChatStoreV3): ChatStoreV3 => {
  const conversations: ConversationMap = {};
  for (const [id, conversation] of Object.entries(store.conversations)) {
    if (!(id in store.tombstones)) conversations[id] = conversation;
  }
  return { ...store, conversations };
};

/**
 * Enforces the configured cap exactly: the current conversation always
 * survives; the remaining slots go to the most recently updated others.
 */
export const enforceConversationCap = (
  conversations: ConversationMap,
  keepConversationId: string,
): ConversationMap => {
  const max = maxConversations();
  const entries = Object.entries(conversations)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const result: ConversationMap = {};
  if (conversations[keepConversationId]) result[keepConversationId] = conversations[keepConversationId];
  for (const [id, conversation] of entries) {
    if (Object.keys(result).length >= max) break;
    if (!result[id]) result[id] = conversation;
  }
  return result;
};

/** Newest-updatedAt wins per conversation; tombstones union with max timestamp. */
export const mergeStores = (local: ChatStoreV3, remote: ChatStoreV3): ChatStoreV3 => {
  const conversations: ConversationMap = { ...local.conversations };
  for (const [id, conversation] of Object.entries(remote.conversations)) {
    if (!conversations[id] || conversation.updatedAt > conversations[id].updatedAt) {
      conversations[id] = conversation;
    }
  }
  const tombstones: Record<string, number> = { ...local.tombstones };
  for (const [id, timestamp] of Object.entries(remote.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, timestamp);
  }
  const pendingServerDeletions: Record<string, number> = { ...local.pendingServerDeletions };
  for (const [id, timestamp] of Object.entries(remote.pendingServerDeletions)) {
    pendingServerDeletions[id] = Math.min(
      pendingServerDeletions[id] ?? Number.POSITIVE_INFINITY,
      timestamp,
    );
  }
  return applyTombstones({ version: 3, conversations, tombstones, pendingServerDeletions });
};

const gcTimestampMap = (map: Record<string, number>, now: number): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const [id, timestamp] of Object.entries(map)) {
    if (now - timestamp < TOMBSTONE_TTL_MS) result[id] = timestamp;
  }
  return result;
};

const sortedByKey = <T>(map: Record<string, T>): Record<string, T> => {
  const result: Record<string, T> = {};
  for (const key of Object.keys(map).sort()) result[key] = map[key];
  return result;
};

/**
 * Serializes the store with every map keyed in a canonical (sorted) order.
 * Two tabs holding identical content therefore produce byte-identical JSON
 * regardless of which conversation each has selected — without this, the
 * current-conversation-first ordering made cross-tab writes ping-pong
 * forever between tabs on different conversations.
 */
export const serializeStore = (store: ChatStoreV3): string => JSON.stringify({
  version: 3,
  conversations: sortedByKey(store.conversations),
  tombstones: sortedByKey(store.tombstones),
  pendingServerDeletions: sortedByKey(store.pendingServerDeletions),
});

// DOMException does not extend Error in every runtime; match on shape.
const isQuotaError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: string; code?: number };
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || code === 22
    || code === 1014;
};

export interface LoadResult {
  store: ChatStoreV3;
  currentId: string | null;
  /** localStorage was unusable; nothing persists this session. */
  unavailable: boolean;
}

/**
 * Loads the per-user store, migrating the v2 conversation map into a v3
 * envelope once, and dropping the unscoped pre-v2 keys that cannot be
 * assigned to a user safely on a shared browser.
 */
export const loadStore = (userId: string): LoadResult => {
  const keys = storageKeys(userId);
  try {
    localStorage.removeItem(UNSCOPED_LEGACY_CONVERSATIONS_KEY);
    localStorage.removeItem(UNSCOPED_LEGACY_CURRENT_KEY);
    localStorage.setItem(STORAGE_VERSION_KEY, '3');

    let store = parseStore(localStorage.getItem(keys.store));
    let currentId = localStorage.getItem(keys.current);
    // A poisoned current id (e.g. "__proto__") must never reach an object
    // key or enforceConversationCap; the JSON paths already filter these.
    if (currentId && DANGEROUS_KEYS.has(currentId)) currentId = null;

    if (!store) {
      // One-time v2 → v3 migration.
      store = emptyStore();
      store.conversations = parseConversationMap(localStorage.getItem(keys.legacyConversations));
      const legacyCurrent = localStorage.getItem(keys.legacyCurrent);
      if (legacyCurrent && !DANGEROUS_KEYS.has(legacyCurrent) && !currentId) currentId = legacyCurrent;
      // Remove the legacy blob BEFORE writing the v3 envelope: its data is
      // already parsed into `store`, and freeing its space first prevents a
      // large v2 store from forcing the first save to evict live history.
      localStorage.removeItem(keys.legacyConversations);
      localStorage.removeItem(keys.legacyCurrent);
      try {
        localStorage.setItem(keys.store, serializeStore(store));
        if (currentId) localStorage.setItem(keys.current, currentId);
      } catch {
        // The first saveStore retries with eviction if quota is still tight.
      }
    }

    return { store: applyTombstones(store), currentId, unavailable: false };
  } catch (error) {
    console.warn('Local chat storage is unavailable; continuing without persistence.', error);
    return { store: emptyStore(), currentId: null, unavailable: true };
  }
};

export interface SaveResult {
  persisted: boolean;
  /** Conversation ids evicted under quota pressure, oldest first. */
  evictedIds: string[];
  /** The store as actually persisted (post cap, GC, and eviction). */
  store: ChatStoreV3;
}

/**
 * Persists the store: merges deletions already on disk (another tab may
 * have written), enforces the cap exactly, garbage-collects expired
 * tombstones, and on quota pressure evicts the oldest non-current
 * conversations until the write fits.
 */
export const saveStore = (
  userId: string,
  store: ChatStoreV3,
  currentId: string,
): SaveResult => {
  const keys = storageKeys(userId);
  const now = Date.now();

  let prepared: ChatStoreV3 = applyTombstones({
    version: 3,
    conversations: store.conversations,
    tombstones: gcTimestampMap(store.tombstones, now),
    pendingServerDeletions: gcTimestampMap(store.pendingServerDeletions, now),
  });
  prepared = {
    ...prepared,
    conversations: enforceConversationCap(prepared.conversations, currentId),
  };

  const evictedIds: string[] = [];
  for (;;) {
    try {
      const serialized = serializeStore(prepared);
      // No-op guard: skip the write (and the storage event it would fire in
      // other tabs) when the on-disk store is already byte-identical. With
      // canonical serialization this converges cross-tab writes to a fixpoint.
      if (localStorage.getItem(keys.store) !== serialized) {
        localStorage.setItem(keys.store, serialized);
      }
      if (localStorage.getItem(keys.current) !== currentId) {
        localStorage.setItem(keys.current, currentId);
      }
      return { persisted: true, evictedIds, store: prepared };
    } catch (error) {
      if (!isQuotaError(error)) {
        console.warn('Failed to persist chat history:', error);
        return { persisted: false, evictedIds, store: prepared };
      }
      const evictable = Object.values(prepared.conversations)
        .filter(conversation => conversation.id !== currentId)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      if (!evictable.length) {
        return { persisted: false, evictedIds, store: prepared };
      }
      const oldest = evictable[0];
      evictedIds.push(oldest.id);
      const conversations = { ...prepared.conversations };
      delete conversations[oldest.id];
      prepared = { ...prepared, conversations };
    }
  }
};
