import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const telemetryMocks = vi.hoisted(() => ({
  reportClientEvent: vi.fn(),
  reportSourceOpened: vi.fn(),
}));

vi.mock('../services/telemetry', () => ({
  reportClientEvent: telemetryMocks.reportClientEvent,
  reportSourceOpened: telemetryMocks.reportSourceOpened,
}));

import { Message } from '../components/Message';

const theme = createTheme();
const renderMessage = (rawContent: string, annotations = [
  { type: 'url_citation' as const, url: 'https://example.com/docs', title: 'Duplicate source' },
  { type: 'file_citation' as const, filename: 'guide.pdf' },
]) => render(
  <ThemeProvider theme={theme}>
    <Message
      msg={{
        id: 'answer-1',
        role: 'ai',
        rawContent,
        timestamp: 1_700_000_000_000,
        status: 'complete',
        turnId: 'turn-1',
        annotations,
      }}
      userAvatar="/avatar.webp"
      userName="Member"
      onEdit={vi.fn()}
      onRegenerate={vi.fn()}
      onRetry={vi.fn()}
      isLastMessage
      isStreaming={false}
    />
  </ThemeProvider>,
);

afterEach(() => {
  cleanup();
  telemetryMocks.reportSourceOpened.mockReset();
  telemetryMocks.reportClientEvent.mockReset();
});

describe('unified message sources', () => {
  it('deduplicates inline and annotation citations into one source panel', () => {
    renderMessage('See [example.com](https://example.com/docs) for details.');

    expect(screen.getAllByText('Sources')).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'example.com' })).toHaveLength(1);
    expect(screen.queryByText('Duplicate source')).not.toBeInTheDocument();
    expect(screen.getByText('guide.pdf')).toBeInTheDocument();
  });

  it('reports a source index and turn correlation without sending its URL', () => {
    renderMessage('See [example.com](https://example.com/docs) for details.');

    fireEvent.click(screen.getByRole('link', { name: 'example.com' }));
    expect(telemetryMocks.reportSourceOpened).toHaveBeenCalledWith('url', 1, 'turn-1');
  });

  it('reports ordinary external answer links as unnumbered sources', () => {
    renderMessage('Open [the documentation](https://learn.example/path).', []);

    fireEvent.click(screen.getByRole('link', { name: 'the documentation' }));
    expect(telemetryMocks.reportSourceOpened).toHaveBeenCalledWith('url', undefined, 'turn-1');
  });
});
