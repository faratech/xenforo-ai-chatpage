import React, { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { ChatWindow } from './components/ChatWindow';
import { ChatAPI } from './services/api';
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
 * (pageshow, focus, visibility). While revalidation is in flight the
 * existing history is hidden — another account may have logged in — and
 * ChatWindow is keyed by the resolved user id, so an identity change
 * remounts it onto that user's own store.
 */
const App: React.FC = () => {
  const domain = ENV.getCurrentDomain();
  const [identity, setIdentity] = useState<ChatIdentity | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [revalidating, setRevalidating] = useState(false);
  const identityRequestRef = useRef<Promise<void> | null>(null);
  const identityRef = useRef<ChatIdentity | null>(null);

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
          throw new Error('The server did not return a stable chat identity.');
        }
        setIdentity({
          userAvatar: data.avatar || `${domain}/images/default-avatar.webp`,
          userName: data.name || 'Guest',
          userId: resolvedId,
        });
        setIdentityError('');
      } catch (error) {
        console.error('Error fetching user data:', error);
        setIdentity(null);
        setIdentityError('Chat could not verify your WindowsForum session. No local history was loaded.');
      } finally {
        identityRequestRef.current = null;
      }
    })();

    identityRequestRef.current = request;
    return request;
  }, [domain]);

  const revalidateIdentity = useCallback(() => {
    if (identityRequestRef.current) return;
    if (!identityRef.current) return; // Initial load path handles this state.
    setRevalidating(true);
    void fetchIdentity().finally(() => setRevalidating(false));
  }, [fetchIdentity]);

  const retryIdentity = useCallback(() => {
    setIdentityError('');
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    const onPageShow = () => revalidateIdentity();
    const onFocus = () => revalidateIdentity();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') revalidateIdentity();
    };
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
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
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }} aria-label="Rechecking chat identity">
          <CircularProgress size={28} />
        </Box>
      )}
      {/* Hidden, not unmounted: a same-user refocus must not kill an
          in-flight response. An identity change remounts via the key. */}
      <Box sx={{ display: revalidating ? 'none' : 'contents' }}>
        <ChatWindow key={identity.userId} {...identity} />
      </Box>
    </>
  );
};

export default App;
