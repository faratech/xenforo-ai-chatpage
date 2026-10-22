import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const mocks = vi.hoisted(() => ({ listSupportCases: vi.fn(), getSupportCase: vi.fn(), upsertSupportCase: vi.fn(), updateSupportCaseProgress: vi.fn() }));
vi.mock('../services/api', async importOriginal => ({ ...await importOriginal<typeof import('../services/api')>(), ChatAPI: mocks }));
import { GuidedSupportPanel } from '../components/GuidedSupportPanel';
import type { SupportCase } from '../services/api';

const theme = createTheme();
const saved: SupportCase = {
  id: 'case_1', title: 'Wi-Fi after sleep', description: 'Network drops after wake.', status: 'open',
  pc_profile: { os_name: 'Windows 11', build: '26100' }, conversation_ids: [], attachment_ids: [],
  revision: 3, created_at: 1, updated_at: 2,
  progress: { confirmed_facts: ['Occurs after sleep'], recent_changes: 'Driver updated', attempts: [{ id: 'step_1', check: 'Restart adapter', outcome: 'no_change', observed_result: 'Still disconnected' }] },
};
const show = (props: Partial<React.ComponentProps<typeof GuidedSupportPanel>> = {}) => render(
  <ThemeProvider theme={theme}><GuidedSupportPanel onSelect={vi.fn()} onUpdated={vi.fn()} onManage={vi.fn()} disabled={false} {...props} /></ThemeProvider>,
);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listSupportCases.mockResolvedValue({ success: true, cases: [], next_cursor: null });
});
afterEach(() => cleanup());

describe('optional guided support intake', () => {
  it('keeps unsaved reviewed facts when a newer outcome revision arrives', async () => {
    const callbacks = { onSelect: vi.fn(), onUpdated: vi.fn(), onManage: vi.fn(), disabled: false };
    const { rerender } = show({ ...callbacks, activeCase: saved });
    fireEvent.click(screen.getByRole('button', { name: `Troubleshooting: ${saved.title}` }));
    fireEvent.change(screen.getByLabelText('Confirmed facts (one per line)'), { target: { value: 'My unsaved correction' } });
    rerender(<ThemeProvider theme={theme}><GuidedSupportPanel {...callbacks} activeCase={{ ...saved, revision: 4, progress: { ...saved.progress!, confirmed_facts: ['Changed on another device'] } }} /></ThemeProvider>);
    expect(screen.getByLabelText('Confirmed facts (one per line)')).toHaveValue('My unsaved correction');
  });
  it('loads saved cases without creating one and cancels loading on unmount', async () => {
    const { unmount } = show();
    await waitFor(() => expect(mocks.listSupportCases).toHaveBeenCalledTimes(1));
    expect(mocks.upsertSupportCase).not.toHaveBeenCalled();
    expect(mocks.updateSupportCaseProgress).not.toHaveBeenCalled();
    const signal = mocks.listSupportCases.mock.calls[0]![0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('creates and selects a case with a symptom and optional Windows details', async () => {
    mocks.upsertSupportCase.mockResolvedValue({ success: true, case: saved });
    const onSelect = vi.fn();
    show({ onSelect });
    fireEvent.click(screen.getByRole('button', { name: 'New guided case' }));
    expect(screen.getByRole('button', { name: 'Create and use case' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What is going wrong?'), { target: { value: ' Wi-Fi disconnects after sleep. ' } });
    fireEvent.change(screen.getByLabelText('Windows version'), { target: { value: 'Windows 11 24H2' } });
    fireEvent.change(screen.getByLabelText('OS build (optional)'), { target: { value: '26100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and use case' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(saved));
    expect(mocks.upsertSupportCase).toHaveBeenCalledWith({ title: 'Wi-Fi disconnects after sleep.', description: 'Wi-Fi disconnects after sleep.', pc_profile: { os_name: 'Windows', os_version: 'Windows 11 24H2', build: '26100' } }, 0);
  });

  it('does not require PC details to create an optional case and retains intake on failure', async () => {
    mocks.upsertSupportCase.mockRejectedValue(new Error('Could not create right now.'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'New guided case' }));
    fireEvent.change(screen.getByLabelText('What is going wrong?'), { target: { value: 'A startup error' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and use case' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create right now.');
    expect(screen.getByLabelText('What is going wrong?')).toHaveValue('A startup error');
    expect(mocks.upsertSupportCase.mock.calls[0]?.[1]).toBe(0);
  });

  it('saves reviewed facts with the displayed revision and keeps previous attempts', async () => {
    const onUpdated = vi.fn();
    mocks.updateSupportCaseProgress.mockResolvedValue({ success: true, case: { ...saved, revision: 4 } });
    show({ activeCase: saved, onUpdated });
    fireEvent.click(screen.getByRole('button', { name: `Troubleshooting: ${saved.title}` }));
    fireEvent.change(screen.getByLabelText('Confirmed facts (one per line)'), { target: { value: ' Windows 11 \n\n Wi-Fi only ' } });
    fireEvent.change(screen.getByLabelText('Recent changes'), { target: { value: 'Updated a driver' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed facts' }));
    await waitFor(() => expect(mocks.updateSupportCaseProgress).toHaveBeenCalledWith(saved.id, 3, { confirmed_facts: ['Windows 11', 'Wi-Fi only'], recent_changes: 'Updated a driver', attempts: saved.progress!.attempts }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }));
  });

  it('keeps a conflicting facts edit visible without acknowledging a stale update', async () => {
    const onUpdated = vi.fn();
    mocks.updateSupportCaseProgress.mockRejectedValue(new Error('Revision conflict: reload the case.'));
    show({ activeCase: saved, onUpdated });
    fireEvent.click(screen.getByRole('button', { name: `Troubleshooting: ${saved.title}` }));
    fireEvent.change(screen.getByLabelText('Confirmed facts (one per line)'), { target: { value: 'My unsaved correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed facts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict');
    expect(screen.getByLabelText('Confirmed facts (one per line)')).toHaveValue('My unsaved correction');
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('lets users return to ordinary chat and manage cases without modifying saved facts', async () => {
    const onSelect = vi.fn(), onManage = vi.fn();
    show({ activeCase: saved, onSelect, onManage });
    fireEvent.click(screen.getByRole('button', { name: `Troubleshooting: ${saved.title}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to ordinary chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage cases and forum draft' }));
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(mocks.updateSupportCaseProgress).not.toHaveBeenCalled();
  });
});
