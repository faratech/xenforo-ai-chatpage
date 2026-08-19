import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import axe from 'axe-core';

const apiMocks = vi.hoisted(() => ({
  exportSavedChatData: vi.fn(),
  deleteAllSavedChatData: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    ChatAPI: {
      ...actual.ChatAPI,
      exportSavedChatData: apiMocks.exportSavedChatData,
      deleteAllSavedChatData: apiMocks.deleteAllSavedChatData,
    },
  };
});

import {
  ACCOUNT_DELETE_CONFIRMATION_PHRASE,
  AccountDataDialog,
} from '../components/AccountDataDialog';
import {
  canonicalConversationShareUrl,
  createAccountDataArtifact,
} from '../components/managementDialogHelpers';

const theme = createTheme();
const generatedAt = 1_787_123_456_000;
let mobileViewport = false;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let anchorClick: ReturnType<typeof vi.spyOn>;

const exportPayload = {
  version: 1 as const,
  scope: 'saved_chat_product_data' as const,
  generated_at: generatedAt,
  conversations: [],
  feedback: [],
  attachments: [],
  shares: [],
  support_cases: [],
};

const deleteResult = {
  success: true as const,
  deleted_scope: 'saved_chat_product_data' as const,
  attachment_files_deleted: 2,
  attachment_files_deferred: 0,
  deletion_guards_retained: 3,
  deletion_guard_expires_at: 1_818_659_200_000,
  deletion_guard_max_retention_days: 365 as const,
};

