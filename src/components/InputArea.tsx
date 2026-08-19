import React, { memo, useCallback } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import MicIcon from '@mui/icons-material/Mic';
import MicNoneIcon from '@mui/icons-material/MicNone';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import type { InputAreaProps } from '../types';
import { ASSISTANT_NAME } from '../config/brand';
import { CHAT_CONTENT_MAX_WIDTH } from '../config/layout';

/**
 * InputArea Component — WindowsForum "Ask the AI" composer.
 *
 * Memoized deliberately. ChatWindow re-renders once per animation frame for
 * the whole duration of a streaming response, and this subtree contains MUI's
 * TextareaAutosize, whose layout effect has no dependency array: every render
 * runs getComputedStyle plus two scrollHeight reads before paint. Left
 * unmemoized that is a forced synchronous reflow ~60 times a second, on a DOM
 * the stream is simultaneously mutating. Callers must pass stable handlers.
 */
export const InputArea = memo<InputAreaProps>(({
  input,
  setInput,
  isLoading,
  isListening,
  isSpeechRecognitionSupported,
  isMuted,
  voiceEnabled,
  isOffline = false,
  inputBytes,
  maxMessageBytes,
  onSend,
  onStop,
  onStartListening,
  onStopListening,
  onToggleMute,
  textFieldRef,
}) => {
  const theme = useTheme();
  const isOverLimit = inputBytes > maxMessageBytes;
  const isNearLimit = inputBytes >= Math.floor(maxMessageBytes * 0.8);
  const canSend = !!input.trim() && !isLoading && !isOverLimit && !isOffline;

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // The composer stays editable while a response streams, so Enter must be
      // gated here rather than by disabling the field.
      if (canSend) onSend();
    }
  }, [canSend, onSend]);

  return (
    <Box
      className="wf-input-area"
      sx={{
        borderTop: `1px solid ${theme.palette.divider}`,
        p: { xs: 1, sm: 2 },
        backgroundColor: 'background.paper',
        // The last row of a fixed-height column, so it is already pinned to the
        // bottom of the pane. It was sticky only while the document scrolled,
        // which also meant it detached once the reader passed the chat.
        flexShrink: 0,
      }}
    >
      <Box sx={{ maxWidth: CHAT_CONTENT_MAX_WIDTH, mx: 'auto' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 0.5,
            p: 0.75,
            pl: 1,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: '14px',
            backgroundColor: 'background.paper',
            transition: 'border-color 0.12s, box-shadow 0.12s',
            '&:focus-within': {
              borderColor: 'primary.main',
              boxShadow: '0 0 0 3px rgba(15,108,189,0.15)',
            },
          }}
        >
          {voiceEnabled && isSpeechRecognitionSupported && (
            <Tooltip title={isListening ? 'Stop recording' : 'Voice input'}>
              <IconButton
                onClick={isListening ? onStopListening : onStartListening}
                aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
                size="small"
                sx={{
                  color: isListening ? '#fff' : 'text.secondary',
                  bgcolor: isListening ? 'error.main' : 'transparent',
                  '&:hover': { bgcolor: isListening ? 'error.main' : 'action.hover' },
                }}
              >
                {isListening ? <MicIcon fontSize="small" /> : <MicNoneIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}

          <TextField
            ref={textFieldRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about Windows, drivers, updates…"
            multiline
            maxRows={6}
            variant="standard"
            fullWidth
            slotProps={{
              input: {
                disableUnderline: true,
                sx: {
                  px: 1,
                  py: 0.75,
                  fontSize: '1rem',
                  '& textarea': { resize: 'none', overflowY: 'auto' },
                },
              },
              htmlInput: {
                'aria-label': 'Type your message',
                'aria-describedby': 'wf-composer-help wf-composer-count',
                'aria-invalid': isOverLimit || undefined,
              },
            }}
            // Deliberately not disabled while loading. Disabling the focused
            // textarea moves focus to <body> on every send, so keyboard and
            // screen-reader users lose their place each turn and nobody can
            // draft the next message during a long response. Only the submit
            // action is gated (canSend / handleKeyDown).
          />

          {voiceEnabled && (
            <Tooltip title={isMuted ? 'Enable read-aloud' : 'Mute read-aloud'}>
              <IconButton
                onClick={onToggleMute}
                aria-label={isMuted ? 'Enable read-aloud' : 'Mute read-aloud'}
                aria-pressed={!isMuted}
                size="small"
                sx={{ color: 'text.secondary' }}
              >
                {isMuted ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}

          {isLoading ? (
            <Tooltip title="Stop generation">
              <IconButton
                onClick={onStop}
                aria-label="Stop generation"
                size="small"
                sx={{ bgcolor: 'action.hover', borderRadius: '10px', width: 38, height: 38 }}
              >
                <StopIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title={isOffline ? 'Reconnect to send' : 'Send message'}>
              <span>
                <IconButton
                  onClick={onSend}
                  disabled={!canSend}
                  aria-label="Send message"
                  sx={{
                    borderRadius: '10px',
                    width: 38,
                    height: 38,
                    color: '#fff',
                    bgcolor: canSend ? 'primary.main' : 'action.disabledBackground',
                    '&:hover': { bgcolor: 'primary.dark' },
                    '&.Mui-disabled': { color: 'text.disabled' },
                  }}
                >
                  <SendIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box>

        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', mt: 1, px: 0.5, gap: 1, flexWrap: 'wrap' }}
        >
          <Typography id="wf-composer-help" variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
            {isOffline
              ? 'Offline · your draft is saved on this device'
              : isListening ? 'Listening… speak now' : 'Press Enter to send · Shift+Enter for new line'}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
            {ASSISTANT_NAME} can make mistakes
          </Typography>
          <Typography
            id="wf-composer-count"
            variant="caption"
            // Announce only once the limit is exceeded. A live region here
            // queued an announcement of the byte count on every keystroke.
            aria-live={isOverLimit ? 'polite' : 'off'}
            sx={{ color: isOverLimit ? 'error.main' : 'text.secondary', fontSize: 11 }}
          >
            {isOverLimit
              ? `Message is ${inputBytes - maxMessageBytes} bytes too long`
              : isNearLimit
                ? `${maxMessageBytes - inputBytes} bytes remaining`
                : `${inputBytes} / ${maxMessageBytes} bytes`}
          </Typography>
        </Stack>
      </Box>
    </Box>
  );
});

InputArea.displayName = 'InputArea';
