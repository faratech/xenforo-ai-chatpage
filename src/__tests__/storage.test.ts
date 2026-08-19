import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStoreV4, Conversation } from '../types';
import {
  applyTombstones,
  emptyStore,
  enforceConversationCap,
  loadStore,
  mergeStores,
  parseStore,
  saveStore,
  serializeStore,
  storageKeys,
} from '../services/storage';

interface FakeStorage extends Storage {
  /** When set, setItem for this key throws QuotaExceededError this many times. */
  failWrites: (key: string, times: number) => void;
}

const installFakeStorage = (): FakeStorage => {
  const values = new Map<string, string>();
  let failKey: string | null = null;
  let failCount = 0;
  const storage: FakeStorage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => {
      if (key === failKey && failCount > 0) {
        failCount -= 1;
        const error = new DOMException('quota exceeded', 'QuotaExceededError');
        throw error;
      }
      values.set(key, String(value));
    },
    failWrites: (key, times) => { failKey = key; failCount = times; },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return storage;
};

const conversation = (id: string, updatedAt: number, overrides: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `Conversation ${id}`,
  messages: [{
    id: `msg_${id}`,
    role: 'user',
    rawContent: `content ${id}`,
    timestamp: updatedAt,
    status: 'complete',
  }],
  createdAt: updatedAt,
  updatedAt,
  ...overrides,
});

let storage: FakeStorage;

beforeEach(() => {
  storage = installFakeStorage();
  vi.restoreAllMocks();
});

