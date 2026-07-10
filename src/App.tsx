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

/**
 * Main App Component — resolves the XenForo identity and initializes chat.
 *
 * The identity is revalidated whenever the page is restored or refocused
 * (pageshow, focus, visibility). While revalidation is in flight the existing
 * history is hidden behind a full-viewport overlay — another account may have
 * logged in — and ChatWindow is keyed by the resolved user id, so an identity
 * change remounts it onto that user's own store.
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
  const revalidationQueuedRef = useRef(false);
  const revalidateRef = useRef<() => void>(() => {});

  useEffect(() => { identityRef.current = identity; }, [identity]);

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
        setIdentity({
          userAvatar: data.avatar || `${domain}/images/default-avatar.webp`,
          userName: data.name || 'Guest',
          userId: resolvedId,
        });
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
    if (!identityRef.current) return; // Initial load path owns this state.
    if (identityRequestRef.current) {
      // A check is already running; remember to run once more when it settles
      // so an account switch that happened mid-request is not missed.
      revalidationQueuedRef.current = true;
      return;
    }
    setRevalidating(true);
    void fetchIdentity().finally(() => {
      setRevalidating(false);
      if (revalidationQueuedRef.current) {
        revalidationQueuedRef.current = false;
        revalidateRef.current();
      }
    });
  }, [fetchIdentity]);

  useEffect(() => { revalidateRef.current = revalidateIdentity; }, [revalidateIdentity]);

  const retryIdentity = useCallback(() => {
    setIdentityError('');
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    const onRevalidate = () => revalidateIdentity();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') revalidateIdentity();
    };
    window.addEventListener('pageshow', onRevalidate);
    window.addEventListener('focus', onRevalidate);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pageshow', onRevalidate);
      window.removeEventListener('focus', onRevalidate);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [revalidateIdentity]);

  if (identityError) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 3 }}>
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
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }} aria-label="Loading chat identity">
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <>
      {revalidating && (
        // A full-viewport overlay above the MUI modal layer, so it also covers
        // the history drawer (which portals into the wrapper, not into the
        // hidden Box below) while the session is being rechecked.
        <Box
          aria-label="Rechecking chat identity"
          sx={{
            position: 'fixed',
            inset: 0,
            zIndex: (t) => t.zIndex.modal + 2,
            display: 'grid',
            placeItems: 'center',
            backgroundColor: 'background.default',
          }}
        >
          <CircularProgress size={28} />
        </Box>
      )}
      {revalidationNotice && !revalidating && (
        <Box sx={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: (t) => t.zIndex.modal + 1, p: 1 }}>
          <Alert severity="warning" onClose={() => setRevalidationNotice('')}>
            {revalidationNotice}
          </Alert>
        </Box>
      )}
      {/* Hidden, not unmounted: a same-user refocus must not kill an in-flight
          response. An identity change remounts via the key. */}
      <Box sx={{ display: revalidating ? 'none' : 'contents' }}>
        <ChatWindow key={identity.userId} {...identity} />
      </Box>
    </>
  );
};

export default App;
