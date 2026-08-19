import type { Annotation, Conversation, Message } from '../types';

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
    lines.push(`## ${messageHeading(message)}`, '', message.rawContent.trim(), '');
    if (message.annotations?.length) {
      lines.push('### Sources', '');
      message.annotations.forEach((annotation, index) => {
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

/** JSON retains only conversation data needed for a future local import. */
export const conversationToJSON = (
  conversation: Conversation,
  options: ConversationExportOptions = {},
): string => JSON.stringify({
  schema: 'windowsforum-ai-conversation',
  version: 1,
  exported_at: options.exportedAt ?? Date.now(),
  conversation: {
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
  },
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
  URL.revokeObjectURL(objectUrl);
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
