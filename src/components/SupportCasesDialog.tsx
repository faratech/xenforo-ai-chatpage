import { useCallback, useEffect, useRef, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import { APIError, ChatAPI } from '../services/api';
import { reportClientEvent } from '../services/telemetry';
import type {
  PCProfile,
  SupportCase,
  SupportCaseDraft,
  SupportCaseStatus,
} from '../services/api';
import {
  buildSupportCaseBBCode,
  PC_PROFILE_FIELDS,
  SUPPORT_STATUS_LABELS,
} from './supportCaseFormat';

const CASE_PAGE_SIZE = 40;
const MAX_LINKED_ITEMS = 20;

type PCProfileForm = Partial<Record<keyof PCProfile, string>>;

interface CaseEditor {
  id?: string;
  title: string;
  description: string;
  status: SupportCaseStatus;
  profile: PCProfileForm;
  conversationIds: string[];
  attachmentIds: string[];
  revision: number;
  createdAt?: number;
}

type DiscardIntent =
  | { kind: 'close' }
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'case'; supportCase: SupportCase };

export interface SupportCasesDialogProps {
  open: boolean;
  onClose: () => void;
  signedIn: boolean;
  /** Current chat, offered as an explicit link in the case editor. */
  currentConversationId?: string;
  /** Parent-controlled upload handles available to link to a case. */
  attachmentIds: readonly string[];
  onCasesChange?: (cases: readonly SupportCase[]) => void;
  /** Fires only after the reviewed BBCode has been copied successfully. */
  onForumHandoffCopied?: (supportCase: SupportCase, bbcode: string) => void;
}

const uniqueIds = (ids: readonly string[]): string[] => [...new Set(ids)].slice(0, MAX_LINKED_ITEMS);

const emptyEditor = (
  currentConversationId: string | undefined,
  attachmentIds: readonly string[],
): CaseEditor => ({
  title: '',
  description: '',
  status: 'open',
  profile: {},
  conversationIds: currentConversationId ? [currentConversationId] : [],
  attachmentIds: uniqueIds(attachmentIds),
  revision: 0,
});

const editorFromCase = (supportCase: SupportCase): CaseEditor => {
  const profile = Object.fromEntries(
    Object.entries(supportCase.pc_profile ?? {}).map(([key, value]) => [key, String(value)]),
  ) as PCProfileForm;
  return {
    id: supportCase.id,
    title: supportCase.title,
    description: supportCase.description,
    status: supportCase.status,
    profile,
    conversationIds: [...supportCase.conversation_ids],
    attachmentIds: [...supportCase.attachment_ids],
    revision: supportCase.revision,
    createdAt: supportCase.created_at,
  };
};

const editorPayload = (editor: CaseEditor, statusOverride?: SupportCaseStatus): SupportCaseDraft => {
  const profile: PCProfile = {};
  for (const { key, numeric } of PC_PROFILE_FIELDS) {
    const raw = editor.profile[key]?.trim();
    if (!raw) continue;
    if (numeric) profile.memory_gb = Number(raw);
    else Object.assign(profile, { [key]: raw });
  }
  return {
    ...(editor.id ? { id: editor.id } : {}),
    title: editor.title.trim(),
    description: editor.description.trim(),
    status: statusOverride ?? editor.status,
    pc_profile: profile,
    conversation_ids: uniqueIds(editor.conversationIds),
    attachment_ids: uniqueIds(editor.attachmentIds),
    ...(editor.createdAt ? { created_at: editor.createdAt } : {}),
  };
};

const validateEditor = (editor: CaseEditor): string | null => {
  if (!editor.title.trim()) return 'Add a short title before saving this case.';
  if (!editor.description.trim()) return 'Describe the problem before saving this case.';
  const rawMemory = editor.profile.memory_gb?.trim();
  if (rawMemory) {
    const memory = Number(rawMemory);
    if (!Number.isFinite(memory) || memory < 0 || memory > 16_384) {
      return 'Memory must be a number between 0 and 16,384 GB.';
    }
  }
  return null;
};

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof APIError || error instanceof Error) return error.message;
  return fallback;
};

const mergeCasePages = (current: readonly SupportCase[], incoming: readonly SupportCase[]): SupportCase[] => {
  const byId = new Map(current.map(supportCase => [supportCase.id, supportCase]));
  for (const supportCase of incoming) byId.set(supportCase.id, supportCase);
  return [...byId.values()].sort((left, right) => right.updated_at - left.updated_at);
};

