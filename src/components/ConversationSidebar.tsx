import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import MenuIcon from '@mui/icons-material/Menu';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import SearchIcon from '@mui/icons-material/Search';
import type { Conversation, ConversationSidebarProps } from '../types';
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';

type DateGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

interface ConversationSearchResult {
  conversation: Conversation;
  excerpt?: string;
  matchCount: number;
}

const normalizeSearchText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const countMatches = (value: string, normalizedQuery: string): number => {
  const haystack = normalizeSearchText(value).toLocaleLowerCase();
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

const excerptAroundMatch = (value: string, normalizedQuery: string): string | undefined => {
  const compact = normalizeSearchText(value);
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
  desktopCollapsed = false,
  onToggleDesktopCollapsed,
}) => {
  const [query, setQuery] = useState('');
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [menuState, setMenuState] = useState<{
    anchor: HTMLElement;
    conversation: Conversation;
  } | null>(null);
  const desktopSearchRef = useRef<HTMLInputElement | null>(null);
  const mobileSearchRef = useRef<HTMLInputElement | null>(null);
  const desktopResultRefs = useRef(new Map<string, HTMLDivElement>());
  const mobileResultRefs = useRef(new Map<string, HTMLDivElement>());
  const shortcutFocusPendingRef = useRef(false);
  const searchSessionReportedRef = useRef(false);
  const [searchAnnouncement, setSearchAnnouncement] = useState('');
  const handleMobileOpen = useCallback(() => onOpen?.(), [onOpen]);

  const normalizedQuery = normalizeSearchText(query).toLocaleLowerCase();

  const searchResults = useMemo<ConversationSearchResult[]>(() => conversations.flatMap(conversation => {
    if (!normalizedQuery) return [{ conversation, matchCount: 0 }];

    const titleMatches = countMatches(conversation.title, normalizedQuery);
    let messageMatches = 0;
    let excerpt: string | undefined;
    for (const message of conversation.messages) {
      const matches = countMatches(message.rawContent, normalizedQuery);
      messageMatches += matches;
      if (!excerpt && matches > 0) excerpt = excerptAroundMatch(message.rawContent, normalizedQuery);
    }

    const matchCount = titleMatches + messageMatches;
    return matchCount > 0 ? [{
      conversation,
      excerpt: excerpt ?? excerptAroundMatch(conversation.title, normalizedQuery),
      matchCount,
    }] : [];
  }), [conversations, normalizedQuery]);

  const groups = useMemo(() => {
    return GROUP_ORDER.map(label => ({
      label,
      results: searchResults.filter(result => groupForDate(result.conversation.updatedAt) === label),
    })).filter(group => group.results.length > 0);
  }, [searchResults]);

  const orderedResults = useMemo(() => groups.flatMap(group => group.results), [groups]);
  const resultIndexById = useMemo(() => new Map(
    orderedResults.map((result, index) => [result.conversation.id, index]),
  ), [orderedResults]);

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
      else if (mobile) onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusResult(resultIndex + (event.key === 'ArrowDown' ? 1 : -1), mobile);
    }
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
              const selected = conversation.id === currentConversationId;
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
                    '&::before': selected ? {
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
                    id={`wf-history-${mobile ? 'mobile' : 'desktop'}-result-${resultIndex}`}
                    ref={(element) => {
                      const refs = mobile ? mobileResultRefs : desktopResultRefs;
                      if (element) refs.current.set(conversation.id, element);
                      else refs.current.delete(conversation.id);
                    }}
                    selected={selected}
                    aria-current={selected ? 'page' : undefined}
                    aria-label={collapsed ? conversation.title : undefined}
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
                    <ChatBubbleOutlineIcon sx={{ fontSize: 17, opacity: 0.85, flexShrink: 0 }} />
                    {!collapsed && (
                      <ListItemText
                        primary={normalizedQuery ? highlightMatches(conversation.title, normalizedQuery) : conversation.title}
                        secondary={normalizedQuery ? (
                          <>
                            <Box component="span" sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}>
                              {highlightMatches(result.excerpt ?? conversation.title, normalizedQuery)}
                            </Box>
                            <Box component="span" sx={{ display: 'block', mt: 0.25, color: 'text.secondary', fontSize: 10 }}>
                              {result.matchCount} {result.matchCount === 1 ? 'match' : 'matches'}
                            </Box>
                          </>
                        ) : conversation.draft?.trim() ? 'Draft saved' : undefined}
                        slotProps={{
                          primary: { noWrap: true, sx: { fontSize: 13, fontWeight: selected ? 650 : 500 } },
                          secondary: { component: 'div', sx: { fontSize: 10.5, color: normalizedQuery ? 'text.secondary' : 'primary.main' } },
                        }}
                      />
                    )}
                  </ListItemButton>
                  {!collapsed && (
                    <IconButton
                      className="conversation-menu"
                      aria-label={`Actions for ${conversation.title}`}
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
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>No chats match “{query.trim()}”.</Typography>
          </Box>
        )}
      </List>

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
          },
        }}
        sx={{ display: { xs: 'block', md: 'none' }, '& .MuiDrawer-paper': { width: '92vw', maxWidth: '360px', bgcolor: 'background.paper' } }}
      >
        {renderContent(false, true)}
      </SwipeableDrawer>

      <Menu
        anchorEl={menuState?.anchor ?? null}
        open={Boolean(menuState)}
        onClose={() => setMenuState(null)}
        container={() => document.getElementById('wf-chat-window')}
      >
        {onRenameConversation && (
          <MenuItem onClick={() => {
            if (menuState) onRenameConversation(menuState.conversation.id);
            setMenuState(null);
          }}>
            <EditIcon fontSize="small" sx={{ mr: 1.25 }} /> Rename
          </MenuItem>
        )}
        <MenuItem sx={{ color: 'error.main' }} onClick={() => {
          if (menuState) onDeleteConversation(menuState.conversation.id);
          setMenuState(null);
        }}>
          <DeleteIcon fontSize="small" sx={{ mr: 1.25 }} /> Delete
        </MenuItem>
      </Menu>
    </>
  );
});

ConversationSidebar.displayName = 'ConversationSidebar';