describe('storage migrations', () => {
  it('migrates the per-user v2 map into a v4 envelope exactly once', () => {
    const keys = storageKeys('42');
    const legacy = {
      conv_1: {
        ...conversation('conv_1', 1_000),
        messages: [{
          id: 'm1',
          role: 'ai',
          rawContent: 'hello',
          timestamp: 1_000,
          // Legacy file-only annotation shape must migrate to the union.
          annotations: [{ index: 0, filename: 'guide.pdf', fileId: 'file_9' }],
        }],
      },
    };
    storage.setItem(keys.legacyConversations, JSON.stringify(legacy));
    storage.setItem(keys.legacyCurrent, 'conv_1');

    const loaded = loadStore('42');
    expect(loaded.unavailable).toBe(false);
    expect(loaded.currentId).toBe('conv_1');
    expect(loaded.store.conversations.conv_1.messages[0].annotations).toEqual([
      { type: 'file_citation', filename: 'guide.pdf', fileId: 'file_9' },
    ]);
    // Legacy keys are gone and a v4 envelope exists.
    expect(storage.getItem(keys.legacyConversations)).toBeNull();
    expect(storage.getItem(keys.legacyCurrent)).toBeNull();
    expect(parseStore(storage.getItem(keys.store))?.version).toBe(4);
  });

  it('upgrades v3 while preserving conversations, tombstones, and pending deletions', () => {
    const keys = storageKeys('42');
    storage.setItem(keys.legacyStoreV3, JSON.stringify({
      version: 3,
      conversations: { conv_1: conversation('conv_1', 1_000) },
      tombstones: { conv_gone: 2_000 },
      pendingServerDeletions: { conv_pending: 3_000 },
    }));
    storage.setItem(keys.legacyCurrentV3, 'conv_1');

    const loaded = loadStore('42');

    expect(loaded.store.version).toBe(4);
    expect(loaded.currentId).toBe('conv_1');
    expect(loaded.store.conversations.conv_1).toBeDefined();
    expect(loaded.store.tombstones).toEqual({ conv_gone: 2_000 });
    expect(loaded.store.pendingServerDeletions).toEqual({ conv_pending: 3_000 });
    expect(storage.getItem(keys.legacyStoreV3)).toBeNull();
    expect(storage.getItem(keys.legacyCurrentV3)).toBeNull();
  });

  it('round-trips drafts and support metadata in v4', () => {
    const detailed = conversation('conv_1', 1_000, {
      draft: 'unfinished question',
      draftUpdatedAt: 1_500,
      cloudRevision: 7,
      cloudUpdatedAt: 1_400,
      cloudSyncedLocalUpdatedAt: 1_000,
      messages: [{
        id: 'msg_ai',
        role: 'ai',
        rawContent: 'answer',
        timestamp: 1_000,
        status: 'complete',
        responseId: 'resp_1',
        turnId: 'turn_1',
        activities: [{ id: 'search_1', label: 'Searched forum', state: 'done', detail: 'drivers' }],
        attachments: [{ id: 'file_1', name: 'report.txt', mime: 'text/plain', size: 12 }],
      }],
    });
    saveStore('42', { ...emptyStore(), conversations: { conv_1: detailed } }, 'conv_1');

    const reloaded = loadStore('42').store.conversations.conv_1;
    expect(reloaded.draft).toBe('unfinished question');
    expect(reloaded.draftUpdatedAt).toBe(1_500);
    expect(reloaded).toMatchObject({
      cloudRevision: 7,
      cloudUpdatedAt: 1_400,
      cloudSyncedLocalUpdatedAt: 1_000,
    });
    expect(reloaded.messages[0]).toMatchObject({
      responseId: 'resp_1',
      turnId: 'turn_1',
      activities: [{ id: 'search_1', label: 'Searched forum', state: 'done', detail: 'drivers' }],
      attachments: [{ id: 'file_1', name: 'report.txt', mime: 'text/plain', size: 12 }],
    });
  });

  it('frees the legacy blob before writing v4 so a quota failure cannot strand or mass-evict it', () => {
    const keys = storageKeys('42');
    const legacy = {
      conv_1: conversation('conv_1', 1_000),
      conv_2: conversation('conv_2', 2_000),
    };
    storage.setItem(keys.legacyConversations, JSON.stringify(legacy));
    storage.setItem(keys.legacyCurrent, 'conv_2');
    // The v4 envelope write fails once (quota) during migration.
    storage.failWrites(keys.store, 1);

    const loaded = loadStore('42');
    // Legacy keys are removed regardless of the failed write — not orphaned.
    expect(storage.getItem(keys.legacyConversations)).toBeNull();
    expect(storage.getItem(keys.legacyCurrent)).toBeNull();
    // The parsed history is still in memory, fully intact (nothing evicted).
    expect(Object.keys(loaded.store.conversations).sort()).toEqual(['conv_1', 'conv_2']);

    // The next save now fits without evicting, since the legacy blob is gone.
    const result = saveStore('42', loaded.store, 'conv_2');
    expect(result.persisted).toBe(true);
    expect(result.evictedIds).toEqual([]);
  });

  it('ignores a poisoned current id from localStorage', () => {
    const keys = storageKeys('42');
    saveStore('42', {
      ...emptyStore(),
      conversations: { conv_1: conversation('conv_1', 1_000) },
    }, 'conv_1');
    storage.setItem(keys.current, '__proto__');
    const loaded = loadStore('42');
    expect(loaded.currentId).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops unscoped pre-v2 keys that cannot be assigned to a user', () => {
    storage.setItem('chat_conversations', '{"leaked": {}}');
    storage.setItem('current_conversation_id', 'leaked');
    loadStore('42');
    expect(storage.getItem('chat_conversations')).toBeNull();
    expect(storage.getItem('current_conversation_id')).toBeNull();
  });

  it('rejects dangerous and malformed store content', () => {
    expect(parseStore('{"version":4,"conversations":{"__proto__":{}}}')?.conversations).toEqual({});
    expect(parseStore('{"version":3,"conversations":{}}')).toBeNull();
    expect(parseStore('{"version":2,"conversations":{}}')).toBeNull();
    expect(parseStore('not json')).toBeNull();
    expect(parseStore(null)).toBeNull();
  });
});

describe('canonical serialization (cross-tab ping-pong guard)', () => {
  it('serializes identical content identically regardless of current conversation', () => {
    const conversations = {
      conv_a: conversation('conv_a', 2_000),
      conv_b: conversation('conv_b', 1_000),
      conv_c: conversation('conv_c', 3_000),
    };
    // Two tabs, different current conversations → cap orders them differently,
    // but the persisted bytes must match so writes converge to a fixpoint.
    const tabA = applyTombstones({ ...emptyStore(), conversations: enforceConversationCap(conversations, 'conv_a') });
    const tabB = applyTombstones({ ...emptyStore(), conversations: enforceConversationCap(conversations, 'conv_c') });
    expect(serializeStore(tabA)).toBe(serializeStore(tabB));
  });

  it('does not rewrite localStorage when the content is unchanged', () => {
    const store: ChatStoreV4 = {
      ...emptyStore(),
      conversations: { conv_1: conversation('conv_1', 1_000) },
    };
    saveStore('42', store, 'conv_1');
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem');
    // A second save with the same content (different current id) must be a no-op.
    saveStore('42', store, 'conv_1');
    const storeWrites = setItemSpy.mock.calls.filter(([key]) => key === storageKeys('42').store);
    expect(storeWrites).toHaveLength(0);
  });
});

