import React, { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { ChatWindow } from './components/ChatWindow';
import { ChatAPI } from './services/api';
import { ENV } from './config/env';
import './App.css';

/**
 * Main App Component - Fetches user data and initializes chat
 */
const App: React.FC = () => {
  const domain = ENV.getCurrentDomain();
  const [identity, setIdentity] = useState<{
    userAvatar: string;
    userName: string;
    userId: string;
  } | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [identityAttempt, setIdentityAttempt] = useState(0);

  const retryIdentity = useCallback(() => {
    setIdentityError('');
    setIdentityAttempt(attempt => attempt + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchUserData = async () => {
      try {
        const data = await ChatAPI.getUserData();
        const resolvedId = data.user_id === undefined || data.user_id === null
          ? ''
          : String(data.user_id);
        if (!resolvedId || resolvedId === '0') {
          throw new Error('The server did not return a stable chat identity.');
        }
        if (!cancelled) {
          setIdentity({
            userAvatar: data.avatar || `${domain}/images/default-avatar.webp`,
            userName: data.name || 'Guest',
            userId: resolvedId,
          });
          setIdentityError('');
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
        if (!cancelled) {
          setIdentity(null);
          setIdentityError('Chat could not verify your WindowsForum session. No local history was loaded.');
        }
      }
    };
    void fetchUserData();
    return () => { cancelled = true; };
  }, [domain, identityAttempt]);

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

  return <ChatWindow {...identity} />;
};

export default App;
