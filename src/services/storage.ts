/**
 * Per-user conversation persistence.
 *
 * Storage layout (v4): one JSON envelope per user containing the
 * conversation map plus timestamped deletion tombstones and the queue of
 * server-side deletions that have not been confirmed yet. Tombstones make
 * deletions win across tabs: a conversation id with a tombstone is dead
 * everywhere, regardless of which tab wrote last. V4 keeps the unsent draft
 * alongside each conversation so switching chats or reloading does not throw
 * away work in the composer.
 */

import type {
  Annotation,
  ChatStoreV3,
  ChatStoreV4,
  Conversation,
  ConversationMap,
  Message,
  MessageAttachment,
  StreamActivity,
} from '../types';
import { ENV } from '../config/env';

const UNSCOPED_LEGACY_CONVERSATIONS_KEY = 'chat_conversations';
const UNSCOPED_LEGACY_CURRENT_KEY = 'current_conversation_id';

export interface StorageKeys {
  store: string;
  current: string;
  /** Quarantine for an envelope that failed to parse; overwritten per incident. */
  corrupt: string;
  legacyStoreV3: string;
  legacyCurrentV3: string;
  legacyConversations: string;
  legacyCurrent: string;
}

export const storageKeys = (userId: string): StorageKeys => {
  const principal = encodeURIComponent(userId);
  return {
    store: `chat_store:v4:${principal}`,
    current: `current_conversation_id:v4:${principal}`,
    corrupt: `chat_store_corrupt:v1:${principal}`,
    legacyStoreV3: `chat_store:v3:${principal}`,
    legacyCurrentV3: `current_conversation_id:v3:${principal}`,
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
const MAX_MESSAGE_ACTIVITIES = 20;
/** Must match the backend's per-message attachment handle cap. */
const MAX_MESSAGE_ATTACHMENTS = 8;

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

const normalizeActivity = (value: unknown): StreamActivity | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || (value.state !== 'active' && value.state !== 'done')
  ) return null;
  return {
    id: value.id,
    label: value.label,
    state: value.state,
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
};

const normalizeAttachment = (value: unknown): MessageAttachment | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.mime !== 'string'
    || typeof value.size !== 'number'
    || !Number.isFinite(value.size)
    || value.size < 0
  ) return null;
  return { id: value.id, name: value.name, mime: value.mime, size: value.size };
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
  if (typeof value.responseId === 'string') message.responseId = value.responseId;
  if (typeof value.turnId === 'string') message.turnId = value.turnId;
  if (Array.isArray(value.activities)) {
    const activities = value.activities
      .slice(0, MAX_MESSAGE_ACTIVITIES)
      .map(normalizeActivity)
      .filter((activity): activity is StreamActivity => activity !== null);
    if (activities.length) message.activities = activities;
  }
  if (Array.isArray(value.attachments)) {
    const attachments = value.attachments
      .slice(0, MAX_MESSAGE_ATTACHMENTS)
      .map(normalizeAttachment)
      .filter((attachment): attachment is MessageAttachment => attachment !== null);
    if (attachments.length) message.attachments = attachments;
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
  // Salvage, never discard: one unreadable message (e.g. written by a newer
  // build) must not erase the whole thread — dropping the conversation here
  // made the loss permanent on the next save.
  if (messages.length !== value.messages.length) {
    console.warn(
      `Recovered conversation ${id}: dropped ${value.messages.length - messages.length} unreadable message(s).`,
    );
  }

  const conversation: Conversation = {
    id,
    title: value.title,
    messages,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (typeof value.draft === 'string') conversation.draft = value.draft;
  if (typeof value.draftUpdatedAt === 'number' && Number.isFinite(value.draftUpdatedAt)) {
    conversation.draftUpdatedAt = value.draftUpdatedAt;
  }
  if (typeof value.cloudRevision === 'number' && Number.isSafeInteger(value.cloudRevision) && value.cloudRevision > 0) {
    conversation.cloudRevision = value.cloudRevision;
  }
  if (typeof value.cloudUpdatedAt === 'number' && Number.isFinite(value.cloudUpdatedAt)) {
    conversation.cloudUpdatedAt = value.cloudUpdatedAt;
  }
  if (typeof value.cloudSyncedLocalUpdatedAt === 'number' && Number.isFinite(value.cloudSyncedLocalUpdatedAt)) {
    conversation.cloudSyncedLocalUpdatedAt = value.cloudSyncedLocalUpdatedAt;
  }
  if (typeof value.pinnedAt === 'number' && Number.isFinite(value.pinnedAt) && value.pinnedAt > 0) {
    conversation.pinnedAt = value.pinnedAt;
  }
  if (typeof value.archivedAt === 'number' && Number.isFinite(value.archivedAt) && value.archivedAt > 0) {
    conversation.archivedAt = value.archivedAt;
  }
  if (
    typeof value.metadataRevision === 'number'
    && Number.isSafeInteger(value.metadataRevision)
    && value.metadataRevision >= 0
  ) {
    conversation.metadataRevision = value.metadataRevision;
  }
  if (typeof value.metadataUpdatedAt === 'number' && Number.isFinite(value.metadataUpdatedAt)) {
    conversation.metadataUpdatedAt = value.metadataUpdatedAt;
  }
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

export const parseStore = (raw: string | null): ChatStoreV4 | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 4) return null;
    const conversations: ConversationMap = {};
    if (isRecord(parsed.conversations)) {
      for (const [id, value] of Object.entries(parsed.conversations)) {
        if (DANGEROUS_KEYS.has(id)) continue;
        const conversation = normalizeConversation(id, value);
        if (conversation) conversations[id] = conversation;
      }
    }
    return {
      version: 4,
      conversations,
      tombstones: parseTimestampMap(parsed.tombstones),
      pendingServerDeletions: parseTimestampMap(parsed.pendingServerDeletions),
    };
  } catch {
    return null;
  }
};

