// App.js
import React, { useState, useEffect, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useTheme } from '@mui/material/styles';
import { marked } from 'marked';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faMicrophone,
  faMicrophoneSlash,
  faVolumeMute,
  faVolumeUp,
} from '@fortawesome/free-solid-svg-icons';
import DOMPurify from 'dompurify';
import './App.css';

function useColorValue(lightValue, darkValue) {
  const theme = useTheme();
  return theme.palette.mode === 'light' ? lightValue : darkValue;
}

const domain =
  window.location.hostname === 'test.windowsforum.com'
    ? 'https://test.windowsforum.com'
    : 'https://windowsforum.com';

const dataDomain = 'https://data.windowsforum.com';

// Utility function for sanitizing and parsing content
const sanitizeAndParse = (content) => marked(DOMPurify.sanitize(content));

async function sendChatMessage(messageContent, onChunkReceived, signal, captchaToken = null) {
  try {
    const payload = { message: messageContent };
    if (captchaToken) {
      payload.captcha_token = captchaToken;
    }
    
    const response = await fetch(`${domain}/chat.php`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      const errorData = await response.json();
      if (errorData.captcha_required) {
        throw new Error('CAPTCHA_REQUIRED');
      }
      throw new Error('Network response was not ok');
    }
    if (!response.body) throw new Error('ReadableStream not supported');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let partialText = '';

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.substring(6).trim();
            if (!jsonStr) continue;
            try {
              const parsedData = JSON.parse(jsonStr);
              switch (parsedData.type) {
                case 'response.output_text.delta':
                  partialText += parsedData.delta;
                  onChunkReceived(partialText);
                  break;
                case 'response.output_text.done':
                  onChunkReceived(partialText);
                  break;
                default:
                  break;
              }
            } catch (error) {
              console.error('Error parsing streaming data:', error);
            }
          }
        }
      }
    }
    return partialText; // Return final text
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  }
}

const Message = React.memo(({ msg, userAvatar, userName }) => {
  const aiBg = useColorValue('#4299E1', '#4A5568');
  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction="row" spacing={2} alignItems="flex-start">
        <Avatar
          src={
            msg.role === 'user'
              ? userAvatar
              : `${dataDomain}/avatars/l/125/125694.jpg?1717034184`
          }
        />
        <Box
          sx={{
            backgroundColor: msg.role === 'user' ? '#4299E1' : aiBg,
            color: '#fff',
            p: 2,
            borderRadius: 2,
            maxWidth: '70%',
            boxShadow: 3,
          }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>
            {msg.role === 'user' ? userName : 'AI Bot'}
          </Typography>
          <Box dangerouslySetInnerHTML={{ __html: msg.content }} />
        </Box>
      </Stack>
    </Box>
  );
});

