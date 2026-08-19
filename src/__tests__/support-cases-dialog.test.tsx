import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const apiMocks = vi.hoisted(() => ({
  listSupportCases: vi.fn(),
  getSupportCase: vi.fn(),
  upsertSupportCase: vi.fn(),
  deleteSupportCase: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    ChatAPI: {
      ...actual.ChatAPI,
      listSupportCases: apiMocks.listSupportCases,
      getSupportCase: apiMocks.getSupportCase,
      upsertSupportCase: apiMocks.upsertSupportCase,
      deleteSupportCase: apiMocks.deleteSupportCase,
    },
  };
});

import { APIError } from '../services/api';
import type { SupportCase } from '../services/api';
import { SupportCasesDialog } from '../components/SupportCasesDialog';
import { buildSupportCaseBBCode } from '../components/supportCaseFormat';

const theme = createTheme();
const writeText = vi.fn();
let mobileViewport = false;
const mediaQueryLists: Array<MediaQueryList & {
  listeners: Set<(event: MediaQueryListEvent) => void>;
}> = [];

const setMobileViewport = (matches: boolean) => {
  mobileViewport = matches;
  for (const queryList of mediaQueryLists) {
    Object.defineProperty(queryList, 'matches', { configurable: true, value: matches });
    const event = { matches, media: queryList.media } as MediaQueryListEvent;
    queryList.listeners.forEach(listener => listener(event));
  }
};

const supportCase = (overrides: Partial<SupportCase> = {}): SupportCase => ({
  id: 'case_1234567890abcdef1234567890abcdef',
  title: 'Blue screen after update',
  description: 'The PC restarts after signing in.',
  status: 'open',
  pc_profile: { os_name: 'Windows 11', memory_gb: 32 },
  conversation_ids: ['conv_saved'],
  attachment_ids: ['att_1234567890abcdef1234567890abcdef'],
  revision: 3,
  created_at: 1_780_000_000_000,
  updated_at: 1_780_000_100_000,
  ...overrides,
});

const renderDialog = (props: Partial<React.ComponentProps<typeof SupportCasesDialog>> = {}) => render(
  <ThemeProvider theme={theme}>
    <SupportCasesDialog
      open
      onClose={vi.fn()}
      signedIn
      currentConversationId="conv_current"
      attachmentIds={['att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']}
      {...props}
    />
  </ThemeProvider>,
);

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      const queryList = {
        matches: mobileViewport,
        media: query,
        onchange: null,
        listeners,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          if (typeof listener === 'function') listeners.add(listener as (event: MediaQueryListEvent) => void);
        },
        removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          if (typeof listener === 'function') listeners.delete(listener as (event: MediaQueryListEvent) => void);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList & { listeners: Set<(event: MediaQueryListEvent) => void> };
      mediaQueryLists.push(queryList);
      return queryList;
    }),
  });
});

