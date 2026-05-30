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
  ChatMessageHistoryItem,
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
    rawContent: extractTextFromHTML(welcomeMsg),
    timestamp: Date.now(),
  }],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const noopEdit = (_id: string, _content: string) => {};
const noopRegenerate = () => {};

type ConversationUpdate = Partial<Conversation> | ((conversation: Conversation) => Partial<Conversation>);

const getMessageText = (message: Message): string => {
  return (message.rawContent || extractTextFromHTML(message.content)).trim();
};

const serializeConversationHistory = (messages: Message[]): ChatMessageHistoryItem[] => {
  return messages
    .filter((message, index) => {
      const text = getMessageText(message);
      return Boolean(text) && !(index === 0 && message.role === 'ai' && text.startsWith('Welcome to WindowsForum.com'));
    })
    .map((message) => ({
      role: message.role === 'ai' ? 'assistant' : 'user',
      content: getMessageText(message),
    }));
};

const pruneConversations = (conversationMap: ConversationMap, keepConversationId: string): ConversationMap => {
  const maxConversations = Number.isFinite(ENV.MAX_CONVERSATIONS) && ENV.MAX_CONVERSATIONS > 0
    ? ENV.MAX_CONVERSATIONS
    : 50;
  const entries = Object.entries(conversationMap).sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  const keep = new Set(entries.slice(0, maxConversations).map(([id]) => id));
  keep.add(keepConversationId);

  return entries.reduce<ConversationMap>((acc, [id, conversation]) => {
    if (keep.has(id)) acc[id] = conversation;
    return acc;
  }, {});
};