const ChatWindow = ({ userAvatar, userName }) => {
  const [messages, setMessages] = useState([
    {
      role: 'ai',
      content: sanitizeAndParse(
        'Welcome to WindowsForum.com! Feel free to ask me anything about Windows or technology!'
      ),
    },
  ]);
  const [streamingMessage, setStreamingMessage] = useState(null); // New state for streaming AI response
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeechRecognitionSupported, setIsSpeechRecognitionSupported] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isMuted, setIsMuted] = useState(true);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState(null);
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const chatContainerRef = useRef(null);

  const containerBg = useColorValue('#f0f0f0', '#1e1e1e');
  const containerBorderColor = useColorValue('#ccc', '#333');

  const scrollToBottom = useCallback(() => {
    if (chatContainerRef.current) {
      const container = chatContainerRef.current;
      const scrollElement = container.querySelector('.chat-messages-container');
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingMessage, scrollToBottom]);

  const playAudioResponse = useCallback(
    async (text) => {
      if (isMuted) return;
      try {
        const response = await fetch(`${domain}/tts.php`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error('TTS request failed');
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play();
      } catch (error) {
        console.error('Error fetching TTS:', error);
      }
    },
    [isMuted]
  );

  const handleSendMessage = useCallback(async () => {
    if (!input.trim()) return;
    const messageContent = input.trim();
    setIsLoading(true);
    setErrorMessage('');

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    if (messageContent.toLowerCase() === '/clear') {
      setMessages([]);
      setStreamingMessage(null);
      setInput('');
      setIsLoading(false);
      return;
    }

    // Add user's message
    const userMessage = { role: 'user', content: sanitizeAndParse(messageContent) };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');

    try {
      const finalText = await sendChatMessage(
        messageContent,
        (partialText) => {
          setStreamingMessage({ role: 'ai', content: partialText }); // Update streaming message
        },
        abortController.signal,
        captchaToken
      );
      if (finalText) {
        setMessages((prev) => [
          ...prev,
          { role: 'ai', content: sanitizeAndParse(finalText) },
        ]);
        setStreamingMessage(null);
        playAudioResponse(finalText);
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (error.message === 'CAPTCHA_REQUIRED') {
          setShowCaptcha(true);
          setErrorMessage('Please complete the captcha to continue.');
          // Remove the user's message since it wasn't sent
          setMessages((prev) => prev.slice(0, -1));
          setInput(messageContent); // Restore the message
        } else {
          setErrorMessage(
            error.message === 'Network response was not ok'
              ? 'Network error. Please check your connection.'
              : 'Failed to send message. Please try again.'
          );
        }
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [input, playAudioResponse, captchaToken]);

  const [speechRecognition, setSpeechRecognition] = useState(null);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0].transcript)
          .join('');
        setInput(transcript);
      };

      recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
      };

      recognition.onend = () => setIsListening(false);

      setSpeechRecognition(recognition);
    } else {
      setIsSpeechRecognitionSupported(false);
    }
  }, []);

  const handleStartListening = useCallback(() => {
    if (speechRecognition) {
      speechRecognition.start();
      setIsListening(true);
    }
  }, [speechRecognition]);

  const handleStopListening = useCallback(() => {
    if (speechRecognition) {
      speechRecognition.stop();
      setIsListening(false);
    }
  }, [speechRecognition]);

  const toggleMute = useCallback(() => setIsMuted((prev) => !prev), []);

  // Load and render Turnstile when captcha is needed
  useEffect(() => {
    if (showCaptcha && window.turnstile) {
      window.turnstile.render('#turnstile-container', {
        sitekey: '0x4AAAAAAABiq2_hH-dGCkQi',
        callback: async (token) => {
          // Verify the token with backend
          try {
            const response = await fetch(`${domain}/chat.php`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'verifyCaptcha', token }),
            });
            const result = await response.json();
            if (result.success) {
              setCaptchaToken(token);
              setShowCaptcha(false);
              setErrorMessage('');
              // Automatically retry sending the message
              if (input) {
                handleSendMessage();
              }
            } else {
              setErrorMessage('Captcha verification failed. Please try again.');
            }
          } catch (error) {
            setErrorMessage('Failed to verify captcha. Please try again.');
          }
        },
      });
    }
  }, [showCaptcha, input, handleSendMessage]);

  // Load Turnstile script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  return (
    <Box
      id="react-chat-container"
      ref={chatContainerRef}
      sx={{
        borderRadius: 1,
        backgroundColor: containerBg,
        border: `1px solid ${containerBorderColor}`,
        boxShadow: 1,
        width: '100%',
        maxWidth: '100%',
        mx: 'auto',
        display: 'flex',
        flexDirection: 'column',
        height: '600px', // Set a fixed height for the chat container
      }}
      role="log"
      aria-live="polite"
    >
      <Box 
        className="chat-messages-container"
        sx={{ 
          flex: 1, 
          overflowY: 'auto',
          overflowX: 'hidden',
          p: 2
        }}
      >
        <Stack spacing={2}>
          {messages.map((msg, index) => (
            <Message key={index} msg={msg} userAvatar={userAvatar} userName={userName} />
          ))}
          {streamingMessage && (
            <Message
              msg={{ role: 'ai', content: sanitizeAndParse(streamingMessage.content) }}
              userAvatar={userAvatar}
              userName={userName}
            />
          )}
          {isLoading && (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={20} />
              <Typography>AI is typing...</Typography>
            </Stack>
          )}
          {errorMessage && (
            <Typography color="error" sx={{ mt: 1 }}>
              {errorMessage}
            </Typography>
          )}
          {showCaptcha && (
            <Box sx={{ mt: 2, textAlign: 'center' }}>
              <div id="turnstile-container"></div>
            </Box>
          )}
          <div ref={messagesEndRef} />
        </Stack>
      </Box>

      <Stack
        direction="row"
        spacing={2}
        sx={{
          p: 2,
          borderTop: `1px solid ${containerBorderColor}`,
          alignItems: 'flex-end',
        }}
      >
        <TextField
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message here..."
          multiline
          variant="outlined"
          fullWidth
          sx={{
            backgroundColor: useColorValue('#fff', '#1e1e1e'),
            color: useColorValue('#000', '#e0e1e0'),
            '& fieldset': { borderColor: useColorValue('#ccc', '#333') },
          }}
          aria-label="Type your message"
        />
        <Button variant="contained" onClick={handleSendMessage} disabled={isLoading}>
          Send
        </Button>
        {isSpeechRecognitionSupported && (
          <Button
            variant="outlined"
            onClick={isListening ? handleStopListening : handleStartListening}
          >
            <FontAwesomeIcon icon={isListening ? faMicrophoneSlash : faMicrophone} />
          </Button>
        )}
        <Button variant="outlined" onClick={toggleMute}>
          <FontAwesomeIcon icon={isMuted ? faVolumeMute : faVolumeUp} />
        </Button>
      </Stack>
    </Box>
  );
};

const App = () => {
  const [userAvatar, setUserAvatar] = useState(`${domain}/images/default-avatar.webp`);
  const [userName, setUserName] = useState('Guest');

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        const response = await fetch(`${domain}/chat.php`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'getUserData' }),
        });
        const data = await response.json();
        if (data.avatar) setUserAvatar(data.avatar);
        if (data.name) setUserName(data.name);
      } catch (error) {
        console.error('Error fetching user data:', error);
      }
    };
    fetchUserData();
  }, []);

  return <ChatWindow userAvatar={userAvatar} userName={userName} />;
};

export default App;
