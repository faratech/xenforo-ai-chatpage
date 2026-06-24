import React, { useCallback } from 'react';
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

/**
 * InputArea Component — WindowsForum "Ask the AI" composer.
 */
export const InputArea: React.FC<InputAreaProps> = ({
  input,
  setInput,
  isLoading,
  isListening,
  isSpeechRecognitionSupported,
  isMuted,
  onSend,
  onStop,
  onStartListening,
  onStopListening,
  onToggleMute,
  textFieldRef,
}) => {
  const theme = useTheme();
  const canSend = !!input.trim() && !isLoading;

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  return (
    <Box
      className="wf-input-area"
      sx={{
        borderTop: `1px solid ${theme.palette.divider}`,
        p: { xs: 1.5, sm: 2 },
        backgroundColor: 'background.paper',
      }}
    >
      <Box sx={{ maxWidth: '52rem', mx: 'auto' }}>
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
          {isSpeechRecognitionSupported && (
            <Tooltip title={isListening ? 'Stop recording' : 'Voice input'}>
              <IconButton
                onClick={isListening ? onStopListening : onStartListening}
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
            }}
            disabled={isLoading}
            aria-label="Type your message"
          />

          <Tooltip title={isMuted ? 'Enable read-aloud' : 'Mute read-aloud'}>
            <IconButton onClick={onToggleMute} size="small" sx={{ color: 'text.secondary' }}>
              {isMuted ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
            </IconButton>
          </Tooltip>

          {isLoading ? (
            <Tooltip title="Stop generation">
              <IconButton
                onClick={onStop}
                size="small"
                sx={{ bgcolor: 'action.hover', borderRadius: '10px', width: 38, height: 38 }}
              >
                <StopIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title="Send message">
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
          justifyContent="space-between"
          sx={{ mt: 1, px: 0.5, gap: 1, flexWrap: 'wrap' }}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
            {isListening ? 'Listening… speak now' : 'Press Enter to send · Shift+Enter for new line'}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
            {ASSISTANT_NAME} can make mistakes
          </Typography>
        </Stack>
      </Box>
    </Box>
  );
};
