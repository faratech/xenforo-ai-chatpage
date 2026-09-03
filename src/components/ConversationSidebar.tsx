import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Drawer from '@mui/material/Drawer';
import SwipeableDrawer from '@mui/material/SwipeableDrawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Avatar from '@mui/material/Avatar';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import SearchIcon from '@mui/icons-material/Search';
import type { Conversation, ConversationSidebarProps } from '../types';
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';

type DateGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';
type LibraryView = 'all' | 'pinned' | 'archived';

type LibraryConversation = Conversation & {
  pinnedAt?: number;
  archivedAt?: number;
};

interface ConversationSearchResult {
  conversation: LibraryConversation;
  excerpt?: string;
  matchCount: number;
}

const normalizeSearchText = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Pre-normalized search corpus for one conversation, built only when the
 * conversation list changes. The title and every message are whitespace
 * normalized once, then joined into `lower` with '\n' — a character a
 * normalized query can never contain, so no match can span a segment boundary
 * and one scan counts the whole conversation. `compactSegments` keeps each
 * segment's original casing for excerpt slicing, addressed via `segmentStarts`.
 */
interface ConversationSearchIndex {
  lower: string;
  segmentStarts: number[];
  compactSegments: string[];
}

const buildSearchIndex = (conversation: LibraryConversation): ConversationSearchIndex => {
  let lower = '';
  const segmentStarts: number[] = [];
  const compactSegments: string[] = [];

  for (const source of [conversation.title, ...conversation.messages.map(message => message.rawContent)]) {
    const compact = normalizeSearchText(source);
    if (segmentStarts.length) lower += '\n';
    segmentStarts.push(lower.length);
    compactSegments.push(compact);
    lower += compact.toLocaleLowerCase();
  }

  return { lower, segmentStarts, compactSegments };
};

const segmentAt = (index: ConversationSearchIndex, offset: number): number => {
  let segment = 0;
  while (segment + 1 < index.segmentStarts.length && index.segmentStarts[segment + 1] <= offset) segment += 1;
  return segment;
};

const countMatches = (index: ConversationSearchIndex, normalizedQuery: string): number => {
  const haystack = index.lower;
  let count = 0;
  let offset = 0;

  while (offset < haystack.length) {
    const matchAt = haystack.indexOf(normalizedQuery, offset);
    if (matchAt < 0) break;
    count += 1;
    offset = matchAt + normalizedQuery.length;
  }

  return count;
};

const excerptAroundMatch = (compact: string, normalizedQuery: string): string | undefined => {
  const matchAt = compact.toLocaleLowerCase().indexOf(normalizedQuery);
  if (matchAt < 0) return undefined;

  const contextBefore = 42;
  const contextAfter = 72;
  let start = Math.max(0, matchAt - contextBefore);
  let end = Math.min(compact.length, matchAt + normalizedQuery.length + contextAfter);

  if (start > 0) {
    const nextSpace = compact.indexOf(' ', start);
    if (nextSpace >= 0 && nextSpace < matchAt) start = nextSpace + 1;
  }
  if (end < compact.length) {
    const previousSpace = compact.lastIndexOf(' ', end);
    if (previousSpace > matchAt + normalizedQuery.length) end = previousSpace;
  }

  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
};

const highlightMatches = (value: string, normalizedQuery: string) => {
  if (!normalizedQuery) return value;

  const normalizedValue = value.toLocaleLowerCase();
  const parts: Array<string | React.ReactElement> = [];
  let offset = 0;
  let key = 0;

  while (offset < value.length) {
    const matchAt = normalizedValue.indexOf(normalizedQuery, offset);
    if (matchAt < 0) break;
    if (matchAt > offset) parts.push(value.slice(offset, matchAt));
    parts.push(
      <Box
        component="mark"
        key={key}
        className="wf-history-match"
        sx={{ px: 0.15, borderRadius: 0.35, bgcolor: 'warning.light', color: 'warning.contrastText' }}
      >
        {value.slice(matchAt, matchAt + normalizedQuery.length)}
      </Box>,
    );
    key += 1;
    offset = matchAt + normalizedQuery.length;
  }

  if (!parts.length) return value;
  if (offset < value.length) parts.push(value.slice(offset));
  return parts;
};

const groupForDate = (timestamp: number): DateGroup => {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const age = startToday - timestamp;
  if (timestamp >= startToday) return 'Today';
  if (age <= 24 * 60 * 60 * 1000) return 'Yesterday';
  if (age < 7 * 24 * 60 * 60 * 1000) return 'Previous 7 days';
  return 'Older';
};

