import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { useCallback, useRef, useState } from 'react';
import axe from 'axe-core';
import { ConversationSidebar } from '../components/ConversationSidebar';
import type { Conversation, ConversationSidebarProps } from '../types';

const theme = createTheme();
let mobileViewport = false;

const conversation = (
  id: string,
  title: string,
  content: string,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id,
  title,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [{
    id: `message_${id}`,
    role: 'user',
    rawContent: content,
    timestamp: Date.now(),
  }],
  ...overrides,
});

const baseConversations = [
  conversation('updates', 'Windows Update loop', 'The update failed. Update rollback restored the update service.'),
  conversation('network', 'Network troubleshooting', 'DNS resolution works, but the adapter disconnects.'),
  conversation('draft', 'Driver diagnostics', 'Collect the display driver version.', { draft: 'Unsent notes' }),
];

const withLibraryMetadata = (
  value: Conversation,
  metadata: { pinnedAt?: number; archivedAt?: number },
): Conversation => Object.assign(value, metadata);

interface HarnessProps extends Partial<ConversationSidebarProps> {
  initiallyOpen?: boolean;
  initiallyCollapsed?: boolean;
}

const Harness = ({
  initiallyOpen = false,
  initiallyCollapsed = false,
  conversations = baseConversations,
  currentConversationId = 'updates',
  onSelectConversation = vi.fn(),
  onDeleteConversation = vi.fn(),
  onNewConversation = vi.fn(),
  onRenameConversation,
  onPinConversation,
  onArchiveConversation,
  onBulkArchive,
  onBulkRestore,
  onBulkDelete,
  onBulkExport,
  onSearchUsed,
  onSearchResultOpened,
}: HarnessProps) => {
  const [open, setOpen] = useState(initiallyOpen);
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const onOpen = useCallback(() => setOpen(true), []);
  const onClose = useCallback(() => setOpen(false), []);
  const onToggleDesktopCollapsed = useCallback(() => setCollapsed(value => !value), []);

  return (
    <ThemeProvider theme={theme}>
      <div id="wf-chat-window">
        <ConversationSidebar
          open={open}
          onOpen={onOpen}
          onClose={onClose}
          conversations={conversations}
          currentConversationId={currentConversationId}
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
          onNewConversation={onNewConversation}
          onRenameConversation={onRenameConversation}
          onPinConversation={onPinConversation}
          onArchiveConversation={onArchiveConversation}
          onBulkArchive={onBulkArchive}
          onBulkRestore={onBulkRestore}
          onBulkDelete={onBulkDelete}
          onBulkExport={onBulkExport}
          desktopCollapsed={collapsed}
          onToggleDesktopCollapsed={onToggleDesktopCollapsed}
          onSearchUsed={onSearchUsed}
          onSearchResultOpened={onSearchResultOpened}
        />
      </div>
    </ThemeProvider>
  );
};

