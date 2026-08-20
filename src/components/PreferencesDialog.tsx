import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import InstallDesktopOutlinedIcon from '@mui/icons-material/InstallDesktopOutlined';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import {
  AudioService,
  TTS_VOICES,
  saveStoredTTSPreferences,
  type TTSPreferences,
  type TTSVoice,
} from '../services/speech';
import { pwaInstallPrompt, type InstallPromptOutcome } from '../services/pwa';
import {
  completionNotificationsSupported,
  getCompletionNotificationPreference,
  requestCompletionNotifications,
  setCompletionNotificationPreference,
} from '../services/completionNotifications';

export interface PreferencesDialogProps {
  open: boolean;
  onClose: () => void;
  voiceEnabled: boolean;
}

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5] as const;
const voiceLabel = (voice: string): string => voice.charAt(0).toUpperCase() + voice.slice(1);

const SHORTCUTS = [
  { label: 'Send message', keys: ['Enter'] },
  { label: 'Add a new line', keys: ['Shift', 'Enter'] },
  { label: 'Search chat history', keys: ['Ctrl/⌘', 'K'] },
  { label: 'Save a message edit', keys: ['Ctrl/⌘', 'Enter'] },
  { label: 'Cancel a message edit', keys: ['Esc'] },
] as const;

const KeyboardShortcut = ({ label, keys }: (typeof SHORTCUTS)[number]) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 2,
      py: 0.5,
    }}
  >
    <Typography component="dt" variant="body2">{label}</Typography>
    <Box
      component="dd"
      aria-label={`${label}: ${keys.join(' plus ')}`}
      sx={{ m: 0, display: 'inline-flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}
    >
      {keys.map((key, index) => (
        <Box key={key} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          {index > 0 && <Typography component="span" aria-hidden variant="caption" color="text.secondary">+</Typography>}
          <Box
            component="kbd"
            aria-hidden
            sx={{
              minWidth: 28,
              px: 0.75,
              py: 0.25,
              border: theme => `1px solid ${theme.palette.divider}`,
              borderBottomWidth: 2,
              borderRadius: 1,
              bgcolor: 'action.hover',
              color: 'text.secondary',
              fontFamily: 'inherit',
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1.35,
              textAlign: 'center',
            }}
          >
            {key}
          </Box>
        </Box>
      ))}
    </Box>
  </Box>
);

const installOutcomeText = (outcome: InstallPromptOutcome): string => {
  if (outcome === 'accepted') return 'WindowsForum AI was added to this device.';
  if (outcome === 'dismissed') return 'Installation was cancelled.';
  return 'Installation is not currently offered by this browser.';
};

/** Device-level chat preferences; no prompt or conversation content is stored. */
export const PreferencesDialog = ({ open, onClose, voiceEnabled }: PreferencesDialogProps) => {
  const [preferences, setPreferences] = useState<TTSPreferences>(() => AudioService.getPreferences());
  const [installAvailable, setInstallAvailable] = useState(pwaInstallPrompt.available);
  const [installing, setInstalling] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => getCompletionNotificationPreference() === 'enabled'
  );
  const [requestingNotifications, setRequestingNotifications] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    pwaInstallPrompt.start();
    return pwaInstallPrompt.subscribe(setInstallAvailable);
  }, []);

  const updatePreferences = (patch: Partial<TTSPreferences>) => {
    const next = saveStoredTTSPreferences({ ...preferences, ...patch });
    AudioService.configure(next);
    setPreferences(next);
    setNotice('Voice preferences saved on this device.');
  };

  const installApp = async () => {
    if (installing) return;
    setInstalling(true);
    setNotice(null);
    try {
      setNotice(installOutcomeText(await pwaInstallPrompt.prompt()));
    } finally {
      setInstalling(false);
    }
  };

  const toggleCompletionNotifications = async () => {
    if (requestingNotifications) return;
    setRequestingNotifications(true);
    setNotice(null);
    try {
      if (notificationsEnabled) {
        setCompletionNotificationPreference('disabled');
        setNotificationsEnabled(false);
        setNotice('Completion notifications are off on this device.');
        return;
      }
      const permission = await requestCompletionNotifications();
      if (permission === 'granted') {
        setNotificationsEnabled(true);
        setNotice('Completion notifications are on for this device.');
      } else if (permission === 'denied') {
        setNotice('Notifications are blocked by your browser. Allow them in site settings to turn this on.');
      } else {
        setNotice('Completion notifications are not supported by this browser.');
      }
    } finally {
      setRequestingNotifications(false);
    }
  };

  const closeDialog = () => {
    if (installing || requestingNotifications) return;
    setNotice(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      fullWidth
      maxWidth="xs"
      aria-labelledby="wf-chat-settings-title"
      container={() => document.getElementById('wf-chat-window')}
    >
      <DialogTitle id="wf-chat-settings-title">
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <SettingsOutlinedIcon color="primary" />
          <Typography component="span" variant="h6">Chat settings</Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.25}>
          {notice && <Alert severity="info" role="status">{notice}</Alert>}

          <Box component="section" aria-labelledby="wf-install-heading">
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
              <InstallDesktopOutlinedIcon color="primary" />
              <Typography id="wf-install-heading" component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
                Install app
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>
              Open WindowsForum AI in its own window and keep a launcher on this device.
            </Typography>
            <Button
              variant="outlined"
              startIcon={<InstallDesktopOutlinedIcon />}
              disabled={!installAvailable || installing}
              onClick={() => { void installApp(); }}
            >
              {installing ? 'Opening installer…' : 'Install WindowsForum AI'}
            </Button>
            {!installAvailable && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                If your browser supports installation, use its app or “Add to home screen” menu.
              </Typography>
            )}
          </Box>

          <Divider />
          <Box component="section" aria-labelledby="wf-notifications-heading">
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
              <NotificationsOutlinedIcon color="primary" />
              <Box>
                <Typography id="wf-notifications-heading" component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Completion notifications
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Notify you when a response finishes while this tab is in the background.
                </Typography>
              </Box>
            </Stack>
            <Button
              variant="outlined"
              startIcon={<NotificationsOutlinedIcon />}
              disabled={!completionNotificationsSupported() || requestingNotifications}
              onClick={() => { void toggleCompletionNotifications(); }}
            >
              {requestingNotifications
                ? 'Checking permission…'
                : notificationsEnabled ? 'Turn off notifications' : 'Turn on notifications'}
            </Button>
            {!completionNotificationsSupported() && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                This browser does not support desktop notifications.
              </Typography>
            )}
          </Box>

          {voiceEnabled && (
            <>
              <Divider />
              <Box component="section" aria-labelledby="wf-voice-heading">
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.25 }}>
                  <RecordVoiceOverOutlinedIcon color="primary" />
                  <Box>
                    <Typography id="wf-voice-heading" component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
                      Read aloud
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Used when you play an assistant answer.
                    </Typography>
                  </Box>
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Voice"
                    value={preferences.voice}
                    onChange={event => updatePreferences({ voice: event.target.value as TTSVoice })}
                  >
                    {TTS_VOICES.map(voice => (
                      <MenuItem key={voice} value={voice}>{voiceLabel(voice)}</MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Speed"
                    value={preferences.speed}
                    onChange={event => updatePreferences({ speed: Number(event.target.value) })}
                  >
                    {SPEED_OPTIONS.map(speed => (
                      <MenuItem key={speed} value={speed}>{speed}×</MenuItem>
                    ))}
                  </TextField>
                </Stack>
              </Box>
            </>
          )}

          <Divider />
          <Box component="section" aria-labelledby="wf-shortcuts-heading">
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
              <KeyboardOutlinedIcon color="primary" />
              <Box>
                <Typography id="wf-shortcuts-heading" component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Keyboard shortcuts
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Move through chat without leaving the keyboard.
                </Typography>
              </Box>
            </Stack>
            <Box component="dl" sx={{ m: 0 }}>
              {SHORTCUTS.map(shortcut => <KeyboardShortcut key={shortcut.label} {...shortcut} />)}
            </Box>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeDialog} disabled={installing || requestingNotifications}>Done</Button>
      </DialogActions>
    </Dialog>
  );
};