const GROUP_ORDER: DateGroup[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

/**
 * Conversation navigation uses a compact permanent support rail on desktop and
 * the same searchable history as a modal drawer on smaller screens.
 */
export const ConversationSidebar = memo<ConversationSidebarProps>(({
  open,
  onOpen,
  onClose,
  onSearchUsed,
  onSearchResultOpened,
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
  onRenameConversation,
  onPinConversation,
  onArchiveConversation,
  onBulkArchive,
  onBulkRestore,
  onBulkDelete,
  onBulkExport,
  desktopCollapsed = false,
  onToggleDesktopCollapsed,
}) => {
  const [query, setQuery] = useState('');
  const [libraryView, setLibraryView] = useState<LibraryView>('all');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(() => new Set());
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [menuState, setMenuState] = useState<{
    anchor: HTMLElement;
    conversation: LibraryConversation;
  } | null>(null);
  const desktopSearchRef = useRef<HTMLInputElement | null>(null);
  const mobileSearchRef = useRef<HTMLInputElement | null>(null);
  const desktopResultRefs = useRef(new Map<string, HTMLButtonElement>());
  const mobileResultRefs = useRef(new Map<string, HTMLButtonElement>());
  const desktopSelectRef = useRef<HTMLButtonElement | null>(null);
  const mobileSelectRef = useRef<HTMLButtonElement | null>(null);
  const mobileDrawerOpenRef = useRef(open);
  const previousMobileOpenRef = useRef(open);
  const mobileReturnFocusRef = useRef<HTMLElement | null>(null);
  const shortcutFocusPendingRef = useRef(false);
  const searchSessionReportedRef = useRef(false);
  const pendingMenuFocusRef = useRef<{
    mobile: boolean;
    trigger: HTMLElement;
    conversationId: string;
    fallbackIds: string[];
  } | null>(null);
  const pendingMenuDialogActionRef = useRef<{
    mobile: boolean;
    run: () => void;
  } | null>(null);
  const [searchAnnouncement, setSearchAnnouncement] = useState('');
  const conversationMenuId = useId();
  const handleMobileOpen = useCallback(() => onOpen?.(), [onOpen]);

  useEffect(() => {
    if (open && !previousMobileOpenRef.current) {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && !activeElement.closest('.wf-history-mobile-drawer')) {
        mobileReturnFocusRef.current = activeElement;
      }
    }
    mobileDrawerOpenRef.current = open;
    previousMobileOpenRef.current = open;
  }, [open]);

  const normalizedQuery = normalizeSearchText(query).toLocaleLowerCase();

  // Derived from conversations alone, so a keystroke scans cached text instead
  // of re-normalizing the corpus.
  const searchIndex = useMemo(() => new Map(conversations.map(conversationValue => {
    const conversation = conversationValue as LibraryConversation;
    return [conversation.id, buildSearchIndex(conversation)];
  })), [conversations]);

  const matchingResults = useMemo<ConversationSearchResult[]>(() => conversations.flatMap(conversationValue => {
    const conversation = conversationValue as LibraryConversation;
    if (!normalizedQuery) return [{ conversation, matchCount: 0 }];

    const index = searchIndex.get(conversation.id);
    if (!index) return [];

    const matchCount = countMatches(index, normalizedQuery);
    if (!matchCount) return [];

    // The excerpt comes from the first matching message, falling back to the
    // title when every match lives in the title itself.
    const firstMessageMatchAt = index.lower.indexOf(normalizedQuery, index.segmentStarts[1] ?? index.lower.length);
    const excerptSegment = firstMessageMatchAt < 0
      ? index.compactSegments[0]
      : index.compactSegments[segmentAt(index, firstMessageMatchAt)];

    return [{
      conversation,
      excerpt: excerptAroundMatch(excerptSegment, normalizedQuery),
      matchCount,
    }];
  }), [conversations, normalizedQuery, searchIndex]);

  const visibleResults = useMemo(() => matchingResults.filter(({ conversation }) => {
    const isArchived = Boolean(conversation.archivedAt);
    if (libraryView === 'archived') return isArchived;
    if (libraryView === 'pinned') return Boolean(conversation.pinnedAt) && !isArchived;
    // The normal history stays uncluttered, but search deliberately reaches
    // the archive so an old conversation never feels lost.
    return normalizedQuery ? true : !isArchived;
  }), [libraryView, matchingResults, normalizedQuery]);

  const groups = useMemo(() => {
    if (libraryView === 'pinned') {
      return visibleResults.length ? [{ label: 'Pinned', results: visibleResults }] : [];
    }
    if (libraryView === 'archived') {
      return visibleResults.length ? [{ label: 'Archived', results: visibleResults }] : [];
    }

    const activePinned = visibleResults.filter(({ conversation }) => conversation.pinnedAt && !conversation.archivedAt);
    const activeRecent = visibleResults.filter(({ conversation }) => !conversation.pinnedAt && !conversation.archivedAt);
    const archived = visibleResults.filter(({ conversation }) => conversation.archivedAt);
    const sections: Array<{ label: string; results: ConversationSearchResult[] }> = [];
    if (activePinned.length) sections.push({ label: 'Pinned', results: activePinned });
    sections.push(...GROUP_ORDER.map(label => ({
      label,
      results: activeRecent.filter(result => groupForDate(result.conversation.updatedAt) === label),
    })).filter(group => group.results.length > 0));
    if (archived.length) sections.push({ label: 'Archived', results: archived });
    return sections;
  }, [libraryView, visibleResults]);

  const orderedResults = useMemo(() => groups.flatMap(group => group.results), [groups]);
  const resultIndexById = useMemo(() => new Map(
    orderedResults.map((result, index) => [result.conversation.id, index]),
  ), [orderedResults]);
  const canSelect = Boolean(onBulkArchive || onBulkRestore || onBulkDelete || onBulkExport);
  const selectedConversations = useMemo(() => conversations
    .filter(conversation => selectedConversationIds.has(conversation.id))
    .map(conversation => conversation as LibraryConversation), [conversations, selectedConversationIds]);
  const selectedIds = useMemo(() => selectedConversations.map(conversation => conversation.id), [selectedConversations]);
  const selectedActiveIds = useMemo(() => selectedConversations
    .filter(conversation => !conversation.archivedAt)
    .map(conversation => conversation.id), [selectedConversations]);
  const selectedArchivedIds = useMemo(() => selectedConversations
    .filter(conversation => conversation.archivedAt)
    .map(conversation => conversation.id), [selectedConversations]);

  const clearSelection = useCallback(() => setSelectedConversationIds(new Set()), []);
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    clearSelection();
  }, [clearSelection]);

  const toggleConversationSelection = useCallback((conversationId: string) => {
    setSelectedConversationIds(current => {
      const next = new Set(current);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }, []);

  const changeLibraryView = useCallback((nextView: LibraryView | null) => {
    if (!nextView) return;
    setLibraryView(nextView);
    setActiveResultIndex(-1);
    clearSelection();
  }, [clearSelection]);

  const runBulkAction = useCallback((
    callback: ((conversationIds: readonly string[]) => void) | undefined,
    conversationIds: readonly string[],
    restoreSelectFocus = false,
  ) => {
    if (!callback || conversationIds.length === 0) return;
    const mobile = Boolean(document.activeElement?.closest('.wf-history-mobile-drawer'));
    // Export/delete open a dialog. Move focus to the persistent Select button
    // before the callback so the dialog records a connected restore target
    // instead of the bulk-toolbar button that is about to unmount.
    if (!restoreSelectFocus) {
      (mobile ? mobileSelectRef : desktopSelectRef).current?.focus();
    }
    callback(conversationIds);
    exitSelectionMode();
    // The focused bulk toolbar unmounts when selection mode exits. Restore
    // focus for in-place organization actions. Export/delete open dialogs,
    // whose own focus trap must remain in control.
    if (restoreSelectFocus) {
      window.setTimeout(() => {
        if (mobile && !mobileDrawerOpenRef.current) return;
        (mobile ? mobileSelectRef : desktopSelectRef).current?.focus();
      }, 0);
    }
  }, [exitSelectionMode]);

  useEffect(() => {
    if (!normalizedQuery) {
      searchSessionReportedRef.current = false;
      setSearchAnnouncement('');
      return;
    }

    const announcementTimer = window.setTimeout(() => {
      setSearchAnnouncement(orderedResults.length === 0
        ? 'No chats found.'
        : `${orderedResults.length} ${orderedResults.length === 1 ? 'chat' : 'chats'} found.`);
    }, 250);

    if (searchSessionReportedRef.current) {
      return () => window.clearTimeout(announcementTimer);
    }

    const telemetryTimer = window.setTimeout(() => {
      searchSessionReportedRef.current = true;
      onSearchUsed?.(orderedResults.length);
    }, 600);
    return () => {
      window.clearTimeout(announcementTimer);
      window.clearTimeout(telemetryTimer);
    };
  }, [normalizedQuery, onSearchUsed, orderedResults.length]);

  const focusSearch = useCallback((mobile: boolean) => {
    (mobile ? mobileSearchRef : desktopSearchRef).current?.focus();
  }, []);

  useEffect(() => {
    if (!shortcutFocusPendingRef.current) return;
    const mobile = window.matchMedia?.('(max-width: 899.95px)').matches ?? window.innerWidth < 900;
    // The temporary Drawer's focus trap runs as it mounts. Mobile focus is
    // intentionally deferred to the transition's onEntered callback so it
    // cannot be replaced by the drawer paper's initial focus.
    if (mobile || desktopCollapsed) return;
    shortcutFocusPendingRef.current = false;
    focusSearch(false);
  }, [desktopCollapsed, focusSearch, open]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'k') return;

      const isOpenBlockingSurface = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement) || element.closest('.wf-history-mobile-drawer')) return false;
        if (element.closest('[aria-hidden="true"], .MuiModal-hidden')) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const eventElement = event.target instanceof Element ? event.target : document.activeElement;
      const targetSurface = eventElement?.closest('[role="dialog"], [role="menu"]') ?? null;
      const activeBlockingSurface = isOpenBlockingSurface(targetSurface)
        ? targetSurface
        : [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"]')]
          .find(isOpenBlockingSurface);
      if (activeBlockingSurface) return;

      const mobile = window.matchMedia?.('(max-width: 899.95px)').matches ?? window.innerWidth < 900;
      if (mobile && !open && !onOpen) return;
      if (!mobile && desktopCollapsed && !onToggleDesktopCollapsed) return;

      event.preventDefault();
      shortcutFocusPendingRef.current = true;
      if (mobile && !open) {
        onOpen?.();
      } else if (!mobile && desktopCollapsed) {
        onToggleDesktopCollapsed?.();
      } else {
        shortcutFocusPendingRef.current = false;
        focusSearch(mobile);
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [desktopCollapsed, focusSearch, onOpen, onToggleDesktopCollapsed, open]);

  const chooseConversation = (conversationId: string, closeAfter: boolean) => {
    if (selectionMode) {
      toggleConversationSelection(conversationId);
      return;
    }
    if (normalizedQuery) onSearchResultOpened?.();
    onSelectConversation(conversationId);
    if (closeAfter) onClose();
  };

  const focusResult = (index: number, mobile: boolean) => {
    if (!orderedResults.length) return;
    const wrappedIndex = (index + orderedResults.length) % orderedResults.length;
    const result = orderedResults[wrappedIndex];
    setActiveResultIndex(wrappedIndex);
    const refs = mobile ? mobileResultRefs : desktopResultRefs;
    requestAnimationFrame(() => refs.current.get(result.conversation.id)?.focus());
  };

  const clearSearch = (mobile: boolean) => {
    setQuery('');
    setActiveResultIndex(-1);
    requestAnimationFrame(() => focusSearch(mobile));
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent, mobile: boolean) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (normalizedQuery) clearSearch(mobile);
      else if (selectionMode) exitSelectionMode();
      else if (mobile) onClose();
      return;
    }
    if (!normalizedQuery || !orderedResults.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = activeResultIndex < 0
        ? event.key === 'ArrowDown' ? 0 : orderedResults.length - 1
        : activeResultIndex + (event.key === 'ArrowDown' ? 1 : -1);
      focusResult(nextIndex, mobile);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = orderedResults[Math.max(0, Math.min(activeResultIndex, orderedResults.length - 1))];
      if (result) chooseConversation(result.conversation.id, mobile);
    }
  };

  const handleResultKeyDown = (event: React.KeyboardEvent, resultIndex: number, mobile: boolean) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (normalizedQuery) clearSearch(mobile);
      else if (selectionMode) exitSelectionMode();
      else if (mobile) onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusResult(resultIndex + (event.key === 'ArrowDown' ? 1 : -1), mobile);
    }
  };

  const prepareConversationMenuFocus = () => {
    if (!menuState) return;
    const { anchor, conversation } = menuState;
    const mobile = Boolean(anchor.closest('.wf-history-mobile-drawer'));
    const oldResultIds = orderedResults.map(result => result.conversation.id);
    const oldIndex = oldResultIds.indexOf(conversation.id);
    pendingMenuFocusRef.current = {
      mobile,
      trigger: anchor,
      conversationId: conversation.id,
      fallbackIds: [
        ...oldResultIds.slice(Math.max(0, oldIndex + 1)),
        ...oldResultIds.slice(0, Math.max(0, oldIndex)).reverse(),
      ],
    };
  };

  const closeConversationMenu = () => {
    prepareConversationMenuFocus();
    setMenuState(null);
  };

  const runConversationMenuAction = (action: (conversation: LibraryConversation) => void) => {
    if (!menuState) return;
    const { conversation } = menuState;
    prepareConversationMenuFocus();
    setMenuState(null);
    action(conversation);
  };

  const runConversationDialogAction = (action: (conversation: LibraryConversation) => void) => {
    if (!menuState) return;
    const { anchor, conversation } = menuState;
    pendingMenuDialogActionRef.current = {
      mobile: Boolean(anchor.closest('.wf-history-mobile-drawer')),
      run: () => action(conversation),
    };
    setMenuState(null);
  };

  const renderContent = (collapsed: boolean, mobile: boolean) => (
    <Box className={collapsed ? 'wf-history-rail is-collapsed' : 'wf-history-rail'} sx={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          gap: 1,
          minHeight: 62,
          px: collapsed ? 1 : 2,
          borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
        }}
      >
        {!collapsed && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
            <Avatar src={BOT_AVATAR} alt={ASSISTANT_NAME} sx={{ width: 30, height: 30, bgcolor: '#0a2c4d' }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 14, lineHeight: 1.1 }}>{mobile ? 'Recent chats' : 'Ask the AI'}</Typography>
              <Typography noWrap sx={{ fontSize: 11, color: 'text.secondary' }}>{ASSISTANT_NAME}</Typography>
            </Box>
          </Box>
        )}
        {mobile ? (
          <IconButton onClick={onClose} aria-label="Close chat history" size="small">
            <CloseIcon />
          </IconButton>
        ) : (
          <Tooltip title={collapsed ? 'Expand chat history' : 'Collapse chat history'} placement="right">
            <IconButton onClick={onToggleDesktopCollapsed} aria-label={collapsed ? 'Expand chat history' : 'Collapse chat history'} size="small">
              {collapsed ? <MenuIcon /> : <MenuOpenIcon />}
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Box sx={{ p: collapsed ? 1 : 1.5 }}>
        {collapsed ? (
          <Tooltip title="New chat" placement="right">
            <IconButton
              color="primary"
              aria-label="New chat"
              onClick={() => { onNewConversation(); if (mobile) onClose(); }}
              sx={{ width: 44, height: 44, mx: 'auto', display: 'flex', border: '1px solid', borderColor: 'divider' }}
            >
              <AddIcon />
            </IconButton>
          </Tooltip>
        ) : (
          <Button
            fullWidth
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => { onNewConversation(); if (mobile) onClose(); }}
          >
            New chat
          </Button>
        )}
      </Box>

      {!collapsed && (
        <Box sx={{ px: 1.5, pb: 1 }}>
          <TextField
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveResultIndex(-1);
            }}
            onKeyDown={(event) => handleSearchKeyDown(event, mobile)}
            inputRef={mobile ? mobileSearchRef : desktopSearchRef}
            placeholder="Search chats"
            slotProps={{
              htmlInput: {
                'aria-label': 'Search chat history',
                'aria-keyshortcuts': 'Control+K Meta+K',
              },
              input: {
                startAdornment: (
                  <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment>
                ),
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => clearSearch(mobile)} aria-label="Clear chat search"><CloseIcon fontSize="small" /></IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
            size="small"
            fullWidth
          />
          <Typography
            role="status"
            aria-live="polite"
            aria-atomic="true"
            sx={{ position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}
          >
            {searchAnnouncement}
          </Typography>
        </Box>
      )}

      {!collapsed && (
        <Box sx={{ px: 1.5, pb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box
              role="group"
              aria-label="Chat history view"
              sx={{
                flex: 1,
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                overflow: 'hidden',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                '& > button:not(:first-of-type)': { borderLeft: '1px solid', borderColor: 'divider' },
              }}
            >
              {([
                ['all', 'All'],
                ['pinned', 'Pinned'],
                ['archived', 'Archived'],
              ] as const).map(([view, label]) => (
                <Button
                  key={view}
                  size="small"
                  variant={libraryView === view ? 'contained' : 'text'}
                  aria-label={`${label} chats`}
                  aria-pressed={libraryView === view}
                  onClick={() => changeLibraryView(view)}
                  sx={{ minWidth: 0, borderRadius: 0, px: 0.5, py: 0.45, fontSize: 10.5, lineHeight: 1.4, textTransform: 'none' }}
                >
                  {label}
                </Button>
              ))}
            </Box>
            {canSelect && (
              <Button
                ref={mobile ? mobileSelectRef : desktopSelectRef}
                size="small"
                variant={selectionMode ? 'contained' : 'text'}
                onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
                sx={{ minWidth: 48, px: 0.75, fontSize: 10.5, textTransform: 'none' }}
              >
                {selectionMode ? 'Done' : 'Select'}
              </Button>
            )}
          </Box>
          {selectionMode && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 28, pt: 0.5 }}>
              <Typography role="status" aria-live="polite" sx={{ fontSize: 11, color: 'text.secondary' }}>
                {selectedIds.length} selected
              </Typography>
              <Button
                size="small"
                disabled={selectedIds.length === 0}
                onClick={clearSelection}
                sx={{ minWidth: 0, px: 0.5, fontSize: 10.5, textTransform: 'none' }}
              >
                Clear selection
              </Button>
            </Box>
          )}
        </Box>
      )}

      <List aria-label="Chat history" sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', px: collapsed ? 0.75 : 1, py: 0 }}>
        {groups.map(group => (
          <Box component="li" key={group.label} sx={{ listStyle: 'none' }}>
            {!collapsed && (
              <ListSubheader
                component="div"
                disableSticky
                sx={{ px: 1, pt: 1.25, pb: 0.5, bgcolor: 'transparent', color: 'text.secondary', fontSize: 10, fontWeight: 700, lineHeight: 1.4, letterSpacing: '0.06em', textTransform: 'uppercase' }}
              >
                {group.label}
              </ListSubheader>
            )}
            {group.results.map(result => {
              const { conversation } = result;
              const isCurrent = conversation.id === currentConversationId;
              const isSelected = selectedConversationIds.has(conversation.id);
              const resultIndex = resultIndexById.get(conversation.id) ?? 0;
              const row = (
                <Box
                  key={conversation.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    position: 'relative',
                    borderRadius: 1.5,
                    mb: 0.25,
                    '&::before': isCurrent && !selectionMode ? {
                      content: '""',
                      position: 'absolute',
                      left: 0,
                      top: 8,
                      bottom: 8,
                      width: 3,
                      borderRadius: 999,
                      bgcolor: 'primary.main',
                      zIndex: 1,
                    } : undefined,
                    '&:hover .conversation-menu, &:focus-within .conversation-menu': { opacity: 1 },
                  }}
                >
                  <ListItemButton
                    component="button"
                    type="button"
                    id={`wf-history-${mobile ? 'mobile' : 'desktop'}-result-${resultIndex}`}
                    ref={(element) => {
                      const refs = mobile ? mobileResultRefs : desktopResultRefs;
                      if (element) refs.current.set(conversation.id, element);
                      else refs.current.delete(conversation.id);
                    }}
                    selected={selectionMode ? isSelected : isCurrent}
                    role={selectionMode ? 'checkbox' : undefined}
                    aria-checked={selectionMode ? isSelected : undefined}
                    aria-current={!selectionMode && isCurrent ? 'page' : undefined}
                    aria-label={selectionMode
                      ? `${isSelected ? 'Deselect' : 'Select'} ${conversation.title}`
                      : collapsed ? conversation.title : undefined}
                    onClick={() => chooseConversation(conversation.id, mobile)}
                    onFocus={() => setActiveResultIndex(resultIndex)}
                    onKeyDown={(event) => handleResultKeyDown(event, resultIndex, mobile)}
                    sx={{
                      minWidth: 0,
                      minHeight: 42,
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      borderRadius: 1.5,
                      px: collapsed ? 1 : 1.25,
                      gap: 1.25,
                      '&.Mui-selected': { bgcolor: 'action.selected' },
                    }}
                  >
                    {selectionMode ? (
                      <Box
                        component="span"
                        aria-hidden="true"
                        sx={{
                          width: 17,
                          height: 17,
                          flexShrink: 0,
                          display: 'grid',
                          placeItems: 'center',
                          border: '1.5px solid',
                          borderColor: isSelected ? 'primary.main' : 'text.secondary',
                          borderRadius: 0.5,
                          bgcolor: isSelected ? 'primary.main' : 'transparent',
                          color: 'primary.contrastText',
                          fontSize: 12,
                          lineHeight: 1,
                        }}
                      >
                        {isSelected ? '✓' : ''}
                      </Box>
                    ) : <ChatBubbleOutlineIcon sx={{ fontSize: 17, opacity: 0.85, flexShrink: 0 }} />}
                    {!collapsed && (
                      <ListItemText
                        primary={normalizedQuery ? highlightMatches(conversation.title, normalizedQuery) : conversation.title}
                        secondary={normalizedQuery ? (
                          <>
                            <Box component="span" sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>
                              {highlightMatches(result.excerpt ?? conversation.title, normalizedQuery)}
                            </Box>
                            <Box component="span" sx={{ display: 'block', mt: 0.25, color: 'text.secondary', fontSize: 10 }}>
                              {conversation.archivedAt ? 'Archived · ' : ''}{result.matchCount} {result.matchCount === 1 ? 'match' : 'matches'}
                            </Box>
                          </>
                        ) : conversation.archivedAt ? 'Archived' : conversation.draft?.trim() ? 'Draft saved' : undefined}
                        slotProps={{
                          primary: { noWrap: true, sx: { fontSize: 13, fontWeight: isCurrent ? 650 : 500 } },
                          secondary: { component: 'div', sx: { fontSize: 10.5, color: normalizedQuery ? 'text.secondary' : 'primary.main' } },
                        }}
                      />
                    )}
                    {!collapsed && !selectionMode && conversation.pinnedAt && !conversation.archivedAt && (
                      <PushPinOutlinedIcon aria-label="Pinned" sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0 }} />
                    )}
                  </ListItemButton>
                  {!collapsed && !selectionMode && (
                    <IconButton
                      className="conversation-menu"
                      aria-label={`Actions for ${conversation.title}`}
                      aria-haspopup="menu"
                      aria-expanded={menuState?.conversation.id === conversation.id}
                      aria-controls={menuState?.conversation.id === conversation.id ? conversationMenuId : undefined}
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuState({ anchor: event.currentTarget, conversation });
                      }}
                      sx={{ opacity: 0, mr: 0.25, flexShrink: 0, '@media (hover: none), (pointer: coarse)': { opacity: 1 } }}
                    >
                      <MoreHorizIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              );
              return collapsed ? <Tooltip key={conversation.id} title={conversation.title} placement="right">{row}</Tooltip> : row;
            })}
          </Box>
        ))}
        {!groups.length && !collapsed && (
          <Box sx={{ px: 1.5, py: 4, textAlign: 'center' }}>
            <SearchIcon sx={{ color: 'text.disabled', mb: 0.75 }} />
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              {normalizedQuery
                ? `No chats match “${query.trim()}”.`
                : libraryView === 'pinned'
                  ? 'No pinned chats yet.'
                  : libraryView === 'archived'
                    ? 'No archived chats.'
                    : 'No chats yet.'}
            </Typography>
          </Box>
        )}
      </List>

      {!collapsed && selectionMode && (
        <Box
          role="toolbar"
          aria-label="Bulk chat actions"
          sx={{
            display: 'flex',
            justifyContent: 'center',
            gap: 0.5,
            px: 1.5,
            py: 0.75,
            borderTop: (theme) => `1px solid ${theme.palette.divider}`,
          }}
        >
          {onBulkArchive && (
            <Tooltip title="Archive selected chats">
              <span>
                <IconButton
                  size="small"
                  disabled={selectedActiveIds.length === 0}
                  aria-label="Archive selected chats"
                  onClick={() => runBulkAction(onBulkArchive, selectedActiveIds, true)}
                >
                  <ArchiveOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {onBulkRestore && (
            <Tooltip title="Restore selected chats">
              <span>
                <IconButton
                  size="small"
                  disabled={selectedArchivedIds.length === 0}
                  aria-label="Restore selected chats"
                  onClick={() => runBulkAction(onBulkRestore, selectedArchivedIds, true)}
                >
                  <ArchiveOutlinedIcon fontSize="small" sx={{ transform: 'rotate(180deg)' }} />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {onBulkExport && (
            <Tooltip title="Export selected chats">
              <span>
                <IconButton
                  size="small"
                  disabled={selectedIds.length === 0}
                  aria-label="Export selected chats"
                  onClick={() => runBulkAction(onBulkExport, selectedIds)}
                >
                  <FileDownloadOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {onBulkDelete && (
            <Tooltip title="Delete selected chats">
              <span>
                <IconButton
                  size="small"
                  color="error"
                  disabled={selectedIds.length === 0}
                  aria-label="Delete selected chats"
                  onClick={() => runBulkAction(onBulkDelete, selectedIds)}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 1, px: collapsed ? 1 : 2, py: 1.25, borderTop: (theme) => `1px solid ${theme.palette.divider}`, color: 'text.secondary' }}>
        <Avatar src={BOT_AVATAR} alt="" sx={{ width: 20, height: 20, bgcolor: '#0a2c4d' }} />
        {!collapsed && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>Grounded in WindowsForum threads</Typography>}
      </Box>
    </Box>
  );

  return (
    <>
      <Drawer
        variant="permanent"
        open
        sx={{
          display: { xs: 'none', md: 'block' },
          width: desktopCollapsed ? 64 : 288,
          flexShrink: 0,
          transition: 'width 160ms ease',
          '& .MuiDrawer-paper': {
            position: 'relative',
            width: desktopCollapsed ? 64 : 288,
            height: '100%',
            overflow: 'hidden',
            bgcolor: 'background.paper',
            transition: 'width 160ms ease',
          },
        }}
      >
        {renderContent(desktopCollapsed, false)}
      </Drawer>

      <SwipeableDrawer
        anchor="left"
        open={open}
        onOpen={handleMobileOpen}
        onClose={onClose}
        ModalProps={{ keepMounted: true, container: () => document.getElementById('wf-chat-window') }}
        slotProps={{
          paper: { className: 'wf-history-mobile-drawer', 'aria-label': 'Chat history' },
          transition: {
            onEntered: () => {
              if (!shortcutFocusPendingRef.current) return;
              shortcutFocusPendingRef.current = false;
              focusSearch(true);
            },
            onExited: () => {
              const returnFocus = mobileReturnFocusRef.current;
              mobileReturnFocusRef.current = null;
              if (returnFocus?.isConnected) returnFocus.focus();
            },
          },
        }}
        sx={{ display: { xs: 'block', md: 'none' }, '& .MuiDrawer-paper': { width: '92vw', maxWidth: '360px', bgcolor: 'background.paper' } }}
      >
        {renderContent(false, true)}
      </SwipeableDrawer>

      <Menu
        id={conversationMenuId}
        anchorEl={menuState?.anchor ?? null}
        open={Boolean(menuState)}
        disableRestoreFocus
        onClose={closeConversationMenu}
        container={() => document.getElementById('wf-chat-window')}
        slotProps={{
          list: { 'aria-label': menuState ? `Actions for ${menuState.conversation.title}` : 'Conversation actions' },
          transition: {
            onExited: () => {
              const pendingDialogAction = pendingMenuDialogActionRef.current;
              pendingMenuDialogActionRef.current = null;
              if (pendingDialogAction) {
                (pendingDialogAction.mobile ? mobileSearchRef : desktopSearchRef).current?.focus();
                pendingDialogAction.run();
                return;
              }
              const pendingFocus = pendingMenuFocusRef.current;
              pendingMenuFocusRef.current = null;
              if (!pendingFocus) return;
              if (pendingFocus.mobile && !mobileDrawerOpenRef.current) return;
              // Pinning may move a row and archiving/restoring may remove it
              // from this view. Wait until Modal restores focus, then choose
              // the same row, a neighbour, or finally the search field.
              const refs = pendingFocus.mobile ? mobileResultRefs : desktopResultRefs;
              const result = [pendingFocus.conversationId, ...pendingFocus.fallbackIds]
                .map(id => refs.current.get(id))
                .find(Boolean);
              const trigger = pendingFocus.trigger.isConnected ? pendingFocus.trigger : null;
              (trigger ?? result ?? (pendingFocus.mobile ? mobileSearchRef : desktopSearchRef).current)?.focus();
            },
          },
        }}
      >
        {onPinConversation && !menuState?.conversation.archivedAt && (
          <MenuItem onClick={() => {
            runConversationMenuAction(conversation => {
              onPinConversation(conversation.id, !conversation.pinnedAt);
            });
          }}>
            <PushPinOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />
            {menuState?.conversation.pinnedAt ? 'Unpin' : 'Pin'}
          </MenuItem>
        )}
        {onArchiveConversation && (
          <MenuItem onClick={() => {
            runConversationMenuAction(conversation => {
              onArchiveConversation(conversation.id, !conversation.archivedAt);
            });
          }}>
            {menuState?.conversation.archivedAt
              ? <ArchiveOutlinedIcon fontSize="small" sx={{ mr: 1.25, transform: 'rotate(180deg)' }} />
              : <ArchiveOutlinedIcon fontSize="small" sx={{ mr: 1.25 }} />}
            {menuState?.conversation.archivedAt ? 'Restore' : 'Archive'}
          </MenuItem>
        )}
        {onRenameConversation && (
          <MenuItem onClick={() => {
            runConversationDialogAction(conversation => onRenameConversation(conversation.id));
          }}>
            <EditIcon fontSize="small" sx={{ mr: 1.25 }} /> Rename
          </MenuItem>
        )}
        <MenuItem sx={{ color: 'error.main' }} onClick={() => {
          runConversationDialogAction(conversation => onDeleteConversation(conversation.id));
        }}>
          <DeleteIcon fontSize="small" sx={{ mr: 1.25 }} /> Delete
        </MenuItem>
      </Menu>
    </>
  );
});

ConversationSidebar.displayName = 'ConversationSidebar';