describe('tombstones', () => {
  it('always removes tombstoned conversations, regardless of timestamps', () => {
    const store: ChatStoreV4 = {
      ...emptyStore(),
      conversations: { conv_1: conversation('conv_1', 5_000), conv_2: conversation('conv_2', 1_000) },
      tombstones: { conv_1: 2_000 },
    };
    expect(Object.keys(applyTombstones(store).conversations)).toEqual(['conv_2']);
  });

  it('merges cross-tab stores: tombstones union, newest conversation wins', () => {
    const local: ChatStoreV4 = {
      ...emptyStore(),
      conversations: {
        conv_a: conversation('conv_a', 2_000, { title: 'local newer' }),
        conv_b: conversation('conv_b', 1_000),
      },
      tombstones: { conv_x: 500 },
    };
    const remote: ChatStoreV4 = {
      ...emptyStore(),
      conversations: {
        conv_a: conversation('conv_a', 1_500, { title: 'remote older' }),
        conv_c: conversation('conv_c', 3_000),
      },
      tombstones: { conv_b: 4_000, conv_x: 900 },
    };

    const merged = mergeStores(local, remote);
    expect(merged.conversations.conv_a.title).toBe('local newer');
    expect(merged.conversations.conv_c).toBeDefined();
    // conv_b was deleted in the other tab: the deletion propagates.
    expect(merged.conversations.conv_b).toBeUndefined();
    expect(merged.tombstones).toEqual({ conv_x: 900, conv_b: 4_000 });
  });

  it('re-reads on-disk deletion state before a stale tab writes', () => {
    const keys = storageKeys('42');
    const deletedAt = Date.now();
    saveStore('42', {
      ...emptyStore(),
      tombstones: { conv_deleted: deletedAt },
      pendingServerDeletions: { conv_deleted: deletedAt },
    }, 'conv_other');

    // This simulates a tab that was suspended before the delete and wakes up
    // with an old full transcript and no deletion maps in memory.
    saveStore('42', {
      ...emptyStore(),
      conversations: { conv_deleted: conversation('conv_deleted', deletedAt - 1_000) },
    }, 'conv_deleted');

    const persisted = parseStore(storage.getItem(keys.store));
    expect(persisted?.conversations.conv_deleted).toBeUndefined();
    expect(persisted?.tombstones.conv_deleted).toBe(deletedAt);
    expect(persisted?.pendingServerDeletions.conv_deleted).toBe(deletedAt);
  });

  it('merges draft and transcript clocks independently across tabs', () => {
    const localConversation = conversation('conv_a', 1_000, {
      title: 'older transcript',
      draft: 'newer local draft',
      draftUpdatedAt: 4_000,
      cloudRevision: 8,
      cloudUpdatedAt: 3_500,
      cloudSyncedLocalUpdatedAt: 1_000,
    });
    const remoteConversation = conversation('conv_a', 3_000, {
      title: 'newer transcript',
      draft: 'older remote draft',
      draftUpdatedAt: 2_000,
      cloudRevision: 4,
      cloudUpdatedAt: 3_000,
      cloudSyncedLocalUpdatedAt: 3_000,
    });

    const merged = mergeStores(
      { ...emptyStore(), conversations: { conv_a: localConversation } },
      { ...emptyStore(), conversations: { conv_a: remoteConversation } },
    );

    expect(merged.conversations.conv_a.title).toBe('newer transcript');
    expect(merged.conversations.conv_a.draft).toBe('newer local draft');
    expect(merged.conversations.conv_a.draftUpdatedAt).toBe(4_000);
    expect(merged.conversations.conv_a).toMatchObject({
      cloudRevision: 8,
      cloudUpdatedAt: 3_500,
      cloudSyncedLocalUpdatedAt: 1_000,
    });
  });
});

describe('conversation cap', () => {
  it('enforces the configured cap exactly and always keeps the current conversation', () => {
    const map: Record<string, Conversation> = {};
    for (let index = 0; index < 55; index += 1) {
      map[`conv_${index}`] = conversation(`conv_${index}`, index);
    }
    // conv_0 is the oldest; make it current — it must survive anyway.
    const capped = enforceConversationCap(map, 'conv_0');
    expect(Object.keys(capped)).toHaveLength(50);
    expect(capped.conv_0).toBeDefined();
    // The newest 49 others survive; conv_1 .. conv_5 (oldest) do not.
    expect(capped.conv_5).toBeUndefined();
    expect(capped.conv_54).toBeDefined();
  });
});

