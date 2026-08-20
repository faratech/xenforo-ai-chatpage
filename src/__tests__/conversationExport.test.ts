import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../types';
import {
  conversationToJSON,
  conversationToMarkdown,
  conversationToPlainText,
  createConversationCollectionExport,
  createConversationExport,
  shareConversationPrivately,
} from '../services/conversationExport';

const conversation: Conversation = {
  id: 'conv_private_1',
  title: 'Fix Wi-Fi / DNS',
  createdAt: 100,
  updatedAt: 200,
  messages: [
    {
      id: 'message_1',
      role: 'user',
      rawContent: 'Why is DNS failing?',
      timestamp: 110,
      status: 'complete',
    },
    {
      id: 'message_2',
      role: 'ai',
      rawContent: 'Try `Resolve-DnsName` first.',
      timestamp: 120,
      status: 'complete',
      responseId: 'resp_2',
      turnId: 'turn_2',
      activities: [{ id: 'search_1', label: 'Searching the web', state: 'done' }],
      attachments: [{ id: 'attachment_1', name: 'ipconfig.txt', mime: 'text/plain', size: 42 }],
      annotations: [
        { type: 'url_citation', title: 'DNS guide', url: 'https://example.com/dns' },
        { type: 'file_citation', filename: 'diagnostic.txt', fileId: 'file_1' },
      ],
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('private conversation exports', () => {
  it('creates readable Markdown with local source references', () => {
    const markdown = conversationToMarkdown(conversation, { exportedAt: 1_700_000_000_000 });
    expect(markdown).toContain('# Fix Wi-Fi / DNS');
    expect(markdown).toContain('## You\n\nWhy is DNS failing?');
    expect(markdown).toContain('## WindowsForum AI');
    expect(markdown).toContain('[DNS guide](https://example.com/dns)');
    expect(markdown).toContain('diagnostic.txt');
    expect(markdown).toContain('ipconfig.txt (text/plain, 42 bytes)');
  });

  it('folds an authored trailing Sources block into one safe deduplicated Markdown list', () => {
    const authoredSources = [
      'Use the supported recovery steps above.',
      '',
      '### Sources:',
      '- [example.com](https://example.com/dns/?utm_source=assistant#recovery)',
      '- [Microsoft Learn](https://learn.microsoft.com/en-us/windows/)',
      '- [Unsafe](javascript:alert(1))',
    ].join('\n');
    const withAuthoredSources: Conversation = {
      ...conversation,
      messages: conversation.messages.map(message => message.role === 'ai' ? {
        ...message,
        rawContent: authoredSources,
        annotations: [
          { type: 'url_citation', title: 'DNS guide', url: 'https://example.com/dns?gclid=duplicate' },
          { type: 'file_citation', filename: 'diagnostic.txt', fileId: 'file_1' },
        ],
      } : message),
    };

    const markdown = conversationToMarkdown(withAuthoredSources, { exportedAt: 1_700_000_000_000 });
    expect(markdown.match(/^### Sources$/gm)).toHaveLength(1);
    expect(markdown.match(/https:\/\/example\.com\/dns/g)).toHaveLength(1);
    expect(markdown).toContain('[DNS guide](https://example.com/dns/?utm_source=assistant#recovery)');
    expect(markdown).toContain('[Microsoft Learn](https://learn.microsoft.com/en-us/windows/)');
    expect(markdown).toContain('diagnostic.txt');
    expect(markdown).not.toContain('javascript:');

    const json = JSON.parse(conversationToJSON(withAuthoredSources, { exportedAt: 500 })) as {
      conversation: { messages: Array<{ role: string; raw_content: string }> };
    };
    expect(json.conversation.messages.find(message => message.role === 'ai')?.raw_content).toBe(authoredSources);
  });

  it('deduplicates canonical structured sources without rewriting JSON', () => {
    const duplicateStructuredSources: Conversation = {
      ...conversation,
      messages: conversation.messages.map(message => message.role === 'ai' ? {
        ...message,
        annotations: [
          { type: 'url_citation', title: 'example.com', url: 'https://example.com/dns/?utm_source=assistant#recovery' },
          { type: 'url_citation', title: 'DNS recovery guide', url: 'https://example.com/dns?gclid=duplicate' },
          { type: 'file_citation', filename: 'diagnostic.txt', fileId: 'file_1' },
        ],
      } : message),
    };

    const markdown = conversationToMarkdown(duplicateStructuredSources, { exportedAt: 1_700_000_000_000 });
    expect(markdown.match(/^### Sources$/gm)).toHaveLength(1);
    expect(markdown.match(/https:\/\/example\.com\/dns/g)).toHaveLength(1);
    expect(markdown).toContain('[DNS recovery guide](https://example.com/dns/?utm_source=assistant#recovery)');
    expect(markdown).toContain('diagnostic.txt');

    const json = JSON.parse(conversationToJSON(duplicateStructuredSources, { exportedAt: 500 })) as {
      conversation: { messages: Array<{ role: string; annotations?: unknown[] }> };
    };
    expect(json.conversation.messages.find(message => message.role === 'ai')?.annotations).toHaveLength(3);
  });

  it('normalizes completed AI citation tokens only in human-readable exports', () => {
    const citationUrl = 'https://windowsforum.com/threads/dns-recovery.123/';
    const rawTokenContent = [
      `Use this guide \uE200cite\uE202${citationUrl}\uE201 before retrying.`,
      'Internal marker \uE200navlist\uE202turn0search1\uE201',
    ].join('\n\n');
    const withCitationToken: Conversation = {
      ...conversation,
      messages: conversation.messages.map(message => message.role === 'ai' ? {
        ...message,
        rawContent: rawTokenContent,
        annotations: undefined,
      } : message),
    };

    const markdown = conversationToMarkdown(withCitationToken, { exportedAt: 1_700_000_000_000 });
    const plainText = conversationToPlainText(withCitationToken);
    for (const humanReadable of [markdown, plainText]) {
      expect(humanReadable).toContain(`[windowsforum.com](${citationUrl})`);
      expect(humanReadable).not.toMatch(/[\uE200-\uE20F]/);
      expect(humanReadable).not.toContain('navlist');
      expect(humanReadable).not.toContain('turn0search1');
    }

    const json = JSON.parse(conversationToJSON(withCitationToken, { exportedAt: 500 })) as {
      conversation: { messages: Array<{ role: string; raw_content: string }> };
    };
    expect(json.conversation.messages.find(message => message.role === 'ai')?.raw_content).toBe(rawTokenContent);
  });

  it('creates a deterministic speaker-labelled plain-text transcript', () => {
    expect(conversationToPlainText(conversation)).toBe([
      'Fix Wi-Fi / DNS',
      '',
      'You',
      '',
      'Why is DNS failing?',
      '',
      'WindowsForum AI',
      '',
      'Try `Resolve-DnsName` first.',
      '',
    ].join('\n'));
  });

  it('emits a versioned JSON document suitable for a future local import', () => {
    const json = JSON.parse(conversationToJSON(conversation, { exportedAt: 500 })) as {
      schema: string;
      exported_at: number;
      conversation: { id: string; messages: Array<Record<string, unknown>> };
    };
    expect(json).toMatchObject({
      schema: 'windowsforum-ai-conversation',
      exported_at: 500,
      conversation: { id: 'conv_private_1' },
    });
    expect(json.conversation.messages[1]).toMatchObject({
      id: 'message_2',
      role: 'ai',
      raw_content: 'Try `Resolve-DnsName` first.',
      response_id: 'resp_2',
      turn_id: 'turn_2',
      activities: [{ id: 'search_1', label: 'Searching the web', state: 'done' }],
      attachments: [{ id: 'attachment_1', name: 'ipconfig.txt', mime: 'text/plain', size: 42 }],
    });
  });

  it('uses a safe deterministic file name', () => {
    const artifact = createConversationExport(conversation, 'markdown', {
      exportedAt: Date.UTC(2026, 7, 19),
    });
    expect(artifact.filename).toBe('fix-wi-fi-dns-2026-08-19.md');
    expect(artifact.mimeType).toBe('text/markdown;charset=utf-8');
  });

  it('creates deterministic collection exports in the supplied conversation order', () => {
    const exportedAt = Date.UTC(2026, 7, 19);
    const secondConversation: Conversation = {
      ...conversation,
      id: 'conv_private_2',
      title: '../ Event Viewer: follow-up?',
      createdAt: 300,
      updatedAt: 400,
      messages: conversation.messages.map(message => message.role === 'ai' ? {
        ...message,
        rawContent: [
          'Open Event Viewer and inspect the System log.',
          '',
          '### Sources',
          '- [example.com](https://example.com/dns/?utm_source=assistant)',
        ].join('\n'),
        annotations: [
          { type: 'url_citation', title: 'DNS guide', url: 'https://example.com/dns?gclid=duplicate' },
        ],
      } : message),
    };
    const selected = [secondConversation, conversation];

    const markdown = createConversationCollectionExport(selected, 'markdown', { exportedAt });
    const expectedMarkdown = selected
      .map(item => conversationToMarkdown(item, { exportedAt }).trim())
      .join('\n\n---\n\n') + '\n';
    expect(markdown.content).toBe(expectedMarkdown);
    expect(markdown.content.indexOf('# ../ Event Viewer: follow-up?'))
      .toBeLessThan(markdown.content.indexOf('# Fix Wi-Fi / DNS'));
    expect(markdown.content.match(/https:\/\/example\.com\/dns/g)).toHaveLength(2);
    expect(markdown.filename).toBe('windowsforum-ai-chats-2026-08-19.md');
    expect(markdown.filename).toMatch(/^[a-z0-9.-]+$/);
    expect(markdown.mimeType).toBe('text/markdown;charset=utf-8');

    const repeated = createConversationCollectionExport(selected, 'markdown', { exportedAt });
    expect(repeated).toMatchObject({
      content: markdown.content,
      filename: markdown.filename,
      mimeType: markdown.mimeType,
    });
  });

  it('uses the single-export JSON projection for every collection member', () => {
    const exportedAt = 1_700_000_000_000;
    const secondConversation: Conversation = {
      ...conversation,
      id: 'conv_private_2',
      title: 'Second conversation',
      createdAt: 300,
      updatedAt: 400,
    };
    const selected = [conversation, secondConversation];
    const artifact = createConversationCollectionExport(selected, 'json', { exportedAt });
    const document = JSON.parse(artifact.content) as {
      schema: string;
      version: number;
      exported_at: number;
      conversations: unknown[];
    };
    const singleRecords = selected.map(item => (
      (JSON.parse(conversationToJSON(item, { exportedAt })) as { conversation: unknown }).conversation
    ));

    expect(document).toEqual({
      schema: 'windowsforum-ai-conversation-collection',
      version: 1,
      exported_at: exportedAt,
      conversations: singleRecords,
    });
    expect(artifact.filename).toBe('windowsforum-ai-chats-2023-11-14.json');
    expect(artifact.mimeType).toBe('application/json;charset=utf-8');
    expect(artifact.content.endsWith('\n')).toBe(true);
  });

  it('prefers native file sharing when the platform accepts files', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const targetNavigator = {
      canShare: vi.fn().mockReturnValue(true),
      share,
    } as unknown as Navigator;

    await expect(shareConversationPrivately(conversation, {
      navigator: targetNavigator,
      exportedAt: 500,
    })).resolves.toBe('web-share-file');
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: conversation.title,
      files: [expect.any(File)],
    }));
  });

  it('downloads locally when Web Share is unavailable', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:private-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await expect(shareConversationPrivately(conversation, {
      navigator: {} as Navigator,
      document,
      exportedAt: 500,
    })).resolves.toBe('download');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-export');
  });

  it('does not download when the user cancels the share sheet', async () => {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    const targetNavigator = {
      canShare: vi.fn().mockReturnValue(false),
      share: vi.fn().mockRejectedValue(error),
    } as unknown as Navigator;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await expect(shareConversationPrivately(conversation, {
      navigator: targetNavigator,
      document,
    })).resolves.toBe('cancelled');
    expect(click).not.toHaveBeenCalled();
  });
});
