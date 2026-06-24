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
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';

/**
 * Message Component — WindowsForum "Ask the AI" bubble layout.
 * User messages are right-aligned brand-blue bubbles; assistant messages are
 * left-aligned cards with the bot avatar, name + AI badge, and hover actions.
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
  const isUser = msg.role === 'user';
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showCopied, setShowCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

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

  const time = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';

  const isThinking = isStreaming && extractTextFromHTML(msg.content).trim() === '▍';

  const contentBlock = isThinking ? (
    <Box className="wf-typing" aria-label="Assistant is typing">
      <Box component="span" />
      <Box component="span" />
      <Box component="span" />
    </Box>
  ) : (
    <Box
      className="message-content"
      dangerouslySetInnerHTML={{ __html: msg.content }}
    />
  );

  const actions = !isStreaming && !isEditing && (
    <Stack
      className="message-actions"
      direction="row"
      spacing={0.25}
      sx={{ mt: 0.75, opacity: 0, transition: 'opacity 0.2s' }}
    >
      <Tooltip title={showCopied ? 'Copied!' : 'Copy'}>
        <IconButton size="small" onClick={handleCopy} aria-label="Copy message content">
          {showCopied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>

      {isUser && isLastUserMessage && (
        <Tooltip title="Edit">
          <IconButton size="small" onClick={handleEdit} aria-label="Edit message">
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      {!isUser && isLastMessage && (
        <Tooltip title="Regenerate">
          <IconButton size="small" onClick={() => onRegenerate()} aria-label="Regenerate response">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      {!isUser && (
        <>
          <Tooltip title="Good response">
            <IconButton
              size="small"
              onClick={() => handleFeedback('up')}
              aria-label="Good response"
              sx={{ color: feedback === 'up' ? 'primary.main' : 'inherit' }}
            >
              <ThumbUpIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Bad response">
            <IconButton
              size="small"
              onClick={() => handleFeedback('down')}
              aria-label="Bad response"
              sx={{ color: feedback === 'down' ? 'error.main' : 'inherit' }}
            >
              <ThumbDownIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </>
      )}
    </Stack>
  );

  const editor = (
    <Stack spacing={1} sx={{ width: '100%' }}>
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
        <Button size="small" variant="contained" onClick={handleEdit} startIcon={<CheckIcon />}>
          Save
        </Button>
        <Button size="small" onClick={() => setIsEditing(false)} startIcon={<CloseIcon />}>
          Cancel
        </Button>
      </Stack>
    </Stack>
  );

  return (
    <Box sx={{ px: { xs: 2, sm: 3, md: 4 }, py: 1, '&:hover .message-actions': { opacity: 1 } }}>
      <Box sx={{ maxWidth: '52rem', mx: 'auto' }}>
        {isUser ? (
          /* ---- User: right-aligned blue bubble + avatar ---- */
          <Stack direction="row" spacing={1.5} justifyContent="flex-end" alignItems="flex-start">
            <Stack alignItems="flex-end" spacing={0.4} sx={{ minWidth: 0, flex: isEditing ? 1 : 'initial' }}>
              {isEditing ? (
                <Box sx={{ width: '100%' }}>{editor}</Box>
              ) : (
                <Box
                  className="wf-user-bubble"
                  sx={{
                    bgcolor: 'primary.main',
                    color: '#fff',
                    borderRadius: '16px 4px 16px 16px',
                    px: 2,
                    py: 1.25,
                    boxShadow: '0 1px 2px rgba(7,66,111,0.25)',
                    fontSize: 15,
                    lineHeight: 1.6,
                  }}
                >
                  {contentBlock}
                </Box>
              )}
              <Stack direction="row" spacing={1} alignItems="center">
                {time && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
                    {time}
                  </Typography>
                )}
                {actions}
              </Stack>
            </Stack>
            <Avatar src={userAvatar} alt={userName} sx={{ width: 32, height: 32, mt: 0.25 }} />
          </Stack>
        ) : (
          /* ---- Assistant: avatar + card bubble ---- */
          <Stack direction="row" spacing={1.5} alignItems="flex-start">
            <Avatar
              src={BOT_AVATAR}
              alt={ASSISTANT_NAME}
              sx={{
                width: 36,
                height: 36,
                mt: 0.25,
                bgcolor: '#0a2c4d',
                boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
              }}
            />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.primary' }}>
                  {ASSISTANT_NAME}
                </Typography>
                <Box
                  component="span"
                  sx={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    bgcolor: 'secondary.main',
                    color: '#fff',
                    px: 0.75,
                    py: '1px',
                    borderRadius: 999,
                    lineHeight: 1.6,
                  }}
                >
                  AI
                </Box>
                {time && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
                    {time}
                  </Typography>
                )}
              </Stack>

              {isEditing ? (
                editor
              ) : (
                <Box
                  className="wf-assistant-bubble"
                  sx={{
                    display: 'inline-block',
                    maxWidth: '100%',
                    bgcolor: theme.palette.mode === 'light' ? '#f8fafb' : '#1f2d46',
                    border: `1px solid ${theme.palette.mode === 'light' ? theme.palette.divider : '#34445f'}`,
                    borderLeft: `4px solid ${theme.palette.primary.main}`,
                    borderRadius: '4px 16px 16px 16px',
                    px: 2,
                    py: 1.5,
                    color: theme.palette.mode === 'light' ? 'inherit' : '#e8edf4',
                    boxShadow: theme.palette.mode === 'light'
                      ? '0 1px 2px rgba(0,0,0,0.08)'
                      : '0 1px 2px rgba(255,255,255,0.06), 0 8px 20px rgba(0,0,0,0.4)',
                  }}
                >
                  {contentBlock}
                </Box>
              )}
              {actions}
            </Box>
          </Stack>
        )}
      </Box>
    </Box>
  );
});
