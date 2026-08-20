import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import axe from 'axe-core';
import type { Conversation } from '../types';

const mocks = vi.hoisted(() => ({
  create: vi.fn((_: readonly Conversation[], format: 'markdown' | 'json') => ({
    format,
    filename: `windowsforum-ai-chats.${format === 'markdown' ? 'md' : 'json'}`,
    mimeType: format === 'markdown' ? 'text/markdown' : 'application/json',
    content: format,
    blob: new Blob([format]),
  })),
  download: vi.fn(),
}));

vi.mock('../services/conversationExport', () => ({
  createConversationCollectionExport: mocks.create,
  downloadConversationExport: mocks.download,
}));

import { ExportConversationCollectionDialog } from '../components/ExportConversationCollectionDialog';

const theme = createTheme();
const conversations: Conversation[] = [
  {
    id: 'conv_export_1',
    title: 'Printer repair',
    createdAt: 100,
    updatedAt: 200,
    messages: [
      { id: 'message_1', role: 'user', rawContent: 'The printer is offline.', timestamp: 110 },
      { id: 'message_2', role: 'ai', rawContent: 'Restart the spooler.', timestamp: 120 },
    ],
  },
  {
    id: 'conv_export_2',
    title: 'Wi-Fi repair',
    createdAt: 300,
    updatedAt: 400,
    messages: [
      { id: 'message_3', role: 'user', rawContent: 'Wi-Fi disconnects.', timestamp: 310 },
      { id: 'message_4', role: 'ai', rawContent: 'Update the adapter driver.', timestamp: 320 },
    ],
  },
];

interface DialogHarnessProps {
  open?: boolean;
  selected?: readonly Conversation[];
  onClose?: () => void;
  onCompleted?: (outcome: { format: 'markdown' | 'json'; conversationCount: number }) => void;
}

const dialog = ({
  open = true,
  selected = conversations,
  onClose = vi.fn(),
  onCompleted,
}: DialogHarnessProps = {}) => (
  <ThemeProvider theme={theme}>
    <ExportConversationCollectionDialog
      open={open}
      conversations={selected}
      onClose={onClose}
      onCompleted={onCompleted}
    />
  </ThemeProvider>
);

beforeEach(() => {
  mocks.create.mockClear();
  mocks.download.mockReset();
  const chatWindow = document.createElement('div');
  chatWindow.id = 'wf-chat-window';
  document.body.append(chatWindow);
});

afterEach(() => {
  cleanup();
  document.getElementById('wf-chat-window')?.remove();
  vi.restoreAllMocks();
});

describe('ExportConversationCollectionDialog', () => {
  it('downloads each format and reports only low-cardinality completion metadata', () => {
    const onClose = vi.fn();
    const onCompleted = vi.fn();
    const { rerender } = render(dialog({ onClose, onCompleted }));

    fireEvent.click(screen.getByRole('button', { name: /Download Markdown/ }));
    expect(mocks.create).toHaveBeenCalledWith(conversations, 'markdown');
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(onCompleted).toHaveBeenCalledWith({ format: 'markdown', conversationCount: 2 });
    expect(Object.keys(onCompleted.mock.calls[0]?.[0] ?? {})).toEqual(['format', 'conversationCount']);
    expect(onClose).toHaveBeenCalledOnce();

    rerender(dialog({ onClose, onCompleted }));
    fireEvent.click(screen.getByRole('button', { name: /Download JSON/ }));
    expect(mocks.create).toHaveBeenLastCalledWith(conversations, 'json');
    expect(onCompleted).toHaveBeenLastCalledWith({ format: 'json', conversationCount: 2 });
  });

  it('does not let an optional completion callback reverse a finished download', () => {
    const onClose = vi.fn();
    render(dialog({
      onClose,
      onCompleted: () => { throw new Error('telemetry unavailable'); },
    }));

    fireEvent.click(screen.getByRole('button', { name: /Download Markdown/ }));
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a download failure once and starts clean when reopened', async () => {
    mocks.download.mockImplementationOnce(() => { throw new Error('blocked'); });
    const { rerender } = render(dialog());

    fireEvent.click(screen.getByRole('button', { name: /Download Markdown/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be exported');

    rerender(dialog({ open: false }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(dialog({ open: true }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Download Markdown/ }));
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it('explains an empty selection and disables both download actions', () => {
    render(dialog({ selected: [] }));

    expect(screen.getByRole('status')).toHaveTextContent('Select at least one chat');
    expect(screen.getByRole('button', { name: /Download Markdown/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Download JSON/ })).toBeDisabled();
  });

  it('has no automated accessibility violations', async () => {
    render(dialog());
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });
});
