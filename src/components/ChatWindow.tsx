import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Fade from '@mui/material/Fade';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import MenuIcon from '@mui/icons-material/Menu';
import LightbulbIcon from '@mui/icons-material/Lightbulb';

import type {
  ChatWindowProps,
  Conversation,
  ConversationMap,
  Message
} from '../types';
import { Message as MessageComponent } from './Message';
import { ConversationSidebar } from './ConversationSidebar';
import { InputArea } from './InputArea';
import {
  sanitizeAndParse,
  generateConversationId,
  EXAMPLE_PROMPTS,
  extractTextFromHTML
} from '../utils/helpers';
import { ChatAPI, AudioService, CaptchaRequiredError } from '../services/api';
import { ENV } from '../config/env';

const createNewConversation = (id: string, welcomeMsg: string): Conversation => ({
  id,
  title: 'New Chat',
  messages: [{
    id: `msg_${Date.now()}`,
    role: 'ai',
    content: sanitizeAndParse(welcomeMsg),
    timestamp: Date.now(),
  }],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const noopEdit = (_id: string, _content: string) => {};
const noopRegenerate = () => {};

/**
 * ChatWindow Component - Main chat interface
 */
export const ChatWindow: React.FC<ChatWindowProps> = ({ userAvatar, userName, userId }) => {
  const theme = useTheme();
  const isGuest = !userId || (typeof userId === 'string' && userId.startsWith('guest_'));
  const welcomeMessage = useMemo(() => isGuest
    ? 'Welcome to WindowsForum.com! Feel free to ask me anything about Windows or technology! For best results please <a href="/register">register</a> or <a href="/login">log-in</a> to the Windows Forum'
    : 'Welcome to WindowsForum.com! Feel free to ask me anything about Windows or technology!',
    [isGuest]
  );

  // Conversation management states
  const [conversations, setConversations] = useState<ConversationMap>(() => {
    const saved = localStorage.getItem('chat_conversations');
    return saved ? JSON.parse(saved) : {};
  });

  const [currentConversationId, setCurrentConversationId] = useState<string>(() => {
    const saved = localStorage.getItem('current_conversation_id');
    if (saved && conversations[saved]) return saved;
    return generateConversationId();
  });

  // Initialize current conversation if it doesn't exist
  useEffect(() => {
    if (!conversations[currentConversationId]) {
      setConversations(prev => ({
        ...prev,
        [currentConversationId]: createNewConversation(currentConversationId, welcomeMessage),
      }));
    }
  }, [currentConversationId, conversations, welcomeMessage]);

  const currentConversation = useMemo(() =>
    conversations[currentConversationId] || {
      messages: [],
      title: 'New Chat',
      id: currentConversationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    [conversations, currentConversationId]
  );

  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeechRecognitionSupported, setIsSpeechRecognitionSupported] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isMuted, setIsMuted] = useState(true);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showExamples, setShowExamples] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textFieldRef = useRef<HTMLDivElement>(null);

  const containerBg = theme.palette.mode === 'light' ? '#fff' : '#343541';
  const borderColor = theme.palette.mode === 'light' ? '#e5e7eb' : '#565869';

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

  const updateConversation = useCallback((updates: Partial<Conversation>) => {
    setConversations(prev => ({
      ...prev,
      [currentConversationId]: {
        ...prev[currentConversationId],
        ...updates,
        updatedAt: Date.now(),
      }
    }));
  }, [currentConversationId]);

  const addMessage = useCallback((message: Message) => {
    updateConversation({
      messages: [...(conversations[currentConversationId]?.messages || []), message],
    });
  }, [conversations, currentConversationId, updateConversation]);

  const handleNewConversation = useCallback(() => {
    const newId = generateConversationId();
    setConversations(prev => ({
      ...prev,
      [newId]: createNewConversation(newId, welcomeMessage),
    }));
    setCurrentConversationId(newId);
    setStreamingMessage(null);
    setInput('');
    setShowExamples(true);
  }, [welcomeMessage]);

  const handleDeleteConversation = useCallback((convId: string) => {
    setConversations(prev => {
      const newConvs = { ...prev };
      delete newConvs[convId];
      return newConvs;
    });
    if (convId === currentConversationId) {
      handleNewConversation();
    }
  }, [currentConversationId, handleNewConversation]);

  const handleSelectConversation = useCallback((convId: string) => {
    setCurrentConversationId(convId);
    setStreamingMessage(null);
    setInput('');
    setDrawerOpen(false);
    setShowExamples(false);
  }, []);

  const playAudioResponse = useCallback(
    async (text: string) => {
      if (isMuted) return;
      try {
        await AudioService.playTTS(text);
      } catch (error) {
        console.error('Error playing TTS:', error);
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

  // Using API service - sendChatMessage is now handled by ChatAPI.sendMessage

  const handleSendMessage = useCallback(async (messageContent: string | null = null) => {
    const content = messageContent || input.trim();
    if (!content) return;

    setIsLoading(true);
    setErrorMessage('');
    setShowExamples(false);

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    if (content.toLowerCase() === '/clear') {
      setIsLoading(false);
      handleNewConversation();
      return;
    }

    // Add user's message
    const userMessage: Message = {
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
      const streamingMsg: Message = {
        id: `msg_${Date.now()}_ai`,
        role: 'ai',
        content: '',
        timestamp: Date.now(),
      };

      const result = await ChatAPI.sendMessage(content, {
        signal: abortController.signal,
        captchaToken: captchaToken || undefined,
        onChunk: (partialText, annotations) => {
          let formattedText = partialText;
          if (annotations && annotations.length > 0) {
            const citationText = annotations
              .map((_ann, idx) => `[${idx + 1}]`)
              .join(' ');
            formattedText = `${partialText} ${citationText}`;
          }
          setStreamingMessage({ ...streamingMsg, content: formattedText, annotations });
        },
      });

      if (result && result.text) {
        let finalContent = result.text;

        if (result.annotations && result.annotations.length > 0 && result.annotations[0].fileId) {
          const citationList = result.annotations
            .map((_ann, idx) => `<sup>[${idx + 1}]</sup>`)
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
      } else if (result === null) {
        setStreamingMessage(null);
      } else {
        setErrorMessage('No response received from server. Please try again.');
        setStreamingMessage(null);
        console.error('Empty result from sendChatMessage:', result);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        if (error instanceof CaptchaRequiredError || error.message === 'CAPTCHA_REQUIRED') {
          setShowCaptcha(true);
          setErrorMessage('Please complete the captcha to continue.');
          updateConversation({
            messages: currentConversation.messages.slice(0, -1),
          });
          setInput(content);
        } else {
          const errorMsg = error.message || 'Unknown error';
          console.error('Chat error:', error);

          let userMessage = 'Failed to send message. Please try again.';
          if (errorMsg.includes('Server error')) {
            userMessage = `Server error: ${errorMsg}. Please try again later.`;
          } else if (errorMsg.includes('No data received')) {
            userMessage = 'No response from server. The server may be experiencing issues.';
          } else if (errorMsg.includes('Network')) {
            userMessage = 'Network error. Please check your connection.';
          } else if (errorMsg.includes('ReadableStream')) {
            userMessage = 'Your browser does not support streaming responses. Please try a modern browser.';
          }

          setErrorMessage(userMessage);
          if (streamingMessage) {
            setStreamingMessage(null);
          }
        }
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [input, playAudioResponse, captchaToken, addMessage, currentConversation, updateConversation, handleNewConversation, streamingMessage]);

  const handleEditMessage = useCallback((messageId: string, newContent: string) => {
    const messageIndex = currentConversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex >= 0) {
      const newMessages = currentConversation.messages.slice(0, messageIndex);
      updateConversation({ messages: newMessages });
      handleSendMessage(newContent);
    }
  }, [currentConversation, updateConversation, handleSendMessage]);

  const handleRegenerateMessage = useCallback(() => {
    const lastUserMessage = [...currentConversation.messages].reverse().find(m => m.role === 'user');
    if (lastUserMessage) {
      const newMessages = currentConversation.messages.slice(0, -1);
      updateConversation({ messages: newMessages });
      const text = extractTextFromHTML(lastUserMessage.content);
      handleSendMessage(text);
    }
  }, [currentConversation, updateConversation, handleSendMessage]);

  const [speechRecognition, setSpeechRecognition] = useState<any>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join('');
        setInput(transcript);
      };

      recognition.onerror = (event: any) => {
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
    if (showCaptcha && (window as any).turnstile) {
      (window as any).turnstile.render('#turnstile-container', {
        sitekey: ENV.TURNSTILE_SITE_KEY,
        callback: async (token: string) => {
          try {
            const result = await ChatAPI.verifyCaptcha(token);
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
      <ConversationSidebar
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        conversations={sortedConversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onNewConversation={handleNewConversation}
      />

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
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flex: 1 }}>
            {currentConversation.title}
          </Typography>
          <Button
            size="small"
            startIcon={<AddIcon />}
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
            <MessageComponent
              key={msg.id}
              msg={msg}
              userAvatar={userAvatar}
              userName={userName}
              onEdit={handleEditMessage}
              onRegenerate={handleRegenerateMessage}
              isLastMessage={index === currentConversation.messages.length - 1}
              isStreaming={false}
            />
          ))}

          {streamingMessage && (
            <MessageComponent
              msg={{
                ...streamingMessage,
                content: sanitizeAndParse(streamingMessage.content || '▍')
              }}
              userAvatar={userAvatar}
              userName={userName}
              onEdit={noopEdit}
              onRegenerate={noopRegenerate}
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
                    <LightbulbIcon sx={{ fontSize: 'inherit', verticalAlign: 'middle', mr: 0.5 }} /> Try asking:
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
                            backgroundColor: theme.palette.mode === 'light' ? '#e5e7eb' : '#4b4f60',
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
        <InputArea
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          isListening={isListening}
          isSpeechRecognitionSupported={isSpeechRecognitionSupported}
          isMuted={isMuted}
          onSend={() => handleSendMessage()}
          onStop={handleStopGeneration}
          onStartListening={handleStartListening}
          onStopListening={handleStopListening}
          onToggleMute={toggleMute}
          textFieldRef={textFieldRef}
        />
      </Box>
    </Box>
  );
};