beforeEach(() => {
  mobileViewport = false;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: mobileViewport,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ConversationSidebar search', () => {
  it('shows a highlighted matching excerpt and occurrence count while preserving drafts normally', () => {
    const { container } = render(<Harness />);
    const desktopDrawer = container.querySelector<HTMLElement>('.MuiDrawer-docked')!;
    const desktop = within(desktopDrawer);
    expect(desktop.getByText('Draft saved')).toBeInTheDocument();

    const search = desktop.getByRole('searchbox', { name: 'Search chat history' });
    fireEvent.change(search, { target: { value: 'update' } });

    const result = document.getElementById('wf-history-desktop-result-0');
    expect(result).toHaveTextContent('Windows Update loop');
    expect(desktop.queryByText('Network troubleshooting')).not.toBeInTheDocument();
    expect(desktop.getByText('4 matches')).toBeInTheDocument();
    expect(desktopDrawer.querySelectorAll('mark.wf-history-match')).toHaveLength(4);
    expect(result).toHaveTextContent('rollback restored the');
  });

  it('reports only a debounced result count and a content-free result-open event', async () => {
    vi.useFakeTimers();
    const onSearchUsed = vi.fn();
    const onSearchResultOpened = vi.fn();
    const onSelectConversation = vi.fn();
    render(
      <Harness
        onSearchUsed={onSearchUsed}
        onSearchResultOpened={onSearchResultOpened}
        onSelectConversation={onSelectConversation}
      />,
    );

    const search = screen.getByRole('searchbox', { name: 'Search chat history' });
    fireEvent.change(search, { target: { value: 'up' } });
    fireEvent.change(search, { target: { value: 'update' } });
    expect(onSearchUsed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(onSearchUsed).toHaveBeenCalledOnce();
    expect(onSearchUsed).toHaveBeenCalledWith(1);
    expect(screen.getAllByRole('status')).toEqual(expect.arrayContaining([
      expect.objectContaining({ textContent: '1 chat found.' }),
    ]));

    fireEvent.change(search, { target: { value: 'update loop' } });
    await vi.advanceTimersByTimeAsync(600);
    expect(onSearchUsed).toHaveBeenCalledOnce();

    fireEvent.click(document.getElementById('wf-history-desktop-result-0')!);
    expect(onSearchResultOpened).toHaveBeenCalledWith();
    expect(onSelectConversation).toHaveBeenCalledWith('updates');
  });

  it('focuses search with Ctrl/Cmd+K and supports arrow, Enter, and Escape navigation', async () => {
    const onSelectConversation = vi.fn();
    render(<Harness onSelectConversation={onSelectConversation} />);
    const newChat = screen.getByRole('button', { name: 'New chat' });
    const search = screen.getByRole('searchbox', { name: 'Search chat history' });
    newChat.focus();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');

    fireEvent.change(search, { target: { value: 'the' } });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    const lastResult = document.getElementById('wf-history-desktop-result-2');
    await waitFor(() => expect(lastResult).toHaveFocus());

    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const firstResult = document.getElementById('wf-history-desktop-result-0');
    await waitFor(() => expect(firstResult).toHaveFocus());

    fireEvent.keyDown(firstResult!, { key: 'ArrowDown' });
    const secondResult = document.getElementById('wf-history-desktop-result-1');
    await waitFor(() => expect(secondResult).toHaveFocus());

    fireEvent.keyDown(secondResult!, { key: 'ArrowUp' });
    await waitFor(() => expect(firstResult).toHaveFocus());

    search.focus();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelectConversation).toHaveBeenCalledWith('updates');

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(screen.getAllByText('Driver diagnostics')).toHaveLength(2);
  });

  it('expands a collapsed desktop rail before focusing its search field', async () => {
    render(<Harness initiallyCollapsed />);
    expect(screen.queryByRole('searchbox', { name: 'Search chat history' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const search = await screen.findByRole('searchbox', { name: 'Search chat history' });
    expect(search).toHaveFocus();
  });

  it('does not move focus behind an open dialog when the search shortcut is pressed', () => {
    render(
      <>
        <Harness />
        <div role="dialog" aria-label="Settings"><button type="button">Dialog action</button></div>
      </>,
    );
    const dialogAction = screen.getByRole('button', { name: 'Dialog action' });
    dialogAction.focus();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    expect(dialogAction).toHaveFocus();
    expect(screen.getByRole('searchbox', { name: 'Search chat history' })).not.toHaveFocus();
  });

  it('ignores a hidden keep-mounted dialog when handling the search shortcut', () => {
    render(
      <>
        <Harness />
        <div aria-hidden="true"><div role="dialog" aria-label="Hidden CAPTCHA">Hidden</div></div>
      </>,
    );
    const newChat = screen.getByRole('button', { name: 'New chat' });
    newChat.focus();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    expect(screen.getByRole('searchbox', { name: 'Search chat history' })).toHaveFocus();
  });

  it('opens the mobile drawer before focusing search and exposes a usable-width paper', async () => {
    mobileViewport = true;
    const { container } = render(<Harness />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const searches = await screen.findAllByRole('searchbox', { name: 'Search chat history' });
    const mobileSearch = searches[searches.length - 1];
    await waitFor(() => expect(mobileSearch).toHaveFocus());

    fireEvent.change(mobileSearch, { target: { value: 'update' } });
    fireEvent.keyDown(mobileSearch, { key: 'Escape' });
    expect(mobileSearch).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Close chat history' })).toBeInTheDocument();

    const drawerPapers = container.ownerDocument.querySelectorAll('.MuiDrawer-paper');
    const mobilePaper = drawerPapers[drawerPapers.length - 1];
    expect(mobilePaper).toHaveStyle({ width: '92vw', maxWidth: '360px' });
  });

  it('gives the open mobile history dialog an accessible name', async () => {
    mobileViewport = true;
    render(<Harness initiallyOpen />);

    expect(await screen.findByRole('dialog', { name: 'Chat history' })).toBeInTheDocument();
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });
});

describe('ConversationSidebar library organization', () => {
  const libraryConversations = [
    withLibraryMetadata(conversation('pinned', 'Pinned diagnostics', 'Pinned display troubleshooting notes.'), { pinnedAt: Date.now() }),
    conversation('recent', 'Recent network chat', 'Current adapter troubleshooting.'),
    withLibraryMetadata(conversation('archived', 'Archived update fix', 'An older update workaround.'), { archivedAt: Date.now() }),
  ];

  it('puts pinned chats first, hides archived chats normally, and searches the archive from All', () => {
    const { container } = render(<Harness conversations={libraryConversations} currentConversationId="recent" />);
    const desktopDrawer = container.querySelector<HTMLElement>('.MuiDrawer-docked')!;
    const desktop = within(desktopDrawer);
    const sectionLabels = [...desktopDrawer.querySelectorAll('.MuiListSubheader-root')].map(node => node.textContent);

    expect(sectionLabels[0]).toBe('Pinned');
    expect(desktop.getByRole('button', { name: /^Pinned diagnostics$/ })).toBeInTheDocument();
    expect(desktop.queryByRole('button', { name: /^Archived update fix$/ })).not.toBeInTheDocument();

    fireEvent.change(desktop.getByRole('searchbox', { name: 'Search chat history' }), { target: { value: 'update' } });

    expect(desktop.getByText('Archived · 2 matches')).toBeInTheDocument();
    const searchedSections = [...desktopDrawer.querySelectorAll('.MuiListSubheader-root')];
    expect(searchedSections[searchedSections.length - 1]).toHaveTextContent('Archived');
  });

  it('filters the library between All, Pinned, and Archived views', () => {
    const { container } = render(<Harness conversations={libraryConversations} currentConversationId="recent" />);
    const desktop = within(container.querySelector<HTMLElement>('.MuiDrawer-docked')!);

    fireEvent.click(desktop.getByRole('button', { name: 'Pinned chats' }));
    expect(desktop.getByRole('button', { name: /^Pinned diagnostics$/ })).toBeInTheDocument();
    expect(desktop.queryByRole('button', { name: /^Recent network chat$/ })).not.toBeInTheDocument();

    fireEvent.click(desktop.getByRole('button', { name: 'Archived chats' }));
    expect(desktop.getByRole('button', { name: /^Archived update fix Archived$/ })).toBeInTheDocument();
    expect(desktop.queryByRole('button', { name: /^Pinned diagnostics$/ })).not.toBeInTheDocument();

    fireEvent.click(desktop.getByRole('button', { name: 'All chats' }));
    expect(desktop.getByRole('button', { name: /^Recent network chat$/ })).toBeInTheDocument();
    expect(desktop.queryByRole('button', { name: /^Archived update fix$/ })).not.toBeInTheDocument();
  });

  it('exposes accessible per-chat pin and archive actions', () => {
    const onPinConversation = vi.fn();
    const onArchiveConversation = vi.fn();
    const { container } = render(
      <Harness
        conversations={libraryConversations}
        currentConversationId="recent"
        onPinConversation={onPinConversation}
        onArchiveConversation={onArchiveConversation}
      />,
    );
    const desktop = within(container.querySelector<HTMLElement>('.MuiDrawer-docked')!);

    fireEvent.click(desktop.getByRole('button', { name: 'Actions for Pinned diagnostics' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }));
    expect(onPinConversation).toHaveBeenCalledWith('pinned', false);

    fireEvent.click(desktop.getByRole('button', { name: 'Actions for Recent network chat' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(onArchiveConversation).toHaveBeenCalledWith('recent', true);

    fireEvent.click(desktop.getByRole('button', { name: 'Archived chats' }));
    fireEvent.click(desktop.getByRole('button', { name: 'Actions for Archived update fix' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
    expect(onArchiveConversation).toHaveBeenCalledWith('archived', false);
  });

  it('restores the row action trigger when its menu is dismissed with Escape', async () => {
    const { container } = render(
      <Harness
        conversations={libraryConversations}
        currentConversationId="recent"
        onArchiveConversation={vi.fn()}
      />,
    );
    const desktop = within(container.querySelector<HTMLElement>('.MuiDrawer-docked')!);
    const trigger = desktop.getByRole('button', { name: 'Actions for Recent network chat' });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Actions for Recent network chat' });
    fireEvent.keyDown(menu, { key: 'Escape' });

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('supports selection, clear selection, and eligible bulk archive/restore actions', () => {
    const onBulkArchive = vi.fn();
    const onBulkRestore = vi.fn();
    const { container } = render(
      <Harness
        conversations={libraryConversations}
        currentConversationId="recent"
        onBulkArchive={onBulkArchive}
        onBulkRestore={onBulkRestore}
      />,
    );
    const desktop = within(container.querySelector<HTMLElement>('.MuiDrawer-docked')!);

    fireEvent.click(desktop.getByRole('button', { name: 'Select' }));
    fireEvent.click(desktop.getByRole('checkbox', { name: 'Select Pinned diagnostics' }));
    fireEvent.click(desktop.getByRole('checkbox', { name: 'Select Recent network chat' }));
    expect(desktop.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(desktop.getByRole('button', { name: 'Clear selection' }));
    expect(desktop.getByText('0 selected')).toBeInTheDocument();

    fireEvent.click(desktop.getByRole('checkbox', { name: 'Select Recent network chat' }));
    fireEvent.click(desktop.getByRole('button', { name: 'Archive selected chats' }));
    expect(onBulkArchive).toHaveBeenCalledWith(['recent']);

    fireEvent.click(desktop.getByRole('button', { name: 'Archived chats' }));
    fireEvent.click(desktop.getByRole('button', { name: 'Select' }));
    fireEvent.click(desktop.getByRole('checkbox', { name: 'Select Archived update fix' }));
    fireEvent.click(desktop.getByRole('button', { name: 'Restore selected chats' }));
    expect(onBulkRestore).toHaveBeenCalledWith(['archived']);
  });

  it('passes all selected chats to bulk export and delete callbacks', () => {
    const onBulkExport = vi.fn();
    const onBulkDelete = vi.fn();
    const { container } = render(
      <Harness
        conversations={libraryConversations}
        currentConversationId="recent"
        onBulkExport={onBulkExport}
        onBulkDelete={onBulkDelete}
      />,
    );
    const desktop = within(container.querySelector<HTMLElement>('.MuiDrawer-docked')!);

    fireEvent.click(desktop.getByRole('button', { name: 'Select' }));
    fireEvent.click(desktop.getByRole('checkbox', { name: 'Select Pinned diagnostics' }));
    fireEvent.click(desktop.getByRole('checkbox', { name: 'Select Recent network chat' }));
    fireEvent.click(desktop.getByRole('button', { name: 'Export selected chats' }));
    expect(onBulkExport).toHaveBeenCalledWith(['pinned', 'recent']);

    fireEvent.click(desktop.getByRole('button', { name: 'Select' }));
    fireEvent.click(desktop.getByRole('checkbox', { name: 'Select Recent network chat' }));
    fireEvent.click(desktop.getByRole('button', { name: 'Delete selected chats' }));
    expect(onBulkDelete).toHaveBeenCalledWith(['recent']);
  });

  it.each(['single', 'bulk'] as const)('does not restore focus into a closed mobile drawer after %s archive', async (mode) => {
    mobileViewport = true;

    const ClosingMobileHarness = () => {
      const [open, setOpen] = useState(false);
      const openerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <ThemeProvider theme={theme}>
          <div id="wf-chat-window">
            <button ref={openerRef} type="button" onClick={() => setOpen(true)}>Open chat history</button>
            <ConversationSidebar
              open={open}
              onOpen={() => setOpen(true)}
              onClose={() => setOpen(false)}
              conversations={libraryConversations}
              currentConversationId="recent"
              onSelectConversation={vi.fn()}
              onDeleteConversation={vi.fn()}
              onNewConversation={vi.fn()}
              onArchiveConversation={mode === 'single' ? () => setOpen(false) : undefined}
              onBulkArchive={mode === 'bulk' ? () => setOpen(false) : undefined}
            />
          </div>
        </ThemeProvider>
      );
    };

    render(<ClosingMobileHarness />);
    const opener = screen.getByRole('button', { name: 'Open chat history' });
    opener.focus();
    fireEvent.click(opener);
    const drawer = await screen.findByRole('dialog', { name: 'Chat history' });

    if (mode === 'single') {
      fireEvent.click(within(drawer).getByRole('button', { name: 'Actions for Recent network chat' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    } else {
      fireEvent.click(within(drawer).getByRole('button', { name: 'Select' }));
      fireEvent.click(within(drawer).getByRole('checkbox', { name: 'Select Recent network chat' }));
      fireEvent.click(within(drawer).getByRole('button', { name: 'Archive selected chats' }));
    }

    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.activeElement?.closest('.wf-history-mobile-drawer')).toBeNull();
  });
});
