import { useEffect, useState, type ReactNode } from 'react';
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
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import IosShareOutlinedIcon from '@mui/icons-material/IosShareOutlined';
import type { Conversation } from '../types';
import {
  createConversationExport,
  conversationToPlainText,
  downloadConversationExport,
  shareConversationPrivately,
  type ConversationShareMethod,
} from '../services/conversationExport';
import { writeClipboardText } from './managementDialogHelpers';

export type ConversationExportAction =
  | 'download-markdown'
  | 'download-json'
  | 'copy-text'
  | 'native-share';

export interface ConversationExportOutcome {
  action: ConversationExportAction;
  format: 'markdown' | 'json' | 'text';
  delivery: 'download' | 'clipboard' | ConversationShareMethod;
  messageCount: number;
}

export interface ExportConversationDialogProps {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
  /** Lets the host report the completed action without coupling this dialog to telemetry. */
  onCompleted?: (outcome: ConversationExportOutcome) => void;
}

const actionError = (action: ConversationExportAction, error: unknown): string => {
  if (action === 'copy-text') {
    return 'The conversation could not be copied. Check clipboard permission and try again.';
  }
  const detail = error instanceof Error && error.message.trim()
    ? ` ${error.message.trim()}`
    : '';
  return `The conversation could not be exported.${detail}`;
};

interface ExportChoiceProps {
  title: string;
  description: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}

const ExportChoice = ({ title, description, icon, disabled, onClick }: ExportChoiceProps) => (
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

/** Local export choices for one conversation. Nothing is uploaded by this dialog. */
export const ExportConversationDialog = ({
  open,
  onClose,
  conversation,
  onCompleted,
}: ExportConversationDialogProps) => {
  const [operation, setOperation] = useState<ConversationExportAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nativeShareAvailable = typeof navigator.share === 'function';

  const notifyCompleted = (outcome: ConversationExportOutcome) => {
    try {
      onCompleted?.(outcome);
    } catch {
      // Optional host telemetry must never reverse a completed user action.
    }
  };

  useEffect(() => {
    if (open) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setOperation(null);
      setNotice(null);
      setError(null);
    });
    return () => { cancelled = true; };
  }, [open]);

  const runAction = async (action: ConversationExportAction) => {
    if (operation) return;
    setOperation(action);
    setNotice(null);
    setError(null);

    try {
      if (action === 'download-markdown' || action === 'download-json') {
        const format = action === 'download-markdown' ? 'markdown' : 'json';
        downloadConversationExport(createConversationExport(conversation, format));
        setNotice(`${format === 'markdown' ? 'Markdown' : 'JSON'} download started.`);
        notifyCompleted({
          action,
          format,
          delivery: 'download',
          messageCount: conversation.messages.length,
        });
        return;
      }

      if (action === 'copy-text') {
        await writeClipboardText(conversationToPlainText(conversation));
        setNotice('Conversation copied as plain text.');
        notifyCompleted({
          action,
          format: 'text',
          delivery: 'clipboard',
          messageCount: conversation.messages.length,
        });
        return;
      }

      const delivery = await shareConversationPrivately(conversation, { format: 'markdown' });
      if (delivery === 'cancelled') {
        setNotice('Sharing cancelled.');
      } else if (delivery === 'download') {
        setNotice('Sharing was unavailable, so a Markdown file was downloaded.');
      } else {
        setNotice('Your device share sheet opened.');
      }
      notifyCompleted({
        action,
        format: 'markdown',
        delivery,
        messageCount: conversation.messages.length,
      });
    } catch (exportError) {
      setError(actionError(action, exportError));
    } finally {
      setOperation(null);
    }
  };

  const closeDialog = () => {
    if (!operation) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      fullWidth
      maxWidth="xs"
      aria-labelledby="wf-export-conversation-title"
      aria-describedby="wf-export-conversation-description"
      container={() => document.getElementById('wf-chat-window')}
    >
      <DialogTitle id="wf-export-conversation-title">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <FileDownloadOutlinedIcon color="primary" />
          <Typography component="span" variant="h6">Export conversation</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography id="wf-export-conversation-description" variant="body2" color="text.secondary">
            Choose how to take a private copy of “{conversation.title}”. Nothing is uploaded unless you choose where to share it.
          </Typography>

          {error && <Alert severity="error" role="alert">{error}</Alert>}
          {notice && <Alert severity="success" role="status">{notice}</Alert>}

          <Stack spacing={1} aria-busy={operation !== null}>
            <ExportChoice
              title="Download Markdown"
              description="A readable file for notes, documentation, or another editor."
              icon={<ArticleOutlinedIcon />}
              disabled={operation !== null}
              onClick={() => { void runAction('download-markdown'); }}
            />
            <ExportChoice
              title="Download JSON"
              description="A structured backup that preserves conversation details."
              icon={<DataObjectOutlinedIcon />}
              disabled={operation !== null}
              onClick={() => { void runAction('download-json'); }}
            />
            <ExportChoice
              title="Copy plain text"
              description="Put the transcript on your clipboard for quick pasting."
              icon={<ContentCopyOutlinedIcon />}
              disabled={operation !== null}
              onClick={() => { void runAction('copy-text'); }}
            />
            {nativeShareAvailable && (
              <ExportChoice
                title="Share privately"
                description="Open your device’s share sheet with a local Markdown copy."
                icon={<IosShareOutlinedIcon />}
                disabled={operation !== null}
                onClick={() => { void runAction('native-share'); }}
              />
            )}
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeDialog} disabled={operation !== null}>Done</Button>
      </DialogActions>
    </Dialog>
  );
};
