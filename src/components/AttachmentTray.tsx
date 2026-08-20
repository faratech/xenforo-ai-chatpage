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
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import { APIError, ChatAPI } from '../services/api';
import type { ChatAttachment } from '../services/api';
import { reportClientEvent } from '../services/telemetry';

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

const attachmentKind = (file: File): AttachmentKind | null => {
  const mime = file.type.toLocaleLowerCase();
  const extension = fileExtension(file.name);
  if (IMAGE_MIMES.has(mime) || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.has(extension)) return 'text';
  return null;
};

const validateFile = (file: File): string | null => {
  const kind = attachmentKind(file);
  if (!kind) return `${file.name}: choose a JPG, PNG, WebP, TXT, CSV, or JSON file.`;
  if (file.size < 1) return `${file.name}: empty files cannot be uploaded.`;
  const limit = kind === 'image' ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_TEXT_BYTES;
  if (file.size > limit) {
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
}: AttachmentTrayProps) => {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const compactTriggerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestAttachmentsRef = useRef<readonly ChatAttachment[]>(attachments);
  const onBusyChangeRef = useRef(onBusyChange);
  const mountedRef = useRef(true);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limit = Math.min(ATTACHMENT_MAX_COUNT, Math.max(1, Math.floor(maxAttachments)));
  const busy = progress !== null || removingId !== null;
  const unavailable = disabled || busy || !signedIn;
  const remaining = Math.max(0, limit - attachments.length);

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
      abortRef.current?.abort();
      onBusyChangeRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    if (!signedIn) abortRef.current?.abort();
  }, [signedIn]);

  const uploadFiles = useCallback(async (selectedFiles: readonly File[]) => {
    if (unavailable || selectedFiles.length === 0) return;
    const slots = Math.max(0, limit - latestAttachmentsRef.current.length);
    if (slots === 0) {
      setError(`Remove a file before adding another. You can attach up to ${limit}.`);
      return;
    }

    const validationErrors: string[] = [];
    const validFiles: File[] = [];
    for (const file of selectedFiles) {
      const validationError = validateFile(file);
      if (validationError) validationErrors.push(validationError);
      else if (validFiles.length < slots) validFiles.push(file);
    }
    if (selectedFiles.length - validationErrors.length > slots) {
      validationErrors.push(`Only ${slots} more ${slots === 1 ? 'file fits' : 'files fit'} in this message.`);
    }
    setError(validationErrors.length > 0 ? validationErrors.join(' ') : null);
    if (validFiles.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    onBusyChange?.(true);
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
          if (!mountedRef.current || controller.signal.aborted) return;
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
      if (mountedRef.current) {
        setProgress(null);
        if (uploadErrors.length > 0) {
          setError([...validationErrors, ...uploadErrors].join(' '));
        }
        onBusyChange?.(false);
      }
    }
  }, [conversationId, limit, onBusyChange, onChange, unavailable]);

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
                  accept={ATTACHMENT_ACCEPT}
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
              JPG, PNG, WebP up to 8 MB; UTF-8 TXT, CSV, JSON up to 1 MB. {remaining} of {limit} slots available.
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
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            onChange={handleFileInput}
          />
        </Button>
      </Box>

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