const statusRailColor = (status: SupportCaseStatus): string => {
  if (status === 'resolved') return 'success.main';
  if (status === 'archived') return 'text.disabled';
  return 'primary.main';
};

const formatUpdatedAt = (timestamp: number): string => new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
}).format(timestamp);

const writeClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.('copy') ?? false;
  textarea.remove();
  if (!copied) throw new Error('Clipboard access is unavailable. Select the BBCode and copy it manually.');
};

/**
 * Private support-case workspace. It persists only through ChatAPI and the
 * forum handoff is intentionally copy-only: this component has no post action.
 */
export const SupportCasesDialog = ({
  open,
  onClose,
  signedIn,
  currentConversationId,
  attachmentIds,
  onCasesChange,
  onForumHandoffCopied,
}: SupportCasesDialogProps) => {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const mobileRef = useRef(mobile);
  const listControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const casesRef = useRef<SupportCase[]>([]);
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<CaseEditor | null>(null);
  const [savedCase, setSavedCase] = useState<SupportCase | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [discardIntent, setDiscardIntent] = useState<DiscardIntent | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => { mobileRef.current = mobile; }, [mobile]);

  const publishCases = useCallback((next: SupportCase[]) => {
    casesRef.current = next;
    setCases(next);
    onCasesChange?.(next);
  }, [onCasesChange]);

  const chooseCase = useCallback((supportCase: SupportCase) => {
    setSavedCase(supportCase);
    setEditor(editorFromCase(supportCase));
    setDirty(false);
    setError(null);
    setConflict(false);
    setCopyState('idle');
  }, []);

  const loadFirstPage = useCallback(async () => {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setListLoading(true);
    setError(null);
    try {
      const response = await ChatAPI.listSupportCases({
        limit: CASE_PAGE_SIZE,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      publishCases(response.cases);
      setNextCursor(response.next_cursor);
      if (!mobileRef.current && response.cases[0]) chooseCase(response.cases[0]);
      else {
        setSavedCase(null);
        setEditor(null);
        setDirty(false);
      }
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setError(errorMessage(loadError, 'Support cases could not be loaded.'));
      }
    } finally {
      if (!controller.signal.aborted) setListLoading(false);
    }
  }, [chooseCase, publishCases]);

  useEffect(() => {
    if (!open || !signedIn) return undefined;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadFirstPage();
    });
    return () => {
      cancelled = true;
      listControllerRef.current?.abort();
    };
  }, [loadFirstPage, open, signedIn]);

  useEffect(() => () => mutationControllerRef.current?.abort(), []);

  useEffect(() => {
    if (!open) mutationControllerRef.current?.abort();
  }, [open]);

  const loadMore = async () => {
    if (!nextCursor || listLoading) return;
    const controller = new AbortController();
    listControllerRef.current = controller;
    setListLoading(true);
    try {
      const response = await ChatAPI.listSupportCases({
        limit: CASE_PAGE_SIZE,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      publishCases(mergeCasePages(casesRef.current, response.cases));
      setNextCursor(response.next_cursor);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(errorMessage(loadError, 'More cases could not be loaded.'));
    } finally {
      if (!controller.signal.aborted) setListLoading(false);
    }
  };

  const startNewCase = () => {
    setSavedCase(null);
    setEditor(emptyEditor(currentConversationId, attachmentIds));
    setDirty(false);
    setError(null);
    setConflict(false);
    setCopyState('idle');
  };

  const applyDiscardIntent = (intent: DiscardIntent) => {
    setDiscardIntent(null);
    if (intent.kind === 'close') {
      onClose();
      return;
    }
    if (intent.kind === 'list') {
      setSavedCase(null);
      setEditor(null);
      setDirty(false);
      setError(null);
      return;
    }
    if (intent.kind === 'new') {
      startNewCase();
      return;
    }
    chooseCase(intent.supportCase);
  };

  const requestIntent = (intent: DiscardIntent) => {
    if (dirty) setDiscardIntent(intent);
    else applyDiscardIntent(intent);
  };

  const changeEditor = (patch: Partial<CaseEditor>) => {
    setEditor(current => current ? { ...current, ...patch } : current);
    setDirty(true);
    setError(null);
    setConflict(false);
    setCopyState('idle');
  };

  const changeProfileField = (key: keyof PCProfile, value: string) => {
    if (!editor) return;
    changeEditor({ profile: { ...editor.profile, [key]: value } });
  };

  const persistCase = async (statusOverride?: SupportCaseStatus) => {
    if (!editor || busy) return;
    const validationError = validateEditor(editor);
    if (validationError) {
      setError(validationError);
      return;
    }
    const creating = !editor.id;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const response = await ChatAPI.upsertSupportCase(
        editorPayload(editor, statusOverride),
        editor.revision,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const next = mergeCasePages(
        casesRef.current.filter(supportCase => supportCase.id !== response.case.id),
        [response.case],
      );
      publishCases(next);
      chooseCase(response.case);
      if (creating) {
        reportClientEvent('support_case_created', {
          outcome: response.case.status,
          value: response.case.attachment_ids.length,
        });
      }
    } catch (saveError) {
      if (controller.signal.aborted) return;
      if (saveError instanceof APIError && saveError.code === 'revision_conflict') {
        setConflict(true);
        setError('This case changed in another tab or device. Reload the latest version before editing again.');
      } else {
        setError(errorMessage(saveError, 'The support case could not be saved.'));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const reloadLatest = async () => {
    if (!editor?.id || busy) return;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await ChatAPI.getSupportCase(editor.id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      publishCases(mergeCasePages(
        casesRef.current.filter(supportCase => supportCase.id !== response.case.id),
        [response.case],
      ));
      chooseCase(response.case);
    } catch (reloadError) {
      if (!controller.signal.aborted) setError(errorMessage(reloadError, 'The latest case could not be loaded.'));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const deleteCase = async () => {
    if (!editor?.id || editor.revision < 1 || busy) return;
    setDeleteConfirmOpen(false);
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      await ChatAPI.deleteSupportCase(editor.id, editor.revision, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const next = casesRef.current.filter(supportCase => supportCase.id !== editor.id);
      publishCases(next);
      if (!mobile && next[0]) chooseCase(next[0]);
      else {
        setEditor(null);
        setSavedCase(null);
        setDirty(false);
      }
    } catch (deleteError) {
      if (controller.signal.aborted) return;
      if (deleteError instanceof APIError && deleteError.code === 'revision_conflict') {
        setConflict(true);
        setError('This case changed before it could be deleted. Reload the latest version, then review it again.');
      } else {
        setError(errorMessage(deleteError, 'The support case could not be deleted.'));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const copyForumHandoff = async () => {
    if (!savedCase || dirty) return;
    const bbcode = buildSupportCaseBBCode(savedCase);
    try {
      await writeClipboard(bbcode);
      setCopyState('copied');
      onForumHandoffCopied?.(savedCase, bbcode);
    } catch {
      setCopyState('failed');
    }
  };

  const toggleCurrentConversation = (checked: boolean) => {
    if (!editor || !currentConversationId) return;
    const next = checked
      ? uniqueIds([...editor.conversationIds, currentConversationId])
      : editor.conversationIds.filter(id => id !== currentConversationId);
    changeEditor({ conversationIds: next });
  };

  const availableAttachmentIds = uniqueIds(attachmentIds);
  const availableLinkedCount = editor
    ? availableAttachmentIds.filter(id => editor.attachmentIds.includes(id)).length
    : 0;
  const allAvailableAttachmentsLinked = availableAttachmentIds.length > 0
    && availableLinkedCount === availableAttachmentIds.length;

  const toggleAvailableAttachments = (checked: boolean) => {
    if (!editor) return;
    const available = new Set(availableAttachmentIds);
    const next = checked
      ? uniqueIds([...editor.attachmentIds, ...availableAttachmentIds])
      : editor.attachmentIds.filter(id => !available.has(id));
    changeEditor({ attachmentIds: next });
  };

  const bbcodePreview = savedCase ? buildSupportCaseBBCode(savedCase) : '';
  const showListPane = !mobile || editor === null;
  const showEditorPane = !mobile || editor !== null;

  return (
    <>
      <Dialog
        open={open}
        onClose={() => requestIntent({ kind: 'close' })}
        fullWidth
        maxWidth="lg"
        fullScreen={mobile}
        aria-labelledby="support-cases-title"
        slotProps={{ paper: { sx: { height: { sm: 'min(820px, calc(100dvh - 48px))' } } } }}
      >
        <DialogTitle id="support-cases-title" sx={{ pr: 7, py: 1.5 }}>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
            <SupportAgentIcon color="primary" />
            <Box>
              <Typography component="span" sx={{ display: 'block', fontSize: 18, fontWeight: 800 }}>
                Support cases
              </Typography>
              <Typography component="span" variant="caption" color="text.secondary">
                Keep diagnostics, AI chats, and files together before asking the forum.
              </Typography>
            </Box>
          </Stack>
          <Tooltip title="Close support cases">
            <IconButton
              aria-label="Close support cases"
              onClick={() => requestIntent({ kind: 'close' })}
              sx={{ position: 'absolute', right: 12, top: 12 }}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </DialogTitle>
        <Divider />

        {!signedIn ? (
          <DialogContent sx={{ display: 'grid', placeItems: 'center' }}>
            <Alert severity="info" variant="outlined" sx={{ maxWidth: 520 }}>
              Sign in to create private support cases and link your saved AI conversations.
            </Alert>
          </DialogContent>
        ) : (
          <DialogContent sx={{ p: 0, minHeight: 0, display: 'flex' }}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '280px minmax(0, 1fr)' },
                flex: 1,
                minWidth: 0,
                minHeight: 0,
              }}
            >
              {showListPane && (
                <Box
                  component="nav"
                  aria-label="Support case list"
                  sx={{
                    minWidth: 0,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    borderRight: { sm: `1px solid ${theme.palette.divider}` },
                    bgcolor: 'action.hover',
                  }}
                >
                  <Box sx={{ p: 1.5 }}>
                    <Button
                      fullWidth
                      variant="contained"
                      startIcon={<AddIcon />}
                      onClick={() => requestIntent({ kind: 'new' })}
                    >
                      New support case
                    </Button>
                  </Box>
                  <Divider />

                  {error && !editor && (
                    <Alert
                      severity="error"
                      action={(
                        <IconButton aria-label="Retry loading support cases" size="small" onClick={() => void loadFirstPage()}>
                          <RefreshIcon fontSize="small" />
                        </IconButton>
                      )}
                      sx={{ m: 1 }}
                    >
                      {error}
                    </Alert>
                  )}

                  {listLoading && cases.length === 0 ? (
                    <Box sx={{ display: 'grid', placeItems: 'center', flex: 1, p: 3 }}>
                      <CircularProgress size={28} aria-label="Loading support cases" />
                    </Box>
                  ) : cases.length === 0 ? (
                    <Box sx={{ p: 2.5 }}>
                      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>No support cases yet</Typography>
                      <Typography variant="body2" color="text.secondary">
                        Create one when a problem needs more than a single chat.
                      </Typography>
                    </Box>
                  ) : (
                    <List disablePadding sx={{ overflowY: 'auto', flex: 1 }}>
                      {cases.map(supportCase => (
                        <ListItemButton
                          key={supportCase.id}
                          selected={editor?.id === supportCase.id}
                          onClick={() => requestIntent({ kind: 'case', supportCase })}
                          sx={{
                            alignItems: 'flex-start',
                            borderLeft: '4px solid',
                            borderLeftColor: statusRailColor(supportCase.status),
                            py: 1.2,
                          }}
                        >
                          <ListItemText
                            primary={(
                              <Typography component="span" noWrap sx={{ display: 'block', fontWeight: 700, fontSize: 14 }}>
                                {supportCase.title}
                              </Typography>
                            )}
                            secondary={(
                              <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5 }}>
                                <Chip
                                  component="span"
                                  label={SUPPORT_STATUS_LABELS[supportCase.status]}
                                  size="small"
                                  variant="outlined"
                                  sx={{ height: 20, fontSize: 11 }}
                                />
                                <Typography component="span" variant="caption" color="text.secondary">
                                  {formatUpdatedAt(supportCase.updated_at)}
                                </Typography>
                              </Box>
                            )}
                          />
                        </ListItemButton>
                      ))}
                    </List>
                  )}

                  {nextCursor && (
                    <Box sx={{ p: 1, borderTop: `1px solid ${theme.palette.divider}` }}>
                      <Button
                        fullWidth
                        size="small"
                        onClick={() => void loadMore()}
                        disabled={listLoading}
                      >
                        {listLoading ? 'Loading…' : 'Load older cases'}
                      </Button>
                    </Box>
                  )}
                </Box>
              )}

              {showEditorPane && (
                <Box sx={{ minWidth: 0, minHeight: 0, overflowY: 'auto', p: { xs: 1.5, sm: 2.5 } }}>
                  {!editor ? (
                    <Box sx={{ minHeight: '100%', display: 'grid', placeItems: 'center', textAlign: 'center', p: 3 }}>
                      <Box>
                        <SupportAgentIcon color="disabled" sx={{ fontSize: 46, mb: 1 }} />
                        <Typography sx={{ fontWeight: 800 }}>Choose a case to review</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                          Or start a new case for a problem you want to track.
                        </Typography>
                        <Button variant="outlined" startIcon={<AddIcon />} onClick={() => startNewCase()}>
                          New support case
                        </Button>
                      </Box>
                    </Box>
                  ) : (
                    <Box component="form" onSubmit={(event) => { event.preventDefault(); void persistCase(); }}>
                      <Stack spacing={2}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          {mobile && (
                            <IconButton
                              aria-label="Back to support case list"
                              onClick={() => requestIntent({ kind: 'list' })}
                              edge="start"
                            >
                              <ArrowBackIcon />
                            </IconButton>
                          )}
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                              <Typography variant="h6" component="h2" noWrap sx={{ fontWeight: 800 }}>
                                {editor.id ? 'Case details' : 'New support case'}
                              </Typography>
                              {dirty && <Chip label="Unsaved" color="warning" size="small" />}
                            </Stack>
                            {editor.id && (
                              <Typography variant="caption" color="text.secondary">
                                Revision {editor.revision} · {editor.id}
                              </Typography>
                            )}
                          </Box>
                        </Box>

                        {error && (
                          <Alert
                            severity={conflict ? 'warning' : 'error'}
                            role="alert"
                            action={conflict ? (
                              <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={() => void reloadLatest()}>
                                Reload latest
                              </Button>
                            ) : undefined}
                          >
                            {error}
                          </Alert>
                        )}

                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 160px' }, gap: 1.5 }}>
                          <TextField
                            label="Case title"
                            value={editor.title}
                            onChange={event => changeEditor({ title: event.target.value })}
                            required
                            fullWidth
                            autoFocus={!editor.id}
                            slotProps={{ htmlInput: { maxLength: 255, 'aria-label': 'Case title' } }}
                          />
                          <TextField
                            select
                            label="Status"
                            value={editor.status}
                            onChange={event => changeEditor({ status: event.target.value as SupportCaseStatus })}
                          >
                            <MenuItem value="open">Open</MenuItem>
                            <MenuItem value="resolved">Resolved</MenuItem>
                            <MenuItem value="archived">Archived</MenuItem>
                          </TextField>
                        </Box>

                        <TextField
                          label="Problem description"
                          value={editor.description}
                          onChange={event => changeEditor({ description: event.target.value })}
                          required
                          multiline
                          minRows={5}
                          fullWidth
                          helperText={`${editor.description.length.toLocaleString()} / 8,000 characters`}
                          slotProps={{ htmlInput: { maxLength: 8000, 'aria-label': 'Problem description' } }}
                        />

                        <Accordion variant="outlined" disableGutters>
                          <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="pc-profile-content" id="pc-profile-header">
                            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                              <ComputerOutlinedIcon fontSize="small" />
                              <Typography sx={{ fontWeight: 700 }}>PC profile</Typography>
                              <Typography variant="caption" color="text.secondary">Optional</Typography>
                            </Stack>
                          </AccordionSummary>
                          <AccordionDetails id="pc-profile-content">
                            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1.25 }}>
                              {PC_PROFILE_FIELDS.map(field => (
                                <TextField
                                  key={field.key}
                                  label={field.label}
                                  placeholder={field.placeholder}
                                  value={editor.profile[field.key] ?? ''}
                                  onChange={event => changeProfileField(field.key, event.target.value)}
                                  type={field.numeric ? 'number' : 'text'}
                                  size="small"
                                  slotProps={{
                                    htmlInput: field.numeric
                                      ? { min: 0, max: 16384, step: 0.25 }
                                      : { maxLength: 255 },
                                  }}
                                />
                              ))}
                            </Box>
                          </AccordionDetails>
                        </Accordion>

                        <Box sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 1.5, p: 1.5 }}>
                          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Case links</Typography>
                          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
                            Links stay private inside this case. File handles expire unless a saved case retains them.
                          </Typography>
                          {currentConversationId ? (
                            <FormControlLabel
                              control={(
                                <Checkbox
                                  checked={editor.conversationIds.includes(currentConversationId)}
                                  onChange={event => toggleCurrentConversation(event.target.checked)}
                                />
                              )}
                              label="Link the current AI conversation"
                            />
                          ) : (
                            <Typography variant="body2" color="text.secondary">No current conversation is available to link.</Typography>
                          )}
                          {availableAttachmentIds.length > 0 ? (
                            <FormControlLabel
                              control={(
                                <Checkbox
                                  checked={allAvailableAttachmentsLinked}
                                  indeterminate={availableLinkedCount > 0 && !allAvailableAttachmentsLinked}
                                  onChange={event => toggleAvailableAttachments(event.target.checked)}
                                />
                              )}
                              label={`Link ${availableAttachmentIds.length} current ${availableAttachmentIds.length === 1 ? 'attachment' : 'attachments'}`}
                            />
                          ) : (
                            <Typography variant="body2" color="text.secondary">No uploaded files are available to link.</Typography>
                          )}
                          {editor.attachmentIds.length > 0 && (
                            <Stack direction="row" useFlexGap spacing={0.5} sx={{ mt: 0.75, flexWrap: 'wrap' }} aria-label="Linked attachment handles">
                              {editor.attachmentIds.map(id => <Chip key={id} label={id} size="small" variant="outlined" />)}
                            </Stack>
                          )}
                        </Box>

                        {savedCase && (
                          <Accordion variant="outlined" disableGutters>
                            <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="forum-handoff-content" id="forum-handoff-header">
                              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                                <ContentCopyIcon fontSize="small" />
                                <Typography sx={{ fontWeight: 700 }}>Review forum handoff</Typography>
                              </Stack>
                            </AccordionSummary>
                            <AccordionDetails id="forum-handoff-content">
                              <Alert severity="info" variant="outlined" sx={{ mb: 1.25 }}>
                                This only copies a BBCode draft. Review it here, then paste and post it to the forum yourself.
                              </Alert>
                              {dirty && (
                                <Alert severity="warning" sx={{ mb: 1.25 }}>
                                  Save your changes before copying so the handoff matches this case.
                                </Alert>
                              )}
                              <TextField
                                value={bbcodePreview}
                                multiline
                                minRows={7}
                                fullWidth
                                slotProps={{ htmlInput: { readOnly: true, 'aria-label': 'Forum BBCode preview' } }}
                              />
                              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.25, alignItems: { sm: 'center' } }}>
                                <Button
                                  variant="outlined"
                                  startIcon={<ContentCopyIcon />}
                                  disabled={dirty}
                                  onClick={() => void copyForumHandoff()}
                                >
                                  Copy reviewed BBCode
                                </Button>
                                <Typography variant="caption" color={copyState === 'failed' ? 'error' : 'text.secondary'} aria-live="polite">
                                  {copyState === 'copied' && 'Copied. Nothing was posted automatically.'}
                                  {copyState === 'failed' && 'Clipboard access failed. Select the preview and copy it manually.'}
                                </Typography>
                              </Stack>
                            </AccordionDetails>
                          </Accordion>
                        )}

                        <Divider />
                        <Stack
                          direction={{ xs: 'column-reverse', sm: 'row' }}
                          spacing={1}
                          sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}
                        >
                          <Box>
                            {editor.id && (
                              <Button
                                color="error"
                                startIcon={<DeleteIcon />}
                                onClick={() => setDeleteConfirmOpen(true)}
                                disabled={busy || conflict}
                              >
                                Delete case
                              </Button>
                            )}
                          </Box>
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                            {editor.id && editor.status !== 'archived' && (
                              <Button
                                variant="outlined"
                                startIcon={<ArchiveOutlinedIcon />}
                                onClick={() => void persistCase('archived')}
                                disabled={busy || conflict}
                              >
                                Archive case
                              </Button>
                            )}
                            <Button
                              type="submit"
                              variant="contained"
                              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                              disabled={busy || conflict || !editor.title.trim() || !editor.description.trim()}
                            >
                              {editor.id ? 'Save changes' : 'Create case'}
                            </Button>
                          </Stack>
                        </Stack>
                      </Stack>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        aria-labelledby="delete-support-case-title"
      >
        <DialogTitle id="delete-support-case-title">Delete this support case?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This removes the case record and its links. It does not delete the original AI conversation.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmOpen(false)}>Keep case</Button>
          <Button color="error" variant="contained" onClick={() => void deleteCase()}>Delete case</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={discardIntent !== null}
        onClose={() => setDiscardIntent(null)}
        aria-labelledby="discard-support-changes-title"
      >
        <DialogTitle id="discard-support-changes-title">Discard unsaved changes?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">Your latest edits to this case have not been saved.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscardIntent(null)}>Keep editing</Button>
          <Button color="warning" variant="contained" onClick={() => discardIntent && applyDiscardIntent(discardIntent)}>
            Discard changes
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
