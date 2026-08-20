import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { useState } from 'react';

const apiMocks = vi.hoisted(() => ({
  uploadChatAttachment: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    ChatAPI: {
      ...actual.ChatAPI,
      uploadChatAttachment: apiMocks.uploadChatAttachment,
    },
  };
});

import { AttachmentTray } from '../components/AttachmentTray';
import type { ChatAttachment } from '../services/api';

const theme = createTheme();

interface HarnessProps {
  initial?: ChatAttachment[];
  signedIn?: boolean;
  compact?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onRemoveAttachment?: (attachment: ChatAttachment) => void | Promise<void>;
}

const Harness = ({
  initial = [],
  signedIn = true,
  compact = false,
  onBusyChange,
  onRemoveAttachment,
}: HarnessProps) => {
  const [attachments, setAttachments] = useState(initial);
  return (
    <ThemeProvider theme={theme}>
      <div className={compact ? 'wf-composer-shell' : undefined}>
        <AttachmentTray
          compact={compact}
          signedIn={signedIn}
          conversationId="conv_current"
          attachments={attachments}
          onChange={setAttachments}
          onBusyChange={onBusyChange}
          onRemoveAttachment={onRemoveAttachment}
        />
        {compact && <textarea aria-label="Composer text" />}
      </div>
    </ThemeProvider>
  );
};

const attachment = (overrides: Partial<ChatAttachment> = {}): ChatAttachment => ({
  id: 'att_1234567890abcdef1234567890abcdef',
  name: 'report.txt',
  mime: 'text/plain',
  size: 12,
  expires_at: Date.now() + 60_000,
  ...overrides,
});

beforeEach(() => {
  apiMocks.uploadChatAttachment.mockReset();
});

afterEach(() => cleanup());

