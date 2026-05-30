import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type { ConversationSidebarProps } from '../types';

/**
 * ConversationSidebar Component - Displays conversation history
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
  const theme = useTheme();

  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={onClose}
      sx={{
        '& .MuiDrawer-paper': {
          width: 280,
          backgroundColor: theme.palette.mode === 'light' ? '#f7f7f8' : '#202123',
        }
      }}
    >
      <Box sx={{ p: 2 }}>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => {
            onNewConversation();
            onClose();
          }}
          sx={{ mb: 2 }}
        >
          New Chat
        </Button>

        <Typography variant="subtitle2" sx={{ mb: 1, opacity: 0.7 }}>
          Recent Chats
        </Typography>

        <List>
          {conversations.map((conv) => (
            <React.Fragment key={conv.id}>
              <ListItemButton
                selected={conv.id === currentConversationId}
                onClick={() => onSelectConversation(conv.id)}
                sx={{
                  borderRadius: 1,
                  mb: 0.5,
                  '&:hover .delete-btn': {
                    opacity: 1,
                  }
                }}
              >
                <ListItemText
                  primary={conv.title}
                  secondary={new Date(conv.updatedAt).toLocaleDateString()}
                  slotProps={{
                    primary: {
                      noWrap: true,
                      sx: { fontSize: '0.875rem' },
                    },
                    secondary: {
                      sx: { fontSize: '0.75rem' },
                    },
                  }}
                />
                <IconButton
                  className="delete-btn"
                  aria-label="Delete conversation"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation(conv.id);
                  }}
                  sx={{ opacity: 0, transition: 'opacity 0.2s' }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </ListItemButton>
            </React.Fragment>
          ))}
        </List>
      </Box>
    </Drawer>
  );
};