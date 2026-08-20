import { useState, useCallback, useEffect, useId, useMemo, useRef, memo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import { useTheme } from '@mui/material/styles';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import type { Annotation, MessageProps } from '../types';
import {
  canonicalHttpUrlKey,
  parseHttpUrl,
  sanitizeAndParse,
  splitStreamingMarkdown,
} from '../utils/helpers';
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';
import { CHAT_CONTENT_MAX_WIDTH } from '../config/layout';
import { reportClientEvent, reportSourceOpened, type SourceKind } from '../services/telemetry';

const citationLabel = (annotation: Annotation): string => {
  switch (annotation.type) {
    case 'url_citation': {
      if (annotation.title?.trim()) return annotation.title.trim();
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
      return `url_${canonicalHttpUrlKey(annotation.url) ?? annotation.url}_${index}`;
    case 'file_citation':
      return `file_${annotation.fileId || annotation.filename || ''}_${index}`;
    case 'container_file_citation':
      return `container_${annotation.containerId || ''}_${annotation.fileId || ''}_${index}`;
    case 'file_path':
      return `path_${annotation.fileId || ''}_${index}`;
  }
};

const sourceIdentity = (annotation: Annotation): string => {
  switch (annotation.type) {
    case 'url_citation':
      return `url:${canonicalHttpUrlKey(annotation.url) ?? annotation.url}`;
    case 'file_citation':
      return `file:${annotation.fileId || annotation.filename || ''}`;
    case 'container_file_citation':
      return `container:${annotation.containerId || ''}:${annotation.fileId || ''}`;
    case 'file_path':
      return `path:${annotation.fileId || ''}`;
  }
};

const citationTitleScore = (annotation: Annotation): number => {
  if (annotation.type !== 'url_citation' || !annotation.title?.trim()) return 0;
  const title = annotation.title.trim();
  const hostname = parseHttpUrl(annotation.url)?.hostname.replace(/^www\./, '') ?? '';
  return title.replace(/^www\./, '').toLowerCase() === hostname.toLowerCase()
    ? 1
    : 10 + Math.min(title.length, 100);
};

const citationMeta = (annotation: Annotation): string => {
  switch (annotation.type) {
    case 'url_citation':
      return parseHttpUrl(annotation.url)?.hostname.replace(/^www\./, '') || 'Link unavailable';
    case 'file_citation':
      return 'File';
    case 'container_file_citation':
      return 'Attached file';
    case 'file_path':
      return 'Generated file';
  }
};

const COLLAPSED_SOURCE_COUNT = 4;

const INLINE_CITATION_SX = {
  '& .wf-inline-citation': {
    appearance: 'none',
    border: 0,
    borderRadius: '999px',
    m: '0 1px',
    px: '4px',
    py: '1px',
    minWidth: '1.65em',
    font: 'inherit',
    fontSize: '1em',
    fontWeight: 700,
    lineHeight: 1.35,
    verticalAlign: 'baseline',
    color: 'primary.main',
    bgcolor: 'action.hover',
    cursor: 'pointer',
    transition: 'background-color 120ms ease, box-shadow 120ms ease',
    '&:hover': { bgcolor: 'action.selected' },
    '&:focus-visible': {
      outline: '2px solid',
      outlineColor: 'primary.main',
      outlineOffset: '2px',
    },
  },
} as const;

const MAX_EDIT_BYTES = 4096;
const editEncoder = new TextEncoder();

const formatAttachmentSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Adds controlled code actions, keyboard-operable answer images, and citation
 * navigation after sanitization. The assistant cannot forge these controls:
 * sanitizeAndParse removes buttons and data attributes before this runs.
 */
const enhanceRichContent = (html: string, interactiveCitations = true): string => {
  if (!html || typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;

  for (const pre of template.content.querySelectorAll('pre')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'wf-code-block';
    const toolbar = document.createElement('div');
    toolbar.className = 'wf-code-toolbar';
    const language = pre.querySelector('code')?.className.match(/(?:^|\s)language-([^\s]+)/)?.[1];
    const label = document.createElement('span');
    label.className = 'wf-code-language';
    label.textContent = language || 'Code';

    const actions = document.createElement('span');
    actions.className = 'wf-code-actions';
    for (const [action, text, ariaLabel] of [
      ['wrap', 'Wrap', 'Toggle code wrapping'],
      ['copy', 'Copy', 'Copy code'],
      ['download', 'Download', 'Download code'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.codeAction = action;
      button.textContent = text;
      button.setAttribute('aria-label', ariaLabel);
      if (action === 'wrap') button.setAttribute('aria-pressed', 'false');
      actions.appendChild(button);
    }
    toolbar.append(label, actions);
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.append(toolbar, pre);
  }

  for (const image of template.content.querySelectorAll('img')) {
    image.classList.add('wf-answer-image');
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', `Open image${image.alt ? `: ${image.alt}` : ''}`);
  }

  if (interactiveCitations) {
    for (const marker of template.content.querySelectorAll('sup')) {
      const match = /^\[(\d+)\]$/.exec(marker.textContent?.trim() ?? '');
      if (!match) continue;
      const index = Number(match[1]);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wf-inline-citation';
      button.dataset.sourceIndex = String(index);
      button.setAttribute('aria-label', `Go to source ${index}`);
      button.title = `Go to source ${index}`;
      button.textContent = `[${index}]`;
      marker.replaceChildren(button);
    }
  }

  return template.innerHTML;
};

interface RenderedAnswerContent {
  html: string;
  citations: Annotation[];
}

const isAuthoredSourcesLabel = (element: Element): boolean => {
  if (!/^(?:H[1-6]|P)$/.test(element.tagName)) return false;
  return element.textContent?.trim().replace(/:$/, '').toLowerCase() === 'sources';
};

const appendSafeLinkCitations = (root: ParentNode, citations: Annotation[]): void => {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
    const url = parseHttpUrl(anchor.href);
    if (!url) return;
    citations.push({
      type: 'url_citation',
      url: url.href,
      title: anchor.textContent?.trim() || url.hostname,
    });
  });
};

/**
 * `sanitizeAndParse` keeps its portable string contract, including its Sources
 * footer. Inside the React message surface we lift that generated footer back
 * into data so model links and streamed annotations share one accessible
 * provenance panel. Some providers also append their own Markdown `Sources`
 * section. When structured citations exist, fold that trailing section into
 * the same panel instead of displaying two source lists.
 */
const prepareAnswerContent = (
  html: string,
  structuredAnnotations: readonly Annotation[] = [],
): RenderedAnswerContent => {
  if (!html || typeof document === 'undefined') return { html, citations: [] };
  const template = document.createElement('template');
  template.innerHTML = html;
  const footer = template.content.lastElementChild;
  const label = footer?.querySelector(':scope > small:first-child')?.textContent?.trim().toLowerCase();
  const citations: Annotation[] = [];

  if (footer instanceof HTMLParagraphElement && label === 'sources:') {
    appendSafeLinkCitations(footer, citations);
    const separator = footer.previousElementSibling;
    footer.remove();
    if (separator?.tagName === 'HR') separator.remove();
  }

  const topLevelElements = [...template.content.children];
  const authoredSources = [...topLevelElements].reverse().find(isAuthoredSourcesLabel);
  if (authoredSources) {
    const authoredTail = topLevelElements.slice(topLevelElements.indexOf(authoredSources));
    const authoredBody = authoredTail.slice(1);
    const isTrailingSourceList = authoredBody.every(element => (
      /^(?:OL|P|UL)$/.test(element.tagName)
      && (element.querySelector('a[href], sup') !== null
        || /(?:https?:\/\/|\[\d+\])/.test(element.textContent ?? ''))
    ));
    if (isTrailingSourceList) {
      authoredTail.forEach(element => appendSafeLinkCitations(element, citations));
    }
    if (isTrailingSourceList && (citations.length > 0 || structuredAnnotations.length > 0)) {
      const precedingSeparator = authoredSources.previousElementSibling;
      authoredTail.forEach(element => element.remove());
      if (precedingSeparator?.tagName === 'HR') precedingSeparator.remove();
    }
  }

  return { html: template.innerHTML, citations };
};

const codeFilename = (code: HTMLElement): string => {
  const language = code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase();
  const extensions: Record<string, string> = {
    bash: 'sh', css: 'css', html: 'html', javascript: 'js', js: 'js', json: 'json',
    powershell: 'ps1', ps1: 'ps1', python: 'py', sql: 'sql', ts: 'ts', typescript: 'ts',
    xml: 'xml', yaml: 'yml', yml: 'yml',
  };
  return `windowsforum-snippet.${extensions[language ?? ''] ?? 'txt'}`;
};

const downloadText = (text: string, filename: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const sourceKind = (annotation: Annotation): SourceKind => {
  switch (annotation.type) {
    case 'url_citation': return 'url';
    case 'file_citation': return 'file';
    case 'container_file_citation': return 'container_file';
    case 'file_path': return 'generated_file';
  }
};

const SourcesList = ({
  annotations,
  eventId,
  expanded,
  highlightedIndex,
  listId,
  onToggle,
}: {
  annotations: Annotation[];
  eventId?: string;
  expanded: boolean;
  highlightedIndex: number | null;
  listId: string;
  onToggle: () => void;
}) => {
  const hiddenCount = annotations.length - COLLAPSED_SOURCE_COUNT;

  return (
    <Box
      component="section"
      aria-label="Sources"
      className="message-file-sources"
      sx={{ mt: 1.25, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline', mb: 0.5 }}>
        <Typography component="h3" sx={{ m: 0, fontSize: 12, fontWeight: 700, color: 'text.secondary' }}>
          Sources
        </Typography>
        <Typography component="span" sx={{ fontSize: 11, color: 'text.disabled' }}>
          {annotations.length}
        </Typography>
      </Stack>
      <Box id={listId} component="ol" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.25 }}>
        {annotations.map((annotation, index) => {
          // Only validated http(s) URLs become links; everything else is text.
          const safeUrl = annotation.type === 'url_citation' ? parseHttpUrl(annotation.url) : null;
          const label = citationLabel(annotation);
          const meta = citationMeta(annotation);
          const showMeta = meta.replace(/^www\./, '').toLowerCase()
            !== label.trim().replace(/^www\./, '').toLowerCase();
          const highlighted = highlightedIndex === index + 1;
          const collapsed = !expanded && index >= COLLAPSED_SOURCE_COUNT;
          return (
            <Box
              key={citationReactKey(annotation, index)}
              component="li"
              tabIndex={-1}
              aria-label={`Source ${index + 1}: ${label}`}
              data-source-row-index={index + 1}
              data-source-highlighted={highlighted ? 'true' : undefined}
              data-source-collapsed={collapsed ? 'true' : undefined}
              sx={{
                display: collapsed ? 'none' : 'list-item',
                py: 0.35,
                pl: 0.25,
                pr: 0.75,
                borderRadius: 1,
                scrollMarginBlock: '20vh',
                bgcolor: highlighted ? 'action.selected' : 'transparent',
                boxShadow: highlighted ? 'inset 3px 0 0' : 'none',
                color: highlighted ? 'primary.main' : 'inherit',
                transition: 'background-color 160ms ease, box-shadow 160ms ease',
                outline: 'none',
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: '2px',
                },
              }}
            >
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 0.75, minWidth: 0 }}>
                {safeUrl ? (
                  <Box
                    component="a"
                    href={safeUrl.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={label}
                    onClick={() => reportSourceOpened(sourceKind(annotation), index + 1, eventId)}
                    sx={{ minWidth: 0, overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.35 }}
                  >
                    {label}
                  </Box>
                ) : (
                  <Typography component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.35 }}>
                    {label}
                  </Typography>
                )}
                {showMeta && (
                  <Typography component="span" sx={{ fontSize: 10.5, lineHeight: 1.35, color: 'text.secondary' }}>
                    {meta}
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
      {hiddenCount > 0 && (
        <Button
          className="wf-source-toggle"
          type="button"
          size="small"
          variant="text"
          aria-controls={listId}
          aria-expanded={expanded}
          onClick={onToggle}
          sx={{ mt: 0.4, px: 0.5, minWidth: 0, fontSize: 11.5, textTransform: 'none' }}
        >
          {expanded ? 'Show fewer sources' : `Show ${hiddenCount} more ${hiddenCount === 1 ? 'source' : 'sources'}`}
        </Button>
      )}
    </Box>
  );
};

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
  isSpeaking = false,
  onSpeak,
  onStopSpeaking,
  feedback,
  feedbackPending = false,
  onFeedback,
}) => {
  const theme = useTheme();
  const isUser = msg.role === 'user';
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [actionAnnouncement, setActionAnnouncement] = useState('');
  const [selectedImage, setSelectedImage] = useState<{ src: string; alt: string } | null>(null);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackReason, setFeedbackReason] = useState('');
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [highlightedSourceIndex, setHighlightedSourceIndex] = useState<number | null>(null);
  const sourcesListId = useId();
  const articleRef = useRef<HTMLElement | null>(null);
  const pendingSourceFocusRef = useRef<number | null>(null);
  const sourceHighlightResetRef = useRef<number | null>(null);

  const renderedAnswer = useMemo(
    () => (isStreaming
      ? { html: '', citations: [] }
      : prepareAnswerContent(
        enhanceRichContent(sanitizeAndParse(msg.rawContent), !isUser),
        msg.annotations,
      )),
    [msg.rawContent, msg.annotations, isStreaming, isUser]
  );
  const renderedContent = renderedAnswer.html;

  // Inline citations and SSE annotations can describe the same source. Merge
  // them by canonical URL/file identity before rendering a single panel.
  const visibleAnnotations = useMemo(() => {
    if (isStreaming) return [];
    const merged: Annotation[] = [];
    const positions = new Map<string, number>();

    for (const annotation of [...renderedAnswer.citations, ...(msg.annotations ?? [])]) {
      const key = sourceIdentity(annotation);
      const existingIndex = positions.get(key);
      if (existingIndex === undefined) {
        positions.set(key, merged.length);
        merged.push(annotation);
        continue;
      }

      const existing = merged[existingIndex];
      if (
        existing.type === 'url_citation'
        && annotation.type === 'url_citation'
        && citationTitleScore(annotation) > citationTitleScore(existing)
      ) {
        // Inline order determines marker numbering. Keep its position and URL,
        // but let the richer structured annotation improve the visible title.
        merged[existingIndex] = { ...existing, title: annotation.title };
      }
    }

    return merged;
  }, [isStreaming, msg.annotations, renderedAnswer.citations]);

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
    () => (streamingClosed
      ? prepareAnswerContent(enhanceRichContent(sanitizeAndParse(streamingClosed), false)).html
      : ''),
    [streamingClosed]
  );

  const copyResetRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    if (sourceHighlightResetRef.current !== null) window.clearTimeout(sourceHighlightResetRef.current);
  }, []);

  const focusSourceRow = useCallback((index: number): boolean => {
    const row = articleRef.current?.querySelector<HTMLElement>(`[data-source-row-index="${index}"]`);
    if (!row || row.dataset.sourceCollapsed === 'true') return false;

    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
    row.focus({ preventScroll: true });
    setHighlightedSourceIndex(index);
    setActionAnnouncement(`Source ${index} focused.`);

    if (sourceHighlightResetRef.current !== null) {
      window.clearTimeout(sourceHighlightResetRef.current);
    }
    sourceHighlightResetRef.current = window.setTimeout(() => {
      sourceHighlightResetRef.current = null;
      setHighlightedSourceIndex(current => current === index ? null : current);
    }, 2200);
    return true;
  }, []);

  const focusSource = useCallback((index: number) => {
    if (index < 1 || index > visibleAnnotations.length) return;
    if (focusSourceRow(index)) return;

    pendingSourceFocusRef.current = index;
    if (index > COLLAPSED_SOURCE_COUNT) setSourcesExpanded(true);
  }, [focusSourceRow, visibleAnnotations.length]);

  useEffect(() => {
    const pendingIndex = pendingSourceFocusRef.current;
    if (pendingIndex !== null && focusSourceRow(pendingIndex)) {
      pendingSourceFocusRef.current = null;
    }
  }, [focusSourceRow, sourcesExpanded, visibleAnnotations.length]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(msg.rawContent);
      setCopyStatus('copied');
      setActionAnnouncement('Message copied.');
      reportClientEvent('message_copied', {
        eventId: msg.turnId,
        outcome: isUser ? 'user' : 'assistant',
      });
    } catch (error) {
      console.error('Clipboard write failed:', error);
      setCopyStatus('failed');
      setActionAnnouncement('Message could not be copied.');
    }
    // Repeated clicks must not let an earlier timer clear a later "Copied!",
    // and a pending timer must not outlive the component.
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => {
      copyResetRef.current = null;
      setCopyStatus('idle');
    }, 3500);
  }, [isUser, msg.rawContent, msg.turnId]);

  const handleRichContentClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const citationButton = target.closest<HTMLButtonElement>('button.wf-inline-citation[data-source-index]');
    if (citationButton) {
      const sourceIndex = Number(citationButton.dataset.sourceIndex);
      if (Number.isInteger(sourceIndex)) {
        event.preventDefault();
        focusSource(sourceIndex);
      }
      return;
    }

    const button = target.closest<HTMLButtonElement>('button[data-code-action]');
    if (button) {
      const block = button.closest<HTMLElement>('.wf-code-block');
      const code = block?.querySelector<HTMLElement>('code');
      if (!block || !code) return;
      const action = button.dataset.codeAction;
      if (action === 'wrap') {
        const wrapped = block.classList.toggle('is-wrapped');
        button.setAttribute('aria-pressed', String(wrapped));
        button.textContent = wrapped ? 'Scroll' : 'Wrap';
        setActionAnnouncement(wrapped ? 'Code wrapping enabled.' : 'Code wrapping disabled.');
      } else if (action === 'copy') {
        void navigator.clipboard.writeText(code.textContent ?? '').then(() => {
          button.textContent = 'Copied';
          setActionAnnouncement('Code copied.');
          window.setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1800);
        }).catch(() => setActionAnnouncement('Code could not be copied.'));
      } else if (action === 'download') {
        downloadText(code.textContent ?? '', codeFilename(code));
        setActionAnnouncement('Code download started.');
      }
      return;
    }

    const link = target.closest<HTMLAnchorElement>('a[href]');
    const sourceUrl = link ? parseHttpUrl(link.href) : null;
    if (sourceUrl) {
      const candidateIndex = Number(link?.dataset.sourceIndex);
      reportSourceOpened(
        'url',
        Number.isInteger(candidateIndex) && candidateIndex > 0 ? candidateIndex : undefined,
        msg.turnId,
      );
    }

    const image = target.closest<HTMLImageElement>('img.wf-answer-image');
    if (image) setSelectedImage({ src: image.currentSrc || image.src, alt: image.alt || 'Answer image' });
  }, [focusSource, msg.turnId]);

  const handleRichContentKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.classList.contains('wf-answer-image')) return;
    event.preventDefault();
    setSelectedImage({ src: target.currentSrc || target.src, alt: target.alt || 'Answer image' });
  }, []);

  const handleEdit = useCallback(() => {
    if (isEditing) {
      const trimmed = editText.trim();
      const bytes = editEncoder.encode(trimmed).byteLength;
      if (!trimmed) {
        setEditError('Enter a message before saving.');
        return;
      }
      if (bytes > MAX_EDIT_BYTES) {
        const excess = bytes - MAX_EDIT_BYTES;
        setEditError(`Message is ${excess} ${excess === 1 ? 'byte' : 'bytes'} too long.`);
        return;
      }
      setEditError('');
      onEdit(msg.id, trimmed);
      setIsEditing(false);
    } else {
      setEditText(msg.rawContent);
      setEditError('');
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
    <Box
      className="message-content"
      onClick={handleRichContentClick}
      onKeyDown={handleRichContentKeyDown}
      sx={INLINE_CITATION_SX}
    >
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
      onClick={handleRichContentClick}
      onKeyDown={handleRichContentKeyDown}
      sx={INLINE_CITATION_SX}
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

      {!isUser && onSpeak && (
        <Tooltip title={isSpeaking ? 'Stop reading' : 'Read aloud'}>
          <IconButton
            size="small"
            onClick={() => {
              if (isSpeaking) onStopSpeaking?.();
              else void onSpeak(msg.id, msg.rawContent);
            }}
            aria-label={isSpeaking ? 'Stop reading message aloud' : 'Read message aloud'}
            aria-pressed={isSpeaking}
          >
            {isSpeaking ? <StopCircleOutlinedIcon fontSize="small" /> : <VolumeUpOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}

      {!isUser && msg.responseId && msg.turnId && onFeedback && (
        <>
          <Tooltip title="Helpful">
            <span>
              <IconButton
                size="small"
                disabled={feedbackPending}
                color={feedback === 'up' ? 'primary' : 'default'}
                onClick={() => { void onFeedback(msg.id, 'up'); }}
                aria-label="Mark response as helpful"
                aria-pressed={feedback === 'up'}
              >
                <ThumbUpOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Not helpful">
            <span>
              <IconButton
                size="small"
                disabled={feedbackPending}
                color={feedback === 'down' ? 'primary' : 'default'}
                onClick={() => setFeedbackDialogOpen(true)}
                aria-label="Mark response as not helpful"
                aria-pressed={feedback === 'down'}
              >
                <ThumbDownOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
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
        label="Edit message"
        error={Boolean(editError)}
        helperText={editError || `${editEncoder.encode(editText).byteLength} / ${MAX_EDIT_BYTES} bytes`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setIsEditing(false);
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) handleEdit();
        }}
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
    <>
    <Box ref={articleRef} component="article" aria-label={`${isUser ? userName : ASSISTANT_NAME} message`} sx={{ px: { xs: 1.5, sm: 2.5, md: 4 }, py: 1, '&:hover .message-actions, &:focus-within .message-actions': { opacity: 1 } }}>
      <Box sx={{ maxWidth: CHAT_CONTENT_MAX_WIDTH, mx: 'auto' }}>
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
                  {!!msg.attachments?.length && (
                    <Box
                      component="ul"
                      aria-label="Files attached to this message"
                      sx={{ listStyle: 'none', m: 0, mt: 1, p: 0, display: 'grid', gap: 0.5 }}
                    >
                      {msg.attachments.map(attachment => (
                        <Box
                          component="li"
                          key={attachment.id}
                          sx={{
                            display: 'flex',
                            alignItems: 'baseline',
                            justifyContent: 'space-between',
                            gap: 1.5,
                            minWidth: 0,
                            px: 1,
                            py: 0.5,
                            borderRadius: 1,
                            bgcolor: 'rgba(255,255,255,0.14)',
                            border: '1px solid rgba(255,255,255,0.24)',
                          }}
                        >
                          <Typography component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere', fontSize: 12.5 }}>
                            {attachment.name}
                          </Typography>
                          <Typography
                            component="span"
                            aria-label={`${attachment.size} bytes`}
                            sx={{ flexShrink: 0, fontSize: 11, opacity: 0.86 }}
                          >
                            {formatAttachmentSize(attachment.size)}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                  {msg.status === 'failed' && (
                    <Typography component="span" sx={{ display: 'block', mt: 0.75, fontSize: 12, color: '#fff' }}>
                      Not sent — edit or retry
                    </Typography>
                  )}
                </Box>
              )}
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                {time && (
                  <Typography component="time" dateTime={new Date(msg.timestamp).toISOString()} variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
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
                <Typography component="span" variant="subtitle2" sx={{ fontWeight: 700, color: 'text.primary' }}>
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
                  <Typography component="time" dateTime={new Date(msg.timestamp).toISOString()} variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
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
                  {!!visibleAnnotations.length && !isStreaming && (
                    <SourcesList
                      annotations={visibleAnnotations}
                      eventId={msg.turnId}
                      expanded={sourcesExpanded}
                      highlightedIndex={highlightedSourceIndex}
                      listId={sourcesListId}
                      onToggle={() => {
                        setSourcesExpanded(current => !current);
                        setHighlightedSourceIndex(null);
                      }}
                    />
                  )}
                </Box>
              )}
              {actions}
            </Box>
          </Stack>
        )}
      </Box>
      <Box className="wf-sr-only" role="status" aria-live="polite">{actionAnnouncement}</Box>
    </Box>

    <Dialog
      open={Boolean(selectedImage)}
      onClose={() => setSelectedImage(null)}
      aria-label="Answer image preview"
      maxWidth="lg"
      container={() => document.getElementById('wf-chat-window')}
    >
      <DialogContent sx={{ p: 1, bgcolor: 'background.default' }}>
        {selectedImage && <img className="wf-image-preview" src={selectedImage.src} alt={selectedImage.alt} />}
      </DialogContent>
      <DialogActions>
        {selectedImage && (
          <Button component="a" href={selectedImage.src} target="_blank" rel="noopener noreferrer" startIcon={<OpenInNewIcon />}>
            Open original
          </Button>
        )}
        {selectedImage && (
          <Button component="a" href={selectedImage.src} download startIcon={<DownloadIcon />}>
            Download
          </Button>
        )}
        <Button onClick={() => setSelectedImage(null)}>Close</Button>
      </DialogActions>
    </Dialog>

    <Dialog
      open={feedbackDialogOpen}
      onClose={() => setFeedbackDialogOpen(false)}
      aria-labelledby={`wf-feedback-title-${msg.id}`}
      fullWidth
      maxWidth="xs"
      container={() => document.getElementById('wf-chat-window')}
    >
      <DialogTitle id={`wf-feedback-title-${msg.id}`}>What could be better?</DialogTitle>
      <DialogContent>
        <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 1.5 }}>
          A short reason is optional. Do not include private information.
        </Typography>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={3}
          label="Reason (optional)"
          value={feedbackReason}
          onChange={(event) => setFeedbackReason(event.target.value.slice(0, 500))}
          slotProps={{ htmlInput: { maxLength: 500 } }}
          helperText={`${feedbackReason.length} / 500`}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setFeedbackDialogOpen(false)}>Cancel</Button>
        <Button
          variant="contained"
          disabled={feedbackPending}
          onClick={() => {
            setFeedbackDialogOpen(false);
            void onFeedback?.(msg.id, 'down', feedbackReason.trim() || undefined);
          }}
        >
          Send feedback
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
});