describe('quota pressure', () => {
  it('evicts the oldest non-current conversations until the write fits', () => {
    const keys = storageKeys('42');
    const store: ChatStoreV4 = {
      ...emptyStore(),
      conversations: {
        conv_old: conversation('conv_old', 1_000),
        conv_mid: conversation('conv_mid', 2_000),
        conv_new: conversation('conv_new', 3_000),
        conv_current: conversation('conv_current', 500),
      },
    };
    storage.failWrites(keys.store, 2);

    const result = saveStore('42', store, 'conv_current');
    expect(result.persisted).toBe(true);
    // Oldest non-current first; the current conversation is never evicted
    // even though it is the oldest overall.
    expect(result.evictedIds).toEqual(['conv_old', 'conv_mid']);
    const persisted = parseStore(storage.getItem(keys.store));
    expect(Object.keys(persisted?.conversations ?? {}).sort()).toEqual(['conv_current', 'conv_new']);
  });

  it('reports failure when nothing evictable remains', () => {
    const keys = storageKeys('42');
    const store: ChatStoreV4 = {
      ...emptyStore(),
      conversations: { conv_current: conversation('conv_current', 500) },
    };
    storage.failWrites(keys.store, 99);

    const result = saveStore('42', store, 'conv_current');
    expect(result.persisted).toBe(false);
    expect(result.evictedIds).toEqual([]);
  });

  it('continues without persistence when localStorage is unavailable', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = loadStore('42');
    expect(loaded.unavailable).toBe(true);
    expect(loaded.store.conversations).toEqual({});
  });
});

describe('pending server deletions', () => {
  it('round-trips pending deletions through the envelope', () => {
    const store: ChatStoreV4 = {
      ...emptyStore(),
      conversations: { conv_current: conversation('conv_current', 1_000) },
      tombstones: { conv_gone: Date.now() },
      pendingServerDeletions: { conv_gone: Date.now() },
    };
    saveStore('42', store, 'conv_current');

    const reloaded = loadStore('42');
    expect(Object.keys(reloaded.store.pendingServerDeletions)).toEqual(['conv_gone']);
    expect(Object.keys(reloaded.store.tombstones)).toEqual(['conv_gone']);
  });

  it('retains old tombstones so a long-suspended stale tab cannot resurrect history', () => {
    const keys = storageKeys('42');
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const store: ChatStoreV4 = {
      ...emptyStore(),
      conversations: { conv_current: conversation('conv_current', 1_000) },
      tombstones: { conv_ancient: expired, conv_recent: Date.now() },
    };
    saveStore('42', store, 'conv_current');

    const persisted = parseStore(storage.getItem(keys.store));
    expect(Object.keys(persisted?.tombstones ?? {}).sort()).toEqual(['conv_ancient', 'conv_recent']);
  });

  it('never ages out an unconfirmed pending deletion after 30 days', () => {
    const keys = storageKeys('42');
    const queuedAt = Date.now() - 45 * 24 * 60 * 60 * 1000;
    saveStore('42', {
      ...emptyStore(),
      conversations: { conv_current: conversation('conv_current', Date.now()) },
      tombstones: { conv_pending: queuedAt },
      pendingServerDeletions: { conv_pending: queuedAt },
    }, 'conv_current');

    const persisted = parseStore(storage.getItem(keys.store));
    expect(persisted?.tombstones.conv_pending).toBe(queuedAt);
    expect(persisted?.pendingServerDeletions.conv_pending).toBe(queuedAt);
  });

  it('lets a newer confirmation tombstone clear a stale pending marker', () => {
    const queuedAt = Date.now() - 10_000;
    const confirmedAt = queuedAt + 1;
    const merged = mergeStores({
      ...emptyStore(),
      tombstones: { conv_gone: confirmedAt },
    }, {
      ...emptyStore(),
      tombstones: { conv_gone: queuedAt },
      pendingServerDeletions: { conv_gone: queuedAt },
    });

    expect(merged.tombstones.conv_gone).toBe(confirmedAt);
    expect(merged.pendingServerDeletions.conv_gone).toBeUndefined();
  });
});