const renderDialog = (props: Partial<React.ComponentProps<typeof AccountDataDialog>> = {}) => render(
  <ThemeProvider theme={theme}>
    <AccountDataDialog
      open
      onClose={vi.fn()}
      signedIn
      onDeleteAllSucceeded={vi.fn()}
      {...props}
    />
  </ThemeProvider>,
);

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mobileViewport,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  mobileViewport = false;
  apiMocks.exportSavedChatData.mockReset();
  apiMocks.deleteAllSavedChatData.mockReset();
  createObjectURL = vi.fn().mockReturnValue('blob:account-export');
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('AccountDataDialog', () => {
  it('downloads the exact server export as a dated JSON artifact', async () => {
    apiMocks.exportSavedChatData.mockResolvedValue({ success: true, export: exportPayload });
    const onExportDownloaded = vi.fn();
    renderDialog({ onExportDownloaded });

    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }));

    await waitFor(() => expect(apiMocks.exportSavedChatData).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:account-export');
    expect(onExportDownloaded).toHaveBeenCalledWith(generatedAt);
    expect(await screen.findByRole('status')).toHaveTextContent('export was downloaded');
  });

  it('requires the exact phrase and clears local data only after server success', async () => {
    let resolveDelete: ((value: typeof deleteResult) => void) | undefined;
    const order: string[] = [];
    apiMocks.deleteAllSavedChatData.mockImplementation(() => {
      order.push('server');
      return new Promise(resolve => { resolveDelete = resolve; });
    });
    const onDeleteAllStarting = vi.fn().mockImplementation(() => { order.push('pause'); });
    const onDeleteAllSucceeded = vi.fn().mockImplementation(() => { order.push('local-reset'); });
    const onDeleteAllFinished = vi.fn().mockImplementation(() => { order.push('resume'); });
    renderDialog({ onDeleteAllStarting, onDeleteAllSucceeded, onDeleteAllFinished });

    expect(apiMocks.deleteAllSavedChatData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));
    const confirmationDialog = screen.getByRole('dialog', { name: 'Permanently delete saved chat data?' });
    const confirmButton = within(confirmationDialog).getByRole('button', { name: 'Delete saved data' });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(within(confirmationDialog).getByLabelText('Confirmation phrase'), {
      target: { value: 'delete saved chat data' },
    });
    expect(confirmButton).toBeDisabled();
    expect(within(confirmationDialog).getByText('The phrase must match exactly.')).toBeInTheDocument();

    fireEvent.change(within(confirmationDialog).getByLabelText('Confirmation phrase'), {
      target: { value: ACCOUNT_DELETE_CONFIRMATION_PHRASE },
    });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(apiMocks.deleteAllSavedChatData).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) }));
    expect(order).toEqual(['pause', 'server']);
    expect(onDeleteAllSucceeded).not.toHaveBeenCalled();

    resolveDelete?.(deleteResult);
    await waitFor(() => expect(onDeleteAllSucceeded).toHaveBeenCalledWith(deleteResult));
    await waitFor(() => expect(onDeleteAllFinished).toHaveBeenCalledWith(true));
    expect(order).toEqual(['pause', 'server', 'local-reset', 'resume']);
    expect(await screen.findByRole('status')).toHaveTextContent('deleted from the server and this browser');
  });

  it('never invokes local cleanup when the server deletion fails', async () => {
    apiMocks.deleteAllSavedChatData.mockRejectedValue(new Error('Deletion service unavailable.'));
    const onDeleteAllSucceeded = vi.fn();
    const onDeleteAllFinished = vi.fn();
    renderDialog({ onDeleteAllSucceeded, onDeleteAllFinished });

    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));
    const confirmationDialog = screen.getByRole('dialog', { name: 'Permanently delete saved chat data?' });
    fireEvent.change(within(confirmationDialog).getByLabelText('Confirmation phrase'), {
      target: { value: ACCOUNT_DELETE_CONFIRMATION_PHRASE },
    });
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Delete saved data' }));

    expect(await within(confirmationDialog).findByText('Deletion service unavailable.')).toBeInTheDocument();
    expect(onDeleteAllSucceeded).not.toHaveBeenCalled();
    expect(onDeleteAllFinished).toHaveBeenCalledWith(false);
  });

  it('distinguishes a post-success local cleanup failure from a server failure', async () => {
    apiMocks.deleteAllSavedChatData.mockResolvedValue({
      ...deleteResult,
      attachment_files_deferred: 1,
    });
    const onDeleteAllSucceeded = vi.fn().mockRejectedValue(new Error('Browser storage is locked.'));
    renderDialog({ onDeleteAllSucceeded });

    fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }));
    const confirmationDialog = screen.getByRole('dialog', { name: 'Permanently delete saved chat data?' });
    fireEvent.change(within(confirmationDialog).getByLabelText('Confirmation phrase'), {
      target: { value: ACCOUNT_DELETE_CONFIRMATION_PHRASE },
    });
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Delete saved data' }));

    await waitFor(() => expect(onDeleteAllSucceeded).toHaveBeenCalledTimes(1));
    expect(within(confirmationDialog).getByText(/Saved server data was deleted/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete saved data' })).toBeDisabled();
  });

  it('states the separate provider cleanup and exposes no actions when signed out', () => {
    renderDialog({ signedIn: false });
    expect(screen.getByText(/Sign in to export or delete/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download JSON' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete all data' })).not.toBeInTheDocument();
    expect(apiMocks.exportSavedChatData).not.toHaveBeenCalled();
    expect(apiMocks.deleteAllSavedChatData).not.toHaveBeenCalled();
  });

  it('discloses the content-free stale-device deletion guard', () => {
    renderDialog();
    expect(screen.getByText(/one-way conversation ID hashes for up to 365 days/)).toBeInTheDocument();
    expect(screen.getByText(/contain no raw conversation ID, title, or message text/)).toBeInTheDocument();
  });

  it('builds stable account filenames and canonical share URLs', () => {
    const artifact = createAccountDataArtifact(exportPayload, generatedAt);
    expect(artifact.filename).toBe('windowsforum-ai-data-2026-08-19.json');
    expect(JSON.parse(artifact.content)).toEqual(exportPayload);
    expect(canonicalConversationShareUrl('token_value', 'https://windowsforum.com')).toBe(
      'https://windowsforum.com/pages/ai/?share=token_value',
    );
  });

  it('uses the mobile dialog layout without automated accessibility violations', async () => {
    mobileViewport = true;
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: /Your AI chat data/ });
    expect(dialog).toHaveClass('MuiDialog-paperFullScreen');
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });
});
