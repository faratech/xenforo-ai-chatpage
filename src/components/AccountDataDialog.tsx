import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { APIError, ChatAPI } from '../services/api';
import type { DeleteAllSavedChatDataResponse } from '../services/api';
import {
  createAccountDataArtifact,
  downloadJSONArtifact,
} from './managementDialogHelpers';
import { reportConversationExport } from '../services/telemetry';

export const ACCOUNT_DELETE_CONFIRMATION_PHRASE = 'DELETE SAVED CHAT DATA';

export interface AccountDataDialogProps {
  open: boolean;
  onClose: () => void;
  signedIn: boolean;
  /** Quiesces background cloud work before the irreversible server request. */
  onDeleteAllStarting?: () => void | Promise<void>;
  /**
   * Root integration clears account-scoped browser data here. This callback is
   * invoked only after deleteAllSavedChatData has returned success.
   */
  onDeleteAllSucceeded: (
    result: DeleteAllSavedChatDataResponse,
  ) => void | Promise<void>;
  /** Resumes background work after failure or after the successful local reset. */
  onDeleteAllFinished?: (serverDeleted: boolean) => void | Promise<void>;
  onExportDownloaded?: (generatedAt: number) => void;
}

const errorText = (error: unknown, fallback: string): string => {
  if (error instanceof APIError || error instanceof Error) return error.message;
  return fallback;
};

