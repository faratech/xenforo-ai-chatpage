import { useState, useCallback, memo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import { useTheme } from '@mui/material/styles';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCopy,
  faRotateRight,
  faEdit,
  faCheck,
  faTimes,
  faThumbsUp,
  faThumbsDown,
} from '@fortawesome/free-solid-svg-icons';
import type { MessageProps } from '../types';
import { extractTextFromHTML } from '../utils/helpers';

/**
 * Message Component - Displays a single chat message with actions
 */
export const Message = memo<MessageProps>(({
  msg,
  userAvatar,
  userName,
  onEdit,
  onRegenerate,
  isLastMessage,
  isStreaming,
  onFeedback
}) => {
  const theme = useTheme();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showCopied, setShowCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  const aiBg = theme.palette.mode === 'light' ? '#f7f7f8' : '#2a2b32';
  const userBg = theme.palette.mode === 'light' ? '#fff' : '#343541';

  const handleCopy = useCallback(() => {
    const text = extractTextFromHTML(msg.content);
    navigator.clipboard.writeText(text);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  }, [msg.content]);

  const handleEdit = useCallback(() => {
    if (isEditing && editText.trim()) {
      onEdit(msg.id, editText);
      setIsEditing(false);
    } else {
      const text = extractTextFromHTML(msg.content);
      setEditText(text);
      setIsEditing(true);
    }
  }, [isEditing, editText, msg.id, msg.content, onEdit]);

  const handleFeedback = useCallback((type: 'up' | 'down') => {
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
                  color: theme.palette.mode === 'light' ? '#000' : '#fff'
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
                      backgroundColor: theme.palette.mode === 'light' ? '#f6f8fa' : '#0d1117',
                      padding: 2,
                      borderRadius: 1,
                      overflow: 'auto',
                    },
                    '& code': {
                      backgroundColor: theme.palette.mode === 'light' ? '#f6f8fa' : '#0d1117',
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