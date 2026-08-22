import { lexer, walkTokens, type Token } from 'marked';
import type { Annotation, Conversation, Message } from '../types';
import { canonicalHttpUrlKey, normalizeAssistantMarkup, parseHttpUrl } from '../utils/helpers';

export type ConversationExportFormat = 'markdown' | 'json';
export type ConversationShareMethod = 'web-share-file' | 'web-share-text' | 'download' | 'cancelled';

export interface ConversationExportArtifact {
  format: ConversationExportFormat;
  filename: string;
  mimeType: string;
  content: string;
  blob: Blob;
}

export interface ConversationExportOptions {
  exportedAt?: number;
}

export interface PrivateShareOptions extends ConversationExportOptions {
  format?: ConversationExportFormat;
  navigator?: Navigator;
  document?: Document;
}

interface ConversationJSONRecord {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: Array<{
    id: string;
    role: Message['role'];
    raw_content: string;
    timestamp: number;
    status?: Message['status'];
    annotations?: Annotation[];
    response_id?: string;
    turn_id?: string;
    activities?: Message['activities'];
    attachments?: Message['attachments'];
  }>;
}

const isoDate = (timestamp: number): string => new Date(timestamp).toISOString();

const filenamePart = (title: string): string => {
  const normalized = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'conversation';
};

