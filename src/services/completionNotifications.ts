const STORAGE_KEY = 'wf_chat_completion_notifications:v1';
const TITLE_BADGE = '(1) ';

export type CompletionNotificationPreference = 'enabled' | 'disabled';

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const getCompletionNotificationPreference = (): CompletionNotificationPreference => {
  try {
    return storage()?.getItem(STORAGE_KEY) === 'enabled' ? 'enabled' : 'disabled';
  } catch {
    return 'disabled';
  }
};

export const setCompletionNotificationPreference = (
  preference: CompletionNotificationPreference,
): void => {
  try { storage()?.setItem(STORAGE_KEY, preference); } catch { /* device preference is optional */ }
};

export const completionNotificationsSupported = (): boolean => (
  typeof window !== 'undefined' && 'Notification' in window
);

export const requestCompletionNotifications = async (): Promise<NotificationPermission | 'unsupported'> => {
  if (!completionNotificationsSupported()) return 'unsupported';
  const permission = await window.Notification.requestPermission();
  setCompletionNotificationPreference(permission === 'granted' ? 'enabled' : 'disabled');
  return permission;
};

let originalTitle: string | null = null;
let listenersInstalled = false;

export const clearCompletionAttention = (): void => {
  if (originalTitle !== null && typeof document !== 'undefined') {
    document.title = originalTitle;
    originalTitle = null;
  }
};

export const installCompletionAttentionListeners = (): (() => void) => {
  if (listenersInstalled || typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }
  listenersInstalled = true;
  const clearWhenVisible = () => {
    if (document.visibilityState === 'visible') clearCompletionAttention();
  };
  window.addEventListener('focus', clearCompletionAttention);
  document.addEventListener('visibilitychange', clearWhenVisible);
  return () => {
    window.removeEventListener('focus', clearCompletionAttention);
    document.removeEventListener('visibilitychange', clearWhenVisible);
    listenersInstalled = false;
    clearCompletionAttention();
  };
};

/** Draw attention only when the user is elsewhere; never interrupts the active chat. */
export const announceCompletedConversation = (): void => {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;

  if (originalTitle === null) originalTitle = document.title.replace(/^\(\d+\)\s+/, '');
  document.title = `${TITLE_BADGE}${originalTitle}`;

  if (
    getCompletionNotificationPreference() !== 'enabled'
    || !completionNotificationsSupported()
    || window.Notification.permission !== 'granted'
  ) return;

  try {
    const notification = new window.Notification('WindowsForum Assistant', {
      body: 'Your answer is ready.',
      tag: 'wf-chat-complete',
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // A browser may revoke notification capability between the permission
    // check and construction. The title badge still provides feedback.
  }
};
