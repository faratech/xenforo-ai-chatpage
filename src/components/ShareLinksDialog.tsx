import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import AddLinkIcon from '@mui/icons-material/AddLink';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { APIError, ChatAPI } from '../services/api';
import {
  canonicalConversationShareUrl,
  writeClipboardText,
} from './managementDialogHelpers';
import { reportClientEvent } from '../services/telemetry';

const SHARE_PAGE_SIZE = 30;

const SHARE_LIFETIMES = [
  { label: '1 day', seconds: 86_400 },
  { label: '7 days', seconds: 604_800 },
  { label: '30 days', seconds: 2_592_000 },
] as const;

export type ManagedConversationShare = Awaited<
  ReturnType<typeof ChatAPI.listConversationShares>
>['shares'][number];

type ShareStatus = 'active' | 'expired' | 'revoked';

interface NewShareLink {
  shareId: string;
  url: string;
  expiresAt: number;
  copied: boolean;
}

export interface ShareLinksDialogProps {
  open: boolean;
  onClose: () => void;
  signedIn: boolean;
  /** Only cloud-synced conversations can produce immutable share snapshots. */
  conversationId?: string;
  conversationTitle?: string;
  conversationRevision?: number;
  onSharesChange?: (shares: readonly ManagedConversationShare[]) => void;
  /** Contains no token; the URL remains a one-time disclosure inside this dialog. */
  onShareCreated?: (shareId: string) => void;
}

const shareStatus = (share: ManagedConversationShare, now = Date.now()): ShareStatus => {
  if (share.revoked_at !== null) return 'revoked';
  if (share.expires_at <= now) return 'expired';
  return 'active';
};

const statusLabel = (status: ShareStatus): string => (
  status === 'active' ? 'Active' : status === 'expired' ? 'Expired' : 'Revoked'
);

const statusColor = (status: ShareStatus): 'success' | 'warning' | 'default' => {
  if (status === 'active') return 'success';
  if (status === 'expired') return 'warning';
  return 'default';
};

const statusRailColor = (status: ShareStatus): string => {
  if (status === 'active') return 'success.main';
  if (status === 'expired') return 'warning.main';
  return 'text.disabled';
};

const formatDateTime = (timestamp: number): string => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(timestamp);

const mergeSharePages = (
  current: readonly ManagedConversationShare[],
  incoming: readonly ManagedConversationShare[],
): ManagedConversationShare[] => {
  const byId = new Map(current.map(share => [share.id, share]));
  for (const share of incoming) byId.set(share.id, share);
  return [...byId.values()].sort((left, right) => right.created_at - left.created_at);
};

const errorText = (error: unknown, fallback: string): string => {
  if (error instanceof APIError || error instanceof Error) return error.message;
  return fallback;
};

