// App.improved.js - Enhanced chat interface with modern UX features
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Paper from '@mui/material/Paper';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import Chip from '@mui/material/Chip';
import Fade from '@mui/material/Fade';
import { useTheme } from '@mui/material/styles';
import { marked } from 'marked';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faMicrophone,
  faMicrophoneSlash,
  faVolumeMute,
  faVolumeUp,
  faPaperPlane,
  faStop,
  faCopy,
  faRotateRight,
  faEdit,
  faCheck,
  faTimes,
  faPlus,
  faTrash,
  faBars,
  faHistory,
  faLightbulb,
  faThumbsUp,
  faThumbsDown,
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
const sanitizeAndParse = (content) => {
  let processedContent = content;
  const citations = [];
  let citationIndex = 1;

  const citationPattern = /\(?\[([^\]]*)\]\((https?:\/\/[^\)]+)\)\)?/g;

  processedContent = processedContent.replace(citationPattern, (match, text, url) => {
    if (text.includes('.com') || text.includes('.org') || text.includes('.net')) {
      citations.push({ text: text, url: url, index: citationIndex });
      const ref = `<sup>[${citationIndex}]</sup>`;
      citationIndex++;
      return ref;
    }
    return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
  });

  const bareDomainPattern = /\(([a-zA-Z0-9.-]+\.(com|org|net|io|gov|edu)[^\)]*)\)/g;
  processedContent = processedContent.replace(bareDomainPattern, (match, domain) => {
    if (!citations.some(c => c.text === domain)) {
      citations.push({ text: domain, url: `https://${domain}`, index: citationIndex });
      const ref = `<sup>[${citationIndex}]</sup>`;
      citationIndex++;
      return ref;
    }
    return match;
  });

  if (citations.length > 0) {
    const citationList = citations.map(c =>
      `<div style="margin: 4px 0;"><small>[${c.index}] <a href="${c.url}" target="_blank" rel="noopener" style="color: #4299E1;">${c.text}</a></small></div>`
    ).join('');
    processedContent += `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.2);">
      <small style="opacity: 0.8;">Sources:</small>
      ${citationList}
    </div>`;
  }

  return marked(DOMPurify.sanitize(processedContent));
};

// Example prompts for new users
const EXAMPLE_PROMPTS = [
  "What's the best way to optimize Windows 11 performance?",
  "How do I troubleshoot blue screen errors?",
  "Explain the difference between UEFI and BIOS",
  "How can I secure my Windows computer?",
  "What are the essential Windows keyboard shortcuts?",
];

