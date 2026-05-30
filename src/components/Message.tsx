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
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
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
  isLastUserMessage,
  isStreaming,
  onFeedback,
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
    setTimeout(() => setShowCopied(false), 3500);
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
        <Stack direction="row" spacing={3} sx={{ alignItems: 'flex-start' }}>
          {msg.role === 'user' && (
            <Avatar
              src={userAvatar}
              sx={{ width: 32, height: 32, mt: 0.5 }}
            />
          )}
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
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
                  <Button size="small" onClick={handleEdit} startIcon={<CheckIcon />}>
                    Save
                  </Button>
                  <Button size="small" onClick={() => setIsEditing(false)} startIcon={<CloseIcon />}>
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
                      <IconButton size="small" onClick={handleCopy} aria-label="Copy message content">
                        {showCopied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
                      </IconButton>
                    </Tooltip>

                    {msg.role === 'user' && isLastUserMessage && (
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={handleEdit} aria-label="Edit message">
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}

                    {msg.role === 'ai' && isLastMessage && (
                      <Tooltip title="Regenerate">
                        <IconButton size="small" onClick={() => onRegenerate()} aria-label="Regenerate response">
                          <RefreshIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}

                    {msg.role === 'ai' && (
                      <>
                        <Tooltip title="Good response">
                          <IconButton
                            size="small"
                            onClick={() => handleFeedback('up')}
                            aria-label="Good response"
                            sx={{ color: feedback === 'up' ? '#10a37f' : 'inherit' }}
                          >
                            <ThumbUpIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Bad response">
                          <IconButton
                            size="small"
                            onClick={() => handleFeedback('down')}
                            aria-label="Bad response"
                            sx={{ color: feedback === 'down' ? '#ef4444' : 'inherit' }}
                          >
                            <ThumbDownIcon fontSize="small" />
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