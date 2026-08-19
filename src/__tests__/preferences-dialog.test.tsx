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
});