/** Explicit export/delete controls for the signed-in member's saved chat data. */
export const AccountDataDialog = ({
  open,
  onClose,
  signedIn,
  onDeleteAllStarting,
  onDeleteAllSucceeded,
  onDeleteAllFinished,
  onExportDownloaded,
}: AccountDataDialogProps) => {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const operationControllerRef = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<'export' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [serverDeletionComplete, setServerDeletionComplete] = useState(false);
  const confirmationMatches = confirmation === ACCOUNT_DELETE_CONFIRMATION_PHRASE;

  useEffect(() => {
    if (open) return undefined;
    operationControllerRef.current?.abort();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setOperation(null);
      setError(null);
      setDeleteError(null);
      setSuccess(null);
      setDeleteConfirmOpen(false);
      setConfirmation('');
      setServerDeletionComplete(false);
    });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => () => operationControllerRef.current?.abort(), []);

  const exportData = async () => {
    if (!signedIn || operation) return;
    const controller = new AbortController();
    operationControllerRef.current = controller;
    setOperation('export');
    setError(null);
    setDeleteError(null);
    setSuccess(null);
    try {
      const response = await ChatAPI.exportSavedChatData({ signal: controller.signal });
      if (controller.signal.aborted) return;
      const artifact = createAccountDataArtifact(response.export, response.export.generated_at);
      downloadJSONArtifact(artifact);
      reportConversationExport(
        'json',
        'download',
        response.export.conversations.reduce((count, conversation) => count + conversation.messages.length, 0),
      );
      onExportDownloaded?.(response.export.generated_at);
      setSuccess('Your saved chat data export was downloaded.');
    } catch (exportError) {
      if (!controller.signal.aborted) {
        setError(errorText(exportError, 'Your saved chat data could not be exported.'));
      }
    } finally {
      if (operationControllerRef.current === controller) operationControllerRef.current = null;
      if (!controller.signal.aborted) setOperation(null);
    }
  };

  const deleteAllData = async () => {
    if (!signedIn || operation || !confirmationMatches) return;
    const controller = new AbortController();
    operationControllerRef.current = controller;
    setOperation('delete');
    setError(null);
    setDeleteError(null);
    setSuccess(null);
    setServerDeletionComplete(false);
    let serverDeleted = false;
    try {
      await onDeleteAllStarting?.();
      if (controller.signal.aborted) return;
      const response = await ChatAPI.deleteAllSavedChatData({ signal: controller.signal });
      if (controller.signal.aborted) return;
      serverDeleted = true;

      // This flag separates a failed browser cleanup callback from an API
      // failure: the irreversible server operation has already succeeded.
      setServerDeletionComplete(true);
      try {
        await onDeleteAllSucceeded(response);
      } catch (cleanupError) {
        if (!controller.signal.aborted) {
          setDeleteError(`Saved server data was deleted, but this browser could not clear its local chat data: ${errorText(cleanupError, 'local cleanup failed')}`);
        }
        return;
      }
      if (controller.signal.aborted) return;

      setDeleteConfirmOpen(false);
      setConfirmation('');
      setSuccess(response.attachment_files_deferred > 0
        ? `Saved chat data was deleted. ${response.attachment_files_deferred} attachment ${response.attachment_files_deferred === 1 ? 'file is' : 'files are'} queued for secure cleanup.`
        : 'Saved chat data was deleted from the server and this browser.');
    } catch (deleteError) {
      if (!controller.signal.aborted) {
        setDeleteError(errorText(deleteError, 'Saved chat data could not be deleted. Nothing was cleared from this browser.'));
      }
    } finally {
      try {
        await onDeleteAllFinished?.(serverDeleted);
      } catch (resumeError) {
        if (!controller.signal.aborted) {
          setDeleteError(errorText(resumeError, 'Cloud history could not resume automatically. Reload this page to resume syncing.'));
        }
      }
      if (operationControllerRef.current === controller) operationControllerRef.current = null;
      if (!controller.signal.aborted) setOperation(null);
    }
  };

  const closeConfirmation = () => {
    if (operation) return;
    setDeleteConfirmOpen(false);
    setConfirmation('');
    setDeleteError(null);
    setServerDeletionComplete(false);
  };

  const requestClose = () => {
    if (operation) return;
    onClose();
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={requestClose}
        fullScreen={mobile}
        fullWidth
        maxWidth="sm"
        aria-labelledby="account-data-title"
      >
        <DialogTitle id="account-data-title" sx={{ pr: 7 }}>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
            <ManageAccountsOutlinedIcon color="primary" />
            <Box>
              <Typography component="span" variant="h6">Your AI chat data</Typography>
              <Typography variant="body2" color="text.secondary">
                Export or remove saved product data
              </Typography>
            </Box>
          </Stack>
          <Tooltip title="Close">
            <span>
              <IconButton
                aria-label="Close account data"
                onClick={requestClose}
                disabled={operation !== null}
                sx={{ position: 'absolute', right: 12, top: 12 }}
              >
                <CloseIcon />
              </IconButton>
            </span>
          </Tooltip>
        </DialogTitle>

        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
          {!signedIn ? (
            <Alert severity="info">Sign in to export or delete your saved AI chat data.</Alert>
          ) : (
            <Stack spacing={2.25}>
              {error && <Alert severity="error" role="alert">{error}</Alert>}
              {success && <Alert severity="success" role="status">{success}</Alert>}

              <Box
                component="section"
                aria-labelledby="account-export-heading"
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 2,
                  p: { xs: 1.75, sm: 2.25 },
                }}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between' }}>
                  <Box sx={{ maxWidth: 430 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <DownloadOutlinedIcon color="primary" />
                      <Typography component="h3" id="account-export-heading" variant="subtitle1" sx={{ fontWeight: 700 }}>
                        Download a copy
                      </Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      Download JSON containing saved conversations, feedback, attachment metadata, share records, and support cases.
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                      Uploaded file contents and provider conversation mappings are not embedded in this export.
                    </Typography>
                  </Box>
                  <Button
                    variant="outlined"
                    startIcon={operation === 'export'
                      ? <CircularProgress size={16} />
                      : <DownloadOutlinedIcon />}
                    onClick={() => { void exportData(); }}
                    disabled={operation !== null}
                    sx={{ alignSelf: { xs: 'stretch', sm: 'center' }, whiteSpace: 'nowrap' }}
                  >
                    Download JSON
                  </Button>
                </Stack>
              </Box>

              <Alert severity="warning" icon={<WarningAmberRoundedIcon />}>
                <Typography component="p" variant="subtitle2">Provider mappings have a separate lifecycle</Typography>
                <Typography variant="body2">
                  Provider conversation mappings are not deleted by this action. They follow a separate 30-day cleanup process.
                </Typography>
              </Alert>

              <Box
                component="section"
                aria-labelledby="account-delete-heading"
                sx={{
                  position: 'relative',
                  overflow: 'hidden',
                  border: '1px solid',
                  borderColor: 'error.main',
                  borderRadius: 2,
                  p: { xs: 1.75, sm: 2.25 },
                  '&::before': {
                    content: '""',
                    position: 'absolute',
                    inset: '0 auto 0 0',
                    width: 5,
                    bgcolor: 'error.main',
                  },
                }}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between' }}>
                  <Box sx={{ maxWidth: 430 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <DeleteSweepOutlinedIcon color="error" />
                      <Typography component="h3" id="account-delete-heading" variant="subtitle1" sx={{ fontWeight: 700 }}>
                        Delete all saved chat data
                      </Typography>
                    </Stack>
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      Permanently remove saved conversations, feedback, uploads, share snapshots, support cases, and chat-app telemetry from WindowsForum.
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                      After the server confirms deletion, this app will ask the parent chat surface to clear this browser’s account-scoped chat data.
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                      To stop stale devices restoring deleted chats, WindowsForum retains only owner-scoped, one-way conversation ID hashes for up to 365 days. They contain no raw conversation ID, title, or message text.
                    </Typography>
                  </Box>
                  <Button
                    color="error"
                    variant="outlined"
                    startIcon={<DeleteSweepOutlinedIcon />}
                    onClick={() => {
                      setError(null);
                      setSuccess(null);
                      setConfirmation('');
                      setDeleteError(null);
                      setServerDeletionComplete(false);
                      setDeleteConfirmOpen(true);
                    }}
                    disabled={operation !== null}
                    sx={{ alignSelf: { xs: 'stretch', sm: 'center' }, whiteSpace: 'nowrap' }}
                  >
                    Delete all data
                  </Button>
                </Stack>
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={requestClose} disabled={operation !== null}>Done</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteConfirmOpen}
        onClose={closeConfirmation}
        fullWidth
        maxWidth="xs"
        aria-labelledby="confirm-account-delete-title"
      >
        <DialogTitle id="confirm-account-delete-title">Permanently delete saved chat data?</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Alert severity="error" icon={<WarningAmberRoundedIcon />}>
              This cannot be undone. Active share links will stop working, and saved chats and support cases will be removed.
            </Alert>
            {deleteError && <Alert severity="error" role="alert">{deleteError}</Alert>}
            <Typography variant="body2">
              Type <Box component="strong" sx={{ fontFamily: 'monospace' }}>{ACCOUNT_DELETE_CONFIRMATION_PHRASE}</Box> to confirm.
            </Typography>
            <TextField
              autoFocus
              fullWidth
              label="Confirmation phrase"
              value={confirmation}
              onChange={event => setConfirmation(event.target.value)}
              disabled={operation !== null || serverDeletionComplete}
              autoComplete="off"
              error={confirmation.length > 0 && !confirmationMatches}
              helperText={confirmation.length > 0 && !confirmationMatches
                ? 'The phrase must match exactly.'
                : 'This check is case-sensitive.'}
            />
            <Divider />
            <Typography variant="caption" color="text.secondary">
              Provider conversation mappings are not part of this deletion and remain subject to their separate 30-day cleanup process.
            </Typography>
            <Typography variant="caption" color="text.secondary">
              A one-way, owner-scoped deletion guard may remain for up to 365 days solely to prevent stale-device restoration; it contains no transcript content.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={closeConfirmation} disabled={operation !== null}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            startIcon={operation === 'delete'
              ? <CircularProgress color="inherit" size={16} />
              : <DeleteSweepOutlinedIcon />}
            onClick={() => { void deleteAllData(); }}
            disabled={!confirmationMatches || operation !== null || serverDeletionComplete}
          >
            Delete saved data
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
