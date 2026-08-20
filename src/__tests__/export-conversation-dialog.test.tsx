import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import axe from 'axe-core';
import type { Conversation } from '../types';

const mocks = vi.hoisted(() => ({
  create: vi.fn((_: Conversation, format: 'markdown' | 'json') => ({
    format,
    filename: `conversation.${format === 'markdown' ? 'md' : 'json'}`,
    mimeType: 'text/plain',
    content: format,
    blob: new Blob([format]),
  })),
  download: vi.fn(),
  share: vi.fn().mockResolvedValue('web-share-file'),
  writeClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/conversationExport', () => ({
  conversationToPlainText: (target: Conversation) => `${target.title}\n\nYou\n\n${target.messages[0]?.rawContent}\n\nWindowsForum AI\n\n${target.messages[1]?.rawContent}\n`,
  createConversationExport: mocks.create,
  downloadConversationExport: mocks.download,
  shareConversationPrivately: mocks.share,
}));

vi.mock('../components/managementDialogHelpers', () => ({
  writeClipboardText: mocks.writeClipboard,
}));

import { ExportConversationDialog } from '../components/ExportConversationDialog';

const theme = createTheme();
const conversation: Conversation = {
  id: 'conv_export',
  title: 'Printer repair',
  createdAt: 100,
  updatedAt: 200,
  messages: [
    { id: 'message_1', role: 'user', rawContent: 'The printer is offline.', timestamp: 110 },
    { id: 'message_2', role: 'ai', rawContent: 'Restart the spooler.', timestamp: 120 },
  ],
};

const renderDialog = (props: Partial<React.ComponentProps<typeof ExportConversationDialog>> = {}) => render(
  <ThemeProvider theme={theme}>
    <ExportConversationDialog
      open
      onClose={vi.fn()}
      conversation={conversation}
      {...props}
    />
  </ThemeProvider>,
);

beforeEach(() => {
  mocks.create.mockClear();
  mocks.download.mockClear();
  mocks.share.mockReset().mockResolvedValue('web-share-file');
  mocks.writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share');
  cleanup();
  vi.restoreAllMocks();
});

describe('ExportConversationDialog', () => {
  it('downloads Markdown and JSON through the existing export service', async () => {
    const onCompleted = vi.fn();
    renderDialog({ onCompleted });

    fireEvent.click(screen.getByRole('button', { name: /Download Markdown/ }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenNthCalledWith(1, conversation, 'markdown');
    expect(onCompleted).toHaveBeenCalledWith({
      action: 'download-markdown',
      format: 'markdown',
      delivery: 'download',
      messageCount: 2,
    });

    fireEvent.click(screen.getByRole('button', { name: /Download JSON/ }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
    expect(mocks.create).toHaveBeenNthCalledWith(2, conversation, 'json');
    expect(screen.getByRole('status')).toHaveTextContent('JSON download started.');
  });

  it('copies a speaker-labelled plain-text transcript', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Copy plain text/ }));

    await waitFor(() => expect(mocks.writeClipboard).toHaveBeenCalledWith(
      'Printer repair\n\nYou\n\nThe printer is offline.\n\nWindowsForum AI\n\nRestart the spooler.\n',
    ));
    expect(screen.getByRole('status')).toHaveTextContent('Conversation copied as plain text.');
  });

  it('uses native private sharing when the platform offers it', async () => {
    const onCompleted = vi.fn();
    renderDialog({ onCompleted });
    fireEvent.click(screen.getByRole('button', { name: /Share privately/ }));

    await waitFor(() => expect(mocks.share).toHaveBeenCalledWith(conversation, { format: 'markdown' }));
    expect(onCompleted).toHaveBeenCalledWith({
      action: 'native-share',
      format: 'markdown',
      delivery: 'web-share-file',
      messageCount: 2,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Your device share sheet opened.');
  });

  it('hides native sharing when unavailable and announces export errors', async () => {
    Reflect.deleteProperty(navigator, 'share');
    mocks.download.mockImplementationOnce(() => { throw new Error('Downloads are blocked.'); });
    renderDialog();

    expect(screen.queryByRole('button', { name: /Share privately/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Download Markdown/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Downloads are blocked.');
  });

  it('has no automated accessibility violations', async () => {
    renderDialog();
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });
});
