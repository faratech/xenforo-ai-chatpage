import React, { useCallback } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faMicrophone,
  faMicrophoneSlash,
  faVolumeMute,
  faVolumeUp,
  faPaperPlane,
  faStop,
} from '@fortawesome/free-solid-svg-icons';
import type { InputAreaProps } from '../types';

/**
 * InputArea Component - Handles message input and controls
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
  const containerBg = theme.palette.mode === 'light' ? '#fff' : '#343541';
  const inputBg = theme.palette.mode === 'light' ? '#fff' : '#40414f';
  const borderColor = theme.palette.mode === 'light' ? '#e5e7eb' : '#565869';

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  return (
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
                <IconButton onClick={onStop} size="small">
                  <FontAwesomeIcon icon={faStop} />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Send message">
                <IconButton
                  onClick={onSend}
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
                  onClick={isListening ? onStopListening : onStartListening}
                  size="small"
                  color={isListening ? "error" : "default"}
                >
                  <FontAwesomeIcon icon={isListening ? faMicrophoneSlash : faMicrophone} />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title={isMuted ? "Enable voice" : "Mute voice"}>
              <IconButton onClick={onToggleMute} size="small">
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
  );
};