// Enhanced Message Component with actions
const Message = React.memo(({
  msg,
  userAvatar,
  userName,
  onEdit,
  onRegenerate,
  onCopy,
  isLastMessage,
  isStreaming,
  onFeedback
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showCopied, setShowCopied] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const aiBg = useColorValue('#f7f7f8', '#2a2b32');
  const userBg = useColorValue('#fff', '#343541');

  const handleCopy = useCallback(() => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = msg.content;
    const text = tempDiv.textContent || tempDiv.innerText || '';
    navigator.clipboard.writeText(text);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  }, [msg.content]);

  const handleEdit = useCallback(() => {
    if (isEditing && editText.trim()) {
      onEdit(msg.id, editText);
      setIsEditing(false);
    } else {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = msg.content;
      const text = tempDiv.textContent || tempDiv.innerText || '';
      setEditText(text);
      setIsEditing(true);
    }
  }, [isEditing, editText, msg.id, msg.content, onEdit]);

  const handleFeedback = useCallback((type) => {
    setFeedback(type);
    if (onFeedback) onFeedback(msg.id, type);
  }, [msg.id, onFeedback]);

  return (
    <Box
      sx={{
        py: 3,
        px: { xs: 2, sm: 4, md: 6 },
        backgroundColor: msg.role === 'user' ? userBg : aiBg,
        '&:hover .message-actions': {
          opacity: 1,
        }
      }}
    >
      <Box sx={{ maxWidth: '48rem', mx: 'auto' }}>
        <Stack direction="row" spacing={3} alignItems="flex-start">
          {msg.role === 'user' && (
            <Avatar
              src={userAvatar}
              sx={{ width: 32, height: 32, mt: 0.5 }}
            />
          )}
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 600,
                  color: useColorValue('#000', '#fff')
                }}
              >
                {msg.role === 'user' ? userName : 'Assistant'}
              </Typography>
              {msg.timestamp && (
                <Typography variant="caption" sx={{ opacity: 0.6 }}>
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </Typography>
              )}
            </Stack>

            {isEditing ? (
              <Stack spacing={1}>
                <TextField
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  multiline
                  fullWidth
                  autoFocus
                  variant="outlined"
                  size="small"
                />
                <Stack direction="row" spacing={1}>
                  <Button size="small" onClick={handleEdit} startIcon={<FontAwesomeIcon icon={faCheck} />}>
                    Save
                  </Button>
                  <Button size="small" onClick={() => setIsEditing(false)} startIcon={<FontAwesomeIcon icon={faTimes} />}>
                    Cancel
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <>
                <Box
                  className="message-content"
                  dangerouslySetInnerHTML={{ __html: msg.content }}
                  sx={{
                    '& pre': {
                      backgroundColor: useColorValue('#f6f8fa', '#0d1117'),
                      padding: 2,
                      borderRadius: 1,
                      overflow: 'auto',
                    },
                    '& code': {
                      backgroundColor: useColorValue('#f6f8fa', '#0d1117'),
                      padding: '2px 4px',
                      borderRadius: '3px',
                      fontSize: '0.875em',
                    },
                    '& a': {
                      color: '#4299E1',
                      textDecoration: 'none',
                      '&:hover': {
                        textDecoration: 'underline',
                      }
                    }
                  }}
                />

                {!isStreaming && (
                  <Stack
                    className="message-actions"
                    direction="row"
                    spacing={1}
                    sx={{
                      mt: 2,
                      opacity: 0,
                      transition: 'opacity 0.2s',
                    }}
                  >
                    <Tooltip title={showCopied ? "Copied!" : "Copy"}>
                      <IconButton size="small" onClick={handleCopy}>
                        <FontAwesomeIcon icon={showCopied ? faCheck : faCopy} size="sm" />
                      </IconButton>
                    </Tooltip>

                    {msg.role === 'user' && isLastMessage && (
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={handleEdit}>
                          <FontAwesomeIcon icon={faEdit} size="sm" />
                        </IconButton>
                      </Tooltip>
                    )}

                    {msg.role === 'ai' && isLastMessage && (
                      <Tooltip title="Regenerate">
                        <IconButton size="small" onClick={() => onRegenerate(msg.id)}>
                          <FontAwesomeIcon icon={faRotateRight} size="sm" />
                        </IconButton>
                      </Tooltip>
                    )}

                    {msg.role === 'ai' && (
                      <>
                        <Tooltip title="Good response">
                          <IconButton
                            size="small"
                            onClick={() => handleFeedback('up')}
                            sx={{ color: feedback === 'up' ? '#10a37f' : 'inherit' }}
                          >
                            <FontAwesomeIcon icon={faThumbsUp} size="sm" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Bad response">
                          <IconButton
                            size="small"
                            onClick={() => handleFeedback('down')}
                            sx={{ color: feedback === 'down' ? '#ef4444' : 'inherit' }}
                          >
                            <FontAwesomeIcon icon={faThumbsDown} size="sm" />
                          </IconButton>
                        </Tooltip>
                      </>
                    )}
                  </Stack>
                )}
              </>
            )}
          </Box>
        </Stack>
      </Box>
    </Box>
  );
});