/** Parses the previous envelope without weakening the current v4 parser. */
const parseV3Store = (raw: string | null): ChatStoreV3 | null => {
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

const upgradeV3Store = (store: ChatStoreV3): ChatStoreV4 => ({
  version: 4,
  conversations: store.conversations,
  tombstones: store.tombstones,
  pendingServerDeletions: store.pendingServerDeletions,
});

export const emptyStore = (): ChatStoreV4 => ({
  version: 4,
  conversations: {},
  tombstones: {},
  pendingServerDeletions: {},
});

/** Removes every conversation that has a tombstone. Tombstones always win. */
export const applyTombstones = (store: ChatStoreV4): ChatStoreV4 => {
  const conversations: ConversationMap = {};
  for (const [id, conversation] of Object.entries(store.conversations)) {
    if (!(id in store.tombstones)) conversations[id] = conversation;
  }
  return { ...store, conversations };
};

/**
 * Enforces the configured cap exactly. The current conversation survives
 * first, followed by pinned conversations, then the most recently updated
 * remaining conversations. Stable id ordering resolves otherwise-equal rows
 * so tabs converge on the same retained set.
 */
export const enforceConversationCap = (
  conversations: ConversationMap,
  keepConversationId: string,
): ConversationMap => {
  const max = maxConversations();
  const entries = Object.entries(conversations).sort(([idA, a], [idB, b]) => {
    const currentDifference = Number(idB === keepConversationId) - Number(idA === keepConversationId);
    if (currentDifference !== 0) return currentDifference;
    const pinnedDifference = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
    if (pinnedDifference !== 0) return pinnedDifference;
    const updatedDifference = b.updatedAt - a.updatedAt;
    return updatedDifference !== 0 ? updatedDifference : idA.localeCompare(idB);
  });
  const result: ConversationMap = {};
  for (const [id, conversation] of entries) {
    if (Object.keys(result).length >= max) break;
    result[id] = conversation;
  }
  return result;
};

const selectMetadataWinner = (local: Conversation, remote: Conversation): Conversation => {
  const revisionDifference = (remote.metadataRevision ?? 0) - (local.metadataRevision ?? 0);
  if (revisionDifference !== 0) return revisionDifference > 0 ? remote : local;
  return (remote.metadataUpdatedAt ?? 0) > (local.metadataUpdatedAt ?? 0) ? remote : local;
};

/** Content, draft, cloud, and library metadata clocks merge independently per conversation. */
export const mergeStores = (local: ChatStoreV4, remote: ChatStoreV4): ChatStoreV4 => {
  const conversations: ConversationMap = { ...local.conversations };
  for (const [id, conversation] of Object.entries(remote.conversations)) {
    const existing = conversations[id];
    if (!existing) {
      conversations[id] = conversation;
      continue;
    }
    const contentWinner = conversation.updatedAt > existing.updatedAt ? conversation : existing;
    const draftWinner = (conversation.draftUpdatedAt ?? 0) > (existing.draftUpdatedAt ?? 0)
      ? conversation
      : existing;
    const cloudWinner = (conversation.cloudRevision ?? 0) > (existing.cloudRevision ?? 0)
      ? conversation
      : existing;
    const metadataWinner = selectMetadataWinner(existing, conversation);
    conversations[id] = {
      ...contentWinner,
      draft: draftWinner.draft,
      draftUpdatedAt: draftWinner.draftUpdatedAt,
      cloudRevision: cloudWinner.cloudRevision,
      cloudUpdatedAt: cloudWinner.cloudUpdatedAt,
      cloudSyncedLocalUpdatedAt: cloudWinner.cloudSyncedLocalUpdatedAt,
      pinnedAt: metadataWinner.pinnedAt,
      archivedAt: metadataWinner.archivedAt,
      metadataRevision: metadataWinner.metadataRevision,
      metadataUpdatedAt: metadataWinner.metadataUpdatedAt,
    };
  }
  const tombstones: Record<string, number> = { ...local.tombstones };
  for (const [id, timestamp] of Object.entries(remote.tombstones)) {
    tombstones[id] = Math.max(tombstones[id] ?? 0, timestamp);
  }
  const pendingServerDeletions: Record<string, number> = { ...local.pendingServerDeletions };
  for (const [id, timestamp] of Object.entries(remote.pendingServerDeletions)) {
    pendingServerDeletions[id] = Math.max(pendingServerDeletions[id] ?? 0, timestamp);
  }
  // Confirmation advances the tombstone beyond the queued-at timestamp. That
  // lets an acknowledgement clear an old pending marker without allowing a
  // stale tab to re-add it during the union above. Equal timestamps still mean
  // the deletion has not yet been confirmed.
  for (const [id, timestamp] of Object.entries(pendingServerDeletions)) {
    if ((tombstones[id] ?? 0) > timestamp) delete pendingServerDeletions[id];
  }
  return applyTombstones({ version: 4, conversations, tombstones, pendingServerDeletions });
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
export const serializeStore = (store: ChatStoreV4): string => JSON.stringify({
  version: 4,
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
  store: ChatStoreV4;
  currentId: string | null;
  /** localStorage was unusable; nothing persists this session. */
  unavailable: boolean;
}

/**
 * Loads the per-user store, migrating v3 (and older v2 maps) into a v4
 * envelope once, and dropping the unscoped pre-v2 keys that cannot be assigned
 * to a user safely on a shared browser.
 *
 * Ordering matters: the v4 write is attempted (with one cap-reduced retry)
 * BEFORE any legacy blob is removed. Deleting the legacy sources first meant
 * a quota failure mid-migration destroyed every conversation with no way to
 * retry. A corrupt v4 envelope is quarantined before recovery so it is never
 * silently overwritten.
 */
export const loadStore = (userId: string): LoadResult => {
  const keys = storageKeys(userId);
  try {
    const rawStore = localStorage.getItem(keys.store);
    let store = parseStore(rawStore);
    if (!store && rawStore) {
      // The envelope exists but is unreadable (e.g. a truncated write).
      // Quarantine it — best effort; quota pressure must not turn a recovery
      // path into a crash — then fall through to migration/first-run.
      try {
        localStorage.setItem(keys.corrupt, rawStore);
        console.warn('Chat history envelope was unreadable; quarantined it for inspection.');
      } catch { /* best effort */ }
    }
    let currentId = localStorage.getItem(keys.current);
    // A poisoned current id (e.g. "__proto__") must never reach an object
    // key or enforceConversationCap; the JSON paths already filter these.
    if (currentId && DANGEROUS_KEYS.has(currentId)) currentId = null;

    /** Superseded keys may only be dropped once their data lives in v4 on disk. */
    const removeSupersededKeys = () => {
      localStorage.removeItem(UNSCOPED_LEGACY_CONVERSATIONS_KEY);
      localStorage.removeItem(UNSCOPED_LEGACY_CURRENT_KEY);
      localStorage.removeItem(keys.legacyStoreV3);
      localStorage.removeItem(keys.legacyCurrentV3);
      localStorage.removeItem(keys.legacyConversations);
      localStorage.removeItem(keys.legacyCurrent);
    };

    if (store) {
      removeSupersededKeys();
    } else {
      // One-time v3 → v4 migration. Preserve deletion state as well as the
      // transcript; otherwise a deleted chat could reappear from another tab.
      const v3 = parseV3Store(localStorage.getItem(keys.legacyStoreV3));
      if (v3) store = upgradeV3Store(v3);
      const v3Current = localStorage.getItem(keys.legacyCurrentV3);
      if (v3Current && !DANGEROUS_KEYS.has(v3Current) && !currentId) currentId = v3Current;

      if (!store) {
        // Older one-time v2 → v4 migration.
        store = emptyStore();
        store.conversations = parseConversationMap(localStorage.getItem(keys.legacyConversations));
        const legacyCurrent = localStorage.getItem(keys.legacyCurrent);
        if (legacyCurrent && !DANGEROUS_KEYS.has(legacyCurrent) && !currentId) currentId = legacyCurrent;
      }

      let persisted = false;
      try {
        localStorage.setItem(keys.store, serializeStore(store));
        persisted = true;
      } catch { /* retried below with a cap-reduced store */ }
      if (!persisted && currentId && !DANGEROUS_KEYS.has(currentId)) {
        try {
          const reduced = emptyStore();
          reduced.conversations = enforceConversationCap(store.conversations, currentId);
          reduced.tombstones = store.tombstones;
          reduced.pendingServerDeletions = store.pendingServerDeletions;
          localStorage.setItem(keys.store, serializeStore(reduced));
          store = reduced;
          persisted = true;
        } catch { /* legacy blobs stay intact for the next attempt */ }
      }
      if (persisted) {
        try {
          if (currentId) localStorage.setItem(keys.current, currentId);
        } catch { /* non-fatal: saveStore rewrites it */ }
        removeSupersededKeys();
      } else {
        console.warn('Local chat storage is full; legacy chat history kept in place for a later migration retry.');
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
  /**
   * Conversation ids dropped by cap enforcement (not quota eviction). Callers
   * tombstone these in the same commit; leaving them merely absent let another
   * tab merge them straight back from its own disk state.
   */
  trimmedIds: string[];
  /** The store as actually persisted (post cap, GC, and eviction). */
  store: ChatStoreV4;
}

/**
 * Persists the store: merges the latest on-disk envelope before every write,
 * enforces the cap exactly, and on quota pressure evicts unpinned conversations
 * before pinned ones (oldest first within each group). Deletion markers are not
 * aged out locally: an offline tab can return long after a fixed TTL, and an
 * unconfirmed server deletion must still defeat that stale transcript.
 */
export const saveStore = (
  userId: string,
  store: ChatStoreV4,
  currentId: string,
): SaveResult => {
  const keys = storageKeys(userId);
  let onDisk: ChatStoreV4 | null;
  try {
    onDisk = parseStore(localStorage.getItem(keys.store));
  } catch (error) {
    console.warn('Failed to read chat history before saving:', error);
    return { persisted: false, evictedIds: [], trimmedIds: [], store: applyTombstones(store) };
  }
  let prepared: ChatStoreV4 = onDisk ? mergeStores(store, onDisk) : applyTombstones(store);

  /** Ids dropped by cap enforcement in the current pass. */
  const collectTrimmed = (before: ConversationMap): string[] => {
    const kept = enforceConversationCap(before, currentId);
    if (Object.keys(kept).length === Object.keys(before).length) return [];
    return Object.keys(before).filter(id => !(id in kept));
  };
  let trimmedIds = collectTrimmed(prepared.conversations);
  prepared = {
    ...prepared,
    conversations: enforceConversationCap(prepared.conversations, currentId),
  };

  const evictedIds: string[] = [];
  for (;;) {
    try {
      // A storage event may land between React's state update and this save.
      // Re-read immediately before each write and re-union deletions so a
      // stale tab cannot overwrite a newer tombstone or retry marker.
      const latestDisk = parseStore(localStorage.getItem(keys.store));
      if (latestDisk) {
        prepared = mergeStores(prepared, latestDisk);
        if (evictedIds.length) {
          const conversations = { ...prepared.conversations };
          for (const id of evictedIds) delete conversations[id];
          prepared = { ...prepared, conversations };
        }
        trimmedIds = [...new Set([...trimmedIds, ...collectTrimmed(prepared.conversations)])];
        prepared = {
          ...prepared,
          conversations: enforceConversationCap(prepared.conversations, currentId),
        };
      }
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
      return { persisted: true, evictedIds, trimmedIds, store: prepared };
    } catch (error) {
      if (!isQuotaError(error)) {
        console.warn('Failed to persist chat history:', error);
        return { persisted: false, evictedIds, trimmedIds, store: prepared };
      }
      const evictable = Object.values(prepared.conversations)
        .filter(conversation => conversation.id !== currentId)
        .sort((a, b) => {
          const pinnedDifference = Number(Boolean(a.pinnedAt)) - Number(Boolean(b.pinnedAt));
          return pinnedDifference !== 0 ? pinnedDifference : a.updatedAt - b.updatedAt;
        });
      if (!evictable.length) {
        return { persisted: false, evictedIds, trimmedIds, store: prepared };
      }
      const oldest = evictable[0];
      evictedIds.push(oldest.id);
      const conversations = { ...prepared.conversations };
      delete conversations[oldest.id];
      prepared = { ...prepared, conversations };
    }
  }
};
