import { useState, useCallback, useMemo, memo } from 'react';
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
import type { Annotation, MessageProps } from '../types';
import { parseHttpUrl, sanitizeAndParse, splitStreamingMarkdown } from '../utils/helpers';
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';

const citationLabel = (annotation: Annotation): string => {
  switch (annotation.type) {
    case 'url_citation': {
      if (annotation.title) return annotation.title;
      const url = parseHttpUrl(annotation.url);
      return url ? url.hostname : annotation.url;
    }
    case 'file_citation':
      return annotation.filename || annotation.fileId || 'Source';
    case 'container_file_citation':
      return annotation.filename || annotation.fileId || annotation.containerId || 'Source';
    case 'file_path':
      return annotation.filename || annotation.fileId || 'Source';
  }
};

const citationReactKey = (annotation: Annotation, index: number): string => {
  switch (annotation.type) {
    case 'url_citation':
      return `url_${annotation.url}_${index}`;
    case 'file_citation':
      return `file_${annotation.fileId || annotation.filename || ''}_${index}`;
    case 'container_file_citation':
      return `container_${annotation.containerId || ''}_${annotation.fileId || ''}_${index}`;
    case 'file_path':
      return `path_${annotation.fileId || ''}_${index}`;
  }
};

const SourcesList = ({ annotations }: { annotations: Annotation[] }) => (
  <Box className="message-file-sources" sx={{ mt: 1.25, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
    <Typography component="div" sx={{ fontSize: 12, color: 'text.secondary', mb: 0.5 }}>Sources</Typography>
    {annotations.map((annotation, index) => {
      // Only validated http(s) URLs become links; everything else is text.
      const safeUrl = annotation.type === 'url_citation' ? parseHttpUrl(annotation.url) : null;
      return (
        <Typography key={citationReactKey(annotation, index)} component="div" sx={{ fontSize: 12 }}>
          [{index + 1}]{' '}
          {safeUrl ? (
            <a href={safeUrl.href} target="_blank" rel="noopener noreferrer">
              {citationLabel(annotation)}
            </a>
          ) : (
            citationLabel(annotation)
          )}
        </Typography>
      );
    })}
  </Box>
);

/**
 * Message Component — WindowsForum "Ask the AI" bubble layout.
 * User messages are right-aligned brand-blue bubbles; assistant messages are
 * left-aligned cards with the bot avatar, name + AI badge, and hover actions.
 *
 * While a response streams, content renders as escaped plain text; Markdown
 * parsing and sanitization run exactly once, when the message completes.
 */
export const Message = memo<MessageProps>(({
  msg,
  userAvatar,
  userName,
  onEdit,
  onRegenerate,
  onRetry,
  isLastMessage,
  isLastUserMessage,
  isStreaming,
  isBusy = false,
}) => {
  const theme = useTheme();
  const isUser = msg.role === 'user';
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const renderedContent = useMemo(
    () => (isStreaming ? '' : sanitizeAndParse(msg.rawContent)),
    [msg.rawContent, isStreaming]
  );

  // While streaming, format the part of the answer that is structurally
  // complete and leave the unfinished tail as plain text. Splitting is a cheap
  // line scan; the parse below is keyed on the prefix, which only changes when
  // a block closes, so it does not run on every animation frame.
  const streamingSplit = useMemo(
    () => (isStreaming ? splitStreamingMarkdown(msg.rawContent) : null),
    [msg.rawContent, isStreaming]
  );
  const streamingClosed = streamingSplit?.closed ?? '';
  const renderedStreamingPrefix = useMemo(
    () => (streamingClosed ? sanitizeAndParse(streamingClosed) : ''),
    [streamingClosed]
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(msg.rawContent);
      setCopyStatus('copied');
    } catch (error) {
      console.error('Clipboard write failed:', error);
      setCopyStatus('failed');
    }
    window.setTimeout(() => setCopyStatus('idle'), 3500);
  }, [msg.rawContent]);

  const handleEdit = useCallback(() => {
    if (isEditing && editText.trim()) {
      onEdit(msg.id, editText);
      setIsEditing(false);
    } else {
      setEditText(msg.rawContent);
      setIsEditing(true);
    }
  }, [isEditing, editText, msg.id, msg.rawContent, onEdit]);

  const time = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';

  const isThinking = isStreaming && !msg.rawContent.trim();

  const contentBlock = isThinking ? (
    <Box className="wf-typing" aria-label="Assistant is typing">
      <Box component="span" />
      <Box component="span" />
      <Box component="span" />
    </Box>
  ) : isStreaming ? (
    <Box className="message-content">
      {renderedStreamingPrefix && (
        <Box dangerouslySetInnerHTML={{ __html: renderedStreamingPrefix }} />
      )}
      {/* The unfinished tail stays a React text child, so it is escaped by
          React and never reaches the Markdown parser. */}
      <Box component="span" className="wf-streaming-plain">
        {streamingSplit?.trailing ?? ''}
        <Box component="span" className="streaming-cursor" aria-hidden="true" />
      </Box>
    </Box>
  ) : (
    <Box
      className="message-content"
      dangerouslySetInnerHTML={{ __html: renderedContent }}
    />
  );

  const actions = !isStreaming && !isEditing && (
    <Stack
      className="message-actions"
      direction="row"
      spacing={0.25}
      sx={{
        mt: 0.75,
        opacity: 0,
        transition: 'opacity 0.2s',
        '@media (hover: none), (pointer: coarse)': { opacity: 1 },
        '&:focus-within': { opacity: 1 },
      }}
    >
      <Tooltip title={copyStatus === 'copied' ? 'Copied!' : copyStatus === 'failed' ? 'Copy failed' : 'Copy'}>
        <IconButton size="small" onClick={() => { void handleCopy(); }} aria-label="Copy message content">
          {copyStatus === 'copied' ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>

      {isUser && isLastUserMessage && !isBusy && (
        <Tooltip title="Edit">
          <IconButton size="small" onClick={handleEdit} aria-label="Edit message">
            <EditIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      {isUser && msg.status === 'failed' && !isBusy && (
        <Tooltip title="Retry">
          <IconButton size="small" onClick={() => onRetry(msg.id)} aria-label="Retry message">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      {!isUser && isLastMessage && !isBusy && (
        <Tooltip title="Regenerate">
          <IconButton size="small" onClick={() => onRegenerate()} aria-label="Regenerate response">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
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
    <Box sx={{ px: { xs: 2, sm: 3, md: 4 }, py: 1, '&:hover .message-actions, &:focus-within .message-actions': { opacity: 1 } }}>
      <Box sx={{ maxWidth: '52rem', mx: 'auto' }}>
        {isUser ? (
          /* ---- User: right-aligned blue bubble + avatar ---- */
          <Stack direction="row" spacing={1.5} sx={{ justifyContent: 'flex-end', alignItems: 'flex-start' }}>
            <Stack spacing={0.4} sx={{ alignItems: 'flex-end', minWidth: 0, flex: isEditing ? 1 : 'initial' }}>
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
                  {msg.status === 'failed' && (
                    <Typography component="span" sx={{ display: 'block', mt: 0.75, fontSize: 12, color: '#fff' }}>
                      Not sent — edit or retry
                    </Typography>
                  )}
                </Box>
              )}
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
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
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
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
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
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
                  {!!msg.annotations?.length && !isStreaming && (
                    <SourcesList annotations={msg.annotations} />
                  )}
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
