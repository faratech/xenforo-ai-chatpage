import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const identityMocks = vi.hoisted(() => ({
  getUserData: vi.fn(),
}));

vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    ChatAPI: { getUserData: identityMocks.getUserData },
  };
});

vi.mock('../components/ChatWindow', () => ({
  ChatWindow: ({ userId }: { userId: string }) => (
    <div data-testid="chat-window">chat-user-{userId}</div>
  ),
}));

import { APIError } from '../services/api';
import App from '../App';

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
  identityMocks.getUserData.mockReset();
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
});

describe('identity lifecycle', () => {
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
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByText('chat-user-99')).toBeInTheDocument();
    expect(screen.queryByText('chat-user-42')).not.toBeInTheDocument();
  });

  it('re-runs a coalesced revalidation so an account switch mid-request is not missed', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    // First revalidation is slow; a second trigger arrives while it is in
    // flight and must be honored once the first settles.
    let resolveFirst: ((value: unknown) => void) | undefined;
    identityMocks.getUserData
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(user(99));

    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { window.dispatchEvent(new Event('focus')); }); // coalesced

    await act(async () => { resolveFirst?.(user(42)); });

    // The queued re-run picks up the switched account.
    expect(await screen.findByText('chat-user-99')).toBeInTheDocument();
    expect(identityMocks.getUserData).toHaveBeenCalledTimes(3);
  });

  it('hides the existing history while revalidation is in flight', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    let resolveSecond: ((value: unknown) => void) | undefined;
    identityMocks.getUserData.mockImplementationOnce(
      () => new Promise(resolve => { resolveSecond = resolve; }),
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.getByLabelText('Rechecking chat identity')).toBeInTheDocument();
    expect(screen.getByText('chat-user-42')).not.toBeVisible();

    await act(async () => {
      resolveSecond?.(user(42));
    });
    await waitFor(() => expect(screen.queryByLabelText('Rechecking chat identity')).not.toBeInTheDocument());
    expect(screen.getByText('chat-user-42')).toBeVisible();
  });

  it('revalidates when the page is restored via pageshow', async () => {
    identityMocks.getUserData.mockResolvedValue(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await waitFor(() => expect(identityMocks.getUserData).toHaveBeenCalledTimes(2));
  });

  it('keeps the established chat mounted when a revalidation fails transiently', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    identityMocks.getUserData.mockRejectedValueOnce(
      new APIError('network down', { code: 'network_error', retryable: true }),
    );
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Transient failure: the chat stays, plus a non-destructive notice.
    expect(screen.getByText('chat-user-42')).toBeInTheDocument();
    expect(screen.queryByText(/could not verify your WindowsForum session/)).not.toBeInTheDocument();
    expect(await screen.findByText(/still using your last verified session/)).toBeInTheDocument();
  });

  it('tears down the chat when a revalidation fails authoritatively', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    identityMocks.getUserData.mockRejectedValueOnce(
      new APIError('forbidden', { status: 403, retryable: false }),
    );
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
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
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByText(/could not verify your WindowsForum session/)).toBeInTheDocument();
    expect(screen.queryByText('chat-user-42')).not.toBeInTheDocument();
  });
});
