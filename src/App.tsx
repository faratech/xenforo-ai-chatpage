import React, { useState, useEffect } from 'react';
import { ChatWindow } from './components/ChatWindow';
import { ChatAPI } from './services/api';
import { ENV } from './config/env';
import './App.css';

/**
 * Main App Component - Fetches user data and initializes chat
 */
const App: React.FC = () => {
  const domain = ENV.getCurrentDomain();
  const [userAvatar, setUserAvatar] = useState<string>(`${domain}/images/default-avatar.webp`);
  const [userName, setUserName] = useState<string>('Guest');
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        const data = await ChatAPI.getUserData();
        if (data.avatar) setUserAvatar(data.avatar);
        if (data.name) setUserName(data.name);
        if (data.user_id !== undefined && data.user_id !== null && String(data.user_id) !== '0') {
          setUserId(String(data.user_id));
        } else {
          setUserId(null);
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      }
    };
    fetchUserData();
  }, []);

  return <ChatWindow userAvatar={userAvatar} userName={userName} userId={userId} />;
};

export default App;
