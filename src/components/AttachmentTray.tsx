import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import { APIError, ChatAPI } from '../services/api';
import type { ChatAttachment } from '../services/api';
import { reportClientEvent } from '../services/telemetry';
import {
  DIAGNOSTIC_EXTENSIONS,
  diagnosticBudgetErrors,
  readDiagnosticFile,
  reviewedDiagnosticFile,
  suggestDiagnosticRedactions,
  utf8Size,
} from '../services/diagnosticFiles';
import type { DiagnosticAttachmentCapability } from '../services/diagnosticFiles';

export type { DiagnosticAttachmentCapability } from '../services/diagnosticFiles';

export const ATTACHMENT_MAX_COUNT = 8;
export const ATTACHMENT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_MAX_TEXT_BYTES = 1024 * 1024;
export const ATTACHMENT_ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/json',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.txt',
  '.csv',
  '.json',
].join(',');

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TEXT_MIMES = new Set(['text/plain', 'text/csv', 'application/json']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'json']);

type AttachmentKind = 'image' | 'text';

interface UploadProgress {
  completed: number;
  total: number;
  fileName: string;
}

interface ReviewFile {
  file: File;
  text?: string;
  included: boolean;
}

interface DiagnosticReview {
  files: ReviewFile[];
  omissions: string[];
  conversationId?: string;
}

export interface AttachmentTrayProps {
  /** Uploads are a member-only backend capability. */
  signedIn: boolean;
  /** Opaque, server-issued handles currently linked to the composer. */
  attachments: readonly ChatAttachment[];
  /** Called after every successful upload and when a handle is removed. */
  onChange: (attachments: ChatAttachment[]) => void;
  conversationId?: string;
  disabled?: boolean;
  /** Kept configurable for reuse, but never allowed above the backend limit. */
  maxAttachments?: number;
  onBusyChange?: (busy: boolean) => void;
  /** Compact controls designed to sit inside the rounded message composer. */
  compact?: boolean;
  /** Server-advertised reviewed text uploads; absent preserves legacy uploads. */
  diagnosticCapability?: DiagnosticAttachmentCapability;
  /**
   * Optional server cleanup hook. The chip remains when this rejects (for
   * example, when the backend reports that a saved case still uses the file).
   */
  onRemoveAttachment?: (attachment: ChatAttachment) => void | Promise<void>;
}

const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLocaleLowerCase();
};

const kindForMime = (mime: string): AttachmentKind | null => {
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (TEXT_MIMES.has(mime)) return 'text';
  return null;
};

const kindForExtension = (extension: string): AttachmentKind | null => {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return null;
};

const attachmentKind = (file: File, diagnostics = false): AttachmentKind | null => {
  const mimeKind = kindForMime(file.type.toLocaleLowerCase());
  const extensionKind = diagnostics && DIAGNOSTIC_EXTENSIONS.has(fileExtension(file.name))
    ? 'text' : kindForExtension(fileExtension(file.name));
  if (mimeKind && extensionKind && mimeKind !== extensionKind) return null;
  return mimeKind ?? extensionKind;
};

const hasKindMismatch = (file: File, diagnostics = false): boolean => {
  const mimeKind = kindForMime(file.type.toLocaleLowerCase());
  const extensionKind = diagnostics && DIAGNOSTIC_EXTENSIONS.has(fileExtension(file.name))
    ? 'text' : kindForExtension(fileExtension(file.name));
  return mimeKind !== null && extensionKind !== null && mimeKind !== extensionKind;
};

const validateFile = (file: File, capability?: DiagnosticAttachmentCapability): string | null => {
  if (hasKindMismatch(file, capability?.enabled)) {
    return `${file.name}: file type and extension mismatch — the content type and filename extension point to different file kinds. Rename the file or choose a file whose type and extension agree.`;
  }
  const kind = attachmentKind(file, capability?.enabled);
  if (!kind) return `${file.name}: choose a JPG, PNG, WebP, TXT, CSV, or JSON${capability?.enabled ? ', LOG, XML, or text NFO' : ''} file.`;
  if (file.size < 1) return `${file.name}: empty files cannot be uploaded.`;
  const limit = kind === 'image'
    ? capability?.maxImageBytes ?? ATTACHMENT_MAX_IMAGE_BYTES
    : capability?.maxTextFileBytes ?? ATTACHMENT_MAX_TEXT_BYTES;
  if (file.size > limit) {
    if (capability?.enabled) return `${file.name}: exceeds the ${formatAttachmentSize(limit)} ${kind === 'image' ? 'image' : 'original text file'} limit. Export a smaller file; nothing was uploaded.`;
    return `${file.name}: ${kind === 'image' ? 'images must be 8 MB or smaller' : 'text files must be 1 MB or smaller'}.`;
  }
  return null;
};