// Conversation management
const generateConversationId = () => `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const ChatWindow = ({ userAvatar, userName, userId }) => {
  const isGuest = !userId || (typeof userId === 'string' && userId.startsWith('guest_'));
  const welcomeMessage = isGuest
    ? 'Welcome to WindowsForum.com! Feel free to ask me anything about Windows or technology! For best results please <a href="/register">register</a> or <a href="/login">log-in</a> to the Windows Forum'
    : 'Welcome to WindowsForum.com! Feel free to ask me anything about Windows or technology!';

  // Conversation management states
  const [conversations, setConversations] = useState(() => {
    const saved = localStorage.getItem('chat_conversations');
    return saved ? JSON.parse(saved) : {};
  });

  const [currentConversationId, setCurrentConversationId] = useState(() => {
    const saved = localStorage.getItem('current_conversation_id');
    if (saved && conversations[saved]) return saved;
    const newId = generateConversationId();
    return newId;
  });

  // Initialize current conversation if it doesn't exist
  useEffect(() => {
    if (!conversations[currentConversationId]) {
      const newConversation = {
        id: currentConversationId,
        title: 'New Chat',
        messages: [{
          id: `msg_${Date.now()}`,
          role: 'ai',
          content: sanitizeAndParse(welcomeMessage),
          timestamp: Date.now(),
        }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setConversations(prev => ({
        ...prev,
        [currentConversationId]: newConversation,
      }));
    }
  }, [currentConversationId, conversations, welcomeMessage]);

  const currentConversation = conversations[currentConversationId] || {
    messages: [],
    title: 'New Chat',
  };

  const [streamingMessage, setStreamingMessage] = useState(null);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeechRecognitionSupported, setIsSpeechRecognitionSupported] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isMuted, setIsMuted] = useState(true);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showExamples, setShowExamples] = useState(true);

  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);
  const chatContainerRef = useRef(null);
  const textFieldRef = useRef(null);

  const containerBg = useColorValue('#fff', '#343541');
  const inputBg = useColorValue('#fff', '#40414f');
  const borderColor = useColorValue('#e5e7eb', '#565869');

  // Save conversations to localStorage
  useEffect(() => {
    localStorage.setItem('chat_conversations', JSON.stringify(conversations));
    localStorage.setItem('current_conversation_id', currentConversationId);
  }, [conversations, currentConversationId]);

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textFieldRef.current?.querySelector('textarea');
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = Math.min(textarea.scrollHeight, 200);
      textarea.style.height = `${newHeight}px`;
    }
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

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
  }, [currentConversation.messages, streamingMessage, scrollToBottom]);

  const updateConversation = useCallback((updates) => {
    setConversations(prev => ({
      ...prev,
      [currentConversationId]: {
        ...prev[currentConversationId],
        ...updates,
        updatedAt: Date.now(),
      }
    }));
  }, [currentConversationId]);

  const addMessage = useCallback((message) => {
    updateConversation({
      messages: [...(conversations[currentConversationId]?.messages || []), message],
    });
  }, [conversations, currentConversationId, updateConversation]);

  const handleNewConversation = useCallback(() => {
    const newId = generateConversationId();
    const newConversation = {
      id: newId,
      title: 'New Chat',
      messages: [{
        id: `msg_${Date.now()}`,
        role: 'ai',
        content: sanitizeAndParse(welcomeMessage),
        timestamp: Date.now(),
      }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setConversations(prev => ({
      ...prev,
      [newId]: newConversation,
    }));
    setCurrentConversationId(newId);
    setStreamingMessage(null);
    setInput('');
    setShowExamples(true);
  }, [welcomeMessage]);

  const handleDeleteConversation = useCallback((convId) => {
    setConversations(prev => {
      const newConvs = { ...prev };
      delete newConvs[convId];
      return newConvs;
    });
    if (convId === currentConversationId) {
      handleNewConversation();
    }
  }, [currentConversationId, handleNewConversation]);

  const handleSelectConversation = useCallback((convId) => {
    setCurrentConversationId(convId);
    setStreamingMessage(null);
    setInput('');
    setDrawerOpen(false);
    setShowExamples(false);
  }, []);

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

  const handleStopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsLoading(false);
      if (streamingMessage) {
        addMessage({
          ...streamingMessage,
          content: sanitizeAndParse(streamingMessage.content + ' [Generation stopped]'),
        });
        setStreamingMessage(null);
      }
    }
  }, [streamingMessage, addMessage]);

  const sendChatMessage = async (messageContent, onChunkReceived, signal, captchaToken = null) => {
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
      let annotations = [];

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
                    onChunkReceived(partialText, annotations);
                    break;
                  case 'response.output_text.done':
                    onChunkReceived(partialText, annotations);
                    break;
                  case 'response.output_text.annotation.added':
                    if (parsedData.annotation && parsedData.annotation.type === 'file_citation') {
                      annotations.push({
                        index: parsedData.annotation_index,
                        filename: parsedData.annotation.filename,
                        fileId: parsedData.annotation.file_id
                      });
                    }
                    break;
                  case 'response.content_part.done':
                    if (parsedData.part && parsedData.part.annotations) {
                      annotations = parsedData.part.annotations.map((ann, idx) => ({
                        index: idx,
                        filename: ann.filename,
                        fileId: ann.file_id
                      }));
                    }
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
      return { text: partialText, annotations };
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  };

  const handleSendMessage = useCallback(async (messageContent = null) => {
    const content = messageContent || input.trim();
    if (!content) return;

    setIsLoading(true);
    setErrorMessage('');
    setShowExamples(false);

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    if (content.toLowerCase() === '/clear') {
      handleNewConversation();
      return;
    }

    // Add user's message
    const userMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: sanitizeAndParse(content),
      timestamp: Date.now(),
    };
    addMessage(userMessage);
    setInput('');

    // Update conversation title if it's the first real message
    if (currentConversation.messages.length === 1) {
      const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
      updateConversation({ title });
    }

    try {
      const streamingMsg = {
        id: `msg_${Date.now()}_ai`,
        role: 'ai',
        content: '',
        timestamp: Date.now(),
      };

      const result = await sendChatMessage(
        content,
        (partialText, annotations) => {
          let formattedText = partialText;
          if (annotations && annotations.length > 0) {
            const citationText = annotations
              .map((ann, idx) => `[${idx + 1}]`)
              .join(' ');
            formattedText = `${partialText} ${citationText}`;
          }
          setStreamingMessage({ ...streamingMsg, content: formattedText, annotations });
        },
        abortController.signal,
        captchaToken
      );

      if (result && result.text) {
        let finalContent = result.text;

        if (result.annotations && result.annotations.length > 0 && result.annotations[0].fileId) {
          const citationList = result.annotations
            .map((ann, idx) => `<sup>[${idx + 1}]</sup>`)
            .join(' ');

          const citationDetails = result.annotations
            .map((ann, idx) => `<div><small>[${idx + 1}] ${ann.filename || 'Source'}</small></div>`)
            .join('');

          finalContent = `${result.text} ${citationList}<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.2);">${citationDetails}</div>`;
        }

        addMessage({
          ...streamingMsg,
          content: sanitizeAndParse(finalContent),
        });
        setStreamingMessage(null);
        playAudioResponse(result.text);
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (error.message === 'CAPTCHA_REQUIRED') {
          setShowCaptcha(true);
          setErrorMessage('Please complete the captcha to continue.');
          // Remove the last message since it wasn't sent
          updateConversation({
            messages: currentConversation.messages.slice(0, -1),
          });
          setInput(content);
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
  }, [input, playAudioResponse, captchaToken, addMessage, currentConversation, updateConversation, handleNewConversation]);

  const handleEditMessage = useCallback((messageId, newContent) => {
    const messageIndex = currentConversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex >= 0) {
      // Remove all messages after the edited one
      const newMessages = currentConversation.messages.slice(0, messageIndex);
      updateConversation({ messages: newMessages });
      // Resend the edited message
      handleSendMessage(newContent);
    }
  }, [currentConversation, updateConversation, handleSendMessage]);

  const handleRegenerateMessage = useCallback(() => {
    const lastUserMessage = [...currentConversation.messages].reverse().find(m => m.role === 'user');
    if (lastUserMessage) {
      // Remove the last AI message
      const newMessages = currentConversation.messages.slice(0, -1);
      updateConversation({ messages: newMessages });
      // Resend the last user message
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = lastUserMessage.content;
      const text = tempDiv.textContent || tempDiv.innerText || '';
      handleSendMessage(text);
    }
  }, [currentConversation, updateConversation, handleSendMessage]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  }, [handleSendMessage]);

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

  // Handle Turnstile
  useEffect(() => {
    if (showCaptcha && window.turnstile) {
      window.turnstile.render('#turnstile-container', {
        sitekey: '0x4AAAAAAABiq2_hH-dGCkQi',
        callback: async (token) => {
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

  // Sort conversations by most recent
  const sortedConversations = useMemo(() => {
    return Object.values(conversations)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations]);

  return (
    <Box
      id="react-chat-container"
      ref={chatContainerRef}
      sx={{
        display: 'flex',
        height: '100vh',
        backgroundColor: containerBg,
      }}
    >
      {/* Conversation Sidebar Drawer */}
      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sx={{
          '& .MuiDrawer-paper': {
            width: 280,
            backgroundColor: useColorValue('#f7f7f8', '#202123'),
          }
        }}
      >
        <Box sx={{ p: 2 }}>
          <Button
            fullWidth
            variant="outlined"
            startIcon={<FontAwesomeIcon icon={faPlus} />}
            onClick={() => {
              handleNewConversation();
              setDrawerOpen(false);
            }}
            sx={{ mb: 2 }}
          >
            New Chat
          </Button>

          <Typography variant="subtitle2" sx={{ mb: 1, opacity: 0.7 }}>
            Recent Chats
          </Typography>

          <List>
            {sortedConversations.map((conv) => (
              <React.Fragment key={conv.id}>
                <ListItemButton
                  selected={conv.id === currentConversationId}
                  onClick={() => handleSelectConversation(conv.id)}
                  sx={{
                    borderRadius: 1,
                    mb: 0.5,
                    '&:hover .delete-btn': {
                      opacity: 1,
                    }
                  }}
                >
                  <ListItemText
                    primary={conv.title}
                    secondary={new Date(conv.updatedAt).toLocaleDateString()}
                    primaryTypographyProps={{
                      noWrap: true,
                      fontSize: '0.875rem',
                    }}
                    secondaryTypographyProps={{
                      fontSize: '0.75rem',
                    }}
                  />
                  <IconButton
                    className="delete-btn"
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteConversation(conv.id);
                    }}
                    sx={{ opacity: 0, transition: 'opacity 0.2s' }}
                  >
                    <FontAwesomeIcon icon={faTrash} size="sm" />
                  </IconButton>
                </ListItemButton>
              </React.Fragment>
            ))}
          </List>
        </Box>
      </Drawer>

      {/* Main Chat Area */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <Box
          sx={{
            borderBottom: `1px solid ${borderColor}`,
            p: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          <IconButton onClick={() => setDrawerOpen(true)}>
            <FontAwesomeIcon icon={faBars} />
          </IconButton>
          <Typography variant="h6" sx={{ flex: 1 }}>
            {currentConversation.title}
          </Typography>
          <Button
            size="small"
            startIcon={<FontAwesomeIcon icon={faPlus} />}
            onClick={handleNewConversation}
          >
            New Chat
          </Button>
        </Box>

        {/* Messages Area */}
        <Box
          className="chat-messages-container"
          sx={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          {currentConversation.messages.map((msg, index) => (
            <Message
              key={msg.id}
              msg={msg}
              userAvatar={userAvatar}
              userName={userName}
              onEdit={handleEditMessage}
              onRegenerate={handleRegenerateMessage}
              onCopy={() => {}}
              isLastMessage={index === currentConversation.messages.length - 1}
              isStreaming={false}
            />
          ))}

          {streamingMessage && (
            <Message
              msg={{
                ...streamingMessage,
                content: sanitizeAndParse(streamingMessage.content || '▍')
              }}
              userAvatar={userAvatar}
              userName={userName}
              onEdit={() => {}}
              onRegenerate={() => {}}
              onCopy={() => {}}
              isLastMessage={true}
              isStreaming={true}
            />
          )}

          {isLoading && !streamingMessage && (
            <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress size={24} />
            </Box>
          )}

          {errorMessage && (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography color="error">{errorMessage}</Typography>
            </Box>
          )}

          {showCaptcha && (
            <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
              <div id="turnstile-container"></div>
            </Box>
          )}

          {/* Example Prompts */}
          {showExamples && currentConversation.messages.length === 1 && !isLoading && (
            <Fade in={true}>
              <Box sx={{ p: 4 }}>
                <Stack spacing={2} alignItems="center">
                  <Typography variant="subtitle1" sx={{ opacity: 0.7 }}>
                    <FontAwesomeIcon icon={faLightbulb} /> Try asking:
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" spacing={1} justifyContent="center">
                    {EXAMPLE_PROMPTS.map((prompt, idx) => (
                      <Chip
                        key={idx}
                        label={prompt}
                        onClick={() => handleSendMessage(prompt)}
                        sx={{
                          cursor: 'pointer',
                          mb: 1,
                          '&:hover': {
                            backgroundColor: useColorValue('#e5e7eb', '#4b4f60'),
                          }
                        }}
                      />
                    ))}
                  </Stack>
                </Stack>
              </Box>
            </Fade>
          )}

          <div ref={messagesEndRef} />
        </Box>

        {/* Input Area */}
        <Box
          sx={{
            borderTop: `1px solid ${borderColor}`,
            p: 2,
            backgroundColor: inputBg,
          }}
        >
          <Box sx={{ maxWidth: '48rem', mx: 'auto' }}>
            <Paper
              elevation={0}
              sx={{
                display: 'flex',
                alignItems: 'flex-end',
                p: 1,
                border: `1px solid ${borderColor}`,
                borderRadius: 2,
                backgroundColor: containerBg,
              }}
            >
              <TextField
                ref={textFieldRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Message Assistant..."
                multiline
                maxRows={5}
                variant="standard"
                fullWidth
                InputProps={{
                  disableUnderline: true,
                  sx: {
                    px: 1.5,
                    fontSize: '1rem',
                    '& textarea': {
                      resize: 'none',
                      overflowY: 'auto',
                      '&::-webkit-scrollbar': {
                        width: '8px',
                      },
                      '&::-webkit-scrollbar-thumb': {
                        backgroundColor: 'rgba(0,0,0,0.2)',
                        borderRadius: '4px',
                      }
                    }
                  }
                }}
                disabled={isLoading}
                aria-label="Type your message"
              />

              <Stack direction="row" spacing={0.5} sx={{ px: 1 }}>
                {isLoading ? (
                  <Tooltip title="Stop generation">
                    <IconButton onClick={handleStopGeneration} size="small">
                      <FontAwesomeIcon icon={faStop} />
                    </IconButton>
                  </Tooltip>
                ) : (
                  <Tooltip title="Send message">
                    <IconButton
                      onClick={() => handleSendMessage()}
                      disabled={!input.trim()}
                      size="small"
                    >
                      <FontAwesomeIcon icon={faPaperPlane} />
                    </IconButton>
                  </Tooltip>
                )}

                {isSpeechRecognitionSupported && (
                  <Tooltip title={isListening ? "Stop recording" : "Start recording"}>
                    <IconButton
                      onClick={isListening ? handleStopListening : handleStartListening}
                      size="small"
                      color={isListening ? "error" : "default"}
                    >
                      <FontAwesomeIcon icon={isListening ? faMicrophoneSlash : faMicrophone} />
                    </IconButton>
                  </Tooltip>
                )}

                <Tooltip title={isMuted ? "Enable voice" : "Mute voice"}>
                  <IconButton onClick={toggleMute} size="small">
                    <FontAwesomeIcon icon={isMuted ? faVolumeMute : faVolumeUp} />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Paper>

            <Typography
              variant="caption"
              sx={{
                display: 'block',
                textAlign: 'center',
                mt: 1,
                opacity: 0.6,
              }}
            >
              Press Enter to send, Shift+Enter for new line
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

const App = () => {
  const [userAvatar, setUserAvatar] = useState(`${domain}/images/default-avatar.webp`);
  const [userName, setUserName] = useState('Guest');
  const [userId, setUserId] = useState(null);

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
        if (data.user_id) setUserId(data.user_id);
      } catch (error) {
        console.error('Error fetching user data:', error);
      }
    };
    fetchUserData();
  }, []);

  return <ChatWindow userAvatar={userAvatar} userName={userName} userId={userId} />;
};

export default App;