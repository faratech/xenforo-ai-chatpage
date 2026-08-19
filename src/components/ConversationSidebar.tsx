import { memo, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Drawer from '@mui/material/Drawer';
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
  onClose,
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
  const [menuState, setMenuState] = useState<{
    anchor: HTMLElement;
    conversation: Conversation;
  } | null>(null);

  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = normalized
      ? conversations.filter(conversation => (
        conversation.title.toLocaleLowerCase().includes(normalized)
        || conversation.messages.some(message => message.rawContent.toLocaleLowerCase().includes(normalized))
      ))
      : conversations;

    return GROUP_ORDER.map(label => ({
      label,
      conversations: filtered.filter(conversation => groupForDate(conversation.updatedAt) === label),
    })).filter(group => group.conversations.length > 0);
  }, [conversations, query]);

  const chooseConversation = (conversationId: string, closeAfter: boolean) => {
    onSelectConversation(conversationId);
    if (closeAfter) onClose();
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chat history"
            size="small"
            fullWidth
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment>
                ),
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setQuery('')} aria-label="Clear chat search"><CloseIcon fontSize="small" /></IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
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
            {group.conversations.map(conversation => {
              const selected = conversation.id === currentConversationId;
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
                    selected={selected}
                    aria-current={selected ? 'page' : undefined}
                    aria-label={collapsed ? conversation.title : undefined}
                    onClick={() => chooseConversation(conversation.id, mobile)}
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
                        primary={conversation.title}
                        secondary={conversation.draft?.trim() ? 'Draft saved' : undefined}
                        slotProps={{
                          primary: { noWrap: true, sx: { fontSize: 13, fontWeight: selected ? 650 : 500 } },
                          secondary: { noWrap: true, sx: { fontSize: 10.5, color: 'primary.main' } },
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

      <Drawer
        anchor="left"
        open={open}
        onClose={onClose}
        ModalProps={{ container: () => document.getElementById('wf-chat-window') }}
        sx={{ display: { xs: 'block', md: 'none' }, '& .MuiDrawer-paper': { width: 'min(88vw, 320px)', bgcolor: 'background.paper' } }}
      >
        {renderContent(false, true)}
      </Drawer>

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
