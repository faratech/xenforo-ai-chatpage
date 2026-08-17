import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const identityMocks = vi.hoisted(() => ({
  getUserData: vi.fn(),
  setExpectedIdentityId: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    ChatAPI: {
      getUserData: identityMocks.getUserData,
      setExpectedIdentityId: identityMocks.setExpectedIdentityId,
    },
  };
});

vi.mock('../components/ChatWindow', () => ({
  ChatWindow: ({ userId }: { userId: string }) => (
    <div data-testid="chat-window">
      chat-user-{userId}
      <button type="button">composer-user-{userId}</button>
    </div>
  ),
}));

import { APIError } from '../services/api';
import App, { IDENTITY_FRESHNESS_MS } from '../App';

let now = 10_000;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  now = 10_000;
  identityMocks.getUserData.mockReset();
  identityMocks.setExpectedIdentityId.mockReset();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const user = (id: string | number, name = 'Member') => ({
  user_id: id,
  name,
  avatar: 'https://windowsforum.com/avatar.webp',
  identity_id: String(id).padStart(64, 'a').slice(-64),
});

const advanceClock = (milliseconds: number) => {
  now += milliseconds;
};

const dispatchPageShow = (persisted: boolean) => {
  const event = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
};

describe('identity lifecycle', () => {
  it('consumes the early bootstrap promise without issuing a second identity request', async () => {
    render(<App initialIdentityPromise={Promise.resolve(user(42))} />);
    expect(await screen.findByText('chat-user-42')).toBeInTheDocument();
    expect(identityMocks.getUserData).not.toHaveBeenCalled();
  });

  it('resolves the identity and mounts the chat for that user', async () => {
    identityMocks.getUserData.mockResolvedValue(user(42));
    render(<App />);
    expect(await screen.findByText('chat-user-42')).toBeInTheDocument();
  });

  it('remounts onto the new user when revalidation reveals an account switch', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42, 'First'));
    render(<App />);
    await screen.findByText('chat-user-42');

    identityMocks.getUserData.mockResolvedValueOnce(user(99, 'Second'));
    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText('chat-user-99')).toBeInTheDocument();
    expect(screen.queryByText('chat-user-42')).not.toBeInTheDocument();
  });

  it('coalesces a correlated visibility and focus burst without queuing a duplicate request', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    let resolveFirst: ((value: unknown) => void) | undefined;
    identityMocks.getUserData.mockImplementationOnce(
      () => new Promise(resolve => { resolveFirst = resolve; }),
    );

    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(identityMocks.getUserData).toHaveBeenCalledTimes(2);

    await act(async () => { resolveFirst?.(user(42)); });
    await waitFor(() => expect(screen.queryByLabelText('Rechecking chat identity')).not.toBeInTheDocument());
    expect(identityMocks.getUserData).toHaveBeenCalledTimes(2);
  });

  it('runs one queued check for a distinct activation during an in-flight request', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    let resolveFirst: ((value: unknown) => void) | undefined;
    identityMocks.getUserData
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(user(99));

    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    advanceClock(501);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { window.dispatchEvent(new Event('focus')); }); // same second activation burst

    await act(async () => { resolveFirst?.(user(42)); });

    expect(await screen.findByText('chat-user-99')).toBeInTheDocument();
    expect(identityMocks.getUserData).toHaveBeenCalledTimes(3);
  });

  it('preserves the chat layout and restores focus after same-user revalidation', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    const composer = screen.getByRole('button', { name: 'composer-user-42' });
    composer.focus();
    const focusSpy = vi.spyOn(composer, 'focus');

    let resolveSecond: ((value: unknown) => void) | undefined;
    identityMocks.getUserData.mockImplementationOnce(
      () => new Promise(resolve => { resolveSecond = resolve; }),
    );
    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    const overlay = screen.getByRole('status', { name: 'Rechecking chat identity' });
    const chat = screen.getByTestId('chat-window');
    expect(overlay).toBeInTheDocument();
    expect(overlay.parentElement).toHaveAttribute('aria-busy', 'true');
    expect(chat).not.toBeVisible();
    expect(chat.parentElement).not.toHaveStyle({ display: 'none' });

    await act(async () => {
      resolveSecond?.(user(42));
    });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Rechecking chat identity' })).not.toBeInTheDocument());
    expect(chat).toBeVisible();
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(composer).toHaveFocus();
  });

  it('ignores ordinary pageshow but revalidates a fresh BFCache restore', async () => {
    identityMocks.getUserData.mockResolvedValue(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    advanceClock(5_000);
    await act(async () => { dispatchPageShow(false); });
    expect(identityMocks.getUserData).toHaveBeenCalledTimes(1);

    act(() => { dispatchPageShow(true); });
    await waitFor(() => expect(identityMocks.getUserData).toHaveBeenCalledTimes(2));
  });

  it('skips ordinary activations for 30 seconds after a successful verification', async () => {
    identityMocks.getUserData.mockResolvedValue(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    advanceClock(100);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(identityMocks.getUserData).toHaveBeenCalledTimes(1);

    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(identityMocks.getUserData).toHaveBeenCalledTimes(2));
  });

  it('revalidates identity-change signals immediately inside the freshness window', async () => {
    identityMocks.getUserData.mockResolvedValue(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    advanceClock(100);
    act(() => { window.dispatchEvent(new Event('wf-chat-identity-changed')); });
    await waitFor(() => expect(identityMocks.getUserData).toHaveBeenCalledTimes(2));
  });

  it('does not steal focus back when the user moves to a XenForo control during revalidation', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    const composer = screen.getByRole('button', { name: 'composer-user-42' });
    composer.focus();
    const composerFocusSpy = vi.spyOn(composer, 'focus');
    const xenForoControl = document.createElement('button');
    xenForoControl.textContent = 'XenForo navigation';
    document.body.append(xenForoControl);

    let resolveSecond: ((value: unknown) => void) | undefined;
    identityMocks.getUserData.mockImplementationOnce(
      () => new Promise(resolve => { resolveSecond = resolve; }),
    );
    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    xenForoControl.focus();

    await act(async () => { resolveSecond?.(user(42)); });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Rechecking chat identity' })).not.toBeInTheDocument());
    expect(xenForoControl).toHaveFocus();
    expect(composerFocusSpy).not.toHaveBeenCalled();
    xenForoControl.remove();
  });

  it('keeps the established chat mounted but locked when revalidation fails transiently', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    identityMocks.getUserData.mockRejectedValueOnce(
      new APIError('network down', { code: 'network_error', retryable: true }),
    );
    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    // The transcript stays mounted for layout/state continuity but cannot be
    // read or mutated until the session is authoritative again.
    expect(screen.getByText('chat-user-42')).toBeInTheDocument();
    expect(screen.queryByText(/could not verify your WindowsForum session/)).not.toBeInTheDocument();
    expect(await screen.findByText(/Chat is locked until your session is verified/)).toBeInTheDocument();
    expect(screen.getByTestId('chat-window').parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('tears down the chat when a revalidation fails authoritatively', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    identityMocks.getUserData.mockRejectedValueOnce(
      new APIError('forbidden', { status: 403, retryable: false }),
    );
    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText(/could not verify your WindowsForum session/)).toBeInTheDocument();
    expect(screen.queryByText('chat-user-42')).not.toBeInTheDocument();

    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('chat-user-42')).toBeInTheDocument();
  });

  it('rejects an unstable identity (user_id 0) at initial load', async () => {
    identityMocks.getUserData.mockResolvedValue(user(0));
    render(<App />);
    expect(await screen.findByText(/could not verify your WindowsForum session/)).toBeInTheDocument();
  });

  it('tears down the chat when revalidation returns an unstable identity', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    identityMocks.getUserData.mockResolvedValueOnce(user(0));
    advanceClock(IDENTITY_FRESHNESS_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText(/could not verify your WindowsForum session/)).toBeInTheDocument();
    expect(screen.queryByText('chat-user-42')).not.toBeInTheDocument();
  });
});
