import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { ComponentProps } from 'react';
import { Message } from '../components/Message';
import { makeTheme } from '../index';

const renderMessage = (overrides: Partial<ComponentProps<typeof Message>> = {}) => {
  const props: ComponentProps<typeof Message> = {
    msg: {
      id: 'ai-action-1',
      role: 'ai',
      rawContent: 'Completed answer',
      timestamp: 1_700_000_000_000,
      status: 'complete',
      responseId: 'response-1',
      turnId: 'turn-1',
    },
    userAvatar: '/avatar.webp',
    userName: 'Member',
    onEdit: vi.fn(),
    onRegenerate: vi.fn(),
    onRetry: vi.fn(),
    isLastMessage: true,
    isStreaming: false,
    onSpeak: vi.fn(),
    onFeedback: vi.fn(),
    ...overrides,
  };

  return render(
    <ThemeProvider theme={createTheme()}>
      <div id="wf-chat-window"><Message {...props} /></div>
    </ThemeProvider>,
  );
};

const channel = (value: number): number => {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const value = hex.replace('#', '');
  return 0.2126 * channel(Number.parseInt(value.slice(0, 2), 16))
    + 0.7152 * channel(Number.parseInt(value.slice(2, 4), 16))
    + 0.0722 * channel(Number.parseInt(value.slice(4, 6), 16));
};

const contrast = (first: string, second: string): number => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('message action menu', () => {
  it('renders validated support checks and evidence controls on an assistant answer', async () => {
    renderMessage({ msg: {
      id: 'support-answer', role: 'ai', rawContent: 'Review the proposed check.', timestamp: 1700000000000,
      details: { cards: [{ id: 'step_1', check: 'Check the Windows build', explanation: 'Identify the applicable version.', expected_result: 'An OS build number', evidence_ids: [] }] },
    } });
    expect(await screen.findByRole('button', { name: 'Check the Windows build' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'View evidence and context' })).toBeVisible();
  });

  it('does not turn user-authored message metadata into support UI', () => {
    renderMessage({ msg: {
      id: 'support-user', role: 'user', rawContent: 'My report', timestamp: 1700000000000,
      details: { cards: [{ id: 'step_1', check: 'Untrusted card', explanation: 'User content', expected_result: 'User content', evidence_ids: [] }] },
    } });
    expect(screen.queryByRole('button', { name: 'Untrusted card' })).not.toBeInTheDocument();
  });
  it('keeps primary actions visible and places secondary actions in one accessible menu', async () => {
    renderMessage();

    expect(screen.getByRole('button', { name: 'Copy message content' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Read aloud' })).not.toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: 'Message actions' });
    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('menu', { name: 'Message actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Read aloud' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Helpful' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: 'Not helpful' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('copies a stable message permalink through the host callback', async () => {
    const onCopyPermalink = vi.fn().mockResolvedValue(undefined);
    const { container } = renderMessage({ onCopyPermalink });

    expect(container.querySelector('#wf-message-ai-action-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Message actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy link to this message' }));

    await waitFor(() => expect(onCopyPermalink).toHaveBeenCalledWith('ai-action-1'));
    expect(screen.getByRole('status')).toHaveTextContent('Link to message copied.');
  });
});

describe('code snippet download', () => {
  it('defers object URL revocation by 10 seconds like the export helpers', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:snippet');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderMessage({
      msg: {
        id: 'ai-code-1',
        role: 'ai',
        rawContent: '```js\nconsole.log("hi");\n```',
        timestamp: 1_700_000_000_000,
        status: 'complete',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download code' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9_999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:snippet');
  });
});

describe('chat theme contrast', () => {
  it('uses the lighter brand blue in dark mode with readable control text', () => {
    const theme = makeTheme('dark');
    const primary = theme.palette.primary.main;
    const onPrimary = theme.palette.primary.contrastText;

    expect(primary.toLowerCase()).toBe('#75b6e7');
    expect(contrast(primary, theme.palette.background.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(primary, onPrimary)).toBeGreaterThanOrEqual(4.5);
  });
});
