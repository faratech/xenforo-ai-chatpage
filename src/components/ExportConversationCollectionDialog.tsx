import { useState, type ReactNode } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import type { Conversation } from '../types';
import {
  createConversationCollectionExport,
  downloadConversationExport,
  type ConversationExportFormat,
} from '../services/conversationExport';

export interface ExportConversationCollectionDialogProps {
  open: boolean;
  conversations: readonly Conversation[];
  onClose: () => void;
  onCompleted?: (outcome: ConversationCollectionExportOutcome) => void;
}

export interface ConversationCollectionExportOutcome {
  format: ConversationExportFormat;
  conversationCount: number;
}

interface CollectionExportChoiceProps {
  title: string;
  description: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}

const CollectionExportChoice = ({
  title,
  description,
  icon,
  disabled,
  onClick,
}: CollectionExportChoiceProps) => (
  <Button
    variant="outlined"
    fullWidth
    disabled={disabled}
    onClick={onClick}
    startIcon={icon}
    sx={{
      justifyContent: 'flex-start',
      px: 1.5,
      py: 1.15,
      textAlign: 'left',
      textTransform: 'none',
      '& .MuiButton-startIcon': { alignSelf: 'flex-start', mt: 0.25 },
    }}
  >
    <Box sx={{ minWidth: 0 }}>
      <Typography component="span" sx={{ display: 'block', fontSize: 14, fontWeight: 700 }}>
        {title}
      </Typography>
      <Typography component="span" color="text.secondary" sx={{ display: 'block', fontSize: 12.5, lineHeight: 1.4 }}>
        {description}
      </Typography>
    </Box>
  </Button>
);

type OpenCollectionDialogProps = Omit<ExportConversationCollectionDialogProps, 'open'>;

/** The open-state child is unmounted on close so stale errors cannot leak into a later export. */
const OpenCollectionDialog = ({
  conversations,
  onClose,
  onCompleted,
}: OpenCollectionDialogProps) => {
  const [error, setError] = useState<string | null>(null);
  const hasConversations = conversations.length > 0;

  const download = (format: ConversationExportFormat) => {
    if (!hasConversations) return;
    setError(null);
    try {
      downloadConversationExport(createConversationCollectionExport(conversations, format));
      try {
        onCompleted?.({ format, conversationCount: conversations.length });
      } catch {
        // Optional host telemetry must never reverse a completed download.
      }
      onClose();
    } catch {
      setError('The selected chats could not be exported. Try again.');
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      aria-labelledby="wf-export-selected-title"
      aria-describedby="wf-export-selected-description"
      container={() => document.getElementById('wf-chat-window')}
    >
      <DialogTitle id="wf-export-selected-title">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <FileDownloadOutlinedIcon color="primary" />
          <Typography component="span" variant="h6">Export selected chats</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography id="wf-export-selected-description" variant="body2" color="text.secondary">
            Download {conversations.length} selected chat{conversations.length === 1 ? '' : 's'} in one private file. Nothing is uploaded.
          </Typography>
          {!hasConversations && (
            <Alert severity="info" role="status">Select at least one chat to export.</Alert>
          )}
          {error && <Alert severity="error" role="alert">{error}</Alert>}
          <CollectionExportChoice
            title="Download Markdown"
            description="A readable document with every selected transcript and its normalized sources."
            icon={<ArticleOutlinedIcon />}
            disabled={!hasConversations}
            onClick={() => download('markdown')}
          />
          <CollectionExportChoice
            title="Download JSON"
            description="A structured backup that preserves every selected conversation in one file."
            icon={<DataObjectOutlinedIcon />}
            disabled={!hasConversations}
            onClick={() => download('json')}
          />
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button></DialogActions>
    </Dialog>
  );
};

export const ExportConversationCollectionDialog = ({
  open,
  ...props
}: ExportConversationCollectionDialogProps) => (
  open ? <OpenCollectionDialog {...props} /> : null
);
