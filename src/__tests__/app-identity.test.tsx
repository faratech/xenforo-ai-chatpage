import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const identityMocks = vi.hoisted(() => ({
  getUserData: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ChatAPI: { getUserData: identityMocks.getUserData },
}));

vi.mock('../components/ChatWindow', () => ({
  ChatWindow: ({ userId }: { userId: string }) => (
    <div data-testid="chat-window">chat-user-{userId}</div>
  ),
}));

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

  it('shows the error state instead of stale history when revalidation fails', async () => {
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    render(<App />);
    await screen.findByText('chat-user-42');

    identityMocks.getUserData.mockRejectedValueOnce(new Error('session check failed'));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByText(/could not verify your WindowsForum session/)).toBeInTheDocument();
    expect(screen.queryByText('chat-user-42')).not.toBeInTheDocument();

    // Retry restores the chat.
    identityMocks.getUserData.mockResolvedValueOnce(user(42));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('chat-user-42')).toBeInTheDocument();
  });

  it('rejects an unstable identity (user_id 0) at initial load', async () => {
    identityMocks.getUserData.mockResolvedValue(user(0));
    render(<App />);
    expect(await screen.findByText(/could not verify your WindowsForum session/)).toBeInTheDocument();
  });
});
