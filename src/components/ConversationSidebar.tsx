import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Avatar from '@mui/material/Avatar';
import IconButton from '@mui/material/IconButton';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type { ConversationSidebarProps } from '../types';
import { ASSISTANT_NAME, BOT_AVATAR } from '../config/brand';

/**
 * ConversationSidebar Component — branded WindowsForum chat history.
 */
export const ConversationSidebar: React.FC<ConversationSidebarProps> = ({
  open,
  onClose,
  conversations,
  currentConversationId,
  onSelectConversation,
  onDeleteConversation,
  onNewConversation,
}) => {
  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={onClose}
      sx={{ '& .MuiDrawer-paper': { width: 288, backgroundColor: 'background.paper' } }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Brand header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.25,
            px: 2,
            py: 1.75,
            borderBottom: (t) => `1px solid ${t.palette.divider}`,
          }}
        >
          <Avatar src={BOT_AVATAR} alt={ASSISTANT_NAME} sx={{ width: 30, height: 30, bgcolor: '#0a2c4d' }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 14, lineHeight: 1.1 }}>Ask the AI</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
              {ASSISTANT_NAME} ·{' '}
              <Box component="span" sx={{ color: 'primary.main', fontWeight: 700 }}>BETA</Box>
            </Typography>
          </Box>
        </Box>

        <Box sx={{ p: 1.5 }}>
          <Button
            fullWidth
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              onNewConversation();
              onClose();
            }}
          >
            New chat
          </Button>
        </Box>

        <Typography
          sx={{
            px: 2,
            pt: 0.5,
            pb: 0.5,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'text.secondary',
          }}
        >
          Recent chats
        </Typography>

        <List sx={{ flex: 1, overflowY: 'auto', px: 1, py: 0 }}>
          {conversations.map((conv) => {
            const selected = conv.id === currentConversationId;
            return (
              <ListItemButton
                key={conv.id}
                selected={selected}
                onClick={() => onSelectConversation(conv.id)}
                sx={{
                  borderRadius: 1.5,
                  mb: 0.25,
                  gap: 1.25,
                  '&.Mui-selected': {
                    backgroundColor: 'secondary.main',
                    color: '#fff',
                    '&:hover': { backgroundColor: 'secondary.main' },
                  },
                  '&:hover .delete-btn': { opacity: 1 },
                  '&:focus-within .delete-btn': { opacity: 1 },
                }}
              >
                <ChatBubbleOutlineIcon sx={{ fontSize: 16, opacity: 0.85, flexShrink: 0 }} />
                <ListItemText
                  primary={conv.title}
                  slotProps={{ primary: { noWrap: true, sx: { fontSize: 13, fontWeight: 500 } } }}
                />
                <IconButton
                  className="delete-btn"
                  aria-label="Delete conversation"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation(conv.id);
                  }}
                  sx={{
                    opacity: 0,
                    transition: 'opacity 0.2s',
                    color: 'inherit',
                    '&:focus-visible': { opacity: 1 },
                    '@media (hover: none), (pointer: coarse)': { opacity: 1 },
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </ListItemButton>
            );
          })}
        </List>

        {/* Footer */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            py: 1.25,
            borderTop: (t) => `1px solid ${t.palette.divider}`,
            fontSize: 11,
            color: 'text.secondary',
          }}
        >
          <Avatar src={BOT_AVATAR} alt="" sx={{ width: 20, height: 20, bgcolor: '#0a2c4d' }} />
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            Grounded in WindowsForum threads
          </Typography>
        </Box>
      </Box>
    </Drawer>
  );
};
