import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { SupportResponseDetails } from '../components/SupportResponseDetails';
import type { ChatResponseDetails, SupportCard } from '../services/supportContracts';

const theme = createTheme();
const card: SupportCard = { id: 'step_1', check: 'Check your Windows build', explanation: 'Read the version first.', expected_result: 'A build number', evidence_ids: ['ev_1'], command: 'winver' };
const show = (details: ChatResponseDetails, props: Partial<React.ComponentProps<typeof SupportResponseDetails>> = {}) => render(
  <ThemeProvider theme={theme}><SupportResponseDetails details={details} {...props} /></ThemeProvider>,
);
beforeAll(() => Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) }));
afterEach(() => cleanup());

describe('support response details', () => {
  it('renders cards and source excerpts as text and omits unsafe links', async () => {
    const injection = '<img src=x onerror="alert(1)">';
    show({ cards: [{ ...card, check: injection, command: '<script>run()</script>' }], evidence: [{ id: 'ev_1', title: injection, kind: 'web', url: 'javascript:alert(1)', excerpt: injection }] });
    fireEvent.click(screen.getByRole('button', { name: injection }));
    expect(screen.getByText('<script>run()</script>')).toBeInTheDocument();
    expect(document.querySelector('script, img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View evidence and context' }));
    expect(await screen.findByRole('dialog', { name: 'Evidence and context' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('script, img')).toBeNull();
  });

  it('shows reviewed context and diagnostic line locations without fabricated metadata', async () => {
    show({ context: { mode: 'troubleshoot', case_id: 'case_1', case_revision: 3, included_attachment_ids: ['att_1'], history_items: 4, history_limit: 250, history_item_bytes: 32768, recovery_used: true, history_truncated: true }, evidence: [{ id: 'diag_1', kind: 'diagnostic', title: 'reviewed.log', line_start: 10, line_end: 14 }] });
    fireEvent.click(screen.getByRole('button', { name: 'View evidence and context' }));
    expect(await screen.findByText('Support case revision 3')).toBeInTheDocument();
    expect(screen.getByText('Selected attachments: 1')).toBeInTheDocument();
    expect(screen.getByText('Submitted text, lines 10–14')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Older or longer messages were omitted');
    expect(screen.queryByText(/^Published:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Retrieved:/)).not.toBeInTheDocument();
  });

  it('records an explicit result and prevents repeat saves while pending', async () => {
    let finish!: () => void;
    const onOutcome = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    show({ cards: [card] }, { onOutcome });
    fireEvent.click(screen.getByRole('button', { name: card.check }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Result of this check' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Helped' }));
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The issue stopped.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result to case' }));
    expect(onOutcome).toHaveBeenCalledWith(card, 'helped', 'The issue stopped.');
    expect(screen.getByRole('button', { name: 'Save result to case' })).toBeDisabled();
    finish();
    expect(await screen.findByRole('status')).toHaveTextContent('Result saved to your support case.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save result to case' })).toBeEnabled());
  });

  it('preserves entered observations after a revision conflict and supports disabled controls', async () => {
    const onOutcome = vi.fn().mockRejectedValue(new Error('Case revision conflict. Reload the latest case.'));
    const { rerender } = show({ cards: [card] }, { onOutcome });
    fireEvent.click(screen.getByRole('button', { name: card.check }));
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'My unsaved observation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save result to case' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Case revision conflict');
    expect(screen.getByLabelText('What happened?')).toHaveValue('My unsaved observation');
    rerender(<ThemeProvider theme={theme}><SupportResponseDetails details={{ cards: [card] }} onOutcome={onOutcome} disabled /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'Save result to case' })).toBeDisabled();
  });
});
