import React, { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { ChatWindow } from './components/ChatWindow';
import { APIError, ChatAPI } from './services/api';
import { ENV } from './config/env';
import './App.css';

interface ChatIdentity {
  userAvatar: string;
  userName: string;
  userId: string;
}

const ACTIVATION_BURST_MS = 500;

/**
 * Main App Component — resolves the XenForo identity and initializes chat.
 *
 * The identity is revalidated when a cached page is restored or the page is
 * reactivated after the last verification has gone stale. Correlated focus and
 * visibility events are treated as one activation. While revalidation is in
 * flight the existing history stays mounted in a dimension-preserving shell,
 * and ChatWindow is keyed by the resolved user id so an identity change
 * remounts it onto that user's own store.
 *
 * A revalidation that only fails transiently (network/timeout/5xx) keeps the
 * established session mounted; only an authoritative signal — a successful
 * response for a different user, or a non-retryable error — tears it down.
 */
const App: React.FC = () => {
  const domain = ENV.getCurrentDomain();
  const [identity, setIdentity] = useState<ChatIdentity | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [revalidating, setRevalidating] = useState(false);
  const [revalidationNotice, setRevalidationNotice] = useState('');
  const identityRequestRef = useRef<Promise<void> | null>(null);
  const identityRef = useRef<ChatIdentity | null>(null);
  const lastActivationAtRef = useRef(Number.NEGATIVE_INFINITY);
  const revalidationQueuedRef = useRef(false);
  const focusBeforeRevalidationRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);

  const fetchIdentity = useCallback((): Promise<void> => {
    if (identityRequestRef.current) return identityRequestRef.current;

    const request = (async () => {
      try {
        const data = await ChatAPI.getUserData();
        const resolvedId = data.user_id === undefined || data.user_id === null
          ? ''
          : String(data.user_id);
        if (!resolvedId || resolvedId === '0') {
          // An authoritative "no valid identity" answer, not a transient blip.
          throw new APIError('The server did not return a stable chat identity.', {
            code: 'unstable_identity',
            retryable: false,
          });
        }
        const nextIdentity = {
          userAvatar: data.avatar || `${domain}/images/default-avatar.webp`,
          userName: data.name || 'Guest',
          userId: resolvedId,
        };
        identityRef.current = nextIdentity;
        setIdentity(nextIdentity);
        setIdentityError('');
        setRevalidationNotice('');
      } catch (error) {
        console.error('Error fetching user data:', error);
        const established = identityRef.current;
        const authoritative = error instanceof APIError && !error.retryable;
        if (established && !authoritative) {
          // Transient revalidation failure (network/timeout/5xx): keep the
          // working chat and any in-flight response mounted; the next focus
          // revalidates again.
          setRevalidationNotice('Could not recheck your session just now; still using your last verified session.');
        } else {
          identityRef.current = null;
          setIdentity(null);
          setIdentityError('Chat could not verify your WindowsForum session. No local history was loaded.');
        }
      } finally {
        identityRequestRef.current = null;
      }
    })();

    identityRequestRef.current = request;
    return request;
  }, [domain]);

  const revalidateIdentity = useCallback(() => {
    const established = identityRef.current;
    if (!established) return; // Initial load path owns this state.
    if (identityRequestRef.current) {
      // A distinct activation arrived during the request. Run one more check
      // after it settles so an account switch mid-request is not missed.
      revalidationQueuedRef.current = true;
      return;
    }

    const activeElement = document.activeElement;
    focusBeforeRevalidationRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null;
    restoreFocusRef.current = false;
    setRevalidating(true);

    const runRevalidation = async () => {
      do {
        revalidationQueuedRef.current = false;
        await fetchIdentity();
      } while (revalidationQueuedRef.current && identityRef.current !== null);
    };

    void runRevalidation().finally(() => {
      const identityUnchanged = identityRef.current?.userId === established.userId;
      const currentFocus = document.activeElement;
      const focusWasNotMovedElsewhere = currentFocus === focusBeforeRevalidationRef.current
        || currentFocus === document.body
        || currentFocus === document.documentElement
        || currentFocus === null;
      restoreFocusRef.current = identityUnchanged && focusWasNotMovedElsewhere;
      if (!identityUnchanged) focusBeforeRevalidationRef.current = null;
      setRevalidating(false);
    });
  }, [fetchIdentity]);

  useEffect(() => {
    if (revalidating || !restoreFocusRef.current) return;

    restoreFocusRef.current = false;
    const element = focusBeforeRevalidationRef.current;
    focusBeforeRevalidationRef.current = null;
    if (element?.isConnected) element.focus({ preventScroll: true });
  }, [revalidating]);

  const retryIdentity = useCallback(() => {
    setIdentityError('');
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    const onActivation = () => {
      const now = Date.now();
      const timeSinceActivation = now - lastActivationAtRef.current;
      if (timeSinceActivation >= 0 && timeSinceActivation <= ACTIVATION_BURST_MS) return;
      lastActivationAtRef.current = now;
      revalidateIdentity();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onActivation();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onActivation();
    };
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onActivation);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onActivation);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [revalidateIdentity]);

  if (identityError) {
    return (
      <Box className="wf-app" sx={{ display: 'grid', placeItems: 'center', p: 3 }}>
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" onClick={retryIdentity}>Retry</Button>}
        >
          {identityError}
        </Alert>
      </Box>
    );
  }

  if (!identity) {
    return (
      <Box className="wf-app" sx={{ display: 'grid', placeItems: 'center' }} aria-label="Loading chat identity">
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box className="wf-app" sx={{ position: 'relative' }} aria-busy={revalidating}>
      {revalidating && (
        <Box
          aria-label="Rechecking chat identity"
          aria-live="polite"
          role="status"
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: (t) => t.zIndex.modal + 2,
            display: 'grid',
            placeItems: 'center',
            backgroundColor: 'background.default',
          }}
        >
          <Box sx={{ display: 'grid', justifyItems: 'center', gap: 1 }}>
            <CircularProgress size={28} aria-hidden="true" />
            <Box component="span" sx={{ typography: 'body2' }}>Rechecking your session…</Box>
          </Box>
        </Box>
      )}
      {revalidationNotice && !revalidating && (
        <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: (t) => t.zIndex.modal + 1, p: 1 }}>
          <Alert severity="warning" onClose={() => setRevalidationNotice('')}>
            {revalidationNotice}
          </Alert>
        </Box>
      )}
      {/* Visually hidden, not collapsed or unmounted: revalidation must not
          shift the XenForo page or kill an in-flight response. */}
      <Box className="wf-app-view" sx={{ visibility: revalidating ? 'hidden' : 'visible' }} aria-hidden={revalidating || undefined}>
        <ChatWindow key={identity.userId} {...identity} />
      </Box>
    </Box>
  );
};

export default App;
