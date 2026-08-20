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
    expect(screen.getAllByRole('link', { name: 'Duplicate source' })).toHaveLength(1);
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('guide.pdf')).toBeInTheDocument();
  });

  it('renders inline citation markers as controls that focus and highlight their source', () => {
    renderMessage('See [example.com](https://example.com/docs) for details.');

    const marker = screen.getByRole('button', { name: 'Go to source 1' });
    const source = screen.getByRole('listitem', { name: 'Source 1: Duplicate source' });
    expect(marker).toHaveAttribute('type', 'button');

    fireEvent.click(marker);

    expect(source).toHaveFocus();
    expect(source).toHaveAttribute('data-source-highlighted', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Source 1 focused.');
  });

  it('folds a provider-authored trailing Sources section into the unified panel', () => {
    renderMessage([
      'Use the supported recovery steps above.',
      '',
      '### Sources',
      '- [example.com](https://example.com/docs)',
      '- [Microsoft Learn](https://learn.microsoft.com/en-us/windows/)',
    ].join('\n'));

    expect(screen.getAllByText('Sources')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Sources' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Duplicate source' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Microsoft Learn' })).toHaveLength(1);
  });

  it('deduplicates canonical URL variants while preserving inline numbering', () => {
    renderMessage([
      'First [docs.example.com](https://docs.example.com/setup/?utm_source=chat#install).',
      'Then [docs.example.com](https://docs.example.com/setup?gclid=tracking).',
    ].join('\n\n'), []);

    expect(screen.getAllByRole('button', { name: 'Go to source 1' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Go to source 2' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'docs.example.com' })).toBeInTheDocument();
  });

  it('collapses long source lists and expands when an inline marker targets a hidden row', () => {
    const rawContent = Array.from({ length: 6 }, (_, index) => {
      const number = index + 1;
      return `[source${number}.example.com](https://source${number}.example.com/article)`;
    }).join(' ');
    renderMessage(rawContent, []);

    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(document.querySelectorAll('[data-source-row-index]')).toHaveLength(6);
    expect(document.querySelector('[data-source-row-index="6"]')).toHaveAttribute('data-source-collapsed', 'true');
    expect(screen.getByRole('button', { name: 'Show 2 more sources' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Go to source 6' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Show fewer sources' })).toHaveAttribute('aria-expanded', 'true');
    const sixthSource = screen.getByRole('listitem', { name: 'Source 6: source6.example.com' });
    expect(sixthSource).toHaveFocus();
    expect(sixthSource).toHaveAttribute('data-source-highlighted', 'true');
  });

  it('reports a source index and turn correlation without sending its URL', () => {
    renderMessage('See [example.com](https://example.com/docs) for details.');

    fireEvent.click(screen.getByRole('link', { name: 'Duplicate source' }));
    expect(telemetryMocks.reportSourceOpened).toHaveBeenCalledWith('url', 1, 'turn-1');
  });

  it('reports ordinary external answer links as unnumbered sources', () => {
    renderMessage('Open [the documentation](https://learn.example/path).', []);

    fireEvent.click(screen.getByRole('link', { name: 'the documentation' }));
    expect(telemetryMocks.reportSourceOpened).toHaveBeenCalledWith('url', undefined, 'turn-1');
  });
});
