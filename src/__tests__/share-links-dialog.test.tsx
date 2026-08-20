import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import axe from 'axe-core';

const apiMocks = vi.hoisted(() => ({
  listConversationShares: vi.fn(),
  createConversationShare: vi.fn(),
  revokeConversationShare: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    ChatAPI: {
      ...actual.ChatAPI,
      listConversationShares: apiMocks.listConversationShares,
      createConversationShare: apiMocks.createConversationShare,
      revokeConversationShare: apiMocks.revokeConversationShare,
    },
  };
});

import { APIError } from '../services/api';
import type { ConversationShareListItem } from '../services/api';
import { ShareLinksDialog } from '../components/ShareLinksDialog';

const theme = createTheme();
const writeText = vi.fn();
let mobileViewport = false;
const now = 1_787_000_000_000;

const share = (
  id: string,
  overrides: Partial<ConversationShareListItem> = {},
): ConversationShareListItem => ({
  id,
  client_conversation_id: 'conv_saved',
  source_revision: 4,
  created_at: now - 10_000,
  expires_at: now + 86_400_000,
  revoked_at: null,
  ...overrides,
});

const renderDialog = (props: Partial<React.ComponentProps<typeof ShareLinksDialog>> = {}) => render(
  <ThemeProvider theme={theme}>
    <ShareLinksDialog
      open
      onClose={vi.fn()}
      signedIn
      conversationId="conv_saved"
      conversationTitle="Printer repair"
      conversationRevision={4}
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
  vi.spyOn(Date, 'now').mockReturnValue(now);
  apiMocks.listConversationShares.mockReset().mockResolvedValue({
    success: true,
    shares: [],
    next_cursor: null,
  });
  apiMocks.createConversationShare.mockReset();
  apiMocks.revokeConversationShare.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('ShareLinksDialog', () => {
  it('loads a conversation-scoped inventory and labels every lifecycle state', async () => {
    apiMocks.listConversationShares.mockResolvedValue({
      success: true,
      shares: [
        share('share_active'),
        share('share_expired', { expires_at: now - 1 }),
        share('share_revoked', { revoked_at: now - 500 }),
      ],
      next_cursor: null,
    });
    renderDialog();

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(apiMocks.listConversationShares).toHaveBeenCalledWith({
      limit: 30,
      conversationId: 'conv_saved',
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByText(/token URLs are intentionally absent/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be recovered/i)).toBeInTheDocument();
  });

  it('keeps existing links manageable while the current revision is still syncing', async () => {
    const active = share('share_active');
    apiMocks.listConversationShares.mockResolvedValue({
      success: true,
      shares: [active],
      next_cursor: null,
    });
    apiMocks.revokeConversationShare.mockResolvedValue({ success: true });
    const onSharesChange = vi.fn();
    renderDialog({ conversationRevision: undefined, onSharesChange });

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/remain manageable while this conversation syncs/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirmation = screen.getByRole('dialog', { name: 'Revoke this share link?' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Revoke link' }));

    await waitFor(() => expect(apiMocks.revokeConversationShare).toHaveBeenCalledWith(
      active.id,
      { signal: expect.any(AbortSignal) },
    ));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(onSharesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: active.id, revoked_at: now }),
    ]);
  });

  it('creates a revision-bound link and discloses its token URL only in the new-link notice', async () => {
    apiMocks.createConversationShare.mockResolvedValue({
      success: true,
      share: {
        id: 'share_new',
        token: 'token_abcdefghijklmnopqrstuvwxyz123456',
        expires_at: now + 604_800_000,
      },
    });
    const onShareCreated = vi.fn();
    renderDialog({ onShareCreated });
    expect(await screen.findByText('No share links yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(apiMocks.createConversationShare).toHaveBeenCalledWith(
      'conv_saved',
      4,
      { expiresIn: 604_800, signal: expect.any(AbortSignal) },
    ));
    const expectedURL = 'https://windowsforum.com/pages/ai/#share=token_abcdefghijklmnopqrstuvwxyz123456';
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedURL));
    expect(screen.getByLabelText('New share URL')).toHaveValue(expectedURL);
    expect(screen.getByText(/disclosed only now/i)).toBeInTheDocument();
    expect(onShareCreated).toHaveBeenCalledWith('share_new');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByLabelText('New share URL')).not.toBeInTheDocument();
    expect(screen.queryByText(expectedURL)).not.toBeInTheDocument();
  });

  it('paginates older links and reloads after a list error', async () => {
    apiMocks.listConversationShares
      .mockResolvedValueOnce({ success: true, shares: [share('share_first')], next_cursor: 'next_1' })
      .mockRejectedValueOnce(new APIError('Temporary inventory error.', { status: 503, retryable: true }))
      .mockResolvedValueOnce({ success: true, shares: [share('share_fresh')], next_cursor: null });
    renderDialog();

    expect(await screen.findByText('Active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older links' }));
    expect(await screen.findByText('Temporary inventory error.')).toBeInTheDocument();
    expect(apiMocks.listConversationShares).toHaveBeenNthCalledWith(2, {
      limit: 30,
      cursor: 'next_1',
      conversationId: 'conv_saved',
      signal: expect.any(AbortSignal),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(apiMocks.listConversationShares).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Revision 4')).toBeInTheDocument();
  });

  it('does not call owner share APIs for a signed-out visitor', () => {
    renderDialog({ signedIn: false });
    expect(screen.getByText(/Sign in to create and manage share links/)).toBeInTheDocument();
    expect(apiMocks.listConversationShares).not.toHaveBeenCalled();
    expect(apiMocks.createConversationShare).not.toHaveBeenCalled();
  });

  it('uses the mobile dialog layout without automated accessibility violations', async () => {
    mobileViewport = true;
    renderDialog();
    expect(await screen.findByText('No share links yet')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Share links/ })).toHaveClass('MuiDialog-paperFullScreen');
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });
});
