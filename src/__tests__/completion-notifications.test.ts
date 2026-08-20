// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announceCompletedConversation,
  clearCompletionAttention,
  getCompletionNotificationPreference,
  installCompletionAttentionListeners,
  requestCompletionNotifications,
  setCompletionNotificationPreference,
} from '../services/completionNotifications';

const originalNotification = Object.getOwnPropertyDescriptor(window, 'Notification');
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
};

beforeEach(() => {
  const storage = memoryStorage();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  document.title = 'WindowsForum';
});

afterEach(() => {
  clearCompletionAttention();
  window.localStorage.clear();
  document.title = 'WindowsForum';
  if (originalNotification) Object.defineProperty(window, 'Notification', originalNotification);
  else Reflect.deleteProperty(window, 'Notification');
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  vi.restoreAllMocks();
});

describe('completion attention', () => {
  it('stores the opt-in only after browser permission is granted', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: Object.assign(vi.fn(), { permission: 'granted', requestPermission }),
    });

    await expect(requestCompletionNotifications()).resolves.toBe('granted');
    expect(getCompletionNotificationPreference()).toBe('enabled');
  });

  it('badges a hidden tab and sends no system notification when disabled', () => {
    const NotificationMock = vi.fn();
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() });
    Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationMock });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    announceCompletedConversation();
    expect(document.title).toBe('(1) WindowsForum');
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('notifies an opted-in hidden tab and clears the badge on visibility', () => {
    const close = vi.fn();
    const NotificationMock = vi.fn().mockImplementation(() => ({ close, onclick: null }));
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() });
    Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationMock });
    Object.defineProperty(document, 'visibilityState', { configurable: true, writable: true, value: 'hidden' });
    setCompletionNotificationPreference('enabled');

    const uninstall = installCompletionAttentionListeners();
    announceCompletedConversation();
    expect(NotificationMock).toHaveBeenCalledWith('WindowsForum Assistant', expect.objectContaining({
      body: 'Your answer is ready.',
    }));
    expect(document.title).toBe('(1) WindowsForum');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.title).toBe('WindowsForum');
    uninstall();
  });
});