export const formatAttachmentSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const uploadErrorMessage = (error: unknown, fileName: string): string => {
  if (error instanceof APIError || error instanceof Error) {
    return `${fileName}: ${error.message}`;
  }
  return `${fileName}: the upload could not be completed.`;
};

/**
 * Member-only upload surface. Files are validated locally for fast feedback,
 * then uploaded immediately so parents only receive server-issued handles.
 */
export const AttachmentTray = ({
  signedIn,
  attachments,
  onChange,
  conversationId,
  disabled = false,
  maxAttachments = ATTACHMENT_MAX_COUNT,
  onBusyChange,
  onRemoveAttachment,
  compact = false,
  diagnosticCapability,
}: AttachmentTrayProps) => {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const compactTriggerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestAttachmentsRef = useRef<readonly ChatAttachment[]>(attachments);
  const onBusyChangeRef = useRef(onBusyChange);
  const mountedRef = useRef(true);
  const dragDepthRef = useRef(0);
  const operationRef = useRef(false);
  const operationGenerationRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<DiagnosticReview | null>(null);
  const capability = diagnosticCapability?.enabled ? diagnosticCapability : undefined;
  const limit = Math.min(capability?.maxAttachments ?? ATTACHMENT_MAX_COUNT, Math.max(1, Math.floor(maxAttachments)));
  const busy = progress !== null || removingId !== null || preparing || review !== null;
  const unavailable = disabled || busy || !signedIn;
  const remaining = Math.max(0, limit - attachments.length);
  const accept = capability ? `${ATTACHMENT_ACCEPT},.log,.xml,.nfo,text/xml,application/xml` : ATTACHMENT_ACCEPT;

  useEffect(() => {
    latestAttachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  }, [onBusyChange]);

  useEffect(() => {
    // React Strict Mode replays mount effects in development, so restore this
    // flag on every setup rather than leaving the replayed instance inert.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      abortRef.current?.abort();
      onBusyChangeRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    // Keep local diagnostic bytes scoped to the originating chat and identity.
    return () => {
      operationGenerationRef.current += 1;
      operationRef.current = false;
      abortRef.current?.abort();
      setPreparing(false);
      setReview(null);
      setProgress(null);
      onBusyChangeRef.current?.(false);
    };
  }, [conversationId, signedIn]);

  const performUploads = useCallback(async (validFiles: readonly File[], validationErrors: readonly string[]) => {
    const generation = operationGenerationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const uploadErrors: string[] = [];
    try {
      for (let index = 0; index < validFiles.length; index += 1) {
        const file = validFiles[index];
        if (!file) continue;
        if (mountedRef.current) {
          setProgress({ completed: index, total: validFiles.length, fileName: file.name });
        }
        try {
          const response = await ChatAPI.uploadChatAttachment(file, {
            conversationId,
            signal: controller.signal,
          });
          if (!mountedRef.current || controller.signal.aborted || generation !== operationGenerationRef.current) return;
          const next = [...latestAttachmentsRef.current, response.attachment];
          latestAttachmentsRef.current = next;
          onChange(next);
          setProgress({ completed: index + 1, total: validFiles.length, fileName: file.name });
          reportClientEvent('attachment_uploaded', {
            outcome: attachmentKind(file) ?? 'unknown',
            value: file.size / (1024 * 1024),
          });
        } catch (uploadError) {
          if (controller.signal.aborted) return;
          uploadErrors.push(uploadErrorMessage(uploadError, file.name));
        }
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current && generation === operationGenerationRef.current) {
        operationRef.current = false;
        setProgress(null);
        if (uploadErrors.length > 0) {
          setError([...validationErrors, ...uploadErrors].join(' '));
        }
        onBusyChangeRef.current?.(false);
      }
    }
  }, [conversationId, onChange]);

  const uploadFiles = useCallback(async (selectedFiles: readonly File[]) => {
    if (unavailable || operationRef.current || selectedFiles.length === 0) return;
    const slots = Math.max(0, limit - latestAttachmentsRef.current.length);
    if (slots === 0) {
      setError(`Remove a file before adding another. You can attach up to ${limit}.`);
      return;
    }
    const validationErrors: string[] = [];
    const validFiles: File[] = [];
    for (const file of selectedFiles) {
      const validationError = validateFile(file, capability);
      if (validationError) validationErrors.push(validationError);
      else if (!capability && validFiles.length >= slots) validationErrors.push(`${file.name}: omitted; only ${slots} more ${slots === 1 ? 'file fits' : 'files fit'} in this message.`);
      else if (capability && validFiles.length >= limit) validationErrors.push(`${file.name}: omitted; review up to ${limit} files at a time. Choose this file in a later selection.`);
      else validFiles.push(file);
    }
    setError(validationErrors.length ? validationErrors.join(' ') : null);
    if (!validFiles.length) return;
    operationRef.current = true;
    onBusyChangeRef.current?.(true);

    if (capability && validFiles.some(file => attachmentKind(file, true) === 'text')) {
      const generation = operationGenerationRef.current;
      setPreparing(true);
      const files: ReviewFile[] = [];
      for (const file of validFiles) {
        try {
          const text = attachmentKind(file, true) === 'text'
            ? await readDiagnosticFile(file, capability.maxTextFileBytes) : undefined;
          files.push({ file, text, included: true });
        } catch (readError) {
          validationErrors.push(uploadErrorMessage(readError, file.name));
        }
      }
      if (!mountedRef.current || generation !== operationGenerationRef.current) return;
      setPreparing(false);
      if (!files.length) {
        operationRef.current = false;
        setError(validationErrors.join(' '));
        onBusyChangeRef.current?.(false);
        return;
      }
      setReview({ files, omissions: validationErrors, conversationId });
      return;
    }
    if (capability) {
      const budgetErrors = diagnosticBudgetErrors([...latestAttachmentsRef.current, ...validFiles.map(file => ({ name: file.name, size: file.size, mime: 'image/*' }))], { ...capability, maxAttachments: limit });
      if (budgetErrors.length) {
        operationRef.current = false;
        setError([...validationErrors, ...budgetErrors].join(' '));
        onBusyChangeRef.current?.(false);
        return;
      }
    }
    await performUploads(validFiles, validationErrors);
  }, [capability, conversationId, limit, performUploads, unavailable]);

  const resetFileInput = () => {
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    resetFileInput();
    void uploadFiles(files);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (unavailable) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (unavailable) return;
    void uploadFiles(Array.from(event.dataTransfer.files));
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (unavailable) return;
    const files = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files);
  };

  useEffect(() => {
    if (!compact) return undefined;
    const composer = compactTriggerRef.current?.closest<HTMLElement>('.wf-composer-shell');
    if (!composer) return undefined;

    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      if (unavailable) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (!unavailable && event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      if (unavailable || !event.dataTransfer) return;
      void uploadFiles(Array.from(event.dataTransfer.files));
    };
    const onPaste = (event: ClipboardEvent) => {
      if (unavailable) return;
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      event.preventDefault();
      void uploadFiles(files);
    };

    composer.addEventListener('dragenter', onDragEnter);
    composer.addEventListener('dragover', onDragOver);
    composer.addEventListener('dragleave', onDragLeave);
    composer.addEventListener('drop', onDrop);
    composer.addEventListener('paste', onPaste);
    return () => {
      composer.removeEventListener('dragenter', onDragEnter);
      composer.removeEventListener('dragover', onDragOver);
      composer.removeEventListener('dragleave', onDragLeave);
      composer.removeEventListener('drop', onDrop);
      composer.removeEventListener('paste', onPaste);
    };
  }, [compact, unavailable, uploadFiles]);

  const removeAttachment = async (attachment: ChatAttachment) => {
    if (busy || disabled) return;
    setRemovingId(attachment.id);
    setError(null);
    onBusyChange?.(true);
    try {
      await onRemoveAttachment?.(attachment);
      if (!mountedRef.current) return;
      const next = latestAttachmentsRef.current.filter(item => item.id !== attachment.id);
      latestAttachmentsRef.current = next;
      onChange([...next]);
    } catch (removeError) {
      if (mountedRef.current) {
        setError(uploadErrorMessage(removeError, attachment.name));
      }
    } finally {
      if (mountedRef.current) {
        setRemovingId(null);
        onBusyChange?.(false);
      }
    }
  };

  const selectedReviewFiles = review?.files.filter(file => file.included) ?? [];
  const reviewErrors = capability && review ? diagnosticBudgetErrors([
    ...attachments,
    ...selectedReviewFiles.map(({ file, text }) => ({
      name: file.name,
      size: text === undefined ? file.size : utf8Size(text),
      mime: text === undefined ? 'image/*' : 'text/plain',
    })),
  ], { ...capability, maxAttachments: limit }) : [];
  if (review && !selectedReviewFiles.length) reviewErrors.push('Select at least one file to upload.');

  const cancelReview = () => {
    setReview(null);
    operationRef.current = false;
    onBusyChangeRef.current?.(false);
  };

  const approveReview = () => {
    if (!review || reviewErrors.length || !capability || disabled || review.conversationId !== conversationId) return;
    const files = selectedReviewFiles.map(({ file, text }) => text === undefined
      ? file : reviewedDiagnosticFile(file.name, text));
    const omissions = [...review.omissions, ...review.files.filter(file => !file.included)
      .map(({ file }) => `${file.name}: excluded from upload by your selection.`)];
    setError(omissions.length ? omissions.join(' ') : null);
    setReview(null);
    void performUploads(files, omissions);
  };

  const reviewDialog = (
    <Dialog open={review !== null && signedIn} onClose={cancelReview} fullWidth maxWidth="md" aria-labelledby={`${inputId}-review-title`}>
      <DialogTitle id={`${inputId}-review-title`}>Review diagnostic files</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Alert severity="info" role="note">
            Originals stay on your device during review. Only included files and the edited UTF-8 text below will be uploaded after you approve.
            Diagnostic line references will refer to the uploaded text. Automated redaction suggestions can miss private information; check the text yourself.
          </Alert>
          {review?.omissions.map((omission, index) => <Alert severity="warning" key={index}>{omission}</Alert>)}
          {review?.files.map(({ file, text, included }, index) => {
            const suggestion = text === undefined ? null : suggestDiagnosticRedactions(text);
            return (
              <Box key={index} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                <FormControlLabel
                  control={<Checkbox checked={included} onChange={event => setReview(current => current && ({
                    ...current,
                    files: current.files.map((item, fileIndex) => fileIndex === index ? { ...item, included: event.target.checked } : item),
                  }))} />}
                  label={`Include ${file.name}`}
                />
                {!included && <Typography role="status" variant="body2">{file.name} will be excluded.</Typography>}
                {text !== undefined ? (
                  <Stack spacing={1}>
                    <Typography variant="caption">
                      Uploaded name: {file.name}.reviewed.txt · {utf8Size(text).toLocaleString()} UTF-8 bytes · {text.split('\n').length} lines
                    </Typography>
                    <TextField
                      label={`Reviewed text for ${file.name}`}
                      value={text}
                      onChange={event => setReview(current => current && ({
                        ...current,
                        files: current.files.map((item, fileIndex) => fileIndex === index ? { ...item, text: event.target.value } : item),
                      }))}
                      multiline minRows={4} maxRows={12} fullWidth disabled={!included}
                      helperText="Edit or remove private and irrelevant text. Nothing is automatically truncated."
                      slotProps={{ htmlInput: { spellCheck: false }, input: { sx: { fontFamily: 'monospace', fontSize: '0.85rem' } } }}
                    />
                    {suggestion !== null && suggestion.count > 0 && (
                      <Button size="small" sx={{ alignSelf: 'flex-start' }} disabled={!included} onClick={() => setReview(current => current && ({
                        ...current,
                        files: current.files.map((item, fileIndex) => fileIndex === index ? { ...item, text: suggestion.text } : item),
                      }))}>
                        Apply {suggestion.count} suggested redactions to {file.name}
                      </Button>
                    )}
                    <Box component="details">
                      <Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>Preview numbered uploaded lines for {file.name}</Typography>
                      <Box component="pre" aria-label={`Numbered uploaded lines for ${file.name}`} sx={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.8rem' }}>
                        {text.split('\n').map((line, lineIndex) => `${lineIndex + 1}  ${line}`).join('\n')}
                      </Box>
                    </Box>
                  </Stack>
                ) : <Typography variant="body2">Image · {formatAttachmentSize(file.size)}</Typography>}
              </Box>
            );
          })}
          <Typography variant="body2" role="status">
            {selectedReviewFiles.length} files selected; {review ? review.files.length - selectedReviewFiles.length : 0} excluded.
            {' '}Existing attachments also count toward message limits.
          </Typography>
          {reviewErrors.map((reviewError, index) => <Alert key={index} severity="warning" role="alert">{reviewError}</Alert>)}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={cancelReview}>Cancel review</Button>
        <Button onClick={approveReview} disabled={reviewErrors.length > 0 || disabled} variant="contained">Upload reviewed selection</Button>
      </DialogActions>
    </Dialog>
  );

  if (!signedIn) {
    return (
      <Alert severity="info" variant="outlined" icon={<AttachFileIcon fontSize="inherit" />}>
        Sign in to attach screenshots, logs, or text files to this chat.
      </Alert>
    );
  }

  if (compact) {
    return (
      <Stack sx={{ display: 'contents' }} aria-busy={busy}>
        {reviewDialog}
        <Box
          ref={compactTriggerRef}
          id={`${inputId}-compact-trigger`}
          role="region"
          aria-label="File attachment drop zone"
          aria-describedby={`${inputId}-guidance`}
          sx={{
            minHeight: 34,
            display: 'flex',
            alignItems: 'center',
            gap: 0.65,
            flex: '0 0 auto',
            borderRadius: 1.5,
            bgcolor: dragActive ? 'action.hover' : 'transparent',
            outline: dragActive ? '1px dashed' : 'none',
            outlineColor: 'primary.main',
          }}
        >
          <Tooltip title={remaining === 0 ? 'Attachment limit reached' : 'Attach screenshots or files'}>
            <span>
              <IconButton
                component="label"
                htmlFor={inputId}
                size="small"
                disabled={unavailable || remaining === 0}
                aria-label="Attach screenshots or files"
                sx={{ color: 'text.secondary' }}
              >
                <AttachFileIcon fontSize="small" />
                <input
                  ref={inputRef}
                  id={inputId}
                  type="file"
                  accept={accept}
                  multiple
                  hidden
                  onChange={handleFileInput}
                />
              </IconButton>
            </span>
          </Tooltip>
          <Typography
            id={`${inputId}-guidance`}
            variant="caption"
            noWrap
            sx={{ display: attachments.length ? 'none' : { xs: 'none', sm: 'block' }, color: 'text.secondary' }}
          >
            Add a screenshot, log, or text file · {remaining} slots available
          </Typography>
        </Box>

        {attachments.length > 0 && (
          <Stack
            direction="row"
            useFlexGap
            spacing={0.5}
            aria-label="Attached files"
            sx={{ order: -1, flex: '1 0 100%', width: '100%', minWidth: 0, flexWrap: 'nowrap', overflowX: 'auto', overscrollBehaviorX: 'contain', pb: 0.25 }}
          >
            {attachments.map(attachment => (
              <Chip
                key={attachment.id}
                icon={<InsertDriveFileIcon />}
                label={`${attachment.name} · ${formatAttachmentSize(attachment.size)}`}
                size="small"
                variant="outlined"
                disabled={disabled}
                onDelete={busy ? undefined : () => void removeAttachment(attachment)}
                deleteIcon={<span aria-label={`Remove ${attachment.name}`}>×</span>}
                sx={{ flex: '0 0 auto', maxWidth: { xs: 180, sm: 280 }, '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
              />
            ))}
          </Stack>
        )}

        {busy && progress && (
          <Box aria-live="polite" sx={{ order: 1, flex: '1 0 100%' }}>
            <Typography variant="caption" noWrap sx={{ display: 'block', mb: 0.35 }}>
              Uploading {progress.completed + 1 > progress.total ? progress.total : progress.completed + 1} of {progress.total}: {progress.fileName}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={(progress.completed / progress.total) * 100}
              aria-label="Attachment upload progress"
            />
          </Box>
        )}
        {preparing && <Typography role="status" variant="caption" sx={{ flex: '1 0 100%' }}>Preparing local diagnostic preview…</Typography>}

        {error && (
          <Alert severity="error" onClose={() => setError(null)} role="alert" sx={{ order: 1, flex: '1 0 100%' }}>
            {error}
          </Alert>
        )}
      </Stack>
    );
  }

  return (
    <Stack spacing={1} aria-busy={busy}>
      {reviewDialog}
      <Box
        role="region"
        tabIndex={unavailable ? -1 : 0}
        aria-label="File attachment drop zone"
        aria-describedby={`${inputId}-guidance`}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => {
          event.preventDefault();
          if (!unavailable) event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', sm: 'center' },
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 1.25,
          minHeight: 64,
          px: 1.5,
          py: 1.1,
          border: '1px dashed',
          borderColor: dragActive ? 'primary.main' : 'divider',
          borderRadius: 2,
          color: disabled ? 'text.disabled' : 'text.secondary',
          bgcolor: dragActive ? 'action.hover' : 'transparent',
          transition: 'border-color 120ms ease, background-color 120ms ease',
          '&:focus-visible': {
            outline: '3px solid',
            outlineColor: 'primary.light',
            outlineOffset: 2,
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
          <CloudUploadIcon color={dragActive ? 'primary' : 'inherit'} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 700 }}>
              Drop or paste files here
            </Typography>
            <Typography id={`${inputId}-guidance`} variant="caption" component="p">
              {capability
                ? `JPG, PNG, WebP up to ${formatAttachmentSize(capability.maxImageBytes)}; review UTF-8 or BOM-marked UTF-16 TXT, CSV, JSON, LOG, XML, text NFO. ${formatAttachmentSize(capability.maxTotalTextBytes)} combined text per message.`
                : 'JPG, PNG, WebP up to 8 MB; UTF-8 TXT, CSV, JSON up to 1 MB.'}
              {' '}{remaining} of {limit} slots available.
            </Typography>
          </Box>
        </Box>
        <Button
          component="label"
          htmlFor={inputId}
          variant="outlined"
          size="small"
          startIcon={<AttachFileIcon />}
          disabled={unavailable || remaining === 0}
          sx={{ flexShrink: 0 }}
        >
          Add files
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={accept}
            multiple
            hidden
            onChange={handleFileInput}
          />
        </Button>
      </Box>

      {preparing && <Typography role="status" variant="caption">Preparing local diagnostic preview…</Typography>}

      {busy && progress && (
        <Box aria-live="polite">
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
            <Typography variant="caption" noWrap>
              Uploading {progress.completed + 1 > progress.total ? progress.total : progress.completed + 1} of {progress.total}: {progress.fileName}
            </Typography>
            <Typography variant="caption">{Math.round((progress.completed / progress.total) * 100)}%</Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={(progress.completed / progress.total) * 100}
            aria-label="Attachment upload progress"
          />
        </Box>
      )}

      {error && (
        <Alert severity="error" onClose={() => setError(null)} role="alert">
          {error}
        </Alert>
      )}

      {attachments.length > 0 && (
        <Stack direction="row" useFlexGap spacing={0.75} aria-label="Attached files" sx={{ flexWrap: 'wrap' }}>
          {attachments.map(attachment => (
            <Chip
              key={attachment.id}
              icon={<InsertDriveFileIcon />}
              label={`${attachment.name} · ${formatAttachmentSize(attachment.size)}`}
              size="small"
              variant="outlined"
              disabled={disabled}
              onDelete={busy ? undefined : () => void removeAttachment(attachment)}
              deleteIcon={<span aria-label={`Remove ${attachment.name}`}>×</span>}
              sx={{ maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};