const loadSavedConversations = (): ConversationMap => {
  try {
    const saved = localStorage.getItem('chat_conversations');
    if (!saved) return {};
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== 'object') return {};
    const sanitized: ConversationMap = {};
    for (const [id, conv] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id !== 'string' || id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      const c = conv as Partial<Conversation>;
      if (
        c &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        typeof c.title === 'string' &&
        Array.isArray(c.messages) &&
        typeof c.createdAt === 'number' &&
        typeof c.updatedAt === 'number'
      ) {
        sanitized[id] = c as Conversation;
      }
    }
    return sanitized;
  } catch (error) {
    console.warn('Ignoring invalid saved conversations:', error);
    return {};
  }
};

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
    return loadSavedConversations();
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

  const defaultConversation = useMemo<Conversation>(() => ({
    id: currentConversationId,
    title: 'New Chat',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }), [currentConversationId]);

  const currentConversation = useMemo(() =>
    conversations[currentConversationId] || defaultConversation,
    [conversations, currentConversationId, defaultConversation]
  );

  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeechRecognitionSupported, setIsSpeechRecognitionSupported] = useState(ENV.ENABLE_VOICE);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    try {
      return JSON.parse(localStorage.getItem('chat_mute') ?? 'true');
    } catch {
      return true;
    }
  });
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showExamples, setShowExamples] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textFieldRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetRef = useRef<string | null>(null);
  const inputRef = useRef(input);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const h = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);

  const streamingMessageRef = useRef(streamingMessage);
  useEffect(() => {
    streamingMessageRef.current = streamingMessage;
  }, [streamingMessage]);

  const containerBg = theme.palette.mode === 'light' ? '#fff' : '#343541';
  const borderColor = theme.palette.mode === 'light' ? '#e5e7eb' : '#565869';

  // Save conversations to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('chat_conversations', JSON.stringify(pruneConversations(conversations, currentConversationId)));
      localStorage.setItem('current_conversation_id', currentConversationId);
    } catch (error) {
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        setErrorMessage('Storage quota exceeded. Your conversation may not persist across page reloads.');
      } else {
        console.error('Failed to save conversations to localStorage:', error);
      }
    }
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

  const updateConversationById = useCallback((conversationId: string, update: ConversationUpdate) => {
    setConversations(prev => {
      const existing = prev[conversationId] || createNewConversation(conversationId, welcomeMessage);
      const updates = typeof update === 'function' ? update(existing) : update;

      return pruneConversations({
        ...prev,
        [conversationId]: {
          ...existing,
          ...updates,
          updatedAt: Date.now(),
        }
      }, conversationId);
    });
  }, [welcomeMessage]);

  const updateConversation = useCallback((updates: ConversationUpdate) => {
    updateConversationById(currentConversationId, updates);
  }, [currentConversationId, updateConversationById]);

  const addMessage = useCallback((conversationId: string, message: Message) => {
    updateConversationById(conversationId, conversation => ({
      messages: [...(conversation.messages || []), message],
    }));
  }, [updateConversationById]);

  const handleNewConversation = useCallback(() => {
    const newId = generateConversationId();
    setConversations(prev => pruneConversations({
      ...prev,
      [newId]: createNewConversation(newId, welcomeMessage),
    }, newId));
    setCurrentConversationId(newId);
    setStreamingMessage(null);
    setInput('');
    setShowExamples(true);
  }, [welcomeMessage]);

  const handleDeleteConversation = useCallback((convId: string) => {
    void ChatAPI.deleteConversation(convId).catch(error => {
      console.error('Failed to delete server conversation:', error);
    });
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
        setErrorMessage('Failed to play audio. Please try again later.');
      }
    },
    [isMuted]
  );

  const handleStopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsLoading(false);
      const currentStreaming = streamingMessageRef.current;
      if (currentStreaming) {
        addMessage(currentConversationId, {
          ...currentStreaming,
          content: sanitizeAndParse(currentStreaming.content + ' [Generation stopped]'),
          rawContent: `${getMessageText(currentStreaming)} [Generation stopped]`,
        });
        setStreamingMessage(null);
      }
    }
  }, [addMessage, currentConversationId]);

  // Using API service - sendChatMessage is now handled by ChatAPI.sendMessage

  const handleSendMessage = useCallback(async (
    messageContent: string | null = null,
    options: {
      conversationId?: string;
      resetConversation?: boolean;
      history?: ChatMessageHistoryItem[];
    } = {}
  ) => {
    const content = messageContent || input.trim();
    if (!content) return;
    const activeConversationId = options.conversationId || currentConversationId;
    const activeConversation = conversations[activeConversationId] || currentConversation;

    setIsLoading(true);
    setErrorMessage('');
    setShowExamples(false);

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    if (content.toLowerCase() === '/clear') {
      setIsLoading(false);
      void ChatAPI.clearConversation(activeConversationId).catch(error => {
        console.error('Failed to clear server conversation:', error);
      });
      handleNewConversation();
      return;
    }

    // Add user's message
    const userMessage: Message = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: sanitizeAndParse(content),
      rawContent: content,
      timestamp: Date.now(),
    };
    addMessage(activeConversationId, userMessage);
    setInput('');

    // Update conversation title if it's the first real message
    if (activeConversation.messages.length === 1) {
      const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
      updateConversationById(activeConversationId, { title });
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
        conversationId: activeConversationId,
        resetConversation: options.resetConversation,
        history: options.history,
        onChunk: (partialText, annotations) => {
          let formattedText = partialText;
          if (annotations && annotations.length > 0) {
            const citationText = annotations
              .map((_ann, idx) => `[${idx + 1}]`)
              .join(' ');
            formattedText = `${partialText} ${citationText}`;
          }
          setStreamingMessage({ ...streamingMsg, content: formattedText, rawContent: partialText, annotations });
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

          finalContent = `${result.text} ${citationList}<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid ${borderColor};">${citationDetails}</div>`;
        }

        addMessage(activeConversationId, {
          ...streamingMsg,
          content: sanitizeAndParse(finalContent),
          rawContent: result.text,
          annotations: result.annotations,
        });
        setStreamingMessage(null);
        playAudioResponse(result.text);
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
          updateConversationById(activeConversationId, conversation => ({
            messages: conversation.messages.filter(message => message.id !== userMessage.id),
          }));
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
          if (streamingMessageRef.current) {
            setStreamingMessage(null);
          }
        }
      }
    } finally {
      setIsLoading(false);
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
    }
  }, [
    input,
    currentConversationId,
    conversations,
    currentConversation,
    borderColor,
    playAudioResponse,
    captchaToken,
    addMessage,
    updateConversationById,
    handleNewConversation
  ]);

  const handleEditMessage = useCallback((messageId: string, newContent: string) => {
    const messageIndex = currentConversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex >= 0) {
      const newMessages = currentConversation.messages.slice(0, messageIndex);
      const history = serializeConversationHistory(newMessages);
      updateConversation({ messages: newMessages });
      handleSendMessage(newContent, {
        conversationId: currentConversationId,
        resetConversation: true,
        history,
      });
    }
  }, [currentConversation, currentConversationId, updateConversation, handleSendMessage]);

  const handleRegenerateMessage = useCallback(() => {
    const lastUserIndex = currentConversation.messages.map(m => m.role).lastIndexOf('user');
    const lastUserMessage = lastUserIndex >= 0 ? currentConversation.messages[lastUserIndex] : undefined;
    if (lastUserMessage) {
      const newMessages = currentConversation.messages.slice(0, lastUserIndex);
      const history = serializeConversationHistory(newMessages);
      updateConversation({ messages: newMessages });
      const text = getMessageText(lastUserMessage);
      handleSendMessage(text, {
        conversationId: currentConversationId,
        resetConversation: true,
        history,
      });
    }
  }, [currentConversation, currentConversationId, updateConversation, handleSendMessage]);

  const [speechRecognition, setSpeechRecognition] = useState<SpeechRecognition | null>(null);

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognitionCtor) {
      const recognition = new SpeechRecognitionCtor();
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0].transcript)
          .join('');
        setInput(transcript);
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
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

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      try {
        localStorage.setItem('chat_mute', JSON.stringify(next));
      } catch { /* ignore persistence failures */ }
      return next;
    });
  }, []);

  // Load Turnstile script
  useEffect(() => {
    const existing = document.querySelector('script[src*="turnstile"]');
    if (existing) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  // Handle Turnstile
  useEffect(() => {
    if (showCaptcha && window.turnstile) {
      if (turnstileWidgetRef.current) {
        window.turnstile.reset(turnstileWidgetRef.current);
        return;
      }

      turnstileWidgetRef.current = window.turnstile.render('#turnstile-container', {
        sitekey: ENV.TURNSTILE_SITE_KEY,
        callback: async (token: string) => {
          try {
            const result = await ChatAPI.verifyCaptcha(token);
            if (result.success) {
              setCaptchaToken(token);
              setShowCaptcha(false);
              turnstileWidgetRef.current = null;
              setErrorMessage('');
              if (inputRef.current) {
                handleSendMessage(inputRef.current);
              }
            } else {
              setErrorMessage('Captcha verification failed. Please try again.');
            }
          } catch {
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

  const lastUserMessageId = useMemo(() => {
    for (let i = currentConversation.messages.length - 1; i >= 0; i--) {
      if (currentConversation.messages[i].role === 'user') return currentConversation.messages[i].id;
    }
    return undefined;
  }, [currentConversation.messages]);

  const streamingDisplayMsg = useMemo(() => streamingMessage
    ? { ...streamingMessage, content: sanitizeAndParse(streamingMessage.content || '▍') }
    : null,
    [streamingMessage]
  );

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
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
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
              isLastUserMessage={msg.id === lastUserMessageId}
              isStreaming={false}
            />
          ))}

          {streamingDisplayMsg && (
            <MessageComponent
              msg={streamingDisplayMsg}
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
            <Fade in={true} timeout={reduceMotion ? 0 : undefined}>
              <Box sx={{ p: 4 }}>
                <Stack spacing={2} sx={{ alignItems: 'center' }}>
                  <Typography variant="subtitle1" sx={{ opacity: 0.7 }}>
                    <LightbulbIcon sx={{ fontSize: 'inherit', verticalAlign: 'middle', mr: 0.5 }} /> Try asking:
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'center' }}>
                    {EXAMPLE_PROMPTS.map((prompt, idx) => (
                      <Chip
                        key={idx}
                        label={prompt}
                        clickable
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