const markdownLabel = (value: string): string => value
  .replace(/[\r\n]+/g, ' ')
  .replace(/([\\`*_[\]<>])/g, '\\$1')
  .trim();

const annotationLabel = (annotation: Annotation): string => {
  switch (annotation.type) {
    case 'url_citation':
      return annotation.title?.trim() || annotation.url;
    case 'file_citation':
    case 'file_path':
      return annotation.filename?.trim() || 'File source';
    case 'container_file_citation':
      return annotation.filename?.trim() || 'Workspace file';
  }
};

const annotationMarkdown = (annotation: Annotation): string => {
  const label = markdownLabel(annotationLabel(annotation));
  if (annotation.type !== 'url_citation') return label;
  try {
    const url = new URL(annotation.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return label;
    return `[${label}](${url.href.replace(/\)/g, '%29')})`;
  } catch {
    return label;
  }
};

const messageHeading = (message: Message): string => message.role === 'user' ? 'You' : 'WindowsForum AI';

const humanReadableMessageContent = (message: Message): string => (
  message.role === 'ai' ? normalizeAssistantMarkup(message.rawContent) : message.rawContent
);

interface FoldedMarkdownSources {
  content: string;
  annotations: Annotation[];
  folded: boolean;
}

const markdownTokenText = (token: Token): string => {
  if ('tokens' in token && Array.isArray(token.tokens)) {
    return token.tokens.map(markdownTokenText).join('');
  }
  return 'text' in token && typeof token.text === 'string' ? token.text : '';
};

const isSourcesLabelToken = (token: Token): boolean => (
  (token.type === 'heading' || token.type === 'paragraph')
  && markdownTokenText(token).trim().replace(/:$/, '').toLocaleLowerCase() === 'sources'
);

const isSourceBodyToken = (token: Token): boolean => {
  if (token.type === 'space') return true;
  if (token.type !== 'list' && token.type !== 'paragraph') return false;

  let containsLink = false;
  void walkTokens([token], nested => {
    if (nested.type === 'link') containsLink = true;
  });
  return containsLink || /(?:https?:\/\/|\[\d+\])/i.test(token.raw);
};

const safeLinkAnnotations = (tokens: Token[]): Annotation[] => {
  const annotations: Annotation[] = [];
  void walkTokens(tokens, token => {
    if (token.type !== 'link') return;
    const url = parseHttpUrl(token.href);
    if (!url) return;
    annotations.push({
      type: 'url_citation',
      url: url.href,
      title: token.text.trim() || url.hostname,
    });
  });
  return annotations;
};

/**
 * Removes only a trailing provider-authored Sources block. Structured
 * annotations are required before folding so an ordinary authored section is
 * never silently rewritten when there is no replacement provenance list.
 */
const foldTrailingMarkdownSources = (content: string): FoldedMarkdownSources => {
  let tokens: Token[];
  try {
    tokens = lexer(content);
  } catch {
    return { content, annotations: [], folded: false };
  }

  for (let sourceIndex = tokens.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    const label = tokens[sourceIndex];
    if (!label || !isSourcesLabelToken(label)) continue;

    const tail = tokens.slice(sourceIndex + 1);
    if (!tail.every(isSourceBodyToken)) continue;

    let removalIndex = sourceIndex;
    let previousIndex = sourceIndex - 1;
    while (previousIndex >= 0 && tokens[previousIndex]?.type === 'space') previousIndex -= 1;
    if (previousIndex >= 0 && tokens[previousIndex]?.type === 'hr') removalIndex = previousIndex;
    const start = tokens.slice(0, removalIndex).reduce((offset, token) => offset + token.raw.length, 0);

    return {
      content: content.slice(0, start).trimEnd(),
      annotations: safeLinkAnnotations(tail),
      folded: true,
    };
  }

  return { content, annotations: [], folded: false };
};

const annotationIdentity = (annotation: Annotation): string => {
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

const annotationTitleScore = (annotation: Annotation): number => {
  if (annotation.type !== 'url_citation' || !annotation.title?.trim()) return 0;
  const title = annotation.title.trim();
  const hostname = parseHttpUrl(annotation.url)?.hostname.replace(/^www\./, '') ?? '';
  return title.replace(/^www\./, '').toLocaleLowerCase() === hostname.toLocaleLowerCase()
    ? 1
    : 10 + Math.min(title.length, 100);
};

const mergeSourceAnnotations = (
  authored: readonly Annotation[],
  structured: readonly Annotation[],
): Annotation[] => {
  const merged: Annotation[] = [];
  const positions = new Map<string, number>();

  for (const annotation of [...authored, ...structured]) {
    const identity = annotationIdentity(annotation);
    const existingIndex = positions.get(identity);
    if (existingIndex === undefined) {
      positions.set(identity, merged.length);
      merged.push(annotation);
      continue;
    }

    const existing = merged[existingIndex];
    if (
      existing?.type === 'url_citation'
      && annotation.type === 'url_citation'
      && annotationTitleScore(annotation) > annotationTitleScore(existing)
    ) {
      merged[existingIndex] = { ...existing, title: annotation.title };
    }
  }

  return merged;
};

/** A deterministic speaker-labelled transcript for the clipboard. */
export const conversationToPlainText = (conversation: Conversation): string => {
  const transcript = conversation.messages.flatMap(message => [
    messageHeading(message),
    humanReadableMessageContent(message).trim(),
  ]);
  return `${[conversation.title.trim() || 'Conversation', ...transcript].join('\n\n').trim()}\n`;
};

export const conversationToMarkdown = (
  conversation: Conversation,
  options: ConversationExportOptions = {},
): string => {
  const exportedAt = options.exportedAt ?? Date.now();
  const lines = [
    `# ${markdownLabel(conversation.title) || 'Conversation'}`,
    '',
    `_Private export created ${isoDate(exportedAt)}._`,
    '',
  ];

  for (const message of conversation.messages) {
    let content = humanReadableMessageContent(message).trim();
    let annotations = mergeSourceAnnotations([], message.annotations ?? []);
    if (message.role === 'ai' && annotations.length) {
      const folded = foldTrailingMarkdownSources(content);
      if (folded.folded) {
        content = folded.content;
        annotations = mergeSourceAnnotations(folded.annotations, annotations);
      }
    }

    lines.push(`## ${messageHeading(message)}`, '', content, '');
    if (annotations.length) {
      lines.push('### Sources', '');
      annotations.forEach((annotation, index) => {
        lines.push(`${index + 1}. ${annotationMarkdown(annotation)}`);
      });
      lines.push('');
    }
    if (message.attachments?.length) {
      lines.push('### Attachments', '');
      message.attachments.forEach(attachment => {
        lines.push(`- ${markdownLabel(attachment.name)} (${markdownLabel(attachment.mime)}, ${attachment.size} bytes)`);
      });
      lines.push('');
    }
  }

  return `${lines.join('\n').trim()}\n`;
};

/**
 * Shared JSON projection for single and collection exports. Keeping this in
 * one place prevents the two formats from silently retaining different data.
 */
