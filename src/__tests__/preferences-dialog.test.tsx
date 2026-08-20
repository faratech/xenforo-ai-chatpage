import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  getPreferences: vi.fn(() => ({ voice: 'alloy', speed: 1 })),
  save: vi.fn((preferences: { voice: string; speed: number }) => preferences),
  start: vi.fn(),
  subscribe: vi.fn((listener: (available: boolean) => void) => {
    listener(true);
    return vi.fn();
  }),
  prompt: vi.fn().mockResolvedValue('accepted'),
  notificationPreference: vi.fn(() => 'disabled'),
  notificationSupported: vi.fn(() => true),
  requestNotifications: vi.fn().mockResolvedValue('granted'),
  setNotificationPreference: vi.fn(),
}));

vi.mock('../services/speech', () => ({
  AudioService: {
    configure: mocks.configure,
    getPreferences: mocks.getPreferences,
  },
  TTS_VOICES: ['alloy', 'cedar'],
  saveStoredTTSPreferences: mocks.save,
}));

vi.mock('../services/pwa', () => ({
  pwaInstallPrompt: {
    available: true,
    start: mocks.start,
    subscribe: mocks.subscribe,
    prompt: mocks.prompt,
  },
}));

vi.mock('../services/completionNotifications', () => ({
  completionNotificationsSupported: mocks.notificationSupported,
  getCompletionNotificationPreference: mocks.notificationPreference,
  requestCompletionNotifications: mocks.requestNotifications,
  setCompletionNotificationPreference: mocks.setNotificationPreference,
}));

import { PreferencesDialog } from '../components/PreferencesDialog';

const theme = createTheme();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('chat preferences dialog', () => {
  it('offers explicit installation and persists read-aloud choices', async () => {
    render(
      <ThemeProvider theme={theme}>
        <PreferencesDialog open onClose={vi.fn()} voiceEnabled />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Install WindowsForum AI' }));
    await waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('WindowsForum AI was added to this device.')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Voice' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Cedar' }));
    expect(mocks.save).toHaveBeenCalledWith({ voice: 'cedar', speed: 1 });
    expect(mocks.configure).toHaveBeenCalledWith({ voice: 'cedar', speed: 1 });
  });

  it('lists the keyboard commands implemented by the chat surface', () => {
    render(
      <ThemeProvider theme={theme}>
        <PreferencesDialog open onClose={vi.fn()} voiceEnabled={false} />
      </ThemeProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('Send message')).toBeInTheDocument();
    expect(screen.getByText('Add a new line')).toBeInTheDocument();
    expect(screen.getByText('Search chat history')).toBeInTheDocument();
    expect(screen.getByText('Save a message edit')).toBeInTheDocument();
    expect(screen.getByText('Cancel a message edit')).toBeInTheDocument();
    expect([...document.querySelectorAll('kbd')].map(key => key.textContent)).toEqual([
      'Enter',
      'Shift', 'Enter',
      'Ctrl/⌘', 'K',
      'Ctrl/⌘', 'Enter',
      'Esc',
    ]);
  });

  it('requests notification permission only from the explicit settings action', async () => {
    render(
      <ThemeProvider theme={theme}>
        <PreferencesDialog open onClose={vi.fn()} voiceEnabled={false} />
      </ThemeProvider>,
    );

    expect(mocks.requestNotifications).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications' }));
    await waitFor(() => expect(mocks.requestNotifications).toHaveBeenCalledOnce());
    expect(await screen.findByText('Completion notifications are on for this device.')).toBeInTheDocument();
  });
});
