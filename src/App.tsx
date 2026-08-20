import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { APIError, ChatAPI } from './services/api';
import { installClientTelemetry } from './services/telemetry';
import { loadLazyModule } from './services/lazyImport';
import { ENV } from './config/env';
import type { UserData } from './types';
import './App.css';

interface ChatIdentity {
  userAvatar: string;
  userName: string;
  userId: string;
  identityId: string;
}

const ACTIVATION_BURST_MS = 500;
export const IDENTITY_FRESHNESS_MS = 30_000;

interface AppProps {
  initialIdentityPromise?: Promise<UserData> | null;
}

const ChatWindow = lazy(() => loadLazyModule(async () => {
  const module = await import('./components/ChatWindow');
  return { default: module.ChatWindow };
}));

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
const App: React.FC<AppProps> = ({ initialIdentityPromise = null }) => {
  const domain = ENV.getCurrentDomain();
  const [identity, setIdentity] = useState<ChatIdentity | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [revalidating, setRevalidating] = useState(false);
  const [revalidationNotice, setRevalidationNotice] = useState('');
  const [identityLocked, setIdentityLocked] = useState(false);
  const [identityVerificationGeneration, setIdentityVerificationGeneration] = useState(0);
  const identityRequestRef = useRef<Promise<void> | null>(null);
  const initialIdentityRequestRef = useRef(initialIdentityPromise);
  const identityRef = useRef<ChatIdentity | null>(null);
  const lastIdentityVerifiedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastActivationAtRef = useRef(Number.NEGATIVE_INFINITY);
  const revalidationQueuedRef = useRef(false);
  const focusBeforeRevalidationRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);

  const fetchIdentity = useCallback((): Promise<void> => {
    if (identityRequestRef.current) return identityRequestRef.current;

    const request = (async () => {
      try {
        const bootstrapRequest = initialIdentityRequestRef.current;
        initialIdentityRequestRef.current = null;
        const data = await (bootstrapRequest ?? ChatAPI.getUserData());
        if (typeof data.csrf_token === 'string' && data.csrf_token.trim()) {
          ChatAPI.setCsrfToken(data.csrf_token);
        }
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
        const identityId = typeof data.identity_id === 'string' ? data.identity_id : '';
        if (!/^[a-f0-9]{64}$/.test(identityId)) {
          throw new APIError('The server did not return a stable identity marker.', {
            code: 'unstable_identity',
            retryable: false,
          });
        }
        const nextIdentity = {
          userAvatar: data.avatar || `${domain}/images/default-avatar.webp`,
          userName: data.name || 'Guest',
          userId: resolvedId,
          identityId,
        };
        ChatAPI.setExpectedIdentityId(identityId);
        identityRef.current = nextIdentity;
        lastIdentityVerifiedAtRef.current = Date.now();
        setIdentity(nextIdentity);
        setIdentityError('');
        setRevalidationNotice('');
        setIdentityLocked(false);
        setIdentityVerificationGeneration(value => value + 1);
      } catch (error) {
        console.error('Error fetching user data:', error);
        const established = identityRef.current;
        const authoritative = error instanceof APIError && !error.retryable;
        if (established && !authoritative) {
          // Transient revalidation failure (network/timeout/5xx): keep the
          // working chat and any in-flight response mounted; the next focus
          // revalidates again.
          setRevalidationNotice('Chat is locked until your WindowsForum session can be verified again.');
          setIdentityLocked(true);
        } else {
          ChatAPI.setExpectedIdentityId('');
          ChatAPI.setCsrfToken('');
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

  const revalidateIdentity = useCallback((force = false) => {
    const established = identityRef.current;
    if (!established) return; // Initial load path owns this state.
    if (!force && Date.now() - lastIdentityVerifiedAtRef.current < IDENTITY_FRESHNESS_MS) return;
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

  useEffect(() => installClientTelemetry(), []);

  useEffect(() => {
    const onActivation = () => {
      const now = Date.now();
      const timeSinceActivation = now - lastActivationAtRef.current;
      if (timeSinceActivation >= 0 && timeSinceActivation <= ACTIVATION_BURST_MS) return;
      lastActivationAtRef.current = now;
      revalidateIdentity();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) revalidateIdentity(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onActivation();
    };
    const onReconnect = () => revalidateIdentity(true);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onActivation);
    window.addEventListener('online', onReconnect);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onActivation);
      window.removeEventListener('online', onReconnect);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [revalidateIdentity]);

  useEffect(() => {
    const handleIdentityChanged = () => {
      setIdentityLocked(true);
      setRevalidationNotice('Your WindowsForum session changed. Rechecking before chat can continue.');
      revalidateIdentity(true);
    };
    window.addEventListener('wf-chat-identity-changed', handleIdentityChanged);
    return () => window.removeEventListener('wf-chat-identity-changed', handleIdentityChanged);
  }, [revalidateIdentity]);

  if (identityError) {
    return (
      <Box className="wf-app-center" sx={{ display: 'grid', placeItems: 'center', p: 3 }}>
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
      <Box className="wf-app-center" sx={{ display: 'grid', placeItems: 'center' }} aria-label="Loading chat identity">
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box className="wf-app" sx={{ position: 'relative' }} aria-busy={revalidating || identityLocked}>
      {(revalidating || identityLocked) && (
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
            {revalidating && <CircularProgress size={28} aria-hidden="true" />}
            <Box component="span" sx={{ typography: 'body2' }}>
              {revalidating ? 'Rechecking your session…' : 'Chat is locked until your session is verified.'}
            </Box>
            {!revalidating && (
              <Button size="small" variant="contained" onClick={() => revalidateIdentity(true)}>Retry verification</Button>
            )}
          </Box>
        </Box>
      )}
      {revalidationNotice && !revalidating && !identityLocked && (
        <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: (t) => t.zIndex.modal + 1, p: 1 }}>
          <Alert severity="warning" onClose={() => setRevalidationNotice('')}>
            {revalidationNotice}
          </Alert>
        </Box>
      )}
      {/* Visually hidden, not collapsed or unmounted: revalidation must not
          shift the XenForo page or kill an in-flight response. */}
      <Box className="wf-app-view" sx={{ visibility: revalidating || identityLocked ? 'hidden' : 'visible' }} aria-hidden={revalidating || identityLocked || undefined}>
        <Suspense fallback={(
          <Box className="wf-app-center" sx={{ display: 'grid', placeItems: 'center' }} aria-label="Loading chat interface">
            <CircularProgress size={28} />
          </Box>
        )}>
          <ChatWindow
            key={identity.userId}
            userAvatar={identity.userAvatar}
            userName={identity.userName}
            userId={identity.userId}
            identityVerificationGeneration={identityVerificationGeneration}
          />
        </Suspense>
      </Box>
    </Box>
  );
};

export default App;