const conversationToJSONRecord = (conversation: Conversation): ConversationJSONRecord => ({
  id: conversation.id,
  title: conversation.title,
  created_at: conversation.createdAt,
  updated_at: conversation.updatedAt,
  messages: conversation.messages.map(message => ({
    id: message.id,
    role: message.role,
    raw_content: message.rawContent,
    timestamp: message.timestamp,
    ...(message.status ? { status: message.status } : {}),
    ...(message.annotations?.length ? { annotations: message.annotations } : {}),
    ...(message.responseId ? { response_id: message.responseId } : {}),
    ...(message.turnId ? { turn_id: message.turnId } : {}),
    ...(message.activities?.length ? { activities: message.activities } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  })),
});

/** JSON retains only conversation data needed for a future local import. */
export const conversationToJSON = (
  conversation: Conversation,
  options: ConversationExportOptions = {},
): string => JSON.stringify({
  schema: 'windowsforum-ai-conversation',
  version: 1,
  exported_at: options.exportedAt ?? Date.now(),
  conversation: conversationToJSONRecord(conversation),
}, null, 2) + '\n';

export const createConversationExport = (
  conversation: Conversation,
  format: ConversationExportFormat,
  options: ConversationExportOptions = {},
): ConversationExportArtifact => {
  const exportedAt = options.exportedAt ?? Date.now();
  const stableOptions = { ...options, exportedAt };
  const content = format === 'markdown'
    ? conversationToMarkdown(conversation, stableOptions)
    : conversationToJSON(conversation, stableOptions);
  const extension = format === 'markdown' ? 'md' : 'json';
  const mimeType = format === 'markdown'
    ? 'text/markdown;charset=utf-8'
    : 'application/json;charset=utf-8';
  const date = isoDate(exportedAt).slice(0, 10);

  return {
    format,
    filename: `${filenamePart(conversation.title)}-${date}.${extension}`,
    mimeType,
    content,
    blob: new Blob([content], { type: mimeType }),
  };
};

export const createConversationCollectionExport = (
  conversations: readonly Conversation[],
  format: ConversationExportFormat,
  options: ConversationExportOptions = {},
): ConversationExportArtifact => {
  const exportedAt = options.exportedAt ?? Date.now();
  const date = isoDate(exportedAt).slice(0, 10);
  const markdownDocuments = conversations.map(conversation => (
    conversationToMarkdown(conversation, { exportedAt }).trim()
  ));
  const content = format === 'markdown'
    ? (markdownDocuments.length ? `${markdownDocuments.join('\n\n---\n\n')}\n` : '')
    : `${JSON.stringify({
      schema: 'windowsforum-ai-conversation-collection',
      version: 1,
      exported_at: exportedAt,
      conversations: conversations.map(conversationToJSONRecord),
    }, null, 2)}\n`;
  const mimeType = format === 'markdown'
    ? 'text/markdown;charset=utf-8'
    : 'application/json;charset=utf-8';
  return {
    format,
    filename: `windowsforum-ai-chats-${date}.${format === 'markdown' ? 'md' : 'json'}`,
    mimeType,
    content,
    blob: new Blob([content], { type: mimeType }),
  };
};

export const downloadConversationExport = (
  artifact: ConversationExportArtifact,
  targetDocument: Document = document,
): void => {
  const objectUrl = URL.createObjectURL(artifact.blob);
  const link = targetDocument.createElement('a');
  link.href = objectUrl;
  link.download = artifact.filename;
  link.hidden = true;
  targetDocument.body.append(link);
  link.click();
  link.remove();
  // The URL used to be revoked synchronously after click(); engines that
  // start the save asynchronously (Safari defers until the user confirms)
  // could then resolve a dead URL and produce an empty download. A deferred
  // revoke leaves the blob alive long enough for the save to read it.
  targetDocument.defaultView?.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
};

/**
 * Shares the local export without creating a server-side/public snapshot.
 * File sharing is preferred, text sharing is the Web Share fallback, and a
 * local download is the final fallback. A user cancellation never downloads.
 */
export const shareConversationPrivately = async (
  conversation: Conversation,
  options: PrivateShareOptions = {},
): Promise<ConversationShareMethod> => {
  const format = options.format ?? 'markdown';
  const artifact = createConversationExport(conversation, format, options);
  const targetNavigator = options.navigator ?? navigator;
  const targetDocument = options.document ?? document;

  if (typeof targetNavigator.share === 'function') {
    try {
      if (typeof File !== 'undefined') {
        const file = new File([artifact.blob], artifact.filename, { type: artifact.mimeType });
        if (typeof targetNavigator.canShare === 'function' && targetNavigator.canShare({ files: [file] })) {
          await targetNavigator.share({ title: conversation.title, files: [file] });
          return 'web-share-file';
        }
      }
      await targetNavigator.share({
        title: conversation.title,
        text: artifact.content,
      });
      return 'web-share-text';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
      // Permissions, payload-size, and platform errors fall back to a private file.
    }
  }

  downloadConversationExport(artifact, targetDocument);
  return 'download';
};