describe('AttachmentTray', () => {
  it('uploads supported files immediately and exposes only server-issued handles', async () => {
    const first = attachment();
    const second = attachment({
      id: 'att_abcdefabcdefabcdefabcdefabcdefab',
      name: 'screen.png',
      mime: 'image/png',
      size: 2048,
    });
    apiMocks.uploadChatAttachment
      .mockResolvedValueOnce({ success: true, attachment: first })
      .mockResolvedValueOnce({ success: true, attachment: second });
    const busyChanges = vi.fn();
    const { container } = render(<Harness onBusyChange={busyChanges} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    const files = [
      new File(['diagnostic'], 'report.txt', { type: 'text/plain' }),
      new File(['image'], 'screen.png', { type: 'image/png' }),
    ];
    fireEvent.change(input!, { target: { files } });

    expect(await screen.findByText(/report\.txt · 12 B/)).toBeInTheDocument();
    expect(await screen.findByText(/screen\.png · 2 KB/)).toBeInTheDocument();
    expect(apiMocks.uploadChatAttachment).toHaveBeenCalledTimes(2);
    expect(apiMocks.uploadChatAttachment).toHaveBeenNthCalledWith(1, files[0], expect.objectContaining({
      conversationId: 'conv_current',
      signal: expect.any(AbortSignal),
    }));
    expect(busyChanges).toHaveBeenNthCalledWith(1, true);
    expect(busyChanges).toHaveBeenLastCalledWith(false);
  });

  it('supports paste and drop while rejecting unsupported or oversized files locally', async () => {
    const pasted = attachment({ name: 'pasted.json', mime: 'application/json' });
    const dropped = attachment({
      id: 'att_ffffffffffffffffffffffffffffffff',
      name: 'dropped.webp',
      mime: 'image/webp',
    });
    apiMocks.uploadChatAttachment
      .mockResolvedValueOnce({ success: true, attachment: pasted })
      .mockResolvedValueOnce({ success: true, attachment: dropped });
    render(<Harness />);
    const region = screen.getByRole('region', { name: 'File attachment drop zone' });

    const pastedFile = new File(['{}'], 'pasted.json', { type: 'application/json' });
    fireEvent.paste(region, {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => pastedFile }],
      },
    });
    expect(await screen.findByText(/pasted\.json · 12 B/)).toBeInTheDocument();

    const droppedFile = new File(['image'], 'dropped.webp', { type: 'image/webp' });
    fireEvent.drop(region, { dataTransfer: { files: [droppedFile] } });
    expect(await screen.findByText(/dropped\.webp · 12 B/)).toBeInTheDocument();

    const unsupported = new File(['pdf'], 'manual.pdf', { type: 'application/pdf' });
    fireEvent.drop(region, { dataTransfer: { files: [unsupported] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('choose a JPG, PNG, WebP, TXT, CSV, or JSON');

    const oversized = new File(
      [new Uint8Array(1024 * 1024 + 1)],
      'oversized.txt',
      { type: 'text/plain' },
    );
    fireEvent.drop(region, { dataTransfer: { files: [oversized] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('text files must be 1 MB or smaller');
    expect(apiMocks.uploadChatAttachment).toHaveBeenCalledTimes(2);
  });

  it('shows truthful queue progress while an upload is pending', async () => {
    let finishUpload: ((value: { success: true; attachment: ChatAttachment }) => void) | undefined;
    apiMocks.uploadChatAttachment.mockImplementation(() => new Promise(resolve => {
      finishUpload = resolve;
    }));
    const { container } = render(<Harness />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, {
      target: { files: [new File(['log'], 'pending.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByText(/Uploading 1 of 1: pending\.txt/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Attachment upload progress' })).toHaveAttribute('aria-valuenow', '0');

    finishUpload?.({ success: true, attachment: attachment({ name: 'pending.txt' }) });
    expect(await screen.findByText(/pending\.txt · 12 B/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  });

  it('awaits server cleanup before removing a chip and preserves it on an in-use error', async () => {
    const onRemoveAttachment = vi.fn()
      .mockRejectedValueOnce(new Error('This file is linked to a support case.'))
      .mockResolvedValueOnce(undefined);
    render(<Harness initial={[attachment()]} onRemoveAttachment={onRemoveAttachment} />);

    fireEvent.click(screen.getByLabelText('Remove report.txt'));
    expect(await screen.findByRole('alert')).toHaveTextContent('linked to a support case');
    expect(screen.getByText(/report\.txt · 12 B/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove report.txt'));
    await waitFor(() => expect(screen.queryByText(/report\.txt · 12 B/)).not.toBeInTheDocument());
    expect(onRemoveAttachment).toHaveBeenCalledTimes(2);
  });

  it('keeps member-only controls unavailable to guests', () => {
    render(<Harness signedIn={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to attach');
    expect(screen.queryByRole('button', { name: 'Add files' })).not.toBeInTheDocument();
  });

  it('accepts paste and drop anywhere in the compact composer', async () => {
    apiMocks.uploadChatAttachment
      .mockResolvedValueOnce({ success: true, attachment: attachment({ name: 'pasted.png', mime: 'image/png' }) })
      .mockResolvedValueOnce({ success: true, attachment: attachment({ id: 'att_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'dropped.txt' }) });
    const { container } = render(<Harness compact />);
    const composer = container.querySelector<HTMLElement>('.wf-composer-shell')!;
    const textarea = screen.getByRole('textbox', { name: 'Composer text' });

    const pasted = new File(['image'], 'pasted.png', { type: 'image/png' });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { items: [{ kind: 'file', getAsFile: () => pasted }] },
    });
    textarea.dispatchEvent(pasteEvent);
    await waitFor(() => expect(apiMocks.uploadChatAttachment).toHaveBeenCalledWith(
      pasted,
      expect.objectContaining({ conversationId: 'conv_current' }),
    ));
    expect(await screen.findByLabelText('Attached files')).toHaveTextContent('pasted.png');

    const dropped = new File(['log'], 'dropped.txt', { type: 'text/plain' });
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [dropped] } });
    composer.dispatchEvent(dropEvent);
    expect(await screen.findByLabelText('Attached files')).toHaveTextContent('dropped.txt');
    expect(apiMocks.uploadChatAttachment).toHaveBeenCalledTimes(2);
  });

  it('keeps the maximum compact attachment set in one horizontally scrollable row', () => {
    const attachments = Array.from({ length: 8 }, (_, index) => attachment({
      id: `att_${String(index).padStart(32, 'a')}`,
      name: `long-diagnostic-file-${index}.txt`,
    }));
    render(<Harness compact initial={attachments} />);

    const row = screen.getByLabelText('Attached files');
    expect(row.children).toHaveLength(8);
    expect(window.getComputedStyle(row).flexWrap).toBe('nowrap');
    expect(window.getComputedStyle(row).overflowX).toBe('auto');
  });
});