beforeEach(() => {
  mobileViewport = false;
  mediaQueryLists.length = 0;
  apiMocks.listSupportCases.mockReset().mockResolvedValue({ success: true, cases: [], next_cursor: null });
  apiMocks.getSupportCase.mockReset();
  apiMocks.upsertSupportCase.mockReset();
  apiMocks.deleteSupportCase.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => cleanup());

describe('SupportCasesDialog', () => {
  it('creates a structured case with the current conversation, attachments, and PC profile', async () => {
    const created = supportCase({
      id: 'case_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'Wi-Fi drops',
      description: 'Wi-Fi disconnects after sleep.',
      pc_profile: { os_name: 'Windows 11', memory_gb: 16 },
      conversation_ids: ['conv_current'],
      attachment_ids: ['att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      revision: 1,
    });
    apiMocks.upsertSupportCase.mockResolvedValue({ success: true, case: created });
    const onCasesChange = vi.fn();
    renderDialog({ onCasesChange });

    expect(await screen.findByText('No support cases yet')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'New support case' })[0]!);
    fireEvent.change(screen.getByLabelText(/Case title/), { target: { value: 'Wi-Fi drops' } });
    fireEvent.change(screen.getByLabelText(/Problem description/), {
      target: { value: 'Wi-Fi disconnects after sleep.' },
    });
    expect(screen.getByRole('checkbox', { name: 'Link the current AI conversation' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Link 1 current attachment' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /PC profile/ }));
    fireEvent.change(screen.getByLabelText('Operating system'), { target: { value: 'Windows 11' } });
    fireEvent.change(screen.getByLabelText('Memory (GB)'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create case' }));

    await waitFor(() => expect(apiMocks.upsertSupportCase).toHaveBeenCalledTimes(1));
    expect(apiMocks.upsertSupportCase).toHaveBeenCalledWith({
      title: 'Wi-Fi drops',
      description: 'Wi-Fi disconnects after sleep.',
      status: 'open',
      pc_profile: { os_name: 'Windows 11', memory_gb: 16 },
      conversation_ids: ['conv_current'],
      attachment_ids: ['att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    }, 0, { signal: expect.any(AbortSignal) });
    expect(await screen.findByText(/Revision 1/)).toBeInTheDocument();
    expect(onCasesChange).toHaveBeenLastCalledWith([created]);
  });

  it('archives with the current revision and never performs a blind overwrite', async () => {
    const existing = supportCase();
    const archived = supportCase({ status: 'archived', revision: 4, updated_at: existing.updated_at + 1 });
    apiMocks.listSupportCases.mockResolvedValue({ success: true, cases: [existing], next_cursor: null });
    apiMocks.upsertSupportCase.mockResolvedValue({ success: true, case: archived });
    renderDialog();

    expect(await screen.findByText(/Revision 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive case' }));

    await waitFor(() => expect(apiMocks.upsertSupportCase).toHaveBeenCalledTimes(1));
    expect(apiMocks.upsertSupportCase.mock.calls[0]?.[0]).toMatchObject({
      id: existing.id,
      status: 'archived',
      created_at: existing.created_at,
    });
    expect(apiMocks.upsertSupportCase.mock.calls[0]?.[1]).toBe(3);
    expect(await screen.findByText(/Revision 4/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive case' })).not.toBeInTheDocument();
  });

  it('offers a deliberate reload when a revision conflict is returned', async () => {
    const existing = supportCase();
    const latest = supportCase({
      title: 'Updated elsewhere',
      description: 'The latest description from another device.',
      revision: 4,
      updated_at: existing.updated_at + 100,
    });
    apiMocks.listSupportCases.mockResolvedValue({ success: true, cases: [existing], next_cursor: null });
    apiMocks.upsertSupportCase.mockRejectedValue(new APIError('Revision conflict.', {
      status: 409,
      code: 'revision_conflict',
    }));
    apiMocks.getSupportCase.mockResolvedValue({ success: true, case: latest });
    renderDialog();

    expect(await screen.findByDisplayValue(existing.title)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Case title/), { target: { value: 'My stale edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('changed in another tab or device');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));

    expect(await screen.findByDisplayValue('Updated elsewhere')).toBeInTheDocument();
    expect(screen.getByDisplayValue('The latest description from another device.')).toBeInTheDocument();
    expect(apiMocks.getSupportCase).toHaveBeenCalledWith(existing.id, { signal: expect.any(AbortSignal) });
  });

  it('requires confirmation before revision-safe deletion', async () => {
    const existing = supportCase();
    apiMocks.listSupportCases.mockResolvedValue({ success: true, cases: [existing], next_cursor: null });
    apiMocks.deleteSupportCase.mockResolvedValue({ success: true });
    renderDialog();

    expect(await screen.findByText(/Revision 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete case' }));
    const confirmation = screen.getByRole('dialog', { name: 'Delete this support case?' });
    expect(within(confirmation).getByText(/does not delete the original AI conversation/)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete case' }));

    await waitFor(() => expect(apiMocks.deleteSupportCase).toHaveBeenCalledWith(
      existing.id,
      existing.revision,
      { signal: expect.any(AbortSignal) },
    ));
    expect(await screen.findByText('No support cases yet')).toBeInTheDocument();
  });

  it('copies a reviewed BBCode draft without any automatic forum action', async () => {
    const existing = supportCase({ title: 'Unsafe [B]title[/B]' });
    apiMocks.listSupportCases.mockResolvedValue({ success: true, cases: [existing], next_cursor: null });
    const onForumHandoffCopied = vi.fn();
    renderDialog({ onForumHandoffCopied });

    expect(await screen.findByText(/Revision 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Review forum handoff/ }));
    const preview = screen.getByLabelText<HTMLTextAreaElement>('Forum BBCode preview');
    expect(preview.value).toContain('Unsafe ［B］title［/B］');
    fireEvent.click(screen.getByRole('button', { name: 'Copy reviewed BBCode' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('[B]Problem description[/B]');
    expect(onForumHandoffCopied).toHaveBeenCalledWith(existing, writeText.mock.calls[0]?.[0]);
    expect(screen.getByText('Copied. Nothing was posted automatically.')).toBeInTheDocument();
    expect(apiMocks.upsertSupportCase).not.toHaveBeenCalled();
  });

  it('shows a member-only explanation without loading private case data for guests', () => {
    renderDialog({ signedIn: false });
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to create private support cases');
    expect(apiMocks.listSupportCases).not.toHaveBeenCalled();
  });

  it('uses a list-first, back-navigable workflow on mobile', async () => {
    mobileViewport = true;
    const existing = supportCase();
    apiMocks.listSupportCases.mockResolvedValue({ success: true, cases: [existing], next_cursor: null });
    renderDialog();

    const caseRow = await screen.findByRole('button', { name: /Blue screen after update/ });
    expect(screen.queryByText(/Revision 3/)).not.toBeInTheDocument();
    fireEvent.click(caseRow);
    expect(await screen.findByLabelText('Back to support case list')).toBeInTheDocument();
    expect(screen.getByText(/Revision 3/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Back to support case list'));
    expect(await screen.findByRole('button', { name: /Blue screen after update/ })).toBeInTheDocument();
    expect(screen.queryByText(/Revision 3/)).not.toBeInTheDocument();
  });

  it('preserves a dirty editor without reloading when the breakpoint changes', async () => {
    const existing = supportCase();
    apiMocks.listSupportCases.mockResolvedValue({ success: true, cases: [existing], next_cursor: null });
    renderDialog();

    const title = await screen.findByLabelText('Case title');
    fireEvent.change(title, { target: { value: 'Unsaved breakpoint edit' } });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    act(() => setMobileViewport(true));

    expect(await screen.findByDisplayValue('Unsaved breakpoint edit')).toBeInTheDocument();
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    expect(apiMocks.listSupportCases).toHaveBeenCalledTimes(1);
  });
});

describe('buildSupportCaseBBCode', () => {
  it('includes structured diagnostics and neutralizes user-supplied BBCode brackets', () => {
    const bbcode = buildSupportCaseBBCode(supportCase({
      description: 'Crash after [URL=https://example.com]click[/URL]',
      pc_profile: { os_name: 'Windows 11', cpu: 'Ryzen 9', memory_gb: 64 },
    }));
    expect(bbcode).toContain('Operating system: Windows 11');
    expect(bbcode).toContain('Processor: Ryzen 9');
    expect(bbcode).toContain('Memory (GB): 64');
    expect(bbcode).toContain('Crash after ［URL=https://example.com］click［/URL］');
    expect(bbcode).toContain('conv_saved');
  });
});