/** Owner-only inventory for immutable public snapshots of one saved chat. */
export const ShareLinksDialog = ({
  open,
  onClose,
  signedIn,
  conversationId,
  conversationTitle,
  conversationRevision,
  onSharesChange,
  onShareCreated,
}: ShareLinksDialogProps) => {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const listControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const sharesRef = useRef<ManagedConversationShare[]>([]);
  const [shares, setShares] = useState<ManagedConversationShare[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [mutation, setMutation] = useState<'create' | 'revoke' | null>(null);
  const [expirySeconds, setExpirySeconds] = useState<number>(604_800);
  const [error, setError] = useState<string | null>(null);
  const [errorCanReload, setErrorCanReload] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [newLink, setNewLink] = useState<NewShareLink | null>(null);
  const [revokeCandidate, setRevokeCandidate] = useState<ManagedConversationShare | null>(null);
  const canCreate = Boolean(
    conversationId
    && Number.isInteger(conversationRevision)
    && (conversationRevision ?? 0) > 0,
  );

  const publishShares = useCallback((next: ManagedConversationShare[]) => {
    sharesRef.current = next;
    setShares(next);
    onSharesChange?.(next);
  }, [onSharesChange]);

  const loadFirstPage = useCallback(async () => {
    if (!signedIn || !conversationId) return;
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setListLoading(true);
    setError(null);
    setErrorCanReload(false);
    try {
      const response = await ChatAPI.listConversationShares({
        limit: SHARE_PAGE_SIZE,
        conversationId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      publishShares(response.shares);
      setNextCursor(response.next_cursor);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setError(errorText(loadError, 'Share links could not be loaded.'));
        setErrorCanReload(true);
      }
    } finally {
      if (listControllerRef.current === controller) listControllerRef.current = null;
      if (!controller.signal.aborted) setListLoading(false);
    }
  }, [conversationId, publishShares, signedIn]);

  useEffect(() => {
    let cancelled = false;
    const resetState = () => queueMicrotask(() => {
      if (cancelled) return;
      setShares([]);
      setNextCursor(null);
      setListLoading(false);
      setMutation(null);
      setNewLink(null);
      setRevokeCandidate(null);
      setError(null);
      setErrorCanReload(false);
      setRevokeError(null);
      setAnnouncement('');
    });
    if (!open) {
      listControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
      sharesRef.current = [];
      resetState();
      return () => { cancelled = true; };
    }
    if (!signedIn || !conversationId) {
      sharesRef.current = [];
      resetState();
      return () => { cancelled = true; };
    }
    queueMicrotask(() => {
      if (!cancelled) void loadFirstPage();
    });
    return () => {
      cancelled = true;
      listControllerRef.current?.abort();
    };
  }, [conversationId, loadFirstPage, open, signedIn]);

  useEffect(() => () => {
    listControllerRef.current?.abort();
    mutationControllerRef.current?.abort();
  }, []);

  const loadMore = async () => {
    if (!conversationId || !nextCursor || listLoading) return;
    const controller = new AbortController();
    listControllerRef.current = controller;
    setListLoading(true);
    setError(null);
    setErrorCanReload(false);
    try {
      const response = await ChatAPI.listConversationShares({
        limit: SHARE_PAGE_SIZE,
        cursor: nextCursor,
        conversationId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      publishShares(mergeSharePages(sharesRef.current, response.shares));
      setNextCursor(response.next_cursor);
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setError(errorText(loadError, 'More share links could not be loaded.'));
        setErrorCanReload(true);
      }
    } finally {
      if (listControllerRef.current === controller) listControllerRef.current = null;
      if (!controller.signal.aborted) setListLoading(false);
    }
  };

  const copyNewLink = async (link: NewShareLink) => {
    try {
      await writeClipboardText(link.url);
      setNewLink(current => current?.shareId === link.shareId ? { ...current, copied: true } : current);
      setAnnouncement('New share link copied.');
    } catch (copyError) {
      setError(errorText(copyError, 'The link was created, but could not be copied.'));
      setErrorCanReload(false);
      setAnnouncement('New share link created. Copy it manually before dismissing it.');
    }
  };

  const createShare = async () => {
    if (!conversationId || !canCreate || conversationRevision === undefined || mutation) return;
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setMutation('create');
    setError(null);
    setErrorCanReload(false);
    setNewLink(null);
    try {
      const response = await ChatAPI.createConversationShare(
        conversationId,
        conversationRevision,
        { expiresIn: expirySeconds, signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const created: ManagedConversationShare = {
        id: response.share.id,
        client_conversation_id: conversationId,
        source_revision: conversationRevision,
        created_at: Date.now(),
        expires_at: response.share.expires_at,
        revoked_at: null,
      };
      publishShares(mergeSharePages(sharesRef.current, [created]));
      const link: NewShareLink = {
        shareId: response.share.id,
        url: canonicalConversationShareUrl(response.share.token),
        expiresAt: response.share.expires_at,
        copied: false,
      };
      setNewLink(link);
      onShareCreated?.(response.share.id);
      reportClientEvent('share_created', {
        outcome: expirySeconds === 86_400 ? 'one_day'
          : expirySeconds === 604_800 ? 'seven_days' : 'thirty_days',
        value: expirySeconds / 86_400,
      });
      await copyNewLink(link);
    } catch (createError) {
      if (!controller.signal.aborted) {
        if (createError instanceof APIError && createError.code === 'revision_conflict') {
          setError('This conversation changed after it was loaded. Close this dialog, let it sync, then create the link again.');
        } else {
          setError(errorText(createError, 'The share link could not be created.'));
        }
      }
    } finally {
      if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
      if (!controller.signal.aborted) setMutation(null);
    }
  };

  const revokeShare = async () => {
    if (!revokeCandidate || mutation) return;
    const target = revokeCandidate;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setMutation('revoke');
    setRevokeError(null);
    try {
      await ChatAPI.revokeConversationShare(target.id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const revokedAt = Date.now();
      const next = sharesRef.current.map(share => (
        share.id === target.id ? { ...share, revoked_at: revokedAt } : share
      ));
      publishShares(next);
      if (newLink?.shareId === target.id) setNewLink(null);
      setRevokeCandidate(null);
      setAnnouncement('Share link revoked.');
    } catch (revokeError) {
      if (!controller.signal.aborted) {
        setRevokeError(errorText(revokeError, 'The share link could not be revoked.'));
      }
    } finally {
      if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
      if (!controller.signal.aborted) setMutation(null);
    }
  };

  const requestClose = () => {
    if (mutation) return;
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
        aria-labelledby="share-links-title"
      >
        <DialogTitle id="share-links-title" sx={{ pr: 7 }}>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
            <LinkOutlinedIcon color="primary" />
            <Box sx={{ minWidth: 0 }}>
              <Typography component="span" variant="h6">Share links</Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {conversationTitle?.trim() || 'Current conversation'}
              </Typography>
            </Box>
          </Stack>
          <Tooltip title="Close">
            <span>
              <IconButton
                aria-label="Close share links"
                onClick={requestClose}
                disabled={mutation !== null}
                sx={{ position: 'absolute', right: 12, top: 12 }}
              >
                <CloseIcon />
              </IconButton>
            </span>
          </Tooltip>
        </DialogTitle>

        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
          <Stack spacing={2.25}>
            {!signedIn ? (
              <Alert severity="info">Sign in to create and manage share links.</Alert>
            ) : !conversationId ? (
              <Alert severity="info">
                Save this conversation before managing public snapshots.
              </Alert>
            ) : (
              <>
                <Alert severity="info" icon={<LinkOutlinedIcon />}>
                  Anyone with an active link can read its snapshot. Existing token URLs are never shown again and cannot be recovered; revoke a lost link and create a new one.
                </Alert>

                {canCreate ? (
                  <Box
                    component="section"
                    aria-labelledby="create-share-heading"
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 2,
                      p: { xs: 1.5, sm: 2 },
                      bgcolor: 'action.hover',
                    }}
                  >
                    <Typography component="h3" id="create-share-heading" variant="subtitle1" sx={{ fontWeight: 700 }}>
                      Create a fresh snapshot
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
                      The link captures revision {conversationRevision}. Later chat edits do not change it.
                    </Typography>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1.25}
                      sx={{ alignItems: { sm: 'flex-end' } }}
                    >
                      <TextField
                        select
                        fullWidth
                        size="small"
                        label="Link expires after"
                        value={expirySeconds}
                        disabled={mutation !== null}
                        onChange={event => setExpirySeconds(Number(event.target.value))}
                      >
                        {SHARE_LIFETIMES.map(option => (
                          <MenuItem key={option.seconds} value={option.seconds}>{option.label}</MenuItem>
                        ))}
                      </TextField>
                      <Button
                        variant="contained"
                        startIcon={mutation === 'create' ? <CircularProgress color="inherit" size={16} /> : <AddLinkIcon />}
                        onClick={() => { void createShare(); }}
                        disabled={mutation !== null}
                        sx={{ whiteSpace: 'nowrap', minHeight: 40 }}
                      >
                        Create link
                      </Button>
                    </Stack>
                  </Box>
                ) : (
                  <Alert severity="info">
                    Existing links remain manageable while this conversation syncs. Create a new link after sync finishes.
                  </Alert>
                )}

                {newLink && (
                  <Alert
                    severity="success"
                    action={(
                      <Button color="inherit" size="small" onClick={() => setNewLink(null)}>
                        Dismiss
                      </Button>
                    )}
                  >
                    <Typography component="p" variant="subtitle2">
                      {newLink.copied ? 'New link copied' : 'New link created'}
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.25 }}>
                      This URL is disclosed only now. Copy it before dismissing this notice. It expires {formatDateTime(newLink.expiresAt)}.
                    </Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.25 }}>
                      <TextField
                        fullWidth
                        size="small"
                        label="New share URL"
                        value={newLink.url}
                        slotProps={{ htmlInput: { readOnly: true } }}
                      />
                      <Button
                        variant="outlined"
                        startIcon={<ContentCopyIcon />}
                        onClick={() => { void copyNewLink(newLink); }}
                        sx={{ whiteSpace: 'nowrap' }}
                      >
                        Copy link
                      </Button>
                    </Stack>
                  </Alert>
                )}

                {error && (
                  <Alert
                    severity="error"
                    role="alert"
                    action={errorCanReload ? (
                      <Button color="inherit" size="small" onClick={() => { void loadFirstPage(); }}>
                        Reload
                      </Button>
                    ) : undefined}
                  >
                    {error}
                  </Alert>
                )}

                <Box component="section" aria-labelledby="existing-shares-heading">
                  <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <Box>
                      <Typography component="h3" id="existing-shares-heading" variant="subtitle1" sx={{ fontWeight: 700 }}>
                        Snapshot history
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Token URLs are intentionally absent from this inventory.
                      </Typography>
                    </Box>
                    <Tooltip title="Reload links">
                      <span>
                        <IconButton
                          aria-label="Reload share links"
                          onClick={() => { void loadFirstPage(); }}
                          disabled={listLoading || mutation !== null}
                        >
                          <RefreshIcon />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>

                  <Divider sx={{ my: 1.25 }} />
                  {listLoading && shares.length === 0 ? (
                    <Stack spacing={1} sx={{ py: 4, alignItems: 'center' }} role="status">
                      <CircularProgress size={26} />
                      <Typography variant="body2" color="text.secondary">Loading share links…</Typography>
                    </Stack>
                  ) : shares.length === 0 ? (
                    <Box sx={{ py: 3, textAlign: 'center' }}>
                      <Typography sx={{ fontWeight: 650 }}>No share links yet</Typography>
                      <Typography variant="body2" color="text.secondary">
                        Create one when you want to show a read-only snapshot.
                      </Typography>
                    </Box>
                  ) : (
                    <Stack component="ul" spacing={1} sx={{ p: 0, m: 0, listStyle: 'none' }}>
                      {shares.map(share => {
                        const status = shareStatus(share);
                        return (
                          <Box
                            component="li"
                            key={share.id}
                            sx={{
                              position: 'relative',
                              overflow: 'hidden',
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1.5,
                              pl: 2,
                              pr: 1.25,
                              py: 1.25,
                              '&::before': {
                                content: '""',
                                position: 'absolute',
                                inset: '0 auto 0 0',
                                width: 4,
                                bgcolor: statusRailColor(status),
                              },
                            }}
                          >
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between' }}>
                              <Box sx={{ minWidth: 0 }}>
                                <Stack
                                  direction="row"
                                  spacing={0.75}
                                  sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                                  useFlexGap
                                >
                                  <Chip size="small" label={statusLabel(status)} color={statusColor(status)} />
                                  <Typography variant="caption" color="text.secondary">
                                    Revision {share.source_revision}
                                  </Typography>
                                </Stack>
                                <Typography variant="body2" sx={{ mt: 0.75 }}>
                                  Created {formatDateTime(share.created_at)}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  {status === 'revoked' && share.revoked_at !== null
                                    ? `Revoked ${formatDateTime(share.revoked_at)}`
                                    : `${status === 'expired' ? 'Expired' : 'Expires'} ${formatDateTime(share.expires_at)}`}
                                </Typography>
                              </Box>
                              {status === 'active' && (
                                <Button
                                  color="error"
                                  size="small"
                                  startIcon={<BlockOutlinedIcon />}
                                  onClick={() => {
                                    setRevokeError(null);
                                    setRevokeCandidate(share);
                                  }}
                                  disabled={mutation !== null}
                                  sx={{ alignSelf: { xs: 'stretch', sm: 'center' } }}
                                >
                                  Revoke
                                </Button>
                              )}
                            </Stack>
                          </Box>
                        );
                      })}
                    </Stack>
                  )}

                  {nextCursor && (
                    <Button
                      fullWidth
                      variant="text"
                      onClick={() => { void loadMore(); }}
                      disabled={listLoading || mutation !== null}
                      sx={{ mt: 1 }}
                    >
                      {listLoading ? 'Loading…' : 'Load older links'}
                    </Button>
                  )}
                </Box>
              </>
            )}
          </Stack>
          <Box role="status" aria-live="polite" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {announcement}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={requestClose} disabled={mutation !== null}>Done</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={revokeCandidate !== null}
        onClose={() => {
          if (mutation === null) {
            setRevokeCandidate(null);
            setRevokeError(null);
          }
        }}
        fullWidth
        maxWidth="xs"
        aria-labelledby="revoke-share-title"
      >
        <DialogTitle id="revoke-share-title">Revoke this share link?</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography>
              The snapshot will stop opening immediately. The old token URL cannot be recovered or reactivated.
            </Typography>
            {revokeError && <Alert severity="error" role="alert">{revokeError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setRevokeCandidate(null);
              setRevokeError(null);
            }}
            disabled={mutation !== null}
          >
            Keep link
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => { void revokeShare(); }}
            disabled={mutation !== null}
            startIcon={mutation === 'revoke' ? <CircularProgress color="inherit" size={16} /> : <BlockOutlinedIcon />}
          >
            Revoke link
